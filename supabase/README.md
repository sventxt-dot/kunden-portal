# Supabase – Migrationen & Tests

## Anwenden (self-hosted, kein Supabase-CLI nötig)

Die DB ist nur vom Hetzner-Server aus erreichbar. Per SSH-Tunnel:

```bash
ssh -L 54322:127.0.0.1:5432 $SSH_USER@$SSH_HOST
```

Dann lokal (Werte aus `infra/secrets/.env`):

```bash
psql "postgresql://postgres:<DB-Passwort>@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 -f migrations/0001_results_and_shares.sql
```

Alternativ direkt im Postgres-Container auf dem Server:

```bash
docker exec -i <supabase-db-container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < migrations/0001_results_and_shares.sql
```

## Testen

```bash
psql "<gleiche URL>" -v ON_ERROR_STOP=1 -f tests/rls_test.sql
```

Der Test legt drei User in `auth.users` an, spielt alle Policies als Alice/Bob/Carol/anon
durch und endet mit `ROLLBACK`. Bei Erfolg endet die Ausgabe mit
`=== ALLE RLS-TESTS BESTANDEN ===`, sonst mit einer `FAIL:`-Meldung.

## Konventionen

- Dateien nummeriert `NNNN_beschreibung.sql`, nie nachträglich ändern – neue Migration anlegen.
- Jede Migration in `begin; … commit;`, idempotent (`if not exists`, `drop policy if exists`).
- Keine Änderungen über Studio/Dashboard, alles hier im Repo.
