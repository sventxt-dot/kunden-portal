// Sicherheitsnetz für den Operativ-Flow (Packlisten-Agent).
//
// Der Prompt verlangt: Artikel mit offener Menge oder mehreren möglichen Rows stehen im ❓-Block,
// nie in ✅ (Invarianten V1/V2/V3). Das Modell hält das nicht in jedem Lauf ein. Diese Schicht
// prüft die Antwort deterministisch, verschiebt verletzende ✅-Zeilen nach ❓, korrigiert die
// Zähler und macht die Korrektur sichtbar. Sie ändert nur Text; die UI bleibt gleich.

const OK_HEAD = /^(#{2,4})\s*✅\s*(?:\[?(\d+)\]?)?\s*Artikel klar zugeordnet.*$/m;
const OPEN_HEAD = /^(#{2,4})\s*❓\s*(?:\[?(\d+)\]?)?\s*offene Punkte.*$/m;
const ANY_HEAD = /^#{1,6}\s/;
const ITEM = /^\s*\d+\.\s+/;

// Muster, die eine offene Entscheidung anzeigen (Prompt Abschnitt 13 / V1–V3)
// stark: in der ganzen Zeile verboten; schwach: nur in Artikel-/Row- und Mengenspalte (nicht in der Begründung)
const FORBIDDEN_STRONG = /❓|verschoben|Klärung|abhängig von|anteilig|\bTBD\b/i;
const FORBIDDEN_WEAK = /\boffen\b|nach Bestätigung|Menge → |\(Aufteilung|Aufteilung offen|nach Aufteilung/i;
const MULTI_ROW = /\bRow\s*\d+\s*(?:[\/–—-]|oder|,)\s*\d+/i;          // Row 22/23/24, Row 31–33, Row 46 oder 47
const RANGE_QTY = /\b\d+\s*[–—-]\s*\d+\s*(?:Fl\.?|Flaschen|St(?:k|ück)?\.?|L\b|l\b|kg|Pack)/i; // 166–221 Fl.
const HAS_DIGIT = /\d/;

export function analyseOkLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  const qty = parts[1] ?? '';
  const reasons = [];
  if (FORBIDDEN_STRONG.test(line) || FORBIDDEN_WEAK.test(`${parts[0] ?? ''} | ${qty}`)) reasons.push('offene Formulierung');
  if (MULTI_ROW.test(parts[0] ?? '')) reasons.push('mehrere Rows');
  if (parts.length >= 2 && !HAS_DIGIT.test(qty)) reasons.push('Menge ohne Zahl');
  if (parts.length >= 2 && /\boffen\b/i.test(qty)) reasons.push('Menge offen');
  if (RANGE_QTY.test(qty)) reasons.push('Mengenbereich');
  return reasons;
}

function articleName(line) {
  const head = line.replace(ITEM, '').split('|')[0].split('→')[0];
  return head.replace(/\*\*/g, '').trim() || 'Artikel';
}

/**
 * @param {string} text  bereinigte Antwort (ohne ```quickreplies-Block)
 * @returns {{ text: string, moved: Array<{article: string, line: string, reasons: string[]}> }}
 */
export function enforceValidation(text) {
  const okHead = text.match(OK_HEAD);
  if (!okHead) return { text, moved: [] };

  const lines = text.split('\n');
  const headIdx = lines.findIndex((l) => l === okHead[0]);
  const level = okHead[1].length;
  // Ende des ✅-Blocks: nächste Überschrift gleicher oder höherer Ebene, Trennlinie mit Folge-Überschrift oder Dateiende
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { endIdx = i; break; }
  }

  const kept = [], moved = [], staleNotes = [];
  for (let i = headIdx + 1; i < endIdx; i++) {
    const l = lines[i];
    if (!ITEM.test(l)) {
      // Erläuterungen im ✅-Block, die auf ❓ verweisen, sind nach dem Verschieben veraltet → entfernen
      if (/^\s*(\*\*Hinweis|>\s*⚠️|>\s*\*\*Hinweis)/.test(l) && /❓/.test(l)) { staleNotes.push(l); continue; }
      kept.push(l); continue;
    }
    const reasons = analyseOkLine(l);
    if (reasons.length) moved.push({ article: articleName(l), line: l.replace(ITEM, '').trim(), reasons });
    else kept.push(l);
  }
  if (!moved.length) return { text, moved }; // veraltete Hinweise nur entfernen, wenn wirklich verschoben wurde

  // ✅-Block neu nummerieren, Zähler setzen
  let n = 0;
  const renumbered = kept.map((l) => (ITEM.test(l) ? l.replace(/^(\s*)\d+\./, (_, sp) => `${sp}${++n}.`) : l));
  const newOkHead = `${okHead[1]} ✅ ${n} Artikel klar zugeordnet`;
  const note = [
    '',
    `🛡️ **Sicherheitsnetz (Portal):** ${moved.length} Zeile${moved.length > 1 ? 'n' : ''} aus ✅ nach ❓ verschoben, weil Menge oder Row nicht eindeutig war: `
      + moved.map((m) => `${m.article} (${m.reasons.join(', ')})`).join('; ') + '.',
    '',
  ];
  let out = [...lines.slice(0, headIdx), ...note, newOkHead, ...renumbered, ...lines.slice(endIdx)];

  // ❓-Block ergänzen (existiert er nicht, vor dem ✅-Block anlegen – Prompt-Reihenfolge ❓ → ✅)
  const joined = out.join('\n');
  const openHead = joined.match(OPEN_HEAD);
  const extra = moved.map((m) => `[D] **${m.article} – Menge/Row offen?** ${m.line} *(Sicherheitsnetz: aus ✅ verschoben – ${m.reasons.join(', ')})*`);
  if (openHead) {
    const oLines = joined.split('\n');
    const oIdx = oLines.findIndex((l) => l === openHead[0]);
    const oLevel = openHead[1].length;
    let oEnd = oLines.length;
    for (let i = oIdx + 1; i < oLines.length; i++) {
      const m = oLines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= oLevel) { oEnd = i; break; }
    }
    // letzte nummerierte Zeile im ❓-Block finden, dahinter einfügen
    let last = oIdx, count = 0;
    for (let i = oIdx + 1; i < oEnd; i++) if (ITEM.test(oLines[i])) { last = i; count++; }
    const inserted = extra.map((e, k) => `${count + k + 1}. ${e}`);
    oLines.splice(last + 1, 0, ...inserted);
    oLines[oIdx] = `${openHead[1]} ❓ ${count + extra.length} offene Punkte`;
    out = oLines;
  } else {
    const oLines = joined.split('\n');
    const okIdx = oLines.findIndex((l) => l === newOkHead);
    const block = [`${'#'.repeat(level)} ❓ ${extra.length} offene Punkte`, '', ...extra.map((e, k) => `${k + 1}. ${e}`), ''];
    oLines.splice(okIdx, 0, ...block);
    out = oLines;
  }
  return { text: out.join('\n'), moved };
}

// Hinweis für die nächste Nachricht an Flowise, damit der Agent den korrigierten Stand kennt.
export function followUpNote(moved) {
  if (!moved?.length) return '';
  return `[Hinweis Portal-Sicherheitsnetz: In der letzten Validierung wurden ${moved.length} Artikel aus ✅ nach ❓ verschoben, weil Menge oder Row nicht eindeutig war: `
    + moved.map((m) => m.article).join(', ')
    + `. Diese Artikel gelten als offen (❓) und dürfen nicht in ✅ oder in ein Items-Array, bis der Operator sie klärt.]\n\n`;
}
