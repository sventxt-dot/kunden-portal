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
  const answer = data.text ?? data.answer ?? data.output ?? JSON.stringify(data);
  return { answer: String(answer), chatMessageId: data.chatMessageId ?? null, followUpPrompts: parseFollowUps(data.followUpPrompts) };
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
