/**
 * Data upload workflow: browser -> multipart POST -> parse -> validate ->
 * transactional bulk insert -> report.
 *
 * POST /api/upload/csv          multipart/form-data, field name "file"
 * GET  /api/upload/template     downloads a sample CSV so the user knows the shape
 *
 * The file is held in memory (5 MB cap) rather than written to disk - nothing
 * is persisted until the rows validate, so a malformed upload leaves no mess.
 * For files above ~50 MB switch multer to diskStorage and stream the parse.
 */
import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, asyncRoute } from '../middleware/errors.js';

export const uploadRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter(req, file, cb) {
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/plain' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(ok ? null : new HttpError(400, 'Only .csv files are accepted'), ok);
  },
});

const TEMPLATE = `title,body,tags
Kickoff meeting,Agreed on scope and timeline for phase one,work;planning
Grocery list,Milk eggs coffee,personal
Bug: login redirect,Users bounce back to /login after a successful POST,work;bug
`;

uploadRouter.get('/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="notes-template.csv"');
  res.send(TEMPLATE);
});

uploadRouter.post(
  '/csv',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded (expected form field "file")');

    let records;
    try {
      records = parse(req.file.buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch (err) {
      throw new HttpError(400, `Could not parse CSV: ${err.message}`);
    }

    if (!records.length) throw new HttpError(400, 'The CSV contained no data rows');
    if (records.length > 5000) throw new HttpError(400, 'Maximum 5000 rows per upload');

    // Validate everything first, then insert. Rows are reported individually so
    // the user sees exactly which line failed rather than a generic error.
    const valid = [];
    const rejected = [];

    records.forEach((row, i) => {
      const line = i + 2; // +1 for zero-index, +1 for the header row
      const title = (row.title ?? row.Title ?? '').trim();

      if (!title) {
        rejected.push({ line, reason: 'missing title' });
        return;
      }
      if (title.length > 200) {
        rejected.push({ line, reason: 'title longer than 200 characters' });
        return;
      }

      const rawTags = (row.tags ?? row.Tags ?? '').trim();
      valid.push({
        title,
        body: (row.body ?? row.Body ?? '').trim(),
        // Semicolons separate tags inside the CSV cell so commas stay free for
        // the CSV itself.
        tags: rawTags ? rawTags.split(';').map((t) => t.trim()).filter(Boolean) : [],
      });
    });

    const { inserted } = valid.length ? await db().bulkCreateNotes(valid) : { inserted: 0 };

    res.status(rejected.length && !inserted ? 422 : 200).json({
      received: records.length,
      inserted,
      rejected,
      filename: req.file.originalname,
    });
  })
);
