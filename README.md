# Claude Full-Stack Starter

A small but complete full-stack JavaScript application: responsive browser UI,
Node/Express API, a pluggable database layer (SQLite **or** MongoDB, one line of
config), and a working Claude AI integration with token-by-token streaming.

It runs with a single command on a clean machine — no database server, no API
key, no build step.

```bash
npm install
cp .env.example .env
npm run dev          # → http://localhost:3000
```

---

## Contents

- [What's in the box](#whats-in-the-box)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Choosing a database](#choosing-a-database-sql-vs-nosql)
- [API reference](#api-reference)
- [The Claude integration](#the-claude-integration)
- [Data upload workflow](#data-upload-workflow)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Deployment](#deployment)
- [Production checklist](#production-checklist)

---

## What's in the box

| Requirement | Where it lives |
|---|---|
| Responsive UI, UI/UX best practices | `public/` — mobile-first CSS grid, light/dark themes, keyboard support, ARIA live regions, no framework |
| Node.js back-end with documented endpoints | `server/routes/` + [API reference](#api-reference) |
| Data upload workflow wired to the database | `server/routes/upload.js` — CSV → validate → transactional bulk insert |
| Working Claude AI integration | `server/claude.js` — streaming chat + schema-constrained JSON extraction |
| CRUD examples | `server/db/sqlite.js` and `server/db/mongo.js`, same interface |
| Clear environment variables | `.env.example`, every value documented inline |
| Single command in dev | `npm run dev` |
| Deploys cleanly to the cloud | [Deployment](#deployment) |

Three things worth calling out because they are the parts people usually get wrong:

**1. The database is swappable, not hard-coded.** Routes never touch a driver.
They call six methods on a repository object, and `DB_DRIVER=sqlite|mongo`
decides which implementation backs it. You can start on SQLite today and move to
Mongo (or Postgres — same shape) without editing a single route.

**2. Streaming actually streams.** The chat endpoint uses Server-Sent Events, and
the client reads the response body as a stream rather than waiting for the whole
answer. The `X-Accel-Buffering: no` header is set because otherwise nginx buffers
the whole response and streaming silently stops working in production.

**3. It runs without an API key.** With `ANTHROPIC_API_KEY` empty, the AI
endpoints fall back to a local mock that streams in the same wire format. You can
demo the entire app, run the tests, and hand it to a colleague before anyone has
provisioned a key. Add the key and the exact same code path hits the real API.

---

## Quick start

Requires **Node 20 or newer** (Node 22 recommended).

```bash
git clone <this repo>
cd claude-fullstack-starter

npm install
cp .env.example .env      # works as-is; add your Claude key when you have one

npm run dev               # dev server with auto-reload → http://localhost:3000
npm run seed              # optional: insert four demo notes
npm run smoke             # optional: end-to-end test against the running server
```

`npm start` runs the same server without the file watcher — that's the
production command.

---

## Environment variables

Every variable has a working default except `ANTHROPIC_API_KEY`. Full annotated
list is in `.env.example`; the summary:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mongo` |
| `SQLITE_PATH` | `./data/app.db` | Relative paths resolve from the project root, not the shell's cwd |
| `MONGO_URL` | `mongodb://127.0.0.1:27017` | Only read when `DB_DRIVER=mongo` |
| `MONGO_DB` | `claude_starter` | |
| `ANTHROPIC_API_KEY` | *(empty)* | Empty → AI endpoints use the local mock |
| `CLAUDE_MODEL` | `claude-opus-5` | `claude-sonnet-5` / `claude-haiku-4-5` are cheaper |
| `CLAUDE_EFFORT` | `medium` | `low` \| `medium` \| `high` \| `xhigh` \| `max` — cost/quality dial |
| `CLAUDE_MAX_TOKENS` | `8192` | Caps thinking **plus** the reply, so don't set it too tight |
| `MAX_UPLOAD_BYTES` | `5242880` | CSV upload cap (5 MB) |

Get an API key at <https://console.anthropic.com> → API Keys.

---

## Choosing a database (SQL vs NoSQL)

You asked for a recommendation rather than a menu, so here it is.

**Default to SQL.** For an application with users, records, and relationships
between them, a relational database is the lower-risk choice: foreign keys and
transactions stop invalid data existing in the first place, `JOIN` answers
questions you didn't anticipate at schema-design time, and every hosting
provider offers a managed Postgres for a few dollars a month. Modern Postgres
also has a first-class `JSONB` column type, so the "but our data is
semi-structured" case is covered without giving up the relational parts.

**Reach for a document store when** the records genuinely vary in shape from one
to the next (event payloads, per-tenant custom fields, scraped documents), when
you need write throughput past what a single primary can handle, or when the
access pattern is always "fetch this one document by id" and never "join across
five tables."

The practical answer for this project: **start on SQLite, migrate to Postgres
when you deploy.** SQLite means zero infrastructure while we build, and the SQL
in `server/db/sqlite.js` is standard enough that swapping the driver to `pg` is
an afternoon, not a rewrite. If your data turns out to be document-shaped,
`DB_DRIVER=mongo` is already implemented — point `MONGO_URL` at a server and run
`npm run smoke` to confirm it end to end in your environment. (The suite in this
repo was run against SQLite; the Mongo path implements the same interface but
has not been exercised against a live cluster here.)

### The repository interface

Both drivers implement exactly this. Adding a third (Postgres, MySQL, DynamoDB)
means writing one file:

```js
listNotes({ q, limit, offset })   // → { items, total }
getNote(id)                       // → note | null
createNote({ title, body, tags }) // → note
updateNote(id, patch)             // → note | null
deleteNote(id)                    // → boolean
bulkCreateNotes([...])            // → { inserted }
```

Two details in there that matter more than they look:

- **Sorts include an id tiebreaker** (`ORDER BY created_at DESC, id DESC`).
  Without it, rows created in the same millisecond sort unpredictably and
  paging can show you the same record twice while skipping another.
- **`total` is the count for the whole query**, not the size of the current
  page. Conflating the two is the single most common pagination bug.

---

## API reference

All responses are JSON. Errors use a consistent envelope:

```json
{ "error": { "message": "title is required" } }
```

### Health

| | |
|---|---|
| `GET /api/health` | Server status, active DB driver, whether Claude is configured |

```bash
curl localhost:3000/api/health
```
```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "db": { "driver": "sqlite", "location": "/app/data/app.db" },
  "claude": { "configured": false, "model": "claude-opus-5" }
}
```

### Notes (CRUD)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `GET` | `/api/notes` | `?q=` search, `?limit=` (1–100, default 20), `?offset=` | `{ items, pagination }` |
| `GET` | `/api/notes/:id` | — | note, or `404` |
| `POST` | `/api/notes` | `{ title*, body, tags[] }` | `201` + note |
| `PATCH` | `/api/notes/:id` | any subset of the above | note, or `404` |
| `DELETE` | `/api/notes/:id` | — | `204`, or `404` |

```bash
# create
curl -X POST localhost:3000/api/notes \
  -H 'Content-Type: application/json' \
  -d '{"title":"Kickoff","body":"Scope agreed","tags":["work"]}'

# search + paginate
curl 'localhost:3000/api/notes?q=kickoff&limit=10&offset=0'

# partial update
curl -X PATCH localhost:3000/api/notes/1 \
  -H 'Content-Type: application/json' -d '{"tags":["work","done"]}'

# delete
curl -X DELETE localhost:3000/api/notes/1
```

A note looks like:

```json
{
  "id": "1",
  "title": "Kickoff",
  "body": "Scope agreed",
  "tags": ["work"],
  "createdAt": "2026-08-18T09:14:02.117Z",
  "updatedAt": "2026-08-18T09:14:02.117Z"
}
```

`id` is always a string, on both drivers — so the front-end never has to care
that SQLite gives out integers and Mongo gives out ObjectIds.

### Upload

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/upload/csv` | `multipart/form-data`, field `file` | `{ received, inserted, rejected[], filename }` |
| `GET` | `/api/upload/template` | — | A sample CSV download |

```bash
curl -X POST localhost:3000/api/upload/csv -F file=@notes.csv
```

### Claude

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/ai/status` | — | `{ configured, model, effort }` |
| `POST` | `/api/ai/chat` | `{ message*, history[], includeNotes }` | `text/event-stream` |
| `POST` | `/api/ai/summarize/:id` | — | `{ summary, tags[], sentiment, note }` |

```bash
curl -N -X POST localhost:3000/api/ai/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarise my notes tagged work","includeNotes":true}'
```

The stream emits three event types:

```
event: delta
data: {"text":"Your notes "}

event: delta
data: {"text":"mention two "}

event: done
data: {"usage":{"input_tokens":812,"output_tokens":96},"mocked":false,"stopReason":"end_turn"}
```

`event: error` carries `{ "message": "..." }` if the upstream call fails
mid-stream. Because SSE headers are already sent by then, errors can't be
reported with an HTTP status — the client has to read this event, which is why
the front-end handles all three.

---

## The Claude integration

`server/claude.js` is the only file that imports the Anthropic SDK. Two
patterns are demonstrated, because between them they cover most real use cases.

### 1. Streaming chat

```js
const stream = client.messages.stream({
  model: config.claudeModel,
  max_tokens: config.claudeMaxTokens,
  thinking: { type: 'adaptive' },              // Claude decides how deep to reason
  output_config: { effort: config.claudeEffort },
  system: SYSTEM_PROMPT,
  messages,
});

for await (const chunk of stream.textStream) onText(chunk);
const final = await stream.finalMessage();     // usage, stop_reason
```

Notes on the choices:

- **Always stream** anything that can produce a long answer. It keeps the UI
  alive and avoids the SDK's HTTP timeout at large `max_tokens`.
- **`effort` is the cost dial**, not `max_tokens`. `low` is genuinely capable and
  much cheaper; `xhigh` is for hard agentic work. Start at `medium`.
- **`max_tokens` caps thinking plus reply.** If answers get cut off, the
  front-end surfaces `stopReason: "max_tokens"` in the message footer so you
  know to raise it rather than guessing.

### 2. Structured extraction (no JSON parsing hacks)

`POST /api/ai/summarize/:id` asks for a summary, tags, and sentiment, and gets
back JSON that is *guaranteed* to match the schema:

```js
output_config: {
  effort: 'low',
  format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        summary:   { type: 'string' },
        tags:      { type: 'array', items: { type: 'string' } },
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      },
      required: ['summary', 'tags', 'sentiment'],
      additionalProperties: false,
    },
  },
}
```

No "reply with only valid JSON" in the prompt, no regex to pull the object out
of prose, no retry loop when the model wraps it in a code fence. The result is
merged into the note's tags and written back to the database, so the AI output
lands in the store rather than only on screen.

### Prompt design

The system prompt lives in one exported constant. When `includeNotes` is on, the
user's notes are appended **after** the stable instructions:

```js
system = `${SYSTEM_PROMPT}\n\n<user_notes>\n${rendered}\n</user_notes>`;
```

That order matters for cost. Prompt caching is a prefix match, so anything that
changes per request has to sit at the end — otherwise the cacheable instruction
block is invalidated every time and you pay full price on each call.

Conversation history is capped at the last 10 turns before it's sent, so a long
session can't quietly grow into an expensive one.

---

## Data upload workflow

The pattern for getting user-generated data into the database, end to end:

1. Browser posts `multipart/form-data` to `POST /api/upload/csv`.
2. **multer** holds it in memory with a 5 MB cap and a `.csv`-only filter.
3. **csv-parse** parses it with headers; a malformed file returns `400` with the
   parser's message rather than a stack trace.
4. **Every row is validated before anything is written.** Bad rows are collected
   with their line numbers instead of aborting the batch.
5. Valid rows are inserted in **one transaction**, so a failure halfway through
   doesn't leave half a file committed.
6. The response reports `received`, `inserted`, and a `rejected` array — the UI
   shows the user exactly which lines failed and why.

```csv
title,body,tags
Kickoff meeting,Agreed scope and timeline,work;planning
Grocery list,Milk eggs coffee,personal
```

Tags are semicolon-separated inside the cell so commas stay free for the CSV
itself. `GET /api/upload/template` serves this file.

For files past ~50 MB, switch multer to `diskStorage` and stream the parse
instead of buffering — the validation and insert steps stay the same.

---

## Project layout

```
claude-fullstack-starter/
├── server/
│   ├── index.js              Express app, static hosting, graceful shutdown
│   ├── config.js             env parsing; paths resolve from the project root
│   ├── claude.js             Anthropic SDK wrapper + offline mock
│   ├── db/
│   │   ├── index.js          picks a driver, exposes one interface
│   │   ├── sqlite.js         SQL implementation (default)
│   │   └── mongo.js          document implementation
│   ├── routes/
│   │   ├── notes.js          CRUD + search + pagination
│   │   ├── upload.js         CSV ingest
│   │   └── ai.js             SSE chat, structured summarise
│   └── middleware/
│       └── errors.js         HttpError, async wrapper, error envelope
├── public/
│   ├── index.html            semantic markup, no build step
│   ├── styles.css            design tokens, responsive grid, light/dark
│   └── app.js                API client, SSE reader, rendering
├── scripts/
│   ├── seed.js               demo data
│   └── smoke-test.js         20 end-to-end assertions
├── .env.example
└── package.json
```

The front-end is deliberately framework-free so the API contract is readable
without knowing anyone's conventions. Dropping in React, Vue, or Svelte means
replacing `public/` and keeping every endpoint — `app.js` already isolates all
network calls behind a single `api()` helper.

---

## Testing

```bash
npm run dev      # terminal 1
npm run smoke    # terminal 2
```

`scripts/smoke-test.js` exercises every endpoint against a running server —
including reading the SSE stream and asserting that `delta` and `done` events
arrive — and exits non-zero on the first failure, so it drops into CI unchanged:

```yaml
- run: npm ci
- run: npm start & sleep 3
- run: npm run smoke
```

Point it at any environment with `BASE_URL=https://staging.example.com npm run smoke`.

---

## Deployment

The app is a single Node process serving both the API and the static front-end,
so anything that runs Node runs this.

### Render / Railway / Fly.io (simplest)

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Environment: set `NODE_ENV=production`, `ANTHROPIC_API_KEY`, and your DB vars

SQLite needs a **persistent disk** mounted (e.g. `/data`) with
`SQLITE_PATH=/data/app.db` — container filesystems are wiped on every deploy.
If the platform doesn't offer one, use a managed Postgres or Mongo instead.

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t claude-starter .
docker run -p 3000:3000 --env-file .env -v $PWD/data:/app/data claude-starter
```

### Behind nginx

Streaming needs buffering off, or replies arrive all at once at the end:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;          # required for SSE
  proxy_read_timeout 300s;      # long AI responses
}
```

The app already sends `X-Accel-Buffering: no`, which covers this too — belt and
braces, because this failure mode is invisible until it isn't.

---

## Production checklist

Things this starter deliberately leaves open, so you know what's missing rather
than discovering it later:

- [ ] **Authentication.** There is none — every note is public. Add sessions or
      JWT and an `ownerId` column before this touches real user data.
- [ ] **Rate limiting** on `/api/ai/*`. AI calls cost money per request; without
      a limit, one script can run up a bill. `express-rate-limit` keyed by user.
- [ ] **CORS.** Currently open (`cors()`), which is right for local development
      and wrong for production. Restrict to your front-end origin.
- [ ] **Secrets.** `.env` is gitignored; use the host's secret manager in
      production and rotate the API key if it's ever pasted into a chat or log.
- [ ] **Postgres** if you're staying relational — swap `better-sqlite3` for `pg`
      in `server/db/`, keep everything else.
- [ ] **Structured logging** (pino) and an error tracker (Sentry).
- [ ] **Backups** for whichever store you land on.

---

## Licence

MIT.
