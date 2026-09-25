// Integrationstest des Servers gegen gemockte Supabase-(PostgREST-) und Flowise-Endpunkte.
// Prüft: JWT-Verifikation, Proxy-Aufruf mit serverseitigem API-Key, results-Schreiben im
// Namen des Users (RLS-Semantik nachgebildet), Read-only für Empfänger, Fehlerfälle.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'test-jwt-secret-1234567890';
const ANON = 'anon-key-test';
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const tokenFor = (sub, extra = {}) => jwt.sign({ sub, email: `${sub.slice(0, 5)}@test.local`, role: 'authenticated', aud: 'authenticated', ...extra }, SECRET, { expiresIn: '1h' });

// ---------- Mock: Supabase PostgREST ----------
const db = { results: [], result_shares: [] };
const seen = { rest: [], flowise: [] };
function userFrom(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { return jwt.verify(t, SECRET).sub; } catch { return null; }
}
const visible = (row, uid) => row.owner_id === uid || db.result_shares.some((s) => s.result_id === row.id && s.shared_with_id === uid);
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b ? JSON.parse(b) : null)); });
function send(res, status, data, single) {
  if (single && Array.isArray(data)) {
    if (data.length !== 1) return send(res, 406, { message: 'JSON object requested, multiple (or no) rows returned' });
    data = data[0];
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
const restMock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  seen.rest.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
  assert.equal(req.headers.apikey, ANON, 'PostgREST muss mit anon key aufgerufen werden');
  const uid = userFrom(req);
  if (!uid) return send(res, 401, { message: 'JWT invalid' });
  const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
  const idEq = (url.searchParams.get('id') || '').replace(/^eq\./, '');
  if (url.pathname === '/rest/v1/results') {
    let rows = db.results.filter((r) => visible(r, uid));
    if (idEq) rows = rows.filter((r) => r.id === idEq);
    if (req.method === 'GET') return send(res, 200, rows, single);
    if (req.method === 'POST') {
      if (body.owner_id !== uid) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
      const row = { id: randomUUID(), created_at: new Date().toISOString(), title: null, input_summary: null, output_data: null, ...body };
      db.results.push(row);
      return send(res, 201, [row], single);
    }
    if (req.method === 'PATCH') {
      const own = rows.filter((r) => r.owner_id === uid);
      own.forEach((r) => Object.assign(r, body));
      return send(res, 200, own, single);
    }
    if (req.method === 'DELETE') {
      const own = rows.filter((r) => r.owner_id === uid);
      db.results = db.results.filter((r) => !own.includes(r));
      return send(res, 200, own.map((r) => ({ id: r.id })), single);
    }
  }
  return send(res, 404, { message: 'not mocked: ' + req.method + ' ' + url.pathname });
});

