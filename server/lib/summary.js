// Operator-Ansicht: Der Operativ-Prompt beendet jede Antwort mit
//   ## 📋 Operator-Ansicht   (oder ältere Antworten: ## 📋 Kurzfassung)
//   … Klartext, darin Platzhalter [[qr:N]] an den Stellen der Inline-Fragen …
// Der Volltext (Analyse, Block 1/2, Validierung) bleibt gespeichert und ist im Frontend hinter
// „Details einblenden“ erreichbar. Standardansicht ist die Operator-Ansicht plus Buttons.
const VIEW_HEAD = /^#{2,4}\s*📋\s*(?:Operator-Ansicht|Kurzfassung)[^\n]*$/m;
const OPEN_HEAD = /^#{2,4}\s*❓[^\n]*offene Punkte[^\n]*$/m;
const TOKEN = /\[\[qr:(\d+)\]\]/g;

export function splitOperatorSummary(text, safetyNet) {
  const m = text.match(VIEW_HEAD);
  if (!m) return { summary: null, details: text };
  const idx = text.indexOf(m[0]);
  const level = (m[0].match(/^#+/) || ['##'])[0].length;
  let summary = text.slice(idx + m[0].length).trim();
  // Unterüberschriften (tiefer als die Ansicht) gehören dazu; eine gleich-/höherrangige beendet sie
  const cut = summary.search(new RegExp(`\\n#{1,${level}}\\s`));
  if (cut > -1) summary = summary.slice(0, cut).trim();
  if (!summary) return { summary: null, details: text };
  if (safetyNet?.moved?.length) {
    summary += `\n\n🛡️ Zusätzlich offen (vom Portal aus „feststehend“ herausgenommen, weil Menge oder Zuordnung nicht eindeutig war): ${safetyNet.moved.map((x) => x.article).join(', ')}.`;
  }
  // Die Details enthalten keine Platzhalter (Buttons gehören zur Ansicht)
  const details = text.replace(TOKEN, '').replace(/[ \t]+\n/g, '\n');
  return { summary, details };
}

// Konsistenz: Jede Inline-Frage soll zu einem ❓-Punkt gehören (gleicher Artikelname).
// Liefert die Fragen, deren Artikel im ❓-Block nicht vorkommt – nur zum Loggen/Testen.
export function questionsWithoutOpenPoint(text, questions) {
  const m = text.match(OPEN_HEAD);
  if (!m) return questions.map((q) => q.question);
  const from = text.indexOf(m[0]) + m[0].length;
  const rest = text.slice(from);
  const cut = rest.search(/\n#{1,3}\s/);
  const block = (cut > -1 ? rest.slice(0, cut) : rest).toLowerCase();
  const key = (q) => q.split(/\s[–—-]\s|\?|:/)[0].replace(/^(Anzahl|Vorschlag\s*\d+|Block.?2)\s*/i, '').trim().toLowerCase();
  return questions.map((q) => q.question).filter((q) => {
    const k = key(q);
    if (!k || /^block.?2|^vorschlag/i.test(q)) return false; // Block-2-Bestätigung hat keinen ❓-Punkt
    return !block.includes(k.split(' ')[0]);
  });
}
