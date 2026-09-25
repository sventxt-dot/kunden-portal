// Serverseitiger Flowise-Client. API-Key und Chatflow-ID kommen aus der Config,
// der Browser sieht davon nichts.
import { config } from './config.js';

function headersFor(flow) {
  const h = { 'Content-Type': 'application/json' };
  if (flow.apiKey) h.Authorization = `Bearer ${flow.apiKey}`;
  return h;
}

export class FlowiseError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export async function predict(flow, { question, chatId, uploads }) {
  const url = `${config.flowiseBaseUrl}/api/v1/prediction/${flow.chatflowId}`;
  const body = { question, chatId, overrideConfig: {} };
  if (uploads?.length) body.uploads = uploads;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headersFor(flow),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.flowiseTimeoutMs),
    });
  } catch (err) {
    const timeout = err?.name === 'TimeoutError';
    throw new FlowiseError(
      timeout ? 'Der Assistent hat zu lange nicht geantwortet.' : 'Der Assistent ist nicht erreichbar.',
      504,
      err?.message,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FlowiseError(`Der Assistent hat mit HTTP ${res.status} geantwortet.`, 502, text.slice(0, 500));
  }

  const data = await res.json();
  const raw = String(data.text ?? data.answer ?? data.output ?? JSON.stringify(data));
  const { text: answer, questions } = extractQuickReplies(raw);
  const followUps = parseFollowUps(data.followUpPrompts);
  // Priorität: strukturierter ```quickreplies-Block aus dem Prompt, sonst Flowise-Follow-ups
  const quickReplies = questions.length ? questions : (followUps.length ? [{ question: '', options: followUps }] : []);
  return { answer, chatMessageId: data.chatMessageId ?? null, quickReplies };
}

// Quick-Reply-Blöcke im Antworttext:
//   ```quickreply            ← ein einzelnes Fragen-Objekt, inline an seiner Stelle (Operator-Ansicht)
//   {"question":"Wasser – wie aufteilen?","options":["70/30 → 95 + 40","andere Aufteilung"]}
//   ```
//   ```quickreplies          ← Array (Altformat, meist am Ende)
//   [{"question":…,"options":[…]}, …]
//   ```
// Jeder Block wird aus dem Text entfernt. Steht er nicht am Ende, bleibt an seiner Stelle ein
// Platzhalter [[qr:N]] – das Frontend setzt dort die Buttons ein. Ein Block ganz am Ende
// (Altformat) bekommt keinen Platzhalter; seine Gruppen werden am Ende der Nachricht gezeigt.
const QR_BLOCK_ALL = /```quickrepl(?:y|ies)\s*\n([\s\S]*?)```/gi;
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 8;
const MAX_LEN = 140;

export function extractQuickReplies(text) {
  const questions = [];
  let out = '';
  let last = 0;
  let m;
  const re = new RegExp(QR_BLOCK_ALL.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { parsed = null; }
    const groups = normalizeQuestions(parsed);
    const trailing = text.slice(m.index + m[0].length).trim() === '';
    out += text.slice(last, m.index);
    if (groups.length && !trailing && questions.length + groups.length <= MAX_QUESTIONS) {
      const tokens = groups.map((_, k) => `[[qr:${questions.length + k}]]`).join(' ');
      out += tokens;
    }
    if (groups.length && questions.length < MAX_QUESTIONS) questions.push(...groups.slice(0, MAX_QUESTIONS - questions.length));
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  if (!questions.length) return { text, questions: [] };
  const cleaned = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, questions };
}

export function normalizeQuestions(input) {
  const list = Array.isArray(input) ? input : (input && Array.isArray(input.questions) ? input.questions : (input && typeof input === 'object' ? [input] : []));
  const out = [];
  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const question = String(q.question ?? q.frage ?? '').trim().slice(0, MAX_LEN);
    const options = (Array.isArray(q.options) ? q.options : Array.isArray(q.optionen) ? q.optionen : [])
      .map((o) => (typeof o === 'string' ? o : o?.label ?? o?.text ?? '')).map((o) => String(o).trim().slice(0, MAX_LEN)).filter(Boolean);
    const unique = [...new Set(options)].slice(0, MAX_OPTIONS);
    if (unique.length >= 2) out.push({ question, options: unique });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

// Flowise-Feature "Follow-up Prompts": kommt als JSON-String oder Array zurück.
function parseFollowUps(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? x : x?.prompt ?? x?.text ?? '')).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
}

// Best effort: Chat-Verlauf in Flowise löschen, wenn der Owner ein Ergebnis löscht.
export async function deleteChat(flow, chatId) {
  const url = `${config.flowiseBaseUrl}/api/v1/chatmessage/${flow.chatflowId}`
    + `?chatId=${encodeURIComponent(chatId)}&chatType=INTERNAL`;
  try {
    await fetch(url, { method: 'DELETE', headers: headersFor(flow), signal: AbortSignal.timeout(15000) });
  } catch (err) {
    console.warn('[flowise] Chat konnte nicht gelöscht werden:', err?.message);
  }
}
