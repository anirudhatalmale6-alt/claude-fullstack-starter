/**
 * Database facade.
 *
 * Routes never import a driver directly - they import this module and get an
 * object with the same six methods no matter which store is configured.
 * That's the whole point: choosing SQL vs NoSQL becomes a one-line change in
 * .env instead of a rewrite.
 *
 *   listNotes({ q, limit, offset })  -> { items, total }
 *   getNote(id)                      -> note | null
 *   createNote({ title, body, tags })-> note
 *   updateNote(id, patch)            -> note | null
 *   deleteNote(id)                   -> boolean
 *   bulkCreateNotes([...])           -> { inserted }
 */
import { config } from '../config.js';

let impl = null;

export async function initDb() {
  if (impl) return impl;

  if (config.dbDriver === 'mongo') {
    const { createMongoRepo } = await import('./mongo.js');
    impl = await createMongoRepo(config);
  } else {
    const { createSqliteRepo } = await import('./sqlite.js');
    impl = createSqliteRepo(config);
  }

  return impl;
}

export function db() {
  if (!impl) throw new Error('Database not initialised - call initDb() first');
  return impl;
}
