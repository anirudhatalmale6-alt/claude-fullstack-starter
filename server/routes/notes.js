/**
 * CRUD endpoints for notes.
 *
 * GET    /api/notes           list + search + paginate
 * GET    /api/notes/:id       fetch one
 * POST   /api/notes           create
 * PATCH  /api/notes/:id       partial update
 * DELETE /api/notes/:id       delete
 */
import { Router } from 'express';
import { db } from '../db/index.js';
import { HttpError, asyncRoute } from '../middleware/errors.js';

export const notesRouter = Router();

function validateNoteBody(body, { partial = false } = {}) {
  const out = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw new HttpError(400, 'title must be a non-empty string');
    }
    if (body.title.length > 200) {
      throw new HttpError(400, 'title must be 200 characters or fewer');
    }
    out.title = body.title.trim();
  } else if (!partial) {
    throw new HttpError(400, 'title is required');
  }

  if (body.body !== undefined) {
    if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
    if (body.body.length > 20000) throw new HttpError(400, 'body must be 20000 characters or fewer');
    out.body = body.body;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      throw new HttpError(400, 'tags must be an array of strings');
    }
    // Commas are the SQLite row separator - strip them so a tag can't corrupt
    // the stored list.
    out.tags = body.tags.map((t) => t.trim().replace(/,/g, '')).filter(Boolean).slice(0, 20);
  }

  return out;
}

notesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '20', 10) || 20, 1), 100);
    const offset = Math.max(Number.parseInt(req.query.offset ?? '0', 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const { items, total } = await db().listNotes({ q, limit, offset });

    res.json({
      items,
      // `total` is the count for the whole query, not the length of this page -
      // the two are different numbers and mixing them up is a classic bug.
      pagination: { total, limit, offset, hasMore: offset + items.length < total },
    });
  })
);

notesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const note = await db().getNote(req.params.id);
    if (!note) throw new HttpError(404, 'Note not found');
    res.json(note);
  })
);

notesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const payload = validateNoteBody(req.body ?? {});
    const note = await db().createNote({ body: '', tags: [], ...payload });
    res.status(201).json(note);
  })
);

notesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const patch = validateNoteBody(req.body ?? {}, { partial: true });
    if (!Object.keys(patch).length) throw new HttpError(400, 'No updatable fields supplied');

    const note = await db().updateNote(req.params.id, patch);
    if (!note) throw new HttpError(404, 'Note not found');
    res.json(note);
  })
);

notesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const ok = await db().deleteNote(req.params.id);
    if (!ok) throw new HttpError(404, 'Note not found');
    res.status(204).end();
  })
);
