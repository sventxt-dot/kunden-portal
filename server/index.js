import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, assertConfig, publicConfig } from './lib/config.js';
import { requireAuth } from './lib/auth.js';
import flowRouter from './routes/flow.js';
import resultsRouter from './routes/results.js';

assertConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

// Build-Version: Coolify setzt SOURCE_COMMIT; sonst Startzeit. Steuert Cache-Busting und
// erkennt veraltete Browser-Tabs (alte app.js gegen neuen Server → „[object Object]“-Bug).
export const VERSION = (process.env.SOURCE_COMMIT || '').slice(0, 12) || `dev-${Date.now().toString(36)}`;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // hinter Traefik/Coolify
app.use(express.json({ limit: '25mb' })); // extrahierter PDF-Text kann groß sein
app.use((_req, res, next) => { res.set('X-Portal-Version', VERSION); next(); });

app.get('/healthz', (_req, res) => res.json({ ok: true, version: VERSION }));

// Laufzeit-Konfiguration für den Browser: nur Supabase-URL, anon key, Flow-Anzeige, Version.
app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.PORTAL_CONFIG = ${JSON.stringify({ ...publicConfig(), version: VERSION })};`);
});

// index.html mit versionierten Asset-Pfaden ausliefern (js/app.js?v=…), niemals cachen.
const indexTemplate = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const indexHtml = indexTemplate.replace(/(href|src)="((?:css|js)\/[^"?]+)"/g, `$1="$2?v=${VERSION}"`);
const sendIndex = (_req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(indexHtml); };
app.get(['/', '/index.html'], sendIndex);

app.use('/api', requireAuth);
app.use('/api/flow', flowRouter);
app.use('/api/results', resultsRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unbekannter Endpunkt.' }));

app.use(express.static(publicDir, {
  index: false,
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // versionierte Assets dürfen lange gecacht werden; ohne ?v= kurz
    if (/\.(js|css)$/.test(filePath)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.get('*', sendIndex);

// Zentraler Fehler-Handler: Details nur ins Log, nie an den Client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Anfrage zu groß.' });
  console.error('[server]', status, err.message, err.detail || '');
  res.status(status).json({ error: status === 500 ? 'Interner Serverfehler.' : err.message });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] Messerich Portal läuft auf Port ${server.address().port}`);
  console.log(`[server] Supabase: ${config.supabaseUrl} · Flowise: ${config.flowiseBaseUrl}`);
});
// Flowise-Antworten (PDF-Analysen) können mehrere Minuten dauern.
server.requestTimeout = config.flowiseTimeoutMs + 30_000;
server.headersTimeout = config.flowiseTimeoutMs + 60_000;
server.keepAliveTimeout = 65_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log(`[server] ${sig} – fahre herunter`); server.close(() => process.exit(0)); });
}

export { server };

// Für Tests: tatsächliche Adresse (bei PORT=0 zufälliger Port)
export const baseUrl = await new Promise((resolve) => {
  if (server.listening) return resolve(`http://127.0.0.1:${server.address().port}`);
  server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
