/* ---------------------------------------------------------------------------
   Notebook front-end — vanilla ES modules, no build step.

   Three pieces worth reading:
     1. api()        — one place that talks to the backend and normalises errors
     2. streamChat() — reads the SSE body with fetch + ReadableStream, because
                       EventSource cannot POST
     3. render()     — the list is re-rendered from state; there is no DOM diffing
                       here on purpose, the dataset is small and the code stays
                       obvious. Swap in React/Vue without touching the API layer.
--------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);

const el = {
  dbDriver: $('#db-driver'),
  aiStatus: $('#ai-status'),
  themeToggle: $('#theme-toggle'),

  search: $('#search'),
  noteList: $('#note-list'),
  newNote: $('#new-note'),
  pager: $('#pager'),
  pagerInfo: $('#pager-info'),
  prevPage: $('#prev-page'),
  nextPage: $('#next-page'),

  form: $('#note-form'),
  title: $('#title'),
  body: $('#body'),
  tags: $('#tags'),
  save: $('#save-note'),
  del: $('#delete-note'),
  summarize: $('#summarize-note'),
  editorState: $('#editor-state'),
  aiResult: $('#ai-result'),

  uploadForm: $('#upload-form'),
  csvFile: $('#csv-file'),
  uploadResult: $('#upload-result'),

  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  chatSend: $('#chat-send'),
  includeNotes: $('#include-notes'),

  toast: $('#toast'),
};

const PAGE_SIZE = 15;

const state = {
  notes: [],
  total: 0,
  offset: 0,
  query: '',
  selectedId: null,
  history: [],
  streaming: false,
};

/* --- api helper ---------------------------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : undefined,
    ...options,
  });

  if (res.status === 204) return null;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error?.message ?? `Request failed (${res.status})`);
  }
  return payload;
}

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', isError);
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --- notes --------------------------------------------------------------- */

async function loadNotes() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.offset });
  if (state.query) params.set('q', state.query);

  try {
    const data = await api(`/api/notes?${params}`);
    state.notes = data.items;
    state.total = data.pagination.total;
    renderNotes();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderNotes() {
  if (!state.notes.length) {
    el.noteList.innerHTML = `<li class="empty-state">${
      state.query ? 'Nothing matches that search.' : 'No notes yet — create one or upload a CSV.'
    }</li>`;
  } else {
    el.noteList.innerHTML = state.notes
      .map(
        (n) => `
        <li>
          <button class="note-item ${n.id === state.selectedId ? 'is-active' : ''}"
                  type="button" data-id="${n.id}">
            <h3>${escapeHtml(n.title)}</h3>
            ${n.body ? `<p>${escapeHtml(n.body)}</p>` : ''}
            ${n.tags.length
              ? `<div class="tag-row">${n.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
              : ''}
          </button>
        </li>`
      )
      .join('');
  }

  const showPager = state.total > PAGE_SIZE;
  el.pager.hidden = !showPager;
  if (showPager) {
    const from = state.offset + 1;
    const to = Math.min(state.offset + state.notes.length, state.total);
    el.pagerInfo.textContent = `${from}–${to} of ${state.total}`;
    el.prevPage.disabled = state.offset === 0;
    el.nextPage.disabled = state.offset + PAGE_SIZE >= state.total;
  }
}

function selectNote(note) {
  state.selectedId = note?.id ?? null;
  el.title.value = note?.title ?? '';
  el.body.value = note?.body ?? '';
  el.tags.value = note?.tags?.join(', ') ?? '';
  el.editorState.textContent = note ? `Editing · ${note.id}` : 'New note';
  el.del.hidden = !note;
  el.summarize.hidden = !note;
  el.save.textContent = note ? 'Save changes' : 'Save note';
  el.aiResult.hidden = true;
  renderNotes();
}

function readForm() {
  return {
    title: el.title.value.trim(),
    body: el.body.value,
    tags: el.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
  };
}

el.noteList.addEventListener('click', (e) => {
  const btn = e.target.closest('.note-item');
  if (!btn) return;
  selectNote(state.notes.find((n) => n.id === btn.dataset.id));
});

el.newNote.addEventListener('click', () => {
  selectNote(null);
  el.title.focus();
});

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = readForm();

  if (!payload.title) {
    toast('A title is required', true);
    el.title.focus();
    return;
  }

  el.save.disabled = true;
  try {
    const saved = state.selectedId
      ? await api(`/api/notes/${state.selectedId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/api/notes', { method: 'POST', body: JSON.stringify(payload) });

    if (!state.selectedId) state.offset = 0;
    await loadNotes();
    selectNote(saved);
    toast('Saved');
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.save.disabled = false;
  }
});

el.del.addEventListener('click', async () => {
  if (!state.selectedId) return;
  if (!confirm('Delete this note? This cannot be undone.')) return;

  try {
    await api(`/api/notes/${state.selectedId}`, { method: 'DELETE' });
    selectNote(null);
    await loadNotes();
    toast('Deleted');
  } catch (err) {
    toast(err.message, true);
  }
});

el.summarize.addEventListener('click', async () => {
  if (!state.selectedId) return;

  el.summarize.disabled = true;
  el.summarize.textContent = '✨ Thinking…';
  try {
    const r = await api(`/api/ai/summarize/${state.selectedId}`, { method: 'POST' });
    el.aiResult.hidden = false;
    el.aiResult.classList.remove('is-error');
    el.aiResult.innerHTML = `
      <strong>Summary</strong>${r.mocked ? ' <span class="muted small">(mock — no API key)</span>' : ''}
      <p>${escapeHtml(r.summary)}</p>
      <p class="muted small">Sentiment: ${escapeHtml(r.sentiment)} · tags added: ${
        r.tags.map(escapeHtml).join(', ')
      }</p>`;
    el.tags.value = r.note.tags.join(', ');
    await loadNotes();
  } catch (err) {
    el.aiResult.hidden = false;
    el.aiResult.classList.add('is-error');
    el.aiResult.textContent = err.message;
  } finally {
    el.summarize.disabled = false;
    el.summarize.textContent = '✨ Summarise with Claude';
  }
});

/* Debounced search — one request per pause, not one per keystroke. */
let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value.trim();
    state.offset = 0;
    loadNotes();
  }, 250);
});

