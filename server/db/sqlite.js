/**
 * SQLite implementation of the note repository.
 *
 * Chosen as the default because it needs zero infrastructure: the file is
 * created on first run, so `npm run dev` works on a clean machine. The schema
 * and queries below are plain SQL, so moving to Postgres/MySQL later is a
 * driver swap (better-sqlite3 -> pg) rather than a redesign.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',      -- comma separated, kept simple on purpose
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_title      ON notes(title);
`;

const nowIso = () => new Date().toISOString();

function toNote(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    title: row.title,
    body: row.body,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteRepo(config) {
  const file = path.resolve(config.sqlitePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');   // concurrent reads while writing
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA);

  const stmt = {
    insert: conn.prepare(
      `INSERT INTO notes (title, body, tags, created_at, updated_at)
       VALUES (@title, @body, @tags, @created_at, @updated_at)`
    ),
    byId: conn.prepare('SELECT * FROM notes WHERE id = ?'),
    del: conn.prepare('DELETE FROM notes WHERE id = ?'),
  };

  return {
    driver: 'sqlite',
    location: file,

    listNotes({ q = '', limit = 20, offset = 0 } = {}) {
      const where = q ? 'WHERE title LIKE @like OR body LIKE @like OR tags LIKE @like' : '';
      const params = { like: `%${q}%`, limit, offset };

      const total = conn
        .prepare(`SELECT COUNT(*) AS n FROM notes ${where}`)
        .get(params).n;

      // ORDER BY includes id as a tiebreaker: two notes created in the same
      // millisecond would otherwise sort non-deterministically and paging
      // could show the same row twice (or skip one).
      const rows = conn
        .prepare(
          `SELECT * FROM notes ${where}
           ORDER BY created_at DESC, id DESC
           LIMIT @limit OFFSET @offset`
        )
        .all(params);

      return { items: rows.map(toNote), total };
    },

    getNote(id) {
      return toNote(stmt.byId.get(id));
    },

    createNote({ title, body = '', tags = [] }) {
      const ts = nowIso();
      const info = stmt.insert.run({
        title,
        body,
        tags: tags.join(','),
        created_at: ts,
        updated_at: ts,
      });
      return toNote(stmt.byId.get(info.lastInsertRowid));
    },

    updateNote(id, patch) {
      const existing = stmt.byId.get(id);
      if (!existing) return null;

      const next = {
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        tags: patch.tags ? patch.tags.join(',') : existing.tags,
        updated_at: nowIso(),
        id,
      };

      conn
        .prepare(
          `UPDATE notes SET title = @title, body = @body, tags = @tags,
                            updated_at = @updated_at
           WHERE id = @id`
        )
        .run(next);

      return toNote(stmt.byId.get(id));
    },

    deleteNote(id) {
      return stmt.del.run(id).changes > 0;
    },

    // Wrapped in a transaction so a bad row halfway through a CSV import
    // doesn't leave half the file committed.
    bulkCreateNotes(notes) {
      const insertMany = conn.transaction((rows) => {
        const ts = nowIso();
        for (const n of rows) {
          stmt.insert.run({
            title: n.title,
            body: n.body ?? '',
            tags: (n.tags ?? []).join(','),
            created_at: ts,
            updated_at: ts,
          });
        }
        return rows.length;
      });

      return { inserted: insertMany(notes) };
    },

    close() {
      conn.close();
    },
  };
}
