import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Project root, derived from this file rather than process.cwd().
 * dotenv and the SQLite path both key off it, so `node server/index.js`,
 * `npm run seed`, and a systemd unit with a different working directory all
 * read the same .env and open the same database file.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Relative paths are resolved against the project root, absolute ones pass through. */
const fromRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

export const config = {
  port: int(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  dbDriver: (process.env.DB_DRIVER ?? 'sqlite').toLowerCase(),
  sqlitePath: fromRoot(process.env.SQLITE_PATH ?? './data/app.db'),
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGO_DB ?? 'claude_starter',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-opus-5',
  claudeEffort: process.env.CLAUDE_EFFORT ?? 'medium',
  claudeMaxTokens: int(process.env.CLAUDE_MAX_TOKENS, 8192),

  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
};

export const hasClaudeKey = () => config.anthropicApiKey.trim().length > 0;
