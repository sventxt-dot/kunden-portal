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
  res.end(JSON.stringify({ text: 'Antwort auf: ' + body.question, chatMessageId: 'cm1', chatId: body.chatId, ...extra }));
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

const api = (path, { token, method = 'GET', body } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, text: await r.text() }))
    .then((r) => ({ ...r, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }));

test('healthz und config.js ohne Geheimnisse', async () => {
  assert.equal((await api('/healthz')).status, 200);
  const c = await api('/config.js');
  assert.equal(c.status, 200);
  assert.match(c.text, /supabaseAnonKey/);
  assert.doesNotMatch(c.text, /cf-kueche|cf-operativ|key-kueche|key-operativ|127\.0\.0\.1:\d+\/api/);
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

test('Flowise followUpPrompts werden als quick_replies gespeichert und zurückgegeben', async () => {
  const r = await api('/api/flow/kueche', { method: 'POST', body: { question: 'bitte followups' }, token: tokenFor(ALICE) });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.quickReplies, ['Option A?', 'Option B?']);
  assert.deepEqual(r.json.result.output_data.messages.at(-1).quick_replies, ['Option A?', 'Option B?']);
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
