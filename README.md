# Messerich Catering – Assistenten-Portal

Mehrbenutzer-Portal für die beiden Flowise-Assistenten „Küche“ und „Operativer Assistent“.
Login über Supabase Auth, Ergebnisse werden pro User gespeichert und können mit Kolleg(inn)en geteilt werden.
Die Flowise-Chatflows werden ausschließlich serverseitig aufgerufen; API-Keys und Chatflow-IDs
erreichen nie den Browser.

```
server/            Node/Express
  index.js         Static Files, /config.js, /api/* (JWT-geschützt), Fehler-Handler
  lib/config.js    Env → Config; publicConfig() = das Einzige, was der Browser sieht
  lib/auth.js      Supabase-JWT prüfen (HS256, JWT_SECRET der Instanz)
  lib/supabase.js  supabase-js im Namen des Users (anon key + User-JWT → RLS greift)
  lib/flowise.js   Prediction-Aufruf mit serverseitigem API-Key, Chat löschen
  routes/flow.js   POST /api/flow/:type – Flow ausführen, results-Zeile INSERT/UPDATE
  routes/results.js DELETE /api/results/:id – Owner löscht (inkl. Flowise-Verlauf)
public/            Frontend (Vanilla JS, supabase-js, pdf.js, marked)
  js/app.js        Login, Assistenten, Chat, Verlauf, Teilen
supabase/          Migrationen + RLS-Tests (siehe supabase/README.md)
test/              Integrationstests gegen gemockte Supabase/Flowise-Endpunkte (`npm test`)
```

## Datenfluss

1. Browser meldet sich bei Supabase Auth an (E-Mail + Passwort, kein Self-Signup).
2. Chat-Nachricht → `POST /api/flow/kueche|operativ` mit Session-JWT.
3. Server prüft JWT, ruft Flowise mit dem API-Key des Chatflows auf, schreibt die
   `results`-Zeile **mit dem JWT des Users** (RLS: `owner_id = auth.uid()`).
4. Verlauf und Teilen: Browser liest `results` / `result_shares` direkt über Supabase,
   RLS liefert nur Eigenes + mit mir Geteiltes. Teilen = INSERT in `result_shares`
   (RLS prüft, dass ich Owner bin). Empfänger sehen den Chat, können ihn aber nicht
   fortsetzen (`/api/flow` antwortet 403, Eingabefeld ist ausgeblendet).

Ein Ergebnis = ein Chat. Folgefragen des Owners hängen Nachrichten an `output_data.messages`
an (RLS: owner-only UPDATE, Migration 0002).

## Environment (Coolify)

Siehe `.env.example`. Pflicht: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`,
`FLOWISE_BASE_URL`, `FLOWISE_CHATFLOW_KUECHE`, `FLOWISE_CHATFLOW_OPERATIV`.
Empfohlen: `FLOWISE_API_KEY_KUECHE`, `FLOWISE_API_KEY_OPERATIV`. Der `service_role`-Key wird nicht benötigt.

## Lokal

```bash
npm install
npm test                                   # Mock-Tests, kein Netz nötig
node --env-file=<pfad-zu>/dev.env server/index.js   # gegen echte Supabase/Flowise
```

Benutzer anlegen: Supabase Studio → Authentication → Users → „Invite user“ / „Add user“.
Anzeigename optional in `user_metadata.full_name`.
