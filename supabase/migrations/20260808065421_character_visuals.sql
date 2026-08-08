create table if not exists public.character_images (
  id uuid primary key,
  work_id uuid not null references public.works(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  storage_path text not null unique,
  mime_type text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.character_images enable row level security;
create policy "Users manage their character images" on public.character_images
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.character_images to authenticated;
create index character_images_user_work_idx on public.character_images(user_id, work_id);
create index character_images_work_id_idx on public.character_images(work_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('character-visuals', 'character-visuals', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Users read own character visuals" on storage.objects
  for select to authenticated
  using (bucket_id = 'character-visuals' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload own character visuals" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'character-visuals' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users update own character visuals" on storage.objects
  for update to authenticated
  using (bucket_id = 'character-visuals' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'character-visuals' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users delete own character visuals" on storage.objects
  for delete to authenticated
  using (bucket_id = 'character-visuals' and (storage.foldername(name))[1] = (select auth.uid())::text);

alter table public.deletion_tombstones drop constraint deletion_tombstones_item_type_check;
alter table public.deletion_tombstones add constraint deletion_tombstones_item_type_check
  check (item_type in ('work','chapter','scene','image'));
