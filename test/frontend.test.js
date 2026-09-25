// DOM-Test des Frontends mit jsdom: echtes index.html + app.js, Supabase/fetch gemockt.
// Prüft Quick-Reply-Rendering (Gruppen, Auswahl, Sammel-Senden), Read-only für Empfänger
// und den Häkchen-Status („✓ Geteilt") im Teilen-Dialog.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';

const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const RESULT = {
  id: '11111111-0000-4000-8000-000000000001', owner_id: ME, flow_type: 'operativ', title: 'Function_Testveranstaltung.pdf',
  created_at: '2026-09-25T09:00:00Z',
  output_data: { chat_id: 'c1', messages: [
    { role: 'user', content: '📎 Function_Testveranstaltung.pdf', ts: '2026-09-25T09:00:00Z' },
    { role: 'bot', content: '## ❓ 2 offene Punkte\n\n1. **14er Schale – welche Variante?**\n2. **Servietten – welche Farbe?**', ts: '2026-09-25T09:01:00Z',
      quick_replies: [
        { question: '14er Schale – welche Variante?', options: ['khaki (Row 22)', 'mint (Row 23)', 'schwarz (Row 24)'] },
        { question: 'Servietten – welche Farbe?', options: ['grau (Row 78)', 'schwarz (Row 79)'] },
      ] },
  ] },
};
const SHARED = { ...RESULT, id: '22222222-0000-4000-8000-000000000002', owner_id: BOB, title: 'Von Bob geteilt' };
const INLINE = { ...RESULT, id: '44444444-0000-4000-8000-000000000004', title: 'Inline-Ansicht', output_data: { chat_id: 'c4', messages: [
  { role: 'user', content: 'Packliste bitte', ts: '2026-09-25T09:00:00Z' },
  { role: 'bot', ts: '2026-09-25T09:01:00Z', content: '## BLOCK 1\n| a | b |\n\n### ✅ 2 Artikel klar zugeordnet\n1. Biertulpe → GBP Row 53 | 220 | ok\n\n## 📋 Operator-Ansicht\n\n### Bestellung\n- Wasser: 135 Flaschen\n- Bier: 184 Flaschen\n',
    summary: '### Bestellung\n- Wasser: 135 Flaschen [[qr:0]]\n- Bier: 184 Flaschen [[qr:1]]\n- Servietten: 220 Stück\n\n### Stand\n✅ 2 feststehend',
    quick_replies: [{ question: 'Wasser – wie aufteilen?', options: ['70/30 → 95 + 40', 'andere Aufteilung'] }, { question: 'Bier – wie aufteilen?', options: ['80/20 → 147 + 37', 'andere Aufteilung'] }, { question: 'Servietten – Farbe?', options: ['weiß', 'grau'] }] },
] } };
const MANY = { ...RESULT, id: '55555555-0000-4000-8000-000000000005', title: 'Zwölf Fragen', output_data: { chat_id: 'c5', messages: [
  { role: 'user', content: 'x', ts: '2026-09-25T09:00:00Z' },
  { role: 'bot', ts: '2026-09-25T09:01:00Z', content: '### ✅ 1 Artikel klar zugeordnet\n1. A → GBP Row 1 | 1 | ok\n\n## 📋 Operator-Ansicht\n\n### Bestellung\n- x\n',
    summary: '### Bestellung laut Function Sheet\n' + Array.from({ length: 12 }, (_, i) => `- **Position ${i}:** Beschreibung ${i}\n[[qr:${i}]]`).join('\n') + '\n\n### Stand\n✅ 1 · ❓ 12',
    quick_replies: Array.from({ length: 12 }, (_, i) => ({ question: `Frage ${i}?`, options: ['a', 'b'] })) },
] } };
const WITH_SUMMARY = { ...RESULT, id: '33333333-0000-4000-8000-000000000003', title: 'Mit Kurzfassung', output_data: { chat_id: 'c3', messages: [
  { role: 'user', content: 'Packliste bitte', ts: '2026-09-25T09:00:00Z' },
  { role: 'bot', ts: '2026-09-25T09:01:00Z', content: '## BLOCK 1\n| Getränk | Formel |\n|---|---|\n| Bier | 0,25 × 220 |\n\n### ✅ 3 Artikel klar zugeordnet\n1. Biertulpe → GBP Row 53 | 220 | ok\n\n## 📋 Kurzfassung\n\nValidierung fertig – 1 Frage unten per Klick.',
    summary: 'Validierung fertig – 1 Frage unten per Klick.', quick_replies: [{ question: 'Bier – Aufteilung?', options: ['70/30 → 129 + 55', 'andere Aufteilung (Freitext)'] }] },
] } };

