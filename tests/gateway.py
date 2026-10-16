"""Тестовый шлюз, имитирующий Supabase для автотестов: /auth/v1 (вход и JWT), /rest/v1 (→ настоящий PostgREST), /storage/v1 (фото в памяти).
Запускается из tests/run.sh, настраивается переменными окружения."""
import base64, hashlib, hmac, json, subprocess, threading, time, uuid, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, unquote

import os
SECRET = os.environ.get("JWT_SECRET", "super-secret-jwt-token-with-at-least-32-characters").encode()
API_KEY = os.environ.get("API_KEY", "sb_publishable__TEST")
PGREST = os.environ.get("PGREST_URL", "http://127.0.0.1:3001")
PG_ARGS = ["-h", os.environ["PG_HOST"], "-p", os.environ["PG_PORT"], "-U", "postgres", "-d", os.environ.get("PG_DB", "hairrate")]
GW_PORT = int(os.environ.get("GW_PORT", "8790"))
users = {}          # email -> {id, password}
refresh = {}        # refresh_token -> user id
files = {}          # path -> (bytes, content_type, owner)
lock = threading.Lock()

def b64(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def make_jwt(sub, ttl):
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"sub": sub, "role": "authenticated", "exp": int(time.time()) + ttl}).encode())
    sig = b64(hmac.new(SECRET, f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"

def read_jwt(token):
    try:
        header, payload, sig = token.split(".")
        expected = b64(hmac.new(SECRET, f"{header}.{payload}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected): return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=="))
        return data if data["exp"] > time.time() else None
    except Exception:
        return None

def session_for(uid, email, ttl=3600):
    token = uuid.uuid4().hex
    refresh[token] = uid
    return {"access_token": make_jwt(uid, ttl), "token_type": "bearer", "expires_in": ttl,
            "expires_at": int(time.time()) + ttl, "refresh_token": token,
            "user": {"id": uid, "email": email}}

def psql_insert_user(uid, meta):
    result = subprocess.run(
        ["psql", *PG_ARGS, "-q", "-v", "ON_ERROR_STOP=1",
         "-v", f"id={uid}", "-v", f"meta={json.dumps(meta)}"],
        input="insert into auth.users (id, raw_user_meta_data) values (:'id', :'meta'::jsonb);",
        capture_output=True, text=True)
    return result.returncode == 0, result.stderr

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    TOKEN_TTL = 3600

    def log_message(self, *args): pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "apikey, authorization, content-type, prefer, x-upsert, cache-control")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")

    def reply(self, status, body=None, content_type="application/json"):
        data = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        self.send_response(status)
        self.cors()
        if data: self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def user_id(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            claims = read_jwt(auth[7:])
            return claims["sub"] if claims else False
        return None

    def do_OPTIONS(self): self.reply(204)
    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PATCH(self): self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")

    def route(self, method):
        url = urlsplit(self.path)
        if url.path == "/__debug":
            return self.reply(200, {"refreshed": getattr(Handler, "refreshed", 0), "files": sorted(files)})
        if url.path.startswith("/storage/v1/object/public/"):
            return self.public_file(unquote(url.path.split("/storage/v1/object/public/photos/", 1)[-1]))
        if self.headers.get("apikey") != API_KEY:
            return self.reply(401, {"message": "No API key found in request"})
        if url.path.startswith("/auth/v1/"):
            return self.auth(method, url)
        if url.path.startswith("/rest/v1/"):
            return self.rest(method, url)
        if url.path.startswith("/storage/v1/object/"):
            return self.storage(method, url)
        self.reply(404, {"message": "not found"})

    # ---------- auth ----------
    def auth(self, method, url):
        name = url.path[len("/auth/v1/"):]
        data = json.loads(self.body() or b"{}") if method == "POST" else {}
        if name == "signup":
            email = str(data.get("email", "")).lower()
            password = str(data.get("password", ""))
            if "@" not in email: return self.reply(400, {"code": 400, "error_code": "email_address_invalid", "msg": "Unable to validate email address: invalid format"})
            if len(password) < 6: return self.reply(422, {"code": 422, "error_code": "weak_password", "msg": "Password should be at least 6 characters."})
            with lock:
                if email in users: return self.reply(422, {"code": 422, "error_code": "user_already_exists", "msg": "User already registered"})
                uid = str(uuid.uuid4())
                ok, err = psql_insert_user(uid, data.get("data") or {})
                if not ok: return self.reply(500, {"code": 500, "error_code": "unexpected_failure", "msg": "Database error saving new user"})
                users[email] = {"id": uid, "password": password}
            return self.reply(200, session_for(uid, email, Handler.TOKEN_TTL))
        if name == "token":
            grant = parse_qs(url.query).get("grant_type", [""])[0]
            if grant == "password":
                user = users.get(str(data.get("email", "")).lower())
                if not user or user["password"] != data.get("password"):
                    return self.reply(400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})
                return self.reply(200, session_for(user["id"], data["email"], Handler.TOKEN_TTL))
            if grant == "refresh_token":
                uid = refresh.pop(data.get("refresh_token"), None)
                if not uid: return self.reply(400, {"code": 400, "error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token"})
                email = next(e for e, u in users.items() if u["id"] == uid)
                Handler.refreshed = getattr(Handler, "refreshed", 0) + 1
                return self.reply(200, session_for(uid, email, 3600))
        if name == "logout":
            return self.reply(204)
        self.reply(404, {"msg": "not found"})

    # ---------- rest → PostgREST ----------
    def rest(self, method, url):
        uid = self.user_id()
        if uid is False: return self.reply(401, {"code": "PGRST301", "message": "JWT expired"})
        target = PGREST + url.path[len("/rest/v1"):] + ("?" + url.query if url.query else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("authorization", "prefer", "content-type", "accept")}
        request = urllib.request.Request(target, data=self.body() or None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request) as response:
                self.reply(response.status, response.read(), response.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as error:
            self.reply(error.code, error.read(), error.headers.get("Content-Type", "application/json"))

    # ---------- storage ----------
    def storage(self, method, url):
        uid = self.user_id()
        if not uid: return self.reply(400, {"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"})
        rest = unquote(url.path[len("/storage/v1/object/"):])
        if method == "POST":
            bucket, _, path = rest.partition("/")
            content_type = self.headers.get("Content-Type", "")
            data = self.body()
            if bucket != "photos" or path.split("/")[0] != uid:
                return self.reply(400, {"statusCode": "403", "error": "Unauthorized", "message": "new row violates row-level security policy"})
            if content_type not in ("image/jpeg", "image/png", "image/webp"):
                return self.reply(400, {"statusCode": "415", "error": "invalid_mime_type", "message": "mime type not supported"})
            if len(data) > 5 * 1024 * 1024:
                return self.reply(413, {"statusCode": "413", "error": "Payload too large", "message": "The object exceeded the maximum allowed size"})
            files[path] = (data, content_type, uid)
            return self.reply(200, {"Key": f"photos/{path}"})
        if method == "DELETE" and rest == "photos":
            prefixes = json.loads(self.body() or b"{}").get("prefixes", [])
            removed = [p for p in prefixes if p in files and files[p][2] == uid]
            for p in removed: del files[p]
            return self.reply(200, [{"name": p} for p in removed])
        self.reply(404, {"message": "not found"})

    def public_file(self, path):
        if path not in files: return self.reply(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
        data, content_type, _ = files[path]
        self.reply(200, data, content_type)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", GW_PORT), Handler).serve_forever()
