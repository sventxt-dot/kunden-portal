import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQuickReplies } from '../server/lib/flowise.js';
import { splitOperatorSummary, questionsWithoutOpenPoint } from '../server/lib/summary.js';

const INLINE = 'intern…\n\n### ❓ 3 offene Punkte\n1. [A] **Wasser – Aufteilung?**\n2. [A] **Bier – Aufteilung?**\n3. [C] **Menuteller – Variante?**\n\n### ✅ 2 Artikel klar zugeordnet\n1. Biertulpe → GBP Row 53 | 220 | ok\n\n## 📋 Operator-Ansicht\n\n### Veranstaltung\nDERTOUR · Mainz · 21.05.2026 · 220 Gäste · **Stehempfang**\n\n### Bestellung laut Function Sheet\n- **Wasser:** Selters still & medium, ca. 135 Flaschen\n```quickreply\n{"question":"Wasser – wie aufteilen?","options":["70/30 → 95 + 40","50/50 → 68 + 67","andere Aufteilung"]}\n```\n- **Bier:** Radeberger, Clausthaler, ca. 184 Flaschen\n```quickreply\n{"question":"Bier – wie aufteilen?","options":["80/20 → 147 + 37","andere Aufteilung"]}\n```\n- **Menüteller:** 220 Stück\n```quickreply\n{"question":"Menuteller – welche Variante?","options":["weiß 26 cm","schwarz 27 cm"]}\n```\n\n### Stand\n✅ 2 feststehend · ❓ 3 offen';

test('mehrere Inline-Blöcke → Platzhalter an Ort und Stelle, Gruppen in Reihenfolge', () => {
  const { text, questions } = extractQuickReplies(INLINE);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map((q) => q.question), ['Wasser – wie aufteilen?', 'Bier – wie aufteilen?', 'Menuteller – welche Variante?']);
  assert.doesNotMatch(text, /```/);
  const iW = text.indexOf('[[qr:0]]'), iB = text.indexOf('[[qr:1]]'), iM = text.indexOf('[[qr:2]]');
  assert.ok(text.indexOf('**Wasser:**') < iW && iW < text.indexOf('**Bier:**'), 'Wasser-Frage direkt nach Wasser');
  assert.ok(text.indexOf('**Bier:**') < iB && iB < text.indexOf('**Menüteller:**'));
  assert.ok(iM > text.indexOf('**Menüteller:**') && iM < text.indexOf('### Stand'));
});

test('Altformat: ein Array-Block ganz am Ende → keine Platzhalter, Gruppen trotzdem', () => {
  const legacy = 'Antwort\n\n```quickreplies\n[{"question":"A?","options":["1","2"]},{"question":"B?","options":["x","y"]}]\n```';
  const { text, questions } = extractQuickReplies(legacy);
  assert.equal(questions.length, 2); assert.equal(text, 'Antwort'); assert.doesNotMatch(text, /\[\[qr/);
});

test('Ansicht wird abgetrennt, Details ohne Platzhalter, Konsistenz-Check findet fremde Frage', () => {
  const { text, questions } = extractQuickReplies(INLINE);
  const { summary, details } = splitOperatorSummary(text, null);
  assert.match(summary, /^### Veranstaltung/); assert.match(summary, /\[\[qr:0\]\]/);
  assert.doesNotMatch(details, /\[\[qr:/); assert.match(details, /### ✅ 2 Artikel/);
  assert.deepEqual(questionsWithoutOpenPoint(text, questions), []);
  assert.deepEqual(questionsWithoutOpenPoint(text, [...questions, { question: 'Servietten – Farbe?', options: ['a', 'b'] }, { question: 'Block 2 – alle Vorschläge?', options: ['a', 'b'] }]), ['Servietten – Farbe?']);
});

test('Obergrenze 20 Gruppen', () => {
  const many = Array.from({ length: 25 }, (_, i) => `Item ${i}\n\`\`\`quickreply\n{"question":"F${i}?","options":["a","b"]}\n\`\`\``).join('\n');
  const { questions, text } = extractQuickReplies(many);
  assert.equal(questions.length, 20); assert.equal((text.match(/\[\[qr:/g) || []).length, 20);
});
