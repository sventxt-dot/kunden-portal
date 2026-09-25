// Operator-Kurzfassung: Der Operativ-Prompt beendet jede Antwort (vor dem Quick-Reply-Block) mit
//   ## 📋 Kurzfassung
//   … 3–8 Zeilen Klartext …
// Der Volltext (Analyse, Block 1/2, Validierung) bleibt gespeichert und ist im Frontend hinter
// „Details einblenden“ erreichbar. Standardansicht ist die Kurzfassung plus Buttons.
const SUMMARY_HEAD = /^#{2,4}\s*📋\s*Kurzfassung[^\n]*$/m;

export function splitOperatorSummary(text, safetyNet) {
  const m = text.match(SUMMARY_HEAD);
  if (!m) return { summary: null, details: text };
  const idx = text.indexOf(m[0]);
  let summary = text.slice(idx + m[0].length).trim();
  // Alles nach einer weiteren Überschrift gehört nicht mehr zur Kurzfassung
  const cut = summary.search(/\n#{1,6}\s/);
  if (cut > -1) summary = summary.slice(0, cut).trim();
  if (!summary) return { summary: null, details: text };
  if (safetyNet?.moved?.length) {
    summary += `\n\n🛡️ Zusätzlich offen (vom Portal aus „feststehend“ herausgenommen, weil Menge oder Zuordnung nicht eindeutig war): ${safetyNet.moved.map((x) => x.article).join(', ')}.`;
  }
  return { summary, details: text };
}