el.prevPage.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadNotes();
});
el.nextPage.addEventListener('click', () => {
  state.offset += PAGE_SIZE;
  loadNotes();
});

/* --- CSV upload ---------------------------------------------------------- */

el.uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = el.csvFile.files?.[0];
  if (!file) return toast('Choose a CSV first', true);

  const fd = new FormData();
  fd.append('file', file);

  try {
    const r = await api('/api/upload/csv', { method: 'POST', body: fd });
    el.uploadResult.hidden = false;
    el.uploadResult.classList.remove('is-error');
    el.uploadResult.innerHTML = `
      <strong>${r.inserted} of ${r.received} rows imported</strong>
      ${r.rejected.length
        ? `<ul>${r.rejected.slice(0, 8).map((x) => `<li>line ${x.line}: ${escapeHtml(x.reason)}</li>`).join('')}${
            r.rejected.length > 8 ? `<li>…and ${r.rejected.length - 8} more</li>` : ''
          }</ul>`
        : ''}`;
    el.uploadForm.reset();
    state.offset = 0;
    await loadNotes();
  } catch (err) {
    el.uploadResult.hidden = false;
    el.uploadResult.classList.add('is-error');
    el.uploadResult.textContent = err.message;
  }
});

/* --- streaming chat ------------------------------------------------------ */

function addMessage(role, text = '') {
  el.chatLog.querySelector('.chat-empty')?.remove();

  const node = document.createElement('div');
  node.className = `msg msg-${role}`;
  node.textContent = text;
  el.chatLog.append(node);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
  return node;
}

async function streamChat(message) {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history: state.history.slice(-10),
      includeNotes: el.includeNotes.checked,
    }),
  });

  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error?.message ?? `Stream failed (${res.status})`);
  }

  const node = addMessage('ai');
  node.classList.add('caret');

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let answer = '';
  let meta = null;

  // SSE frames are separated by a blank line. Chunks can split a frame, so we
  // keep the tail in `buffer` until the terminator arrives.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += value;
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const dataLine = frame.match(/^data: (.*)$/m)?.[1];
      if (!event || dataLine === undefined) continue;

      const data = JSON.parse(dataLine);

      if (event === 'delta') {
        answer += data.text;
        node.textContent = answer;
        el.chatLog.scrollTop = el.chatLog.scrollHeight;
      } else if (event === 'done') {
        meta = data;
      } else if (event === 'error') {
        node.classList.add('is-error');
        node.textContent = answer + `\n\n[${data.message}]`;
      }
    }
  }

  node.classList.remove('caret');

  if (meta) {
    const bits = [];
    if (meta.mocked) bits.push('mock reply — no ANTHROPIC_API_KEY set');
    if (meta.usage) bits.push(`${meta.usage.input_tokens} in / ${meta.usage.output_tokens} out tokens`);
    if (meta.stopReason === 'max_tokens') bits.push('truncated — raise CLAUDE_MAX_TOKENS');
    if (bits.length) {
      const m = document.createElement('div');
      m.className = 'msg-meta';
      m.textContent = bits.join(' · ');
      node.append(m);
    }
  }

  return answer;
}

el.chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = el.chatInput.value.trim();
  if (!message || state.streaming) return;

  addMessage('user', message);
  el.chatInput.value = '';
  el.chatInput.style.height = 'auto';

  state.streaming = true;
  el.chatSend.disabled = true;

  try {
    const answer = await streamChat(message);
    state.history.push({ role: 'user', content: message }, { role: 'assistant', content: answer });
  } catch (err) {
    addMessage('ai', err.message).classList.add('is-error');
  } finally {
    state.streaming = false;
    el.chatSend.disabled = false;
    el.chatInput.focus();
  }
});

// Enter sends, Shift+Enter is a newline; the textarea grows with its content.
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.chatForm.requestSubmit();
  }
});
el.chatInput.addEventListener('input', () => {
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 144)}px`;
});

/* --- theme --------------------------------------------------------------- */

const savedTheme = localStorage.getItem('notebook-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

el.themeToggle.addEventListener('click', () => {
  const current =
    document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('notebook-theme', next);
});

/* --- boot ---------------------------------------------------------------- */

async function boot() {
  try {
    const health = await api('/api/health');
    el.dbDriver.textContent = health.db.driver;

    const live = health.claude.configured;
    el.aiStatus.classList.toggle('is-live', live);
    el.aiStatus.classList.toggle('is-mock', !live);
    el.aiStatus.querySelector('.pill-text').textContent = live
      ? health.claude.model
      : 'mock mode — no API key';
  } catch {
    el.aiStatus.querySelector('.pill-text').textContent = 'server unreachable';
  }

  await loadNotes();
  selectNote(null);
}

boot();
