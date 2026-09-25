-- rls_test.sql
-- Prüft die Policies aus 0001_results_and_shares.sql und 0002_results_owner_update_delete.sql
-- als drei simulierte User.
-- Läuft komplett in einer Transaktion und endet mit ROLLBACK – hinterlässt nichts.
--
-- Ausführen als Superuser/postgres, z.B.:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/rls_test.sql
-- Jede Prüfung meldet "PASS: ..." als NOTICE. Schlägt eine fehl, bricht das
-- Skript mit "FAIL: ..." ab.

\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages to notice;

begin;

-- ---------------------------------------------------------------------------
-- Testuser direkt in auth.users (nur innerhalb dieser Transaktion)
-- ---------------------------------------------------------------------------
insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-alice@test.local', '', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Alice Test"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-bob@test.local', '', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{"full_name":"Bob Test"}'),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rls-carol@test.local', '', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}');

-- Helfer: Session eines Users simulieren (wirkt bis zum nächsten Aufruf / reset)
create or replace function pg_temp.become(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.become_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

-- Helfer: Zählung prüfen
create or replace function pg_temp.expect_count(label text, actual bigint, expected bigint)
returns void language plpgsql as $$
begin
  if actual = expected then
    raise notice 'PASS: % (%)', label, actual;
  else
    raise exception 'FAIL: % – erwartet %, bekommen %', label, expected, actual;
  end if;
end $$;

-- ===========================================================================
-- 1. Alice legt ein Ergebnis an
-- ===========================================================================
select pg_temp.become('aaaaaaaa-0000-0000-0000-000000000001');

insert into public.results (id, owner_id, flow_type, title, output_data)
values ('11111111-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000001', 'kueche', 'Alices Menü', '{"ok":true}');
do $$ begin raise notice 'PASS: Alice kann eigenes Ergebnis anlegen'; end $$;

-- 1b. Alice darf kein Ergebnis für Bob anlegen
do $$
begin
  insert into public.results (owner_id, flow_type)
  values ('bbbbbbbb-0000-0000-0000-000000000002', 'kueche');
  raise exception 'FAIL: Alice konnte Ergebnis mit owner_id=Bob anlegen';
exception when insufficient_privilege then
  raise notice 'PASS: INSERT mit fremdem owner_id wird abgelehnt';
end $$;

-- 1c. Ungültiger flow_type scheitert am CHECK
do $$
begin
  insert into public.results (owner_id, flow_type)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'sonstiges');
  raise exception 'FAIL: ungültiger flow_type wurde akzeptiert';
exception when check_violation then
  raise notice 'PASS: flow_type CHECK greift';
end $$;

