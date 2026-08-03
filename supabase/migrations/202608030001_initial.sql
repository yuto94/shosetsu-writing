create extension if not exists pgcrypto;

create table profiles (id uuid primary key references auth.users(id) on delete cascade, user_id uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);
create table works (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, title text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);
create table chapters (id uuid primary key, work_id uuid not null references works(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, title text not null, "order" integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);
create table scenes (id uuid primary key, work_id uuid not null references works(id) on delete cascade, chapter_id uuid not null references chapters(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, title text not null, content text not null default '', "order" integer not null default 0, device_id uuid, last_synced_revision bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);
create table devices (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, name text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);
create table sync_conflicts (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, scene_id uuid not null, local_content text not null, cloud_content text not null, local_updated_at timestamptz not null, cloud_updated_at timestamptz not null, device_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision bigint not null default 1);

alter table profiles enable row level security; alter table works enable row level security; alter table chapters enable row level security; alter table scenes enable row level security; alter table devices enable row level security; alter table sync_conflicts enable row level security;
create policy "own profiles" on profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own works" on works for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own chapters" on chapters for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own scenes" on scenes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own devices" on devices for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own conflicts" on sync_conflicts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
