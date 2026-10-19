#!/usr/bin/env bash
# Автотесты HairRate.
# Поднимает локальную копию Supabase (Postgres + PostgREST + шлюз входа и фото),
# применяет supabase/setup.sql, сверяет формулу и прогоняет сайт в браузере.
# Запуск из корня репозитория:  bash tests/run.sh
# Код выхода 0 — всё прошло; иначе что-то сломано и выкладывать нельзя.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/hairrate-tests.XXXXXX)"
PG_PORT="${PG_PORT:-5499}"
PGREST_PORT="${PGREST_PORT:-3001}"
GW_PORT="${GW_PORT:-8790}"
SITE_PORT="${SITE_PORT:-8771}"
POSTGREST_VERSION="v12.2.3"
POSTGREST="${POSTGREST:-$HOME/.cache/hairrate-tests/postgrest}"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PIDS=()

log() { printf '\n== %s\n' "$*"; }
fail() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ -x "$PG_BIN/initdb" ] || fail "не найден PostgreSQL (ожидался в /usr/lib/postgresql/*/bin)"
command -v psql >/dev/null || fail "не найден psql"
command -v node >/dev/null || fail "не найден node"

# Postgres нельзя запускать от root — используем обычного пользователя
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  for candidate in claude postgres nobody; do
    if id "$candidate" >/dev/null 2>&1; then RUN_AS="$candidate"; break; fi
  done
  chown -R "$RUN_AS" "$WORK"
fi
as_user() { if [ -n "$RUN_AS" ]; then su "$RUN_AS" -s /bin/bash -c "$*"; else bash -c "$*"; fi; }

cleanup() {
  local code=$?
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  as_user "$PG_BIN/pg_ctl -D $WORK/pg -m immediate stop" >/dev/null 2>&1 || true
  if [ "$code" = "0" ]; then
    rm -rf "$WORK"
  else
    echo "Логи и скриншоты сохранены в $WORK" >&2
  fi
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$url"; then return 0; fi
    sleep 0.5
  done
  fail "$name не запустился"
}

log "Postgres"
as_user "$PG_BIN/initdb -D $WORK/pg -U postgres -A trust" >/dev/null
as_user "$PG_BIN/pg_ctl -D $WORK/pg -o \"-p $PG_PORT -k $WORK -c listen_addresses=''\" -l $WORK/pg.log start" >/dev/null
PSQL=(psql -h "$WORK" -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q)
for _ in $(seq 1 40); do "${PSQL[@]}" -At -c "select 1" >/dev/null 2>&1 && break; sleep 0.25; done
"${PSQL[@]}" -c "create database hairrate"
"${PSQL[@]}" -d hairrate -f "$ROOT/tests/mock_supabase.sql" >/dev/null

log "Схема из supabase/setup.sql (два запуска подряд — повтор должен быть безопасным)"
"${PSQL[@]}" -d hairrate -f "$ROOT/supabase/setup.sql" >/dev/null 2>"$WORK/setup.log" || { cat "$WORK/setup.log"; fail "setup.sql не применился"; }
"${PSQL[@]}" -d hairrate -f "$ROOT/supabase/setup.sql" >/dev/null 2>"$WORK/setup2.log" || { cat "$WORK/setup2.log"; fail "повторный запуск setup.sql упал"; }

log "Формула: script.js против базы на всех 7290 комбинациях"
node "$ROOT/tests/formula.js" > "$WORK/js_scores.csv"
MISMATCHES=$("${PSQL[@]}" -d hairrate -At <<SQL
create temp table js(a int, b int, c int, d int, s int);
\copy js from '$WORK/js_scores.csv' csv
select count(*) filter (where public.hairrate_score(a, b, c, d) <> s) from js;
SQL
)
[ "$MISMATCHES" = "0" ] || fail "формула в script.js и в базе расходится в $MISMATCHES комбинациях"
echo "расхождений: 0"

log "PostgREST $POSTGREST_VERSION"
if [ ! -x "$POSTGREST" ]; then
  mkdir -p "$(dirname "$POSTGREST")"
  curl -sSL "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/postgrest-$POSTGREST_VERSION-linux-static-x64.tar.xz" \
    | tar xJ -C "$(dirname "$POSTGREST")"
fi
cat > "$WORK/postgrest.conf" <<CONF
db-uri = "postgres://authenticator@/hairrate?host=$WORK&port=$PG_PORT"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "super-secret-jwt-token-with-at-least-32-characters"
server-port = $PGREST_PORT
server-host = "127.0.0.1"
CONF
"$POSTGREST" "$WORK/postgrest.conf" > "$WORK/postgrest.log" 2>&1 & PIDS+=($!)

log "Шлюз (вход, фото) и сайт"
PG_HOST="$WORK" PG_PORT="$PG_PORT" PG_DB=hairrate GW_PORT="$GW_PORT" PGREST_URL="http://127.0.0.1:$PGREST_PORT" \
  python3 "$ROOT/tests/gateway.py" > "$WORK/gateway.log" 2>&1 & PIDS+=($!)

mkdir -p "$WORK/site"
cp "$ROOT/index.html" "$ROOT/style.css" "$ROOT/script.js" "$ROOT/favicon.svg" "$ROOT/apple-touch-icon.png" "$ROOT/og-image.png" "$WORK/site/"
printf 'window.HAIRRATE_CONFIG = { supabaseUrl: "http://localhost:%s", supabaseKey: "sb_publishable__TEST" };\n' "$GW_PORT" > "$WORK/site/config.js"
python3 -m http.server "$SITE_PORT" --bind 127.0.0.1 --directory "$WORK/site" > /dev/null 2>&1 & PIDS+=($!)

wait_for "http://127.0.0.1:$PGREST_PORT/" "PostgREST"
for _ in $(seq 1 40); do
  curl -s "http://127.0.0.1:$PGREST_PORT/profiles?select=id" | grep -q '^\[' && break
  sleep 0.5
done
wait_for "http://localhost:$GW_PORT/__debug" "шлюз"
wait_for "http://localhost:$SITE_PORT/" "сайт"

log "Сайт в браузере"
SITE="http://localhost:$SITE_PORT/" GW="http://localhost:$GW_PORT" WORK="$WORK" \
PSQL_ARGS="-h $WORK -p $PG_PORT -U postgres -d hairrate" \
  node "$ROOT/tests/e2e.js"

log "Все проверки пройдены"