-- ===========================================================================
-- 2. Bob sieht vor dem Share nichts
-- ===========================================================================
select pg_temp.become('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.expect_count('Bob sieht vor Share keine results', (select count(*) from public.results), 0);
select pg_temp.expect_count('Bob sieht vor Share keine result_shares', (select count(*) from public.result_shares), 0);

-- 2b. Bob darf Alices Ergebnis nicht an Carol teilen (nicht Owner)
do $$
begin
  insert into public.result_shares (result_id, shared_with_id, shared_by_id)
  values ('11111111-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-000000000003',
          'bbbbbbbb-0000-0000-0000-000000000002');
  raise exception 'FAIL: Bob konnte fremdes Ergebnis teilen';
exception when insufficient_privilege then
  raise notice 'PASS: Nicht-Owner kann nicht teilen';
end $$;

-- ===========================================================================
-- 3. Alice teilt mit Bob
-- ===========================================================================
select pg_temp.become('aaaaaaaa-0000-0000-0000-000000000001');

-- 3a. shared_by_id muss der eigene sein
do $$
begin
  insert into public.result_shares (result_id, shared_with_id, shared_by_id)
  values ('11111111-0000-0000-0000-000000000001',
          'bbbbbbbb-0000-0000-0000-000000000002',
          'cccccccc-0000-0000-0000-000000000003');
  raise exception 'FAIL: Share mit fremdem shared_by_id akzeptiert';
exception when insufficient_privilege then
  raise notice 'PASS: shared_by_id muss auth.uid() sein';
end $$;

-- 3b. Mit sich selbst teilen scheitert am CHECK
do $$
begin
  insert into public.result_shares (result_id, shared_with_id, shared_by_id)
  values ('11111111-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001',
          'aaaaaaaa-0000-0000-0000-000000000001');
  raise exception 'FAIL: Share mit sich selbst akzeptiert';
exception when check_violation then
  raise notice 'PASS: Share mit sich selbst wird abgelehnt';
end $$;

-- 3c. Der eigentliche Share
insert into public.result_shares (result_id, shared_with_id, shared_by_id)
values ('11111111-0000-0000-0000-000000000001',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin raise notice 'PASS: Owner kann teilen'; end $$;

select pg_temp.expect_count('Alice sieht ihren Share', (select count(*) from public.result_shares), 1);
select pg_temp.expect_count('Alice sieht ihr Ergebnis', (select count(*) from public.results), 1);

-- ===========================================================================
-- 4. Bob sieht das geteilte Ergebnis, Carol nicht
-- ===========================================================================
select pg_temp.become('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.expect_count('Bob sieht geteiltes Ergebnis', (select count(*) from public.results), 1);
select pg_temp.expect_count('Bob sieht den Share', (select count(*) from public.result_shares), 1);

-- 4b. Bob darf das geteilte Ergebnis nicht weiterteilen
do $$
begin
  insert into public.result_shares (result_id, shared_with_id, shared_by_id)
  values ('11111111-0000-0000-0000-000000000001',
          'cccccccc-0000-0000-0000-000000000003',
          'bbbbbbbb-0000-0000-0000-000000000002');
  raise exception 'FAIL: Empfänger konnte weiterteilen';
exception when insufficient_privilege then
  raise notice 'PASS: Empfänger kann nicht weiterteilen';
end $$;

-- 4c. UPDATE / DELETE (Migration 0002): Empfänger Bob darf nichts ändern oder löschen
do $$
declare n int;
begin
  update public.results set title = 'von Bob geändert' where id = '11111111-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n = 0 then raise notice 'PASS: Empfänger kann geteiltes Ergebnis nicht ändern';
  else raise exception 'FAIL: Empfänger-UPDATE hat % Zeile(n) geändert', n; end if;
  delete from public.results where id = '11111111-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n = 0 then raise notice 'PASS: Empfänger kann geteiltes Ergebnis nicht löschen';
  else raise exception 'FAIL: Empfänger-DELETE hat % Zeile(n) gelöscht', n; end if;
end $$;

-- 4d. Owner Alice darf ändern, aber owner_id nicht an Bob übertragen
select pg_temp.become('aaaaaaaa-0000-0000-0000-000000000001');
do $$
declare n int;
begin
  update public.results set title = 'von Alice geändert',
    output_data = '{"messages":[{"role":"user","content":"hi"}]}'
    where id = '11111111-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'PASS: Owner kann eigenes Ergebnis ändern';
  else raise exception 'FAIL: Owner-UPDATE hat % Zeile(n) geändert', n; end if;
end $$;
do $$
begin
  update public.results set owner_id = 'bbbbbbbb-0000-0000-0000-000000000002'
    where id = '11111111-0000-0000-0000-000000000001';
  raise exception 'FAIL: Owner konnte owner_id übertragen';
exception when insufficient_privilege then
  raise notice 'PASS: owner_id kann nicht übertragen werden (WITH CHECK)';
end $$;

-- 4e. Owner darf ein zweites, ungeteiltes Ergebnis löschen
insert into public.results (id, owner_id, flow_type, title)
values ('11111111-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'operativ', 'Löschtest');
do $$
declare n int;
begin
  delete from public.results where id = '11111111-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n = 1 then raise notice 'PASS: Owner kann eigenes Ergebnis löschen';
  else raise exception 'FAIL: Owner-DELETE hat % Zeile(n) gelöscht', n; end if;
end $$;

select pg_temp.become('cccccccc-0000-0000-0000-000000000003');
select pg_temp.expect_count('Carol sieht keine results', (select count(*) from public.results), 0);
select pg_temp.expect_count('Carol sieht keine result_shares', (select count(*) from public.result_shares), 0);

-- ===========================================================================
-- 5. anon sieht nichts, portal_users() nur für eingeloggte
-- ===========================================================================
select pg_temp.become_anon();
select pg_temp.expect_count('anon sieht keine results', (select count(*) from public.results), 0);
select pg_temp.expect_count('anon sieht keine result_shares', (select count(*) from public.result_shares), 0);
do $$
begin
  perform public.portal_users();
  raise exception 'FAIL: anon konnte portal_users() aufrufen';
exception when insufficient_privilege then
  raise notice 'PASS: portal_users() für anon gesperrt';
end $$;

select pg_temp.become('cccccccc-0000-0000-0000-000000000003');
select pg_temp.expect_count('portal_users() liefert die 3 Testuser',
  (select count(*) from public.portal_users() where email like 'rls-%@test.local'), 3);
do $$
declare d text;
begin
  select display_name into d from public.portal_users() where email = 'rls-alice@test.local';
  if d = 'Alice Test' then raise notice 'PASS: display_name aus full_name';
  else raise exception 'FAIL: display_name = %', d; end if;
  select display_name into d from public.portal_users() where email = 'rls-carol@test.local';
  if d = 'rls-carol' then raise notice 'PASS: display_name Fallback auf E-Mail-Präfix';
  else raise exception 'FAIL: display_name Fallback = %', d; end if;
end $$;

-- ===========================================================================
-- 6. Cascade: Löscht postgres das Ergebnis, verschwindet der Share
-- ===========================================================================
reset role;
delete from public.results where id = '11111111-0000-0000-0000-000000000001';
select pg_temp.expect_count('ON DELETE CASCADE räumt Shares auf',
  (select count(*) from public.result_shares where result_id = '11111111-0000-0000-0000-000000000001'), 0);

do $$ begin raise notice '=== ALLE RLS-TESTS BESTANDEN ==='; end $$;

rollback;
