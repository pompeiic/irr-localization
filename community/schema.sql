-- Community suggestions backend. Paste into Supabase -> SQL Editor -> Run. Safe to re-run.
-- The repo stays the source of truth: nothing here reaches the game until an admin applies it to Areas/*.json.

create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create table if not exists public.bans (
  user_id uuid primary key references auth.users on delete cascade,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;

create or replace function public.is_banned() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from bans where user_id = auth.uid());
$$;

-- A member is a signed-in, non-anonymous, non-banned account (Discord), so one person = one vote.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and not exists (select 1 from bans where user_id = auth.uid());
$$;

-- Hourly spam limits, edited in the web editor's admin settings. One row; 0 = no limit. Admins are never limited.
create table if not exists public.limits (
  id boolean primary key default true check (id),
  suggestions_per_hour integer not null default 30 check (suggestions_per_hour >= 0),
  contexts_per_hour integer not null default 20 check (contexts_per_hour >= 0)
);
insert into public.limits default values on conflict do nothing;
alter table public.limits enable row level security;
drop policy if exists "anyone reads limits" on public.limits;
create policy "anyone reads limits" on public.limits for select using (true);
drop policy if exists "admins change limits" on public.limits;
create policy "admins change limits" on public.limits for update to authenticated using (is_admin()) with check (is_admin());

create table if not exists public.suggestions (
  id bigint generated always as identity primary key,
  ns text not null default '',
  key text not null,
  culture text not null check (culture ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  source_hash text not null,
  text text not null check (char_length(text) between 1 and 4000),
  note text not null default '' check (char_length(note) <= 1000),
  author uuid not null default auth.uid() references auth.users on delete cascade,
  author_name text not null default 'Anonymous' check (char_length(author_name) between 1 and 40),
  status text not null default 'open' check (status in ('open', 'applied', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists suggestions_slot on public.suggestions (culture, ns, key);
create index if not exists suggestions_author on public.suggestions (author, created_at);

create table if not exists public.votes (
  suggestion_id bigint not null references public.suggestions on delete cascade,
  voter uuid not null default auth.uid() references auth.users on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (suggestion_id, voter)
);

-- Votes on the translation currently in the repo; text_hash ties them to that exact text.
create table if not exists public.current_votes (
  ns text not null default '',
  key text not null,
  culture text not null,
  text_hash text not null,
  voter uuid not null default auth.uid() references auth.users on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (culture, ns, key, text_hash, voter)
);

-- Author name always comes from the account, never from the client. Spam guard: hourly limit, no duplicates.
create or replace function public.guard_suggestion() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb;
  cap integer;
begin
  select raw_user_meta_data into meta from auth.users where id = new.author;
  new.author_name := left(coalesce(nullif(meta -> 'custom_claims' ->> 'global_name', ''), nullif(meta ->> 'full_name', ''),
                                   nullif(meta ->> 'name', ''), nullif(meta ->> 'user_name', ''), 'Unknown'), 40);
  if not is_admin() then
    select suggestions_per_hour into cap from limits;
    if coalesce(cap, 30) > 0
       and (select count(*) from suggestions where author = new.author and created_at > now() - interval '1 hour') >= coalesce(cap, 30) then
      raise exception 'Too many suggestions in the last hour - please try again later.';
    end if;
    if exists (select 1 from suggestions where culture = new.culture and ns = new.ns and key = new.key
               and text = new.text and status = 'open') then
      raise exception 'This exact text is already suggested - vote for it instead.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_suggestion on public.suggestions;
create trigger guard_suggestion before insert on public.suggestions
  for each row execute function public.guard_suggestion();

-- Aggregates are public; the individual vote rows are only visible to their voter.
create or replace view public.open_suggestions as
  select s.id, s.ns, s.key, s.culture, s.source_hash, s.text, s.note, s.author, s.author_name, s.created_at,
         coalesce(count(v.*) filter (where v.value > 0), 0)::int as ups,
         coalesce(count(v.*) filter (where v.value < 0), 0)::int as downs
  from public.suggestions s
  left join public.votes v on v.suggestion_id = s.id
  where s.status = 'open'
  group by s.id;

create or replace view public.current_scores as
  select culture, ns, key, text_hash,
         count(*) filter (where value > 0)::int as ups,
         count(*) filter (where value < 0)::int as downs
  from public.current_votes
  group by culture, ns, key, text_hash;

grant select on public.open_suggestions, public.current_scores to anon, authenticated;

alter table public.admins enable row level security;
alter table public.bans enable row level security;
alter table public.suggestions enable row level security;
alter table public.votes enable row level security;
alter table public.current_votes enable row level security;

drop policy if exists "see own admin row" on public.admins;
create policy "see own admin row" on public.admins for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins manage bans" on public.bans;
create policy "admins manage bans" on public.bans for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "anyone reads suggestions" on public.suggestions;
create policy "anyone reads suggestions" on public.suggestions for select using (true);
drop policy if exists "add own suggestion" on public.suggestions;
create policy "add own suggestion" on public.suggestions for insert to authenticated
  with check (author = auth.uid() and status = 'open' and resolved_at is null and is_member());
drop policy if exists "withdraw own open suggestion" on public.suggestions;
create policy "withdraw own open suggestion" on public.suggestions for delete to authenticated
  using (author = auth.uid() and status = 'open');
drop policy if exists "admins manage suggestions" on public.suggestions;
create policy "admins manage suggestions" on public.suggestions for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists "see own votes" on public.votes;
create policy "see own votes" on public.votes for select to authenticated using (voter = auth.uid());
drop policy if exists "cast vote" on public.votes;
create policy "cast vote" on public.votes for insert to authenticated
  with check (voter = auth.uid() and is_member()
              and exists (select 1 from public.suggestions s
                          where s.id = suggestion_id and s.status = 'open' and s.author <> auth.uid()));
drop policy if exists "change vote" on public.votes;
create policy "change vote" on public.votes for update to authenticated
  using (voter = auth.uid()) with check (voter = auth.uid() and is_member());
drop policy if exists "remove vote" on public.votes;
create policy "remove vote" on public.votes for delete to authenticated using (voter = auth.uid() or is_admin());

drop policy if exists "see own current votes" on public.current_votes;
create policy "see own current votes" on public.current_votes for select to authenticated using (voter = auth.uid());
drop policy if exists "cast current vote" on public.current_votes;
create policy "cast current vote" on public.current_votes for insert to authenticated
  with check (voter = auth.uid() and is_member());
drop policy if exists "change current vote" on public.current_votes;
create policy "change current vote" on public.current_votes for update to authenticated
  using (voter = auth.uid()) with check (voter = auth.uid() and is_member());
drop policy if exists "remove current vote" on public.current_votes;
create policy "remove current vote" on public.current_votes for delete to authenticated
  using (voter = auth.uid() or is_admin());

-- Context players add to an entry: a note, a screenshot, or both. Shown at once; the author or an admin removes it.
create table if not exists public.contexts (
  id bigint generated always as identity primary key,
  ns text not null default '',
  key text not null,
  note text not null default '' check (char_length(note) <= 1000),
  image_path text check (image_path is null or char_length(image_path) <= 200),
  author uuid not null default auth.uid() references auth.users on delete cascade,
  author_name text not null default 'Anonymous' check (char_length(author_name) between 1 and 40),
  created_at timestamptz not null default now(),
  check (note <> '' or image_path is not null)
);
create index if not exists contexts_slot on public.contexts (ns, key);

create or replace function public.guard_context() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  meta jsonb;
  cap integer;
begin
  select raw_user_meta_data into meta from auth.users where id = new.author;
  new.author_name := left(coalesce(nullif(meta -> 'custom_claims' ->> 'global_name', ''), nullif(meta ->> 'full_name', ''),
                                   nullif(meta ->> 'name', ''), nullif(meta ->> 'user_name', ''), 'Unknown'), 40);
  select contexts_per_hour into cap from limits;
  if not is_admin() and coalesce(cap, 20) > 0
     and (select count(*) from contexts where author = new.author and created_at > now() - interval '1 hour') >= coalesce(cap, 20) then
    raise exception 'Too much context added in the last hour - please try again later.';
  end if;
  return new;
end $$;

drop trigger if exists guard_context on public.contexts;
create trigger guard_context before insert on public.contexts
  for each row execute function public.guard_context();

alter table public.contexts enable row level security;
drop policy if exists "anyone reads contexts" on public.contexts;
create policy "anyone reads contexts" on public.contexts for select using (true);
drop policy if exists "add own context" on public.contexts;
create policy "add own context" on public.contexts for insert to authenticated
  with check (author = auth.uid() and is_member() and (image_path is null or image_path like auth.uid()::text || '/%'));
drop policy if exists "remove own context" on public.contexts;
create policy "remove own context" on public.contexts for delete to authenticated
  using (author = auth.uid() or is_admin());

-- Screenshots: public bucket, images up to 2 MB; each member uploads into a folder named after their user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('context', 'context', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "context images readable" on storage.objects;
create policy "context images readable" on storage.objects for select using (bucket_id = 'context');
drop policy if exists "context upload own folder" on storage.objects;
create policy "context upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'context' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
drop policy if exists "context remove own or admin" on storage.objects;
create policy "context remove own or admin" on storage.objects for delete to authenticated
  using (bucket_id = 'context' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- Make yourself admin once: sign in on the editor with Discord, copy your user id from the account menu, then:
--   insert into public.admins (user_id) values ('<your user id>');
