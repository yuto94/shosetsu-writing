create schema if not exists private;
revoke all on schema private from public;

create table public.scene_versions (
  id bigint generated always as identity primary key,
  scene_id uuid not null,
  work_id uuid not null,
  chapter_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null default '',
  "order" integer not null default 0,
  revision bigint not null,
  source_device_id uuid,
  saved_at timestamptz not null default now()
);

create index scene_versions_user_scene_saved_idx
  on public.scene_versions (user_id, scene_id, saved_at desc);
alter table public.scene_versions enable row level security;
create policy "own scene versions select" on public.scene_versions
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "own scene versions insert" on public.scene_versions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
grant select, insert on public.scene_versions to authenticated;
grant usage, select on sequence public.scene_versions_id_seq to authenticated;

create table public.deletion_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('work', 'chapter', 'scene')),
  item_id uuid not null,
  deleted_at timestamptz not null default now(),
  device_id uuid,
  primary key (user_id, item_type, item_id)
);

create index deletion_tombstones_user_deleted_idx
  on public.deletion_tombstones (user_id, deleted_at desc);
create index if not exists devices_user_id_idx on public.devices (user_id);
create index if not exists profiles_user_id_idx on public.profiles (user_id);
create index if not exists sync_conflicts_user_id_idx on public.sync_conflicts (user_id);
alter table public.deletion_tombstones enable row level security;
create policy "own deletion tombstones" on public.deletion_tombstones
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.deletion_tombstones to authenticated;

create or replace function private.record_scene_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or row(new.title, new.content, new."order", new.revision, new.updated_at, new.device_id)
    is distinct from row(old.title, old.content, old."order", old.revision, old.updated_at, old.device_id) then
    insert into public.scene_versions (
      scene_id, work_id, chapter_id, user_id, title, content, "order",
      revision, source_device_id, saved_at
    ) values (
      new.id, new.work_id, new.chapter_id, new.user_id, new.title, new.content,
      new."order", new.revision, new.device_id, now()
    );
  end if;
  return new;
end;
$$;
revoke all on function private.record_scene_version() from public;

create trigger record_scene_version_trigger
after insert or update on public.scenes
for each row execute function private.record_scene_version();

insert into public.scene_versions (
  scene_id, work_id, chapter_id, user_id, title, content, "order",
  revision, source_device_id, saved_at
)
select id, work_id, chapter_id, user_id, title, content, "order",
       revision, device_id, now()
from public.scenes;

create or replace function public.save_scene_if_current(
  p_scene_id uuid,
  p_work_id uuid,
  p_chapter_id uuid,
  p_title text,
  p_content text,
  p_order integer,
  p_expected_revision bigint,
  p_created_at timestamptz,
  p_device_id uuid
)
returns table(status text, server_revision bigint, server_updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision bigint;
  v_updated_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required';
  end if;

  if p_expected_revision = 0 then
    insert into public.scenes (
      id, work_id, chapter_id, user_id, title, content, "order", device_id,
      last_synced_revision, created_at, updated_at, revision
    ) values (
      p_scene_id, p_work_id, p_chapter_id, (select auth.uid()), p_title,
      p_content, p_order, p_device_id, 1, coalesce(p_created_at, now()),
      now(), 1
    )
    on conflict (id) do nothing
    returning revision, updated_at into v_revision, v_updated_at;

    if found then
      return query select 'saved'::text, v_revision, v_updated_at;
      return;
    end if;
  end if;

  update public.scenes as s
  set title = p_title,
      content = p_content,
      "order" = p_order,
      device_id = p_device_id,
      revision = s.revision + 1,
      last_synced_revision = s.revision + 1,
      updated_at = now()
  where s.id = p_scene_id
    and s.user_id = (select auth.uid())
    and s.revision = p_expected_revision
  returning s.revision, s.updated_at into v_revision, v_updated_at;

  if found then
    return query select 'saved'::text, v_revision, v_updated_at;
    return;
  end if;

  select s.revision, s.updated_at into v_revision, v_updated_at
  from public.scenes s
  where s.id = p_scene_id and s.user_id = (select auth.uid());

  return query
    select 'conflict'::text, coalesce(v_revision, 0), v_updated_at;
end;
$$;
revoke all on function public.save_scene_if_current(
  uuid, uuid, uuid, text, text, integer, bigint, timestamptz, uuid
) from public;
grant execute on function public.save_scene_if_current(
  uuid, uuid, uuid, text, text, integer, bigint, timestamptz, uuid
) to authenticated;
