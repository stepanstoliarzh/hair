-- =====================================================================
--  HairRate — настройка базы Supabase
--  Вставьте весь файл в SQL Editor → Run. Повторный запуск безопасен.
-- =====================================================================

-- ---------- Формула оценки (та же, что в script.js) ----------
-- Считается в базе, чтобы балл нельзя было подделать.
-- Вычисления в double precision и округление floor(x + 0.5) дают ровно
-- тот же результат, что Math.round в JavaScript.
create or replace function public.hairrate_score(a int, b int, c int, d int)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select floor(
    4 + 63 * (
      0.2::float8 * (a - 1) / 8 +
      0.2::float8 * (b - 1) / 8 +
      0.2::float8 * (c - 1) / 8 +
      0.4::float8 * (d - 1) / 9
    ) + 0.5
  )::smallint
$$;

-- ---------- Профили ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null
    check (username ~ '^[A-Za-zА-Яа-яЁё0-9_.-]{3,24}$'),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

-- Профиль создаётся автоматически при регистрации.
-- Ник берётся из данных, переданных при signUp.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), 'user_' || substr(new.id::text, 1, 8))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Админ может удалять чужие прически и оценки (модерация)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
$$;

-- ---------- Прически ----------
create table if not exists public.hairstyles (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 60),
  description text not null default '' check (char_length(description) <= 240),
  tags text[] not null default '{}' check (cardinality(tags) <= 6),
  images text[] not null check (cardinality(images) between 1 and 4),
  created_at timestamptz not null default now()
);

create index if not exists hairstyles_created_at_idx on public.hairstyles (created_at desc);

-- ---------- Оценки и рецензии ----------
-- Один человек — одна оценка на прическу (её можно изменить).
create table if not exists public.reviews (
  id bigint generated always as identity primary key,
  hairstyle_id bigint not null references public.hairstyles (id) on delete cascade,
  author uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text text not null default '' check (char_length(text) <= 800),
  accuracy smallint not null check (accuracy between 1 and 9),
  beauty smallint not null check (beauty between 1 and 9),
  appearance smallint not null check (appearance between 1 and 9),
  personal smallint not null check (personal between 1 and 10),
  score smallint generated always as (public.hairrate_score(accuracy, beauty, appearance, personal)) stored,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  unique (hairstyle_id, author)
);

-- Оценки из старой версии сайта: у них нет аккаунта, только ник (legacy_author).
-- Переносить их может только админ, обычная оценка всегда привязана к аккаунту.
alter table public.reviews add column if not exists legacy_author text;
alter table public.reviews alter column author drop not null;
alter table public.reviews drop constraint if exists reviews_author_or_legacy;
alter table public.reviews add constraint reviews_author_or_legacy check (
  (author is not null and legacy_author is null) or
  (author is null and char_length(trim(legacy_author)) between 1 and 30)
);

create index if not exists reviews_hairstyle_idx on public.reviews (hairstyle_id);
create index if not exists reviews_author_idx on public.reviews (author);

-- ---------- Права ролей Data API ----------
-- В новых проектах Supabase таблицы не открываются для сайта автоматически,
-- поэтому права выдаются явно. Что именно разрешено, дальше уточняют правила RLS.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.hairstyles, public.reviews to anon, authenticated;
grant insert, delete on public.hairstyles, public.reviews to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.hairrate_score(int, int, int, int) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- Права доступа (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.hairstyles enable row level security;
alter table public.reviews enable row level security;

-- Смотреть каталог могут все, даже без входа
drop policy if exists "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles
  for select to anon, authenticated using (true);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Менять в своём профиле можно только ник (не is_admin)
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (username) on public.profiles to authenticated;

drop policy if exists "hairstyles: read" on public.hairstyles;
create policy "hairstyles: read" on public.hairstyles
  for select to anon, authenticated using (true);

drop policy if exists "hairstyles: insert own" on public.hairstyles;
create policy "hairstyles: insert own" on public.hairstyles
  for insert to authenticated
  with check (owner = (select auth.uid()));

drop policy if exists "hairstyles: update own" on public.hairstyles;
create policy "hairstyles: update own" on public.hairstyles
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

drop policy if exists "hairstyles: delete own or admin" on public.hairstyles;
create policy "hairstyles: delete own or admin" on public.hairstyles
  for delete to authenticated
  using (owner = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "reviews: read" on public.reviews;
create policy "reviews: read" on public.reviews
  for select to anon, authenticated using (true);

drop policy if exists "reviews: insert own" on public.reviews;
create policy "reviews: insert own" on public.reviews
  for insert to authenticated
  with check (
    (author = (select auth.uid()) and legacy_author is null)
    or (author is null and legacy_author is not null and (select public.is_admin()))
  );

drop policy if exists "reviews: update own" on public.reviews;
create policy "reviews: update own" on public.reviews
  for update to authenticated
  using (author = (select auth.uid()))
  with check (author = (select auth.uid()));

drop policy if exists "reviews: delete own or admin" on public.reviews;
create policy "reviews: delete own or admin" on public.reviews
  for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_admin()));

-- Владельца и автора нельзя подменить при изменении записи
revoke update on public.hairstyles from anon, authenticated;
grant update (title, description, tags, images) on public.hairstyles to authenticated;
revoke update on public.reviews from anon, authenticated;
grant update (text, accuracy, beauty, appearance, personal, edited_at) on public.reviews to authenticated;

-- ---------- Хранилище фото ----------
-- Публичное чтение; загружать можно только в свою папку <id пользователя>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos: upload own folder" on storage.objects;
create policy "photos: upload own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "photos: delete own or admin" on storage.objects;
create policy "photos: delete own or admin" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and ((storage.foldername(name))[1] = (select auth.uid()::text) or (select public.is_admin())));
