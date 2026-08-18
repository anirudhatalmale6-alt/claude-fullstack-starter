/**
 * End-to-end smoke test against a running server.
 *
 *   npm run dev      # terminal 1
 *   npm run smoke    # terminal 2
 *
 * Exercises every endpoint including the SSE stream. Exits non-zero on the
 * first failure so it can be dropped into CI as-is.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function json(path, options) {
  const res = await fetch(BASE + path, {
    headers: options?.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : undefined,
    ...options,
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

console.log(`\nSmoke test against ${BASE}\n`);

// 1 ── health
const health = await json('/api/health');
check('GET  /api/health returns 200', health.status === 200, `got ${health.status}`);
check('     reports a db driver', Boolean(health.body?.db?.driver));

// 2 ── create
const created = await json('/api/notes', {
  method: 'POST',
  body: JSON.stringify({ title: 'Smoke test note', body: 'created by smoke-test.js', tags: ['smoke', 'test'] }),
});
check('POST /api/notes creates (201)', created.status === 201, `got ${created.status}`);
const id = created.body?.id;
check('     returns an id', Boolean(id));

// 3 ── validation
const bad = await json('/api/notes', { method: 'POST', body: JSON.stringify({ body: 'no title' }) });
check('POST /api/notes rejects a missing title (400)', bad.status === 400, `got ${bad.status}`);

// 4 ── read
const one = await json(`/api/notes/${id}`);
check('GET  /api/notes/:id returns the note', one.body?.title === 'Smoke test note');

const missing = await json('/api/notes/999999999');
check('GET  unknown id returns 404', missing.status === 404, `got ${missing.status}`);

// 5 ── list + search
const list = await json('/api/notes?limit=5');
check('GET  /api/notes lists with pagination', Array.isArray(list.body?.items) && 'total' in (list.body?.pagination ?? {}));

const search = await json('/api/notes?q=smoke');
check('GET  /api/notes?q= filters', search.body.items.some((n) => n.id === id));

// 6 ── update
const patched = await json(`/api/notes/${id}`, {
  method: 'PATCH',
  body: JSON.stringify({ title: 'Smoke test note (edited)' }),
});
check('PATCH updates the note', patched.body?.title === 'Smoke test note (edited)');
check('      preserves untouched fields', patched.body?.tags?.includes('smoke'));

// 7 ── CSV upload
const csv = 'title,body,tags\nUploaded A,from csv,smoke;csv\n,missing title,\nUploaded B,second row,smoke\n';
const fd = new FormData();
fd.append('file', new Blob([csv], { type: 'text/csv' }), 'test.csv');
const upload = await json('/api/upload/csv', { method: 'POST', body: fd });
check('POST /api/upload/csv imports valid rows', upload.body?.inserted === 2, JSON.stringify(upload.body));
check('     reports the rejected row', upload.body?.rejected?.length === 1);

// 8 ── AI status
const aiStatus = await json('/api/ai/status');
check('GET  /api/ai/status responds', aiStatus.status === 200);
console.log(`     (claude ${aiStatus.body?.configured ? `live: ${aiStatus.body.model}` : 'mock mode — no API key'})`);

// 9 ── streaming chat
const chatRes = await fetch(`${BASE}/api/ai/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Reply with the single word: pong', includeNotes: false }),
});
check('POST /api/ai/chat opens an SSE stream', chatRes.headers.get('content-type')?.includes('text/event-stream'));

let raw = '';
for await (const chunk of chatRes.body.pipeThrough(new TextDecoderStream())) raw += chunk;
const deltas = [...raw.matchAll(/^event: delta$/gm)].length;
check('     streams delta events', deltas > 0, `got ${deltas}`);
check('     finishes with a done event', /^event: done$/m.test(raw));

// 10 ── summarize
const summary = await json(`/api/ai/summarize/${id}`, { method: 'POST' });
check('POST /api/ai/summarize/:id returns structured JSON',
  typeof summary.body?.summary === 'string' && Array.isArray(summary.body?.tags),
  JSON.stringify(summary.body)?.slice(0, 120));

// 11 ── delete
const del = await json(`/api/notes/${id}`, { method: 'DELETE' });
check('DELETE removes the note (204)', del.status === 204, `got ${del.status}`);
const gone = await json(`/api/notes/${id}`);
check('       the note is really gone (404)', gone.status === 404);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