// ---------- Mock: Flowise ----------
let flowiseMode = 'ok';
const flowiseMock = http.createServer(async (req, res) => {
  const body = await readBody(req);
  seen.flowise.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
  if (req.method === 'DELETE') { res.writeHead(200); return res.end('{}'); }
  if (flowiseMode === 'fail') { res.writeHead(500); return res.end('boom'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  const extra = /followups/.test(body.question) ? { followUpPrompts: JSON.stringify(['Option A?', 'Option B?']) } : {};
  let text = 'Antwort auf: ' + body.question;
  if (/quickblock/.test(body.question)) {
    text += '\n\n## ❓ 2 offene Punkte\n1. 14er Schale – welche Variante?\n2. Servietten – welche Farbe?\n\n```quickreplies\n'
      + JSON.stringify([{ question: '14er Schale – welche Variante?', options: ['khaki (Row 22)', 'mint (Row 23)', 'schwarz (Row 24)'] }, { question: 'Servietten – welche Farbe?', options: ['grau (Row 78)', 'schwarz (Row 79)'] }, { question: 'kaputt', options: ['nur eine'] }])
      + '\n```';
  }
  if (/summarytest/.test(body.question)) {
    text = '## 🔍 Validierung\n\n### ❓ 1 offene Punkte\n1. [A] **Bier – Aufteilung?**\n\n### ✅ 1 Artikel klar zugeordnet\n1. Biertulpe → GBP Row 53 | 220 | ok\n\n## 📋 Kurzfassung\n\nValidierung fertig – 1 Frage unten per Klick.\n✅ 1 Artikel eindeutig zugeordnet.\n\n```quickreplies\n[{"question":"Bier – Aufteilung?","options":["70/30 → 129 + 55","andere Aufteilung (Freitext)"]}]\n```';
  }
  if (/guardtest/.test(body.question)) {
    text = '## 🔍 Validierung\n\n### ❓ 1 offene Punkte\n\n1. [A] **Bier – Aufteilung?** Row 69 / 71\n\n### ⚠️ 0 Annahmen\n\n🔁 V1/V2/V3-Check: 0\n\n### ✅ 3 Artikel klar zugeordnet\n\n'
      + '1. Biertulpe → GBP Row 53 | 220 | 1,0 × 220\n2. Radeberger Flasche → Getränke Row 69 | nach Klärung ❓1 | Bier\n3. Kellnermesser → Bar-I Row 7 | 1 | Wein\n\n```quickreplies\n[{"question":"Bier – Aufteilung?","options":["70/30 → 129 + 55","andere Aufteilung (Freitext)"]}]\n```';
  }
  res.end(JSON.stringify({ text, chatMessageId: 'cm1', chatId: body.chatId, ...extra }));
});

let base;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  const restPort = await listen(restMock);
  const flowPort = await listen(flowiseMock);
  Object.assign(process.env, {
    PORT: '0',
    SUPABASE_URL: `http://127.0.0.1:${restPort}`,
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_JWT_SECRET: SECRET,
    FLOWISE_BASE_URL: `http://127.0.0.1:${flowPort}/api/v1/prediction/`, // absichtlich mit Suffix
    FLOWISE_CHATFLOW_KUECHE: 'cf-kueche',
    FLOWISE_CHATFLOW_OPERATIV: 'cf-operativ',
    FLOWISE_API_KEY_KUECHE: 'key-kueche',
    FLOWISE_API_KEY_OPERATIV: 'key-operativ',
  });
  const mod = await import('../server/index.js');
  base = mod.baseUrl;
});
after(async () => { restMock.close(); flowiseMock.close(); (await import('../server/index.js')).server.close(); });

const api = (path, { token, method = 'GET', body, legacy = false } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(legacy ? {} : { 'x-portal-client': 'test' }), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, text: await r.text() }))
    .then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }));

test('healthz und config.js ohne Geheimnisse', async () => {
  assert.equal((await api('/healthz')).status, 200);
  const c = await api('/config.js');
  assert.equal(c.status, 200);
  assert.match(c.text, /supabaseAnonKey/);
  assert.doesNotMatch(c.text, /cf-kueche|cf-operativ|key-kueche|key-operativ|127\.0\.0\.1:\d+\/api/);
});

test('Version: Header auf jeder Antwort, versionierte Asset-Pfade in index.html, keine Caches für index', async () => {
  const r = await fetch(base + '/healthz'); const v = r.headers.get('x-portal-version');
  assert.ok(v && v.length >= 4);
  assert.equal((await r.json()).version, v);
  const idx = await fetch(base + '/'); const html = await idx.text();
  assert.match(html, new RegExp(`src="js/app\\.js\\?v=${v}"`));
  assert.match(html, new RegExp(`href="css/style\\.css\\?v=${v}"`));
  assert.equal(idx.headers.get('cache-control'), 'no-cache');
  const js = await fetch(base + '/js/app.js?v=' + v);
  assert.match(js.headers.get('cache-control'), /max-age=31536000/);
  const cfg = await (await fetch(base + '/config.js')).text();
  assert.match(cfg, new RegExp(`"version":"${v}"`));
});

