// Sicherheitsnetz: verletzende ✅-Zeilen werden nach ❓ verschoben, Zähler korrigiert, Rest unverändert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceValidation, analyseOkLine, followUpNote } from '../server/lib/validationGuard.js';

const SAMPLE = `## 🔍 Validierung

### ❓ 2 offene Punkte

1. [A] **Bier – Aufteilung der 184 Fl.?** Radeberger (Row 69) / Clausthaler (Row 71)
2. [C] **Menuteller – welche Variante?** Row 14 / 15 / 16

### ⚠️ 1 Annahmen

* eventName „Test_21.05.2026" — korrekt so?

🔁 V1/V2/V3-Check: 0 Artikel gehören nach ❓ statt ✅

### ✅ 7 Artikel klar zugeordnet

1. Biertulpe → GBP Row 53 | 220 | 1,0 × 220
2. Radeberger Flasche → Getränke Row 69 | nach Klärung ❓1 | Bier 0,33l
3. Clausthaler → Getränke Row 71 | Menge nach Klärung Aufteilung | FS explizit
4. Eiswürfel 10 kg → Bar-I Row 25 | 60 kg (6 Säcke) | ⚡ IMMER, ceil(220/40)×10
5. Brotkorb geflochten → Bar-I Row 98/99/100 | 11 | ceil(220/20)
6. Martini bianco → Getränke Row 101 | Menge: offen (Cocktailanzahl) | Empfangscocktail
7. Chafilöffel → Bar-I Row 46 | 166–221 Fl. | Bereich
8. Kellnermesser → Bar-I Row 7 | 1 | Wein-Ableitung

---
Danach folgt der Quick-Reply-Block.`;

test('analyseOkLine erkennt alle Verstoßarten und lässt saubere Zeilen durch', () => {
  assert.deepEqual(analyseOkLine('1. Biertulpe → GBP Row 53 | 220 | 1,0 × 220'), []);
  assert.deepEqual(analyseOkLine('4. Eiswürfel 10 kg → Bar-I Row 25 | 60 kg (6 Säcke) | ⚡ IMMER'), []);
  assert.ok(analyseOkLine('2. Radeberger → Getränke Row 69 | nach Klärung ❓1 | x').includes('offene Formulierung'));
  assert.ok(analyseOkLine('5. Brotkorb → Bar-I Row 98/99/100 | 11 | x').includes('mehrere Rows'));
  assert.ok(analyseOkLine('6. Martini → Getränke Row 101 | Menge: offen | x').includes('Menge offen'));
  assert.ok(analyseOkLine('7. X → Row 46 | 166–221 Fl. | x').includes('Mengenbereich'));
  assert.ok(analyseOkLine('9. Y → Row 1 | — | keine Zahl').includes('Menge ohne Zahl'));
  assert.deepEqual(analyseOkLine('10. Getränkewanne silber groß → Bar-I Row 32 | 1 | Bier-Ableitung (Außenbereich)'), []);
});

test('enforceValidation verschiebt 5 von 8 Zeilen, nummeriert neu, korrigiert Zähler, fügt Hinweis ein', () => {
  const { text, moved } = enforceValidation(SAMPLE);
  assert.equal(moved.length, 5);
  assert.deepEqual(moved.map((m) => m.article), ['Radeberger Flasche', 'Clausthaler', 'Brotkorb geflochten', 'Martini bianco', 'Chafilöffel']);
  assert.match(text, /### ✅ 3 Artikel klar zugeordnet/);
  assert.match(text, /### ❓ 7 offene Punkte/);
  const okBlock = text.split('### ✅')[1];
  assert.match(okBlock, /1\. Biertulpe/); assert.match(okBlock, /2\. Eiswürfel/); assert.match(okBlock, /3\. Kellnermesser/);
  assert.doesNotMatch(okBlock, /Radeberger|Clausthaler|Brotkorb|Martini|Chafilöffel/);
  const openBlock = text.split('### ❓')[1].split('### ⚠️')[0];
  assert.match(openBlock, /3\. \[D\] \*\*Radeberger Flasche – Menge\/Row offen\?\*\*/);
  assert.match(openBlock, /7\. \[D\] \*\*Chafilöffel – Menge\/Row offen\?\*\*/);
  assert.match(text, /🛡️ \*\*Sicherheitsnetz \(Portal\):\*\* 5 Zeilen aus ✅ nach ❓ verschoben/);
  assert.match(text, /Danach folgt der Quick-Reply-Block\./, 'Text nach dem ✅-Block bleibt erhalten');
  assert.ok(text.indexOf('### ❓') < text.indexOf('### ✅'), 'Reihenfolge ❓ vor ✅ bleibt');
});

test('saubere Antwort bleibt byteidentisch; ohne ✅-Block passiert nichts', () => {
  const clean = SAMPLE.replace(/\n[2356-7]\..*$/gm, '').replace('### ✅ 7', '### ✅ 3');
  const r = enforceValidation(clean);
  assert.equal(r.moved.length, 0); assert.equal(r.text, clean);
  const none = enforceValidation('Hier ist Block 2:\n1. 📌 Cocktailbar → Barwerkzeug');
  assert.equal(none.moved.length, 0); assert.equal(none.text, 'Hier ist Block 2:\n1. 📌 Cocktailbar → Barwerkzeug');
});

test('fehlt der ❓-Block, wird er vor ✅ angelegt', () => {
  const noOpen = SAMPLE.replace(/### ❓[\s\S]*?(?=### ⚠️)/, '');
  const { text, moved } = enforceValidation(noOpen);
  assert.equal(moved.length, 5);
  assert.match(text, /### ❓ 5 offene Punkte/);
  assert.ok(text.indexOf('### ❓ 5') < text.indexOf('### ✅ 3'));
});

test('mehrere ✅-Listen (z. B. „bereinigt") werden alle geprüft', () => {
  const twice = SAMPLE + '\n\n### ✅ 2 Artikel klar zugeordnet (bereinigt)\n\n1. Biertulpe → GBP Row 53 | 220 | ok\n2. Tonic → Getränke Row 59 | Menge nach Klärung | Filler\n';
  const { text, moved } = enforceValidation(twice);
  assert.equal(moved.length, 6);
  assert.match(text, /### ✅ 1 Artikel klar zugeordnet \(bereinigt\)/);
  const second = text.split('(bereinigt)')[1];
  assert.doesNotMatch(second, /Tonic/);
  assert.match(text, /### ❓ 8 offene Punkte/);
});

test('followUpNote nennt die Artikel und ist leer ohne Verschiebungen', () => {
  assert.equal(followUpNote([]), ''); assert.equal(followUpNote(undefined), '');
  assert.match(followUpNote([{ article: 'Radeberger Flasche' }, { article: 'Tonic' }]), /Radeberger Flasche, Tonic.*dürfen nicht in ✅/);
});