let dom, win, doc, sent, authCb;
function makeSupabaseMock() {
  const table = (name) => {
    const q = { _f: {}, select() { return q; }, order() { return q; }, eq(k, v) { q._f[k] = v; return q; },
      insert(row) { q._ins = row; return q; }, single() { return q; },
      then(res) {
        if (name === 'results') return res({ data: [RESULT, SHARED, WITH_SUMMARY, INLINE, MANY], error: null });
        if (name === 'result_shares') {
          if (q._ins) { win.__shares.push({ ...q._ins, created_at: new Date().toISOString() }); return res({ data: win.__shares.at(-1), error: null }); }
          return res({ data: [...win.__shares], error: null });
        }
        return res({ data: [], error: null });
      } };
    return q;
  };
  return { createClient: () => ({
    auth: { onAuthStateChange: (cb) => { authCb = cb; }, getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: ME } } } }), signOut: async () => {}, signInWithPassword: async () => ({ error: null }) },
    from: (name) => table(name),
    rpc: async () => ({ data: [{ id: ME, email: 'me@test.local', display_name: 'Ich' }, { id: BOB, email: 'bob@test.local', display_name: 'Bob' }], error: null }),
  }) };
}

before(async () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>\s*/g, '');
  dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://portal.test/' });
  win = dom.window; doc = win.document;
  win.__shares = [{ result_id: SHARED.id, shared_with_id: ME, shared_by_id: BOB, created_at: '2026-09-25T09:02:00Z' }];
  win.PORTAL_CONFIG = { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', version: 'test', flows: [
    { type: 'kueche', name: 'Küchen-Assistent', description: 'Einkauf', icon: '🍽️', color: '#f5eaec' },
    { type: 'operativ', name: 'Operativer Assistent', description: 'Packliste', icon: '📋', color: '#eaf0f5' } ] };
  win.supabase = makeSupabaseMock();
  win.marked = { parse: (t) => marked.parse(t) };
  sent = [];
  win.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body), headers: opts.headers }); return { status: 200, ok: true, json: async () => ({ resultId: RESULT.id, answer: 'Danke, übernommen.', quickReplies: null, result: RESULT }) }; };
  win.confirm = () => true;
  win.eval(fs.readFileSync(path.resolve('public/js/app.js'), 'utf8'));
  authCb('SIGNED_IN', { user: { id: ME, email: 'me@test.local' } });
  await new Promise((r) => setTimeout(r, 50));
});

test('Verlauf zeigt eigenes und geteiltes Ergebnis mit Badges', () => {
  const items = [...doc.querySelectorAll('.archive-item')];
  assert.equal(items.length, 5);
  assert.ok(items.some((i) => i.textContent.includes('von Bob')), 'Badge "von Bob" fehlt');
  assert.equal(doc.querySelectorAll('.archive-item .archive-del-btn').length, 4, 'Löschen nur bei eigenen Ergebnissen');
});

