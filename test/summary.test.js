import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOperatorSummary } from '../server/lib/summary.js';

const FULL = '## 🔍 Validierung\n\n### ❓ 2 offene Punkte\n1. [A] **Bier – Aufteilung?**\n\n### ✅ 3 Artikel\n1. Biertulpe → GBP Row 53 | 220 | ok\n\n## 📋 Kurzfassung\n\nValidierung fertig – 1 Frage unten per Klick.\n✅ 3 Artikel eindeutig zugeordnet.\n❓ 2 Punkte offen, davon 1 per Klick.\n• Saison Frühling angenommen. Wenn etwas nicht stimmt, bitte kurz schreiben.';

test('Kurzfassung wird abgetrennt, Volltext bleibt komplett', () => {
  const { summary, details } = splitOperatorSummary(FULL, null);
  assert.equal(summary, 'Validierung fertig – 1 Frage unten per Klick.\n✅ 3 Artikel eindeutig zugeordnet.\n❓ 2 Punkte offen, davon 1 per Klick.\n• Saison Frühling angenommen. Wenn etwas nicht stimmt, bitte kurz schreiben.');
  assert.equal(details, FULL);
});
test('ohne Kurzfassung → null; Guard-Hinweis wird angehängt; Folge-Überschrift schneidet ab', () => {
  assert.equal(splitOperatorSummary('nur Text', null).summary, null);
  const { summary } = splitOperatorSummary(FULL, { moved: [{ article: 'Tonic' }, { article: 'Martini' }] });
  assert.match(summary, /🛡️ Zusätzlich offen .*: Tonic, Martini\.$/);
  const cut = splitOperatorSummary(FULL + '\n\n## Nachtrag\nirrelevant', null).summary;
  assert.doesNotMatch(cut, /Nachtrag/);
});
