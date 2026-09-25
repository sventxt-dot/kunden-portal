-- 0001_results_and_shares.sql
-- Messerich Portal: Ergebnis-Historie + Sharing mit Row Level Security.
-- Idempotent formuliert, damit ein erneutes Ausführen keinen Schaden anrichtet.

begin;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table if not exists public.results (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id),
  flow_type     text not null check (flow_type in ('kueche', 'operativ')),
  title         text,
  input_summary text,
  output_data   jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists public.result_shares (
  result_id      uuid not null references public.results(id) on delete cascade,
  shared_with_id uuid not null references auth.users(id),
  shared_by_id   uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  primary key (result_id, shared_with_id),
  -- Mit sich selbst teilen ergibt keinen Sinn und würde nur die History doppeln.
  constraint result_shares_not_self check (shared_with_id <> shared_by_id)
);

-- Indizes für die Policy-Subqueries und die History-Abfrage.
create index if not exists results_owner_id_created_at_idx
  on public.results (owner_id, created_at desc);
create index if not exists result_shares_shared_with_id_idx
  on public.result_shares (shared_with_id);
create index if not exists result_shares_shared_by_id_idx
  on public.result_shares (shared_by_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.results       enable row level security;
alter table public.result_shares enable row level security;

-- Alle Policies gelten nur für eingeloggte User (Rolle "authenticated").
-- "anon" bekommt keine Policy und sieht damit gar nichts.
-- auth.uid() wird als (select auth.uid()) geschrieben, damit Postgres es einmal
-- pro Statement auswertet statt einmal pro Zeile (Supabase-Empfehlung).

-- results: SELECT – Owner oder Empfänger eines Shares
drop policy if exists results_select_owner_or_shared on public.results;
create policy results_select_owner_or_shared
  on public.results
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or exists (
      select 1
      from public.result_shares s
      where s.result_id      = results.id
        and s.shared_with_id = (select auth.uid())
    )
  );

-- results: INSERT – nur mit sich selbst als Owner
drop policy if exists results_insert_own on public.results;
create policy results_insert_own
  on public.results
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

-- results: kein UPDATE / DELETE (bewusst, siehe Anforderungen §3)

-- result_shares: SELECT – beide Seiten des Shares
drop policy if exists result_shares_select_party on public.result_shares;
create policy result_shares_select_party
  on public.result_shares
  for select
  to authenticated
  using (
    shared_by_id   = (select auth.uid())
    or shared_with_id = (select auth.uid())
  );

-- result_shares: INSERT – nur der Owner des Ergebnisses, und nur in seinem Namen.
-- Die Owner-Prüfung läuft als Subquery in WITH CHECK, nicht in der App.
--
-- Warum eine Funktion statt einer direkten Subquery auf results?
-- Die SELECT-Policy von results fragt result_shares ab; würde diese Policy
-- direkt results abfragen, meldet Postgres "infinite recursion detected in
-- policy" (es prüft Zyklen zwischen Tabellen, nicht ob sie terminieren).
-- is_result_owner() ist security definer und liest results daher ohne RLS –
-- gibt aber nur ein boolean für die eigene auth.uid() zurück, nichts weiter.
create or replace function public.is_result_owner(p_result_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.results r
    where r.id       = p_result_id
      and r.owner_id = auth.uid()
  );
$$;

revoke execute on function public.is_result_owner(uuid) from public, anon;
grant  execute on function public.is_result_owner(uuid) to authenticated;

drop policy if exists result_shares_insert_owner_only on public.result_shares;
create policy result_shares_insert_owner_only
  on public.result_shares
  for insert
  to authenticated
  with check (
    shared_by_id = (select auth.uid())
    and public.is_result_owner(result_id)
  );

-- result_shares: kein UPDATE / DELETE (bewusst; "Share zurückziehen" später owner-only)

-- ---------------------------------------------------------------------------
-- Kollegenliste für den "Teilen"-Dialog
-- ---------------------------------------------------------------------------
-- auth.users ist über die API nicht lesbar. Diese Funktion gibt nur id, E-Mail
-- und Anzeigename aller User zurück – ausschließlich für eingeloggte User.

create or replace function public.portal_users()
returns table (
  id           uuid,
  email        text,
  display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    u.email::text,
    coalesce(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name',
      split_part(u.email, '@', 1)
    ) as display_name
  from auth.users u
  where auth.uid() is not null        -- ohne Session: leere Liste
    and u.deleted_at is null
    and u.email is not null
  order by display_name;
$$;

revoke execute on function public.portal_users() from public, anon;
grant  execute on function public.portal_users() to authenticated;

commit;