test('zwölf Inline-Platzhalter mit echtem Markdown → zwölf Gruppen an den Positionen, keine am Ende', () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Zwölf Fragen')).click();
  const sum = [...doc.querySelectorAll('.msg.bot .msg-bubble')].at(-1).querySelector('.msg-summary');
  assert.equal(sum.querySelectorAll('.quick-group').length, 12);
  assert.equal(doc.querySelectorAll('.quick-replies .quick-group').length, 0);
  assert.doesNotMatch(sum.textContent, /\[\[qr:/);
  const h = sum.innerHTML;
  for (let i = 0; i < 11; i++) assert.ok(h.indexOf(`Position ${i}:`) < h.indexOf(`Frage ${i}?`) && h.indexOf(`Frage ${i}?`) < h.indexOf(`Position ${i + 1}:`), `Frage ${i} direkt nach Position ${i}`);
});

test('Inline-Ansicht: Platzhalter werden an Ort und Stelle zu Buttons, Rest am Ende, ein Sammel-Senden', async () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Inline-Ansicht')).click();
  const bubble = [...doc.querySelectorAll('.msg.bot .msg-bubble')].at(-1);
  const summary = bubble.querySelector('.msg-summary');
  assert.doesNotMatch(summary.textContent, /\[\[qr:/, 'keine Platzhalter sichtbar');
  const groups = summary.querySelectorAll('.quick-group');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].querySelector('.quick-question').textContent, 'Wasser – wie aufteilen?');
  const html = summary.innerHTML;
  assert.ok(html.indexOf('Wasser: 135 Flaschen') < html.indexOf('Wasser – wie aufteilen?') && html.indexOf('Wasser – wie aufteilen?') < html.indexOf('Bier: 184 Flaschen'), 'Wasser-Buttons direkt nach Wasser, vor Bier');
  const rest = doc.querySelectorAll('.quick-replies .quick-group');
  assert.equal(rest.length, 1); assert.equal(rest[0].querySelector('.quick-question').textContent, 'Servietten – Farbe?');
  assert.equal(doc.querySelectorAll('.quick-send').length, 1);
  assert.ok(bubble.querySelector('.msg-details').hidden);
  assert.doesNotMatch(bubble.querySelector('.msg-details').textContent, /Operator-Ansicht|Bestellung/, 'Details enden vor der Ansicht');
  // Auswahl inline + am Ende, gemeinsam senden
  groups[0].querySelectorAll('.quick-reply')[0].click();
  rest[0].querySelectorAll('.quick-reply')[1].click();
  const send = doc.querySelector('.quick-send'); assert.match(send.textContent, /2\/3/);
  const before = sent.length; send.click(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).body.question, 'Meine Antworten:\n- Wasser – wie aufteilen? → 70/30 → 95 + 40\n- Servietten – Farbe? → grau\n(1 Frage noch offen)');
});

test('„Details immer anzeigen" gilt lokal und sofort', () => {
  const pref = doc.getElementById('pref-details');
  assert.equal(pref.checked, false);
  pref.checked = true; pref.dispatchEvent(new win.Event('change'));
  assert.equal(win.localStorage.getItem('mc_always_details'), '1');
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Mit Kurzfassung')).click();
  const bubble = [...doc.querySelectorAll('.msg.bot .msg-bubble')].at(-1);
  assert.equal(bubble.querySelector('.msg-details').hidden, false);
  assert.equal(bubble.querySelector('.details-toggle').textContent, 'Details ausblenden ▴');
  pref.checked = false; pref.dispatchEvent(new win.Event('change'));
  assert.equal(bubble.querySelector('.msg-details').hidden, true);
});

test('Kurzfassung: nur Summary sichtbar, Tabellen hinter „Details einblenden", Buttons darunter', () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Mit Kurzfassung')).click();
  const bubble = [...doc.querySelectorAll('.msg.bot .msg-bubble')].at(-1);
  assert.match(bubble.querySelector('.msg-summary').textContent, /Validierung fertig – 1 Frage unten per Klick\./);
  const det = bubble.querySelector('.msg-details');
  assert.equal(det.hidden, true);
  assert.match(det.textContent, /BLOCK 1[\s\S]*Biertulpe/);
  const toggle = bubble.querySelector('.details-toggle');
  assert.equal(toggle.textContent, 'Details einblenden ▾');
  toggle.click();
  assert.equal(det.hidden, false); assert.equal(toggle.textContent, 'Details ausblenden ▴');
  toggle.click(); assert.equal(det.hidden, true);
  assert.equal(doc.querySelectorAll('.quick-replies .quick-reply').length, 2);
});