test('Kurzfassung (operativ) wird als summary geliefert und gespeichert; Volltext bleibt content', async () => {
  const r = await api('/api/flow/operativ', { method: 'POST', body: { question: 'summarytest' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.summary, 'Validierung fertig – 1 Frage unten per Klick.\n✅ 1 Artikel eindeutig zugeordnet.');
  assert.match(r.json.answer, /### ✅ 1 Artikel klar zugeordnet/);
  assert.match(r.json.answer, /## 📋 Kurzfassung/);
  assert.doesNotMatch(r.json.answer, /quickreplies/);
  const last = r.json.result.output_data.messages.at(-1);
  assert.equal(last.summary, r.json.summary);
  assert.match(last.content, /### ❓ 1 offene Punkte/);
  const k = await api('/api/flow/kueche', { method: 'POST', body: { question: 'summarytest' }, token: tokenFor(ALICE) });
  assert.equal(k.json.summary, null);
  seen.flowise.length = 0; seen.rest.length = 0;
});

test('API ohne / mit ungültigem Token → 401', async () => {
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x' } })).status, 401);
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x' }, token: 'kaputt' })).status, 401);
  const wrongSecret = jwt.sign({ sub: ALICE, aud: 'authenticated' }, 'anderes-secret');
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x' }, token: wrongSecret })).status, 401);
  const wrongAud = jwt.sign({ sub: ALICE, aud: 'anon' }, SECRET);
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x' }, token: wrongAud })).status, 401);
  const expired = jwt.sign({ sub: ALICE, aud: 'authenticated' }, SECRET, { expiresIn: -10 });
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x' }, token: expired })).status, 401);
  assert.equal(seen.flowise.length, 0, 'Flowise darf ohne gültige Session nie aufgerufen werden');
});

test('Validierung: unbekannter Flow, leere Nachricht, kaputte resultId', async () => {
  const t = tokenFor(ALICE);
  assert.equal((await api('/api/flow/sonstwas', { method: 'POST', body: { question: 'x' }, token: t })).status, 404);
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: {}, token: t })).status, 400);
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x', resultId: 'nope' }, token: t })).status, 400);
  assert.equal((await api('/api/flow/kueche', { method: 'POST', body: { question: 'x', upload: { text: 1 } }, token: t })).status, 400);
  assert.equal(seen.flowise.length, 0);
});

let aliceResult;
test('Neuer Chat: Proxy nutzt API-Key, schreibt results im Namen des Users', async () => {
  seen.rest.length = 0; seen.flowise.length = 0;
  const r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'Was koche ich heute?' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.answer, 'Antwort auf: Was koche ich heute?');
  aliceResult = r.json.result;
  assert.equal(aliceResult.owner_id, ALICE);
  assert.equal(aliceResult.flow_type, 'kueche');
  assert.equal(aliceResult.title, 'Was koche ich heute?');
  assert.equal(aliceResult.output_data.messages.length, 2);
  assert.equal(aliceResult.output_data.messages[0].role, 'user');
  assert.equal(aliceResult.output_data.messages[1].content, r.json.answer);
  // Flowise-Aufruf
  assert.equal(seen.flowise.length, 1);
  assert.equal(seen.flowise[0].url, '/api/v1/prediction/cf-kueche');
  assert.equal(seen.flowise[0].auth, 'Bearer key-kueche');
  assert.equal(seen.flowise[0].body.chatId, aliceResult.output_data.chat_id);
  assert.equal(seen.flowise[0].body.uploads, undefined);
  // Supabase-Aufruf: anon key + User-JWT, owner_id = sub
  const ins = seen.rest.find((x) => x.method === 'POST');
  assert.ok(ins, 'INSERT auf results erwartet');
  assert.equal(ins.body.owner_id, ALICE);
  assert.equal(jwt.verify(ins.headers.authorization.replace('Bearer ', ''), SECRET).sub, ALICE);
});

