// POST /api/flow/:type
// Prüft die Session (requireAuth), ruft den Flowise-Chatflow serverseitig auf und
// schreibt das Ergebnis als results-Zeile – mit dem JWT des Users, also unter RLS.
//
// Body: { question?: string, resultId?: uuid, upload?: { name, size, pages, text } }
//  - ohne resultId: neuer Chat → INSERT results (owner_id = auth.uid())
//  - mit resultId:  Folgefrage im eigenen Chat → UPDATE results.output_data
//    Für geteilte (fremde) Ergebnisse schlägt das mit 403 fehl – Empfänger sind read-only.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';
import { supabaseForUser } from '../lib/supabase.js';
import { predict, FlowiseError } from '../lib/flowise.js';
import { enforceValidation, followUpNote } from '../lib/validationGuard.js';
import { splitOperatorSummary } from '../lib/summary.js';

const router = Router();

const MAX_QUESTION = 20_000;      // Zeichen
const MAX_UPLOAD_TEXT = 3_000_000; // Zeichen extrahierter PDF-Text
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/:type', async (req, res, next) => {
  try {
    const flow = config.flows[req.params.type];
    if (!flow) return res.status(404).json({ error: 'Unbekannter Assistent.' });

    const { question: rawQuestion, resultId, upload } = req.body ?? {};
    const question = typeof rawQuestion === 'string' ? rawQuestion.trim() : '';

    if (question.length > MAX_QUESTION) return res.status(413).json({ error: 'Nachricht zu lang.' });
    if (upload !== undefined) {
      if (!upload || typeof upload !== 'object' || typeof upload.text !== 'string' || typeof upload.name !== 'string') {
        return res.status(400).json({ error: 'Ungültiger Anhang.' });
      }
      if (upload.text.length > MAX_UPLOAD_TEXT) return res.status(413).json({ error: 'PDF-Text zu groß.' });
    }
    if (!question && !upload) return res.status(400).json({ error: 'Nachricht oder PDF fehlt.' });
    if (resultId !== undefined && !UUID_RE.test(String(resultId))) {
      return res.status(400).json({ error: 'Ungültige Ergebnis-ID.' });
    }

    const sb = supabaseForUser(req.user.token);

    // Bestehenden Chat laden (RLS: nur sichtbar, wenn eigen oder geteilt)
    let existing = null;
    if (resultId) {
      const { data, error } = await sb.from('results').select('*').eq('id', resultId).maybeSingle();
      if (error) throw Object.assign(new Error('Ergebnis konnte nicht geladen werden.'), { status: 500, detail: error.message });
      if (!data) return res.status(404).json({ error: 'Ergebnis nicht gefunden.' });
      if (data.owner_id !== req.user.id) {
        return res.status(403).json({ error: 'Geteilte Ergebnisse sind schreibgeschützt. Nur der Besitzer kann den Chat fortsetzen.' });
      }
      if (data.flow_type !== flow.type) return res.status(400).json({ error: 'Ergebnis gehört zu einem anderen Assistenten.' });
      existing = data;
    }

    const chatId = existing?.output_data?.chat_id || randomUUID();
    const uploads = upload
      ? [{ data: upload.text, mime: 'application/pdf', name: upload.name, type: 'file:full' }]
      : undefined;

    // Sicherheitsnetz-Hinweis aus der letzten Runde an den Agenten weiterreichen (nur Operativ)
    const prevBot = [...(existing?.output_data?.messages || [])].reverse().find((m) => m.role === 'bot');
    const carry = flow.type === 'operativ' ? followUpNote(prevBot?.safety_net?.moved) : '';

    const flowiseResult = await predict(flow, {
      question: carry + (question || 'Bitte analysiere das angehängte PDF.'),
      chatId,
      uploads,
    });
    let { answer } = flowiseResult;
    const { quickReplies } = flowiseResult;
    let safetyNet = null;
    let summary = null;
    if (flow.type === 'operativ') {
      const guarded = enforceValidation(answer);
      if (guarded.moved.length) {
        answer = guarded.text;
        safetyNet = { moved: guarded.moved.map(({ article, reasons }) => ({ article, reasons })), at: new Date().toISOString() };
        console.warn('[guard] operativ: %d Zeile(n) aus ✅ nach ❓ verschoben: %s', guarded.moved.length, guarded.moved.map((m) => m.article).join(', '));
      }
      // Kurzfassung für den Operator (Prompt Abschnitt 21) – Details bleiben im gespeicherten Volltext
      const split = splitOperatorSummary(answer, safetyNet);
      summary = split.summary;
    }

    const now = new Date().toISOString();
    const userMessage = {
      role: 'user',
      content: question || `📎 ${upload.name}`,
      ts: now,
      ...(upload ? { attachment: { name: upload.name, size: upload.size ?? null, pages: upload.pages ?? null } } : {}),
    };
    // quick_replies: [{question, options[]}] aus dem ```quickreplies-Block des Operativ-Prompts
    // oder aus Flowise-Follow-ups. Fehlt beides, parst das Frontend heuristisch (parseQuickReplies).
    const botMessage = {
      role: 'bot', content: answer, ts: new Date().toISOString(),
      ...(quickReplies.length ? { quick_replies: quickReplies } : {}),
      ...(safetyNet ? { safety_net: safetyNet } : {}),
      ...(summary ? { summary } : {}),
    };

    let row;
    if (existing) {
      const prev = Array.isArray(existing.output_data?.messages) ? existing.output_data.messages : [];
      const output_data = { ...existing.output_data, chat_id: chatId, messages: [...prev, userMessage, botMessage], updated_at: now };
      const { data, error } = await sb.from('results').update({ output_data }).eq('id', existing.id).select().single();
      if (error) throw Object.assign(new Error('Ergebnis konnte nicht aktualisiert werden.'), { status: 403, detail: error.message });
      row = data;
    } else {
      const titleSource = question || upload.name;
      const { data, error } = await sb.from('results').insert({
        owner_id: req.user.id,
        flow_type: flow.type,
        title: titleSource.slice(0, 80),
        input_summary: (question || `PDF: ${upload.name}`).slice(0, 500),
        output_data: { chat_id: chatId, messages: [userMessage, botMessage], updated_at: now },
      }).select().single();
      if (error) throw Object.assign(new Error('Ergebnis konnte nicht gespeichert werden.'), { status: 500, detail: error.message });
      row = data;
    }

    return res.json({ resultId: row.id, answer, summary, quickReplies: botMessage.quick_replies || null, safetyNet, result: row });
  } catch (err) {
    if (err instanceof FlowiseError) {
      console.error('[flow] Flowise-Fehler:', err.message, err.detail || '');
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
});

export default router;