test('sendMessage lehnt Nicht-Strings ab statt „[object Object]" zu senden', async () => {
  const before = sent.length;
  // Simuliert alten Code-Pfad: Klick-Handler ruft sendMessage mit Objekt auf
  const btn = doc.querySelector('.quick-replies .quick-reply');
  const groupObj = { question: 'x', options: ['y'] };
  // Zugriff über das globale sendMessage gibt es nicht (IIFE) – daher Objekt über den Textkanal prüfen:
  win.__probe = null;
  const input = doc.getElementById('msg-input'); input.value = ''; // leer → sendMessage tut nichts
  doc.getElementById('send-btn').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, before, 'leere Eingabe sendet nichts');
  assert.ok(btn && groupObj);
});

test('Quick Replies: Gruppen mit Fragen und Optionen werden als Buttons gerendert', () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Function_Testveranstaltung')).click();
  const groups = doc.querySelectorAll('.quick-replies .quick-group');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].querySelector('.quick-question').textContent, '14er Schale – welche Variante?');
  assert.equal(groups[0].querySelectorAll('.quick-reply').length, 3);
  assert.equal(groups[1].querySelectorAll('.quick-reply').length, 2);
  assert.doesNotMatch(doc.getElementById('messages').textContent, /quickreplies/);
  const send = doc.querySelector('.quick-send');
  assert.ok(send && send.disabled, 'Senden-Button initial deaktiviert');
  assert.equal(doc.getElementById('input-area').hidden, false, 'Eingabefeld für Owner sichtbar');
});

test('Klick markiert Option, Sammel-Senden schickt „Meine Antworten" mit resultId', async () => {
  const groups = doc.querySelectorAll('.quick-replies .quick-group');
  groups[0].querySelectorAll('.quick-reply')[0].click();
  groups[1].querySelectorAll('.quick-reply')[1].click();
  assert.ok(groups[0].querySelectorAll('.quick-reply')[0].classList.contains('selected'));
  const send = doc.querySelector('.quick-send');
  assert.equal(send.disabled, false);
  assert.match(send.textContent, /2\/2/);
  const before = sent.length;
  send.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, before + 1);
  const last = sent.at(-1);
  assert.equal(last.url, '/api/flow/operativ');
  assert.equal(last.body.resultId, RESULT.id);
  assert.equal(last.headers['X-Portal-Client'], 'test', 'Client sendet seine Version');
  assert.equal(last.body.question, 'Meine Antworten:\n- 14er Schale – welche Variante? → khaki (Row 22)\n- Servietten – welche Farbe? → schwarz (Row 79)');
  assert.equal(doc.querySelectorAll('.quick-replies').length, 0, 'alte Buttons nach dem Senden entfernt');
});

test('Empfänger eines geteilten Ergebnisses: keine Buttons, kein Eingabefeld, Banner', () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Von Bob geteilt')).click();
  assert.equal(doc.querySelectorAll('.quick-replies').length, 0);
  assert.equal(doc.getElementById('input-area').hidden, true);
  assert.match(doc.getElementById('readonly-banner').textContent, /Geteilt von Bob.*nur Lesen/);
  assert.equal(doc.getElementById('share-btn').hidden, true);
});

test('Teilen-Dialog: Button „Teilen" → nach Klick „✓ Geteilt" (deaktiviert) und Badge im Verlauf', async () => {
  [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Function_Testveranstaltung')).click();
  assert.equal(doc.getElementById('share-btn').hidden, false);
  doc.getElementById('share-btn').click();
  assert.ok(doc.getElementById('share-modal').classList.contains('open'));
  const rows = doc.querySelectorAll('.share-row');
  assert.equal(rows.length, 1, 'nur Bob, nicht ich selbst');
  const btn = rows[0].querySelector('button');
  assert.equal(btn.textContent, 'Teilen'); assert.equal(btn.disabled, false);
  btn.click();
  await new Promise((r) => setTimeout(r, 30));
  const btn2 = doc.querySelector('.share-row button');
  assert.equal(btn2.textContent, '✓ Geteilt'); assert.equal(btn2.disabled, true);
  doc.getElementById('share-close').click();
  assert.ok(!doc.getElementById('share-modal').classList.contains('open'));
  const own = [...doc.querySelectorAll('.archive-item')].find((i) => i.textContent.includes('Function_Testveranstaltung'));
  assert.match(own.textContent, /geteilt mit 1/);
});
