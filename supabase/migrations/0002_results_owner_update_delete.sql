-- 0002_results_owner_update_delete.sql
-- Owner-only UPDATE und DELETE auf results (in 0001 bewusst weggelassen, laut
-- Anforderung "owner-only if you add one later").
--
-- Warum jetzt: Ein Ergebnis ist ein Chat mit mehreren Runden. Der Server hängt
-- jede neue Antwort an output_data.messages an – dafür braucht der Owner UPDATE.
-- DELETE erlaubt dem Owner, eigene Chats aus der History zu entfernen
-- (Shares werden per ON DELETE CASCADE mitgelöscht).
-- Empfänger eines Shares bleiben read-only: keine der beiden Policies greift für sie.

begin;

drop policy if exists results_update_owner on public.results;
create policy results_update_owner
  on public.results
  for update
  to authenticated
  using      (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));   -- Owner darf owner_id nicht "verschenken"

drop policy if exists results_delete_owner on public.results;
create policy results_delete_owner
  on public.results
  for delete
  to authenticated
  using (owner_id = (select auth.uid()));

commit;
