/* Messerich Catering – Assistenten-Portal
 * Login über Supabase Auth, Flows über den Server-Proxy (/api/flow/:type),
 * Verlauf + Teilen direkt über Supabase (RLS filtert serverseitig).
 */
(function () {
  'use strict';

  const CFG = window.PORTAL_CONFIG || {};
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
    document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Portal ist nicht konfiguriert (Supabase-URL/Key fehlen).</p>';
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const FLOWS = Object.fromEntries((CFG.flows || []).map((f) => [f.type, f]));

  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,            // { id, email }
    users: new Map(),      // id -> { id, email, display_name }  (portal_users())
    results: [],           // eigene + geteilte results-Zeilen
    shares: [],            // result_shares-Zeilen, die mich betreffen
    activeFlow: null,      // FLOWS[type]
    activeResult: null,    // results-Zeile oder null (= neuer Chat)
    isLoading: false,
    pendingPdf: null,
    filter: 'all',
    inApp: false,
  };

  // ---------- Helfer ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const isOwner = (r) => !!r && !!state.user && r.owner_id === state.user.id;
  const updatedAt = (r) => r.output_data?.updated_at || r.created_at;
  const userName = (id) => state.users.get(id)?.display_name || 'Kollege/in';
  const sharesFor = (resultId) => state.shares.filter((s) => s.result_id === resultId);
  const renderMd = (text) => (typeof marked !== 'undefined' ? marked.parse(text, { breaks: true }) : esc(text));

  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 5000 : 2500);
  }

  async function apiFetch(path, options = {}) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error('Nicht angemeldet.');
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, ...(options.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* keine JSON-Antwort */ }
    if (res.status === 401) { await sb.auth.signOut(); throw new Error('Sitzung abgelaufen. Bitte neu anmelden.'); }
    if (!res.ok) throw new Error(body?.error || ('HTTP ' + res.status));
    return body;
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  // ---------- Auth ----------
  sb.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      if (!state.inApp || state.user?.id !== session.user.id) enterApp(session.user);
    } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
      leaveApp();
    }
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim();
    const password = $('login-pass').value;
    const err = $('login-error');
    err.style.display = 'none';
    if (!email || !password) { err.textContent = 'Bitte E-Mail und Passwort eingeben.'; err.style.display = 'block'; return; }
    $('login-btn').disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    $('login-btn').disabled = false;
    if (error) {
      const m = error.message || '';
      err.textContent = /invalid login/i.test(m) ? 'E-Mail oder Passwort falsch.'
        : /not confirmed/i.test(m) ? 'E-Mail-Adresse ist noch nicht bestätigt.'
        : /rate limit|too many/i.test(m) ? 'Zu viele Versuche. Bitte kurz warten.'
        : 'Anmeldung fehlgeschlagen: ' + m;
      err.style.display = 'block';
    }
  });

  $('logout-btn').addEventListener('click', () => sb.auth.signOut());

  async function enterApp(user) {
    state.user = { id: user.id, email: user.email };
    state.inApp = true;
    const label = $('user-label');
    label.textContent = '👤 ' + (user.email || '');
    label.title = user.email || '';
    $('login-pass').value = '';
    showScreen('app-screen');
    renderAgents();
    try {
      await Promise.all([loadUsers(), loadHistory()]);
    } catch (e) {
      toast('Verlauf konnte nicht geladen werden: ' + e.message, true);
    }
  }

  function leaveApp() {
    Object.assign(state, { user: null, results: [], shares: [], activeFlow: null, activeResult: null, pendingPdf: null, isLoading: false, inApp: false });
    state.users = new Map();
    $('messages').innerHTML = '';
    $('chat-view').classList.remove('open');
    $('welcome-state').style.display = '';
    $('share-modal').classList.remove('open');
    showScreen('login-screen');
  }

  // ---------- Daten ----------
  async function loadUsers() {
    const { data, error } = await sb.rpc('portal_users');
    if (error) throw new Error(error.message);
    state.users = new Map((data || []).map((u) => [u.id, u]));
  }

  async function loadHistory() {
    const [r, s] = await Promise.all([
      sb.from('results').select('id, owner_id, flow_type, title, input_summary, output_data, created_at').order('created_at', { ascending: false }),
      sb.from('result_shares').select('result_id, shared_with_id, shared_by_id, created_at'),
    ]);
    if (r.error) throw new Error(r.error.message);
    if (s.error) throw new Error(s.error.message);
    state.results = r.data || [];
    state.shares = s.data || [];
    // Aktives Ergebnis ggf. auf frische Daten zeigen lassen
    if (state.activeResult) state.activeResult = state.results.find((x) => x.id === state.activeResult.id) || null;
    renderArchive();
  }

  // ---------- Sidebar ----------
  function renderAgents() {
    const list = $('agent-list');
    list.innerHTML = '';
    Object.values(FLOWS).forEach((flow) => {
      const btn = document.createElement('button');
      const active = state.activeFlow?.type === flow.type && !state.activeResult;
      btn.className = 'agent-btn' + (active ? ' active' : '');
      btn.innerHTML = `<div class="agent-icon" style="background:${esc(flow.color)}">${esc(flow.icon)}</div>`
        + `<div class="agent-info"><strong>${esc(flow.name)}</strong><span>${esc(flow.description)}</span></div>`;
      btn.addEventListener('click', () => selectFlow(flow.type));
      list.appendChild(btn);
    });
  }

  $('history-filter').addEventListener('change', (e) => { state.filter = e.target.value; renderArchive(); });

  function renderArchive() {
    const list = $('archive-list');
    let items = state.results.slice();
    if (state.filter === 'mine') items = items.filter(isOwner);
    if (state.filter === 'shared') items = items.filter((r) => !isOwner(r));
    items.sort((a, b) => new Date(updatedAt(b)) - new Date(updatedAt(a)));

    if (!items.length) {
      list.innerHTML = `<p class="archive-empty">${state.results.length ? 'Keine Einträge für diesen Filter.' : 'Noch keine Ergebnisse.'}</p>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((r) => {
      const flow = FLOWS[r.flow_type];
      const own = isOwner(r);
      const shares = sharesFor(r.id);
      const row = document.createElement('button');
      row.className = 'archive-item' + (state.activeResult?.id === r.id ? ' active' : '');
      const badge = own
        ? (shares.length ? `<span class="badge">geteilt mit ${shares.length}</span>` : '')
        : `<span class="badge shared-in">von ${esc(userName(r.owner_id))}</span>`;
      row.innerHTML = `<div class="archive-dot" style="background:${esc(flow?.color || '#ccc')}; border:1px solid #ccc;"></div>`
        + `<div class="archive-info"><strong>${esc(r.title || 'Ohne Titel')}</strong>`
        + `<span>${esc(flow?.icon || '')} ${esc(flow?.name || r.flow_type)} · ${fmtDate(updatedAt(r))}</span>${badge}</div>`
        + (own ? `<button class="archive-del-btn" title="Ergebnis löschen">&#128465;</button>` : '');
      row.addEventListener('click', () => openResult(r.id));
      const del = row.querySelector('.archive-del-btn');
      if (del) del.addEventListener('click', (e) => { e.stopPropagation(); deleteResult(r.id); });
      list.appendChild(row);
    });
  }

  // ---------- Chat-Ansicht ----------
  function selectFlow(type) {
    state.activeFlow = FLOWS[type];
    state.activeResult = null;
    showChat();
  }

  function openResult(id) {
    const r = state.results.find((x) => x.id === id);
    if (!r) return;
    state.activeResult = r;
    state.activeFlow = FLOWS[r.flow_type] || null;
    showChat();
  }

  function showChat() {
    const flow = state.activeFlow;
    const r = state.activeResult;
    const readonly = !!r && !isOwner(r);
    $('welcome-state').style.display = 'none';
    $('chat-view').classList.add('open');
    $('header-icon').textContent = flow?.icon || '🤖';
    $('header-icon').style.background = flow?.color || '#f0f2f5';
    $('header-name').textContent = r ? (r.title || flow?.name || '') : (flow?.name || '');
    $('header-desc').textContent = r ? `${flow?.name || r.flow_type} · ${fmtDate(r.created_at)}` : (flow?.description || '');
    $('share-btn').hidden = !(r && isOwner(r));
    $('new-chat-btn').hidden = !flow;
    $('input-area').hidden = readonly || !flow;
    const banner = $('readonly-banner');
    if (readonly) {
      const share = sharesFor(r.id).find((s) => s.shared_with_id === state.user.id);
      banner.textContent = `Geteilt von ${userName(r.owner_id)}${share ? ' am ' + fmtDate(share.created_at) : ''} · nur Lesen`;
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
    renderAgents();
    renderArchive();
    renderMessages();
    if (!readonly) $('msg-input').focus();
  }

  $('new-chat-btn').addEventListener('click', () => {
    if (!state.activeFlow) return;
    state.activeResult = null;
    removePdf();
    showChat();
  });

  function renderMessages() {
    const c = $('messages');
    c.innerHTML = '';
    const r = state.activeResult;
    if (!r) {
      const f = state.activeFlow;
      if (f) appendMessage('bot', `Hallo! Ich bin der ${f.name} von Messerich Catering. ${f.description}. Wie kann ich dir helfen?`, new Date().toISOString());
      return;
    }
    (r.output_data?.messages || []).forEach((m) => appendMessage(m.role, m.content, m.ts, m.attachment));
    scrollToBottom();
  }

  function bubbleFor(role, ts) {
    const flow = state.activeFlow;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? '👤' : (flow?.icon || '🤖');
    if (role === 'bot') avatar.style.background = flow?.color || '#f0f2f5';
    const inner = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime(ts);
    inner.appendChild(bubble); inner.appendChild(time);
    wrap.appendChild(avatar); wrap.appendChild(inner);
    $('messages').appendChild(wrap);
    return { wrap, bubble };
  }

  function appendMessage(role, content, ts, attachment) {
    const { bubble } = bubbleFor(role, ts);
    if (role === 'bot') {
      bubble.innerHTML = renderMd(content);
      bubble.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    } else {
      bubble.textContent = content;
      if (attachment?.name) {
        const att = document.createElement('div');
        att.className = 'msg-attachment';
        att.textContent = `📎 ${attachment.name}${attachment.pages ? ' · ' + attachment.pages + ' Seite(n)' : ''}`;
        bubble.appendChild(att);
      }
    }
    scrollToBottom();
  }

  function typewriterMessage(fullText, ts) {
    const { bubble } = bubbleFor('bot', ts);
    const chars = Array.from(fullText);
    let i = 0, shown = '';
    (function tick() {
      if (i >= chars.length) {
        bubble.innerHTML = renderMd(fullText);
        bubble.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
        scrollToBottom();
        return;
      }
      const batch = Math.min(4, chars.length - i);
      for (let b = 0; b < batch; b++) shown += chars[i++];
      bubble.textContent = shown;
      scrollToBottom();
      setTimeout(tick, 16);
    })();
  }

  function appendTyping() {
    const { wrap, bubble } = bubbleFor('bot', new Date().toISOString());
    wrap.id = 'typing-indicator';
    bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    wrap.querySelector('.msg-time').remove();
  }
  const removeTyping = () => $('typing-indicator')?.remove();
  function scrollToBottom() { const c = $('messages'); c.scrollTop = c.scrollHeight; }

  // ---------- PDF ----------
  $('pdf-btn').addEventListener('click', () => $('pdf-input').click());
  $('pdf-remove').addEventListener('click', removePdf);
  $('pdf-input').addEventListener('change', (e) => handlePdf(e.target));

  async function handlePdf(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { toast('Bitte nur PDF-Dateien.', true); input.value = ''; return; }
    if (file.size > 20 * 1024 * 1024) { toast('PDF zu groß (max. 20 MB).', true); input.value = ''; return; }
    if (typeof pdfjsLib === 'undefined') { toast('PDF-Bibliothek nicht geladen.', true); input.value = ''; return; }

    $('pdf-name').textContent = 'Lese PDF…';
    $('pdf-size').textContent = '';
    $('pdf-preview').classList.add('visible');
    $('pdf-btn').classList.add('has-file');
    try {
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        text += tc.items.map((s) => s.str).join(' ') + '\n';
      }
      state.pendingPdf = { name: file.name, size: file.size, pages: pdf.numPages, text: text.trim() };
      $('pdf-name').textContent = file.name;
      $('pdf-size').textContent = `${fmtSize(file.size)} · ${pdf.numPages} Seite(n)`;
    } catch (err) {
      toast('PDF konnte nicht gelesen werden: ' + err.message, true);
      removePdf();
    }
    input.value = '';
  }

  function removePdf() {
    state.pendingPdf = null;
    $('pdf-preview').classList.remove('visible');
    $('pdf-btn').classList.remove('has-file');
    $('pdf-input').value = '';
  }

  // ---------- Senden ----------
  $('send-btn').addEventListener('click', () => sendMessage());
  const input = $('msg-input');
  input.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

  async function sendMessage() {
    const text = input.value.trim();
    const flow = state.activeFlow;
    if ((!text && !state.pendingPdf) || state.isLoading || !flow) return;
    if (state.activeResult && !isOwner(state.activeResult)) { toast('Geteilte Ergebnisse sind schreibgeschützt.', true); return; }

    const upload = state.pendingPdf;
    const resultId = state.activeResult?.id;
    input.value = ''; input.style.height = 'auto';
    removePdf();
    state.isLoading = true;
    $('send-btn').disabled = true;

    if (!resultId) $('messages').innerHTML = '';
    appendMessage('user', text || `📎 ${upload.name}`, new Date().toISOString(), upload ? { name: upload.name, pages: upload.pages } : null);
    appendTyping();

    try {
      const body = { question: text };
      if (resultId) body.resultId = resultId;
      if (upload) body.upload = upload;
      const data = await apiFetch('/api/flow/' + flow.type, { method: 'POST', body: JSON.stringify(body) });

      removeTyping();
      const idx = state.results.findIndex((r) => r.id === data.result.id);
      if (idx >= 0) state.results[idx] = data.result; else state.results.unshift(data.result);
      state.activeResult = data.result;
      $('header-name').textContent = data.result.title || flow.name;
      $('header-desc').textContent = `${flow.name} · ${fmtDate(data.result.created_at)}`;
      $('share-btn').hidden = false;
      renderAgents();
      renderArchive();
      typewriterMessage(data.answer, new Date().toISOString());
    } catch (err) {
      removeTyping();
      appendMessage('bot', 'Der Assistent konnte nicht antworten.\n\nDetails: ' + err.message, new Date().toISOString());
    }
    state.isLoading = false;
    $('send-btn').disabled = false;
    input.focus();
  }

  // ---------- Löschen ----------
  async function deleteResult(id) {
    const r = state.results.find((x) => x.id === id);
    if (!r || !isOwner(r)) return;
    const n = sharesFor(id).length;
    if (!confirm(`„${r.title || 'Ergebnis'}“ wirklich löschen?${n ? ` Es ist mit ${n} Kolleg(inn)en geteilt.` : ''}`)) return;
    try {
      await apiFetch('/api/results/' + id, { method: 'DELETE' });
      state.results = state.results.filter((x) => x.id !== id);
      state.shares = state.shares.filter((s) => s.result_id !== id);
      if (state.activeResult?.id === id) {
        state.activeResult = null;
        state.activeFlow = null;
        $('chat-view').classList.remove('open');
        $('welcome-state').style.display = '';
        renderAgents();
      }
      renderArchive();
      toast('Ergebnis gelöscht.');
    } catch (err) {
      toast('Löschen fehlgeschlagen: ' + err.message, true);
    }
  }

  // ---------- Teilen ----------
  $('share-btn').addEventListener('click', openShare);
  $('share-close').addEventListener('click', () => $('share-modal').classList.remove('open'));
  $('share-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('share-modal').classList.remove('open'); });

  function openShare() {
    const r = state.activeResult;
    if (!r || !isOwner(r)) return;
    $('share-sub').textContent = `„${r.title || 'Ergebnis'}“ – Kolleg(inn)en können es danach im Verlauf lesen, aber nicht ändern.`;
    renderShareList();
    $('share-modal').classList.add('open');
  }

  function renderShareList() {
    const r = state.activeResult;
    const list = $('share-list');
    list.innerHTML = '';
    const others = [...state.users.values()].filter((u) => u.id !== state.user.id);
    if (!others.length) { list.innerHTML = '<p class="share-empty">Noch keine weiteren Konten im Portal.</p>'; return; }
    const shared = new Set(sharesFor(r.id).map((s) => s.shared_with_id));
    others.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `<div><span class="share-name">${esc(u.display_name)}</span><span class="share-mail">${esc(u.email)}</span></div>`
        + `<button ${shared.has(u.id) ? 'disabled' : ''}>${shared.has(u.id) ? '✓ Geteilt' : 'Teilen'}</button>`;
      row.querySelector('button').addEventListener('click', () => shareWith(u));
      list.appendChild(row);
    });
  }

  async function shareWith(u) {
    const r = state.activeResult;
    if (!r) return;
    const { data, error } = await sb.from('result_shares')
      .insert({ result_id: r.id, shared_with_id: u.id, shared_by_id: state.user.id })
      .select().single();
    if (error) {
      toast(/duplicate|unique/i.test(error.message) ? 'Bereits geteilt.' : 'Teilen fehlgeschlagen: ' + error.message, true);
      return;
    }
    state.shares.push(data);
    renderShareList();
    renderArchive();
    toast(`Geteilt mit ${u.display_name}.`);
  }
})();
