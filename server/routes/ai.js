/**
 * Claude AI endpoints.
 *
 * POST /api/ai/chat            Server-Sent Events stream of the reply
 * POST /api/ai/summarize/:id   Structured JSON (summary + tags + sentiment)
 * GET  /api/ai/status          Whether a real API key is configured
 *
 * Why SSE rather than WebSockets: the traffic is one-directional (server ->
 * browser) and SSE is plain HTTP, so it works through every proxy and needs no
 * extra dependency on either side. EventSource can't POST, so the client uses
 * fetch() and reads the ReadableStream directly - see public/app.js.
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { config, hasClaudeKey } from '../config.js';
import { streamChat, summarizeNote, SYSTEM_PROMPT } from '../claude.js';
import { HttpError, asyncRoute } from '../middleware/errors.js';

export const aiRouter = Router();

aiRouter.get('/status', (req, res) => {
  res.json({
    configured: hasClaudeKey(),
    model: config.claudeModel,
    effort: config.claudeEffort,
  });
});

aiRouter.post(
  '/chat',
  asyncRoute(async (req, res) => {
    const { message, history = [], includeNotes = false } = req.body ?? {};

    if (typeof message !== 'string' || !message.trim()) {
      throw new HttpError(400, 'message is required');
    }
    if (message.length > 8000) {
      throw new HttpError(400, 'message must be 8000 characters or fewer');
    }
    if (!Array.isArray(history)) {
      throw new HttpError(400, 'history must be an array');
    }

    // Keep only the last 10 turns, and only the fields the API accepts.
    const priorTurns = history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    let system = SYSTEM_PROMPT;

    if (includeNotes) {
      const { items } = await db().listNotes({ limit: 25 });
      const rendered = items
        .map((n) => `- [${n.id}] ${n.title}${n.tags.length ? ` (${n.tags.join(', ')})` : ''}\n  ${n.body}`)
        .join('\n');

      // Notes go at the END of the system prompt, after the stable instructions.
      // Prompt caching is a prefix match, so keeping the volatile part last
      // means the instruction block stays cacheable across requests.
      system = `${SYSTEM_PROMPT}\n\n<user_notes>\n${rendered || '(no notes yet)'}\n</user_notes>`;
    }

    // SSE headers. `X-Accel-Buffering` stops nginx from buffering the stream,
    // which is the usual reason streaming "works locally but not in production".
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Listen on `res`, not `req`. On Node 20+ `req`'s "close" fires as soon as
    // the request body has been fully read - which is immediately, on every
    // request - so using it here silently swallows every chunk after the first.
    // `res`'s "close" is the real client-disconnect signal.
    let aborted = false;
    res.on('close', () => {
      aborted = true;
    });

    try {
      const result = await streamChat(
        { messages: [...priorTurns, { role: 'user', content: message }], system },
        (chunk) => {
          if (!aborted) send('delta', { text: chunk });
        }
      );

      if (!aborted) {
        send('done', {
          usage: result.usage,
          mocked: result.mocked,
          stopReason: result.stopReason,
        });
      }
    } catch (err) {
      console.error('[ai/chat]', err);
      send('error', { message: err.message ?? 'Claude request failed' });
    } finally {
      res.end();
    }
  })
);

aiRouter.post(
  '/summarize/:id',
  asyncRoute(async (req, res) => {
    const note = await db().getNote(req.params.id);
    if (!note) throw new HttpError(404, 'Note not found');

    const result = await summarizeNote({ title: note.title, body: note.body });

    // Merge the suggested tags into the stored note so the AI output actually
    // lands in the database rather than only in the UI.
    const merged = [...new Set([...note.tags, ...result.tags])].slice(0, 20);
    const updated = await db().updateNote(note.id, { tags: merged });

    res.json({ ...result, note: updated });
  })
);