test('PDF-Upload wird als file:full an Flowise gereicht', async () => {
  seen.flowise.length = 0;
  const upload = { name: 'event.pdf', size: 1234, pages: 2, text: 'Hochzeit 120 Personen' };
  const r = await api('/api/flow/operativ', { method: 'POST', body: { question: '', upload }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.equal(seen.flowise[0].url, '/api/v1/prediction/cf-operativ');
  assert.equal(seen.flowise[0].auth, 'Bearer key-operativ');
  assert.deepEqual(seen.flowise[0].body.uploads, [{ data: 'Hochzeit 120 Personen', mime: 'application/pdf', name: 'event.pdf', type: 'file:full' }]);
  assert.equal(seen.flowise[0].body.question, 'Bitte analysiere das angehängte PDF.');
  assert.equal(r.json.result.title, 'event.pdf');
  assert.equal(r.json.result.input_summary, 'PDF: event.pdf');
  assert.deepEqual(r.json.result.output_data.messages[0].attachment, { name: 'event.pdf', size: 1234, pages: 2 });
});

test('```quickreplies-Block wird extrahiert, aus dem Text entfernt und strukturiert gespeichert', async () => {
  const r = await api('/api/flow/operativ', { method: 'POST', body: { question: 'quickblock bitte' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.doesNotMatch(r.json.answer, /quickreplies|```/);
  assert.match(r.json.answer, /❓ 2 offene Punkte/);
  assert.deepEqual(r.json.quickReplies, [
    { question: '14er Schale – welche Variante?', options: ['khaki (Row 22)', 'mint (Row 23)', 'schwarz (Row 24)'] },
    { question: 'Servietten – welche Farbe?', options: ['grau (Row 78)', 'schwarz (Row 79)'] },
  ]);
  const last = r.json.result.output_data.messages.at(-1);
  assert.deepEqual(last.quick_replies, r.json.quickReplies);
  assert.doesNotMatch(last.content, /quickreplies/);
});

test('Sicherheitsnetz (operativ): ✅-Zeile mit offener Menge wird nach ❓ verschoben, Folgerunde trägt Hinweis an Flowise', async () => {
  seen.flowise.length = 0;
  const r = await api('/api/flow/operativ', { method: 'POST', body: { question: 'guardtest bitte' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.answer, /### ✅ 2 Artikel klar zugeordnet/);
  assert.match(r.json.answer, /### ❓ 2 offene Punkte/);
  assert.match(r.json.answer, /2\. \[D\] \*\*Radeberger Flasche – Menge\/Row offen\?\*\*/);
  assert.match(r.json.answer, /🛡️ \*\*Sicherheitsnetz \(Portal\):\*\* 1 Zeile aus ✅ nach ❓ verschoben.*Radeberger Flasche/);
  const okBlock = r.json.answer.split('### ✅')[1];
  assert.doesNotMatch(okBlock, /Radeberger/);
  assert.match(okBlock, /1\. Biertulpe[\s\S]*2\. Kellnermesser/);
  assert.deepEqual(r.json.safetyNet.moved, [{ article: 'Radeberger Flasche', reasons: ['offene Formulierung'] }]);
  assert.deepEqual(r.json.quickReplies, [{ question: 'Bier – Aufteilung?', options: ['70/30 → 129 + 55', 'andere Aufteilung (Freitext)'] }]);
  const last = r.json.result.output_data.messages.at(-1);
  assert.equal(last.safety_net.moved[0].article, 'Radeberger Flasche');
  assert.doesNotMatch(last.content.split('### ✅')[1], /nach Klärung ❓1/);
  // Folgerunde: Hinweis wird der Frage an Flowise vorangestellt, nicht der gespeicherten Nutzernachricht
  const r2 = await api('/api/flow/operativ', { method: 'POST', body: { question: 'Bier – Aufteilung? → 70/30 → 129 + 55', resultId: r.json.resultId }, token: tokenFor(ALICE) });
  assert.equal(r2.status, 200, r2.text);
  const sentQuestion = seen.flowise.at(-1).body.question;
  assert.match(sentQuestion, /^\[Hinweis Portal-Sicherheitsnetz: In der letzten Validierung wurden 1 Artikel aus ✅ nach ❓ verschoben.*Radeberger Flasche.*\]\n\nBier – Aufteilung\? → 70\/30 → 129 \+ 55$/s);
  const userMsg = r2.json.result.output_data.messages.at(-2);
  assert.equal(userMsg.content, 'Bier – Aufteilung? → 70/30 → 129 + 55');
  // Küche-Flow bleibt unberührt (kein Netz, kein Hinweis)
  const k = await api('/api/flow/kueche', { method: 'POST', body: { question: 'guardtest kueche' }, token: tokenFor(ALICE) });
  assert.equal(k.json.safetyNet, null);
  assert.match(k.json.answer, /nach Klärung ❓1/);
});

test('Legacy-Client ohne X-Portal-Client: Hinweis statt Strukturdaten, Speicherung unverändert', async () => {
  const r = await api('/api/flow/operativ', { method: 'POST', body: { question: 'summarytest' }, token: tokenFor(ALICE), legacy: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.legacyClient, true);
  assert.equal(r.json.quickReplies, null); assert.equal(r.json.summary, null);
  assert.match(r.json.answer, /^⚠️ \*\*Bitte die Portal-Seite einmal neu laden/);
  assert.ok(!('quick_replies' in r.json.result.output_data.messages.at(-1)), 'keine Objekte an alten Client');
  assert.ok(!('summary' in r.json.result.output_data.messages.at(-1)));
  // in der DB (Mock) liegen die Strukturdaten trotzdem
  assert.deepEqual(db.results.at(-1).output_data.messages.at(-1).quick_replies, [{ question: 'Bier – Aufteilung?', options: ['70/30 → 129 + 55', 'andere Aufteilung (Freitext)'] }]);
  seen.flowise.length = 0; seen.rest.length = 0;
});

test('Flowise followUpPrompts werden als quick_replies gespeichert und zurückgegeben', async () => {
  const r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'bitte followups' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.quickReplies, [{ question: '', options: ['Option A?', 'Option B?'] }]);
  assert.deepEqual(r.json.result.output_data.messages.at(-1).quick_replies, [{ question: '', options: ['Option A?', 'Option B?'] }]);
  const plain = await api('/api/flow/kueche', { method: 'POST', body: { question: 'ohne' }, token: tokenFor(ALICE) });
  assert.equal(plain.json.quickReplies, null);
  assert.equal(plain.json.result.output_data.messages.at(-1).quick_replies, undefined);
});

test('Folgefrage im eigenen Chat hängt Nachrichten an (UPDATE), gleiche chatId', async () => {
  seen.rest.length = 0; seen.flowise.length = 0;
  const r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'Und morgen?', resultId: aliceResult.id }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.resultId, aliceResult.id);
  assert.equal(r.json.result.output_data.messages.length, 4);
  assert.equal(seen.flowise[0].body.chatId, aliceResult.output_data.chat_id);
  assert.ok(seen.rest.some((x) => x.method === 'PATCH'), 'UPDATE erwartet');
  assert.ok(!seen.rest.some((x) => x.method === 'POST'), 'kein zweites INSERT');
});

test('Empfänger eines Shares: 403, kein Flowise-Aufruf; Fremde: 404', async () => {
  seen.flowise.length = 0;
  // Bob sieht nichts → 404
  let r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'hi', resultId: aliceResult.id }, token: tokenFor(BOB) });
  assert.equal(r.status, 404);
  // Alice teilt mit Bob → Bob sieht es, darf aber nicht weiterfragen
  db.result_shares.push({ result_id: aliceResult.id, shared_with_id: BOB, shared_by_id: ALICE });
  r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'hi', resultId: aliceResult.id }, token: tokenFor(BOB) });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /schreibgeschützt/);
  assert.equal(seen.flowise.length, 0);
  // Falscher Flow-Typ für vorhandenes Ergebnis
  r = await api('/api/flow/operativ', { method: 'POST', body: { question: 'hi', resultId: aliceResult.id }, token: tokenFor(ALICE) });
  assert.equal(r.status, 400);
});

test('Flowise-Fehler → 502, nichts wird gespeichert', async () => {
  flowiseMode = 'fail';
  seen.rest.length = 0;
  const before = db.results.length;
  const r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'kaputt?' }, token: tokenFor(ALICE) });
  flowiseMode = 'ok';
  assert.equal(r.status, 502);
  assert.equal(db.results.length, before);
  assert.ok(!seen.rest.some((x) => x.method === 'POST'));
});

test('Löschen: nur Owner, Flowise-Verlauf wird mitgelöscht', async () => {
  seen.flowise.length = 0;
  let r = await api('/api/results/' + aliceResult.id, { method: 'DELETE', token: tokenFor(BOB) });
  assert.equal(r.status, 403);
  r = await api('/api/results/' + aliceResult.id, { method: 'DELETE', token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.ok(!db.results.some((x) => x.id === aliceResult.id));
  const del = seen.flowise.find((x) => x.method === 'DELETE');
  assert.ok(del, 'Flowise chatmessage DELETE erwartet');
  assert.match(del.url, new RegExp('/api/v1/chatmessage/cf-kueche\\?chatId=' + aliceResult.output_data.chat_id));
  assert.equal(del.auth, 'Bearer key-kueche');
  r = await api('/api/results/' + aliceResult.id, { method: 'DELETE', token: tokenFor(ALICE) });
  assert.equal(r.status, 404);
});
