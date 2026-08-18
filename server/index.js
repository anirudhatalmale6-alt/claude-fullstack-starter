import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';

import { config, hasClaudeKey } from './config.js';
import { initDb, db } from './db/index.js';
import { notesRouter } from './routes/notes.js';
import { uploadRouter } from './routes/upload.js';
import { aiRouter } from './routes/ai.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Static front-end. In production put this behind nginx/CloudFront instead.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    db: { driver: db().driver, location: db().location },
    claude: { configured: hasClaudeKey(), model: config.claudeModel },
  });
});

app.use('/api/notes', notesRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/ai', aiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

const server = await start();

async function start() {
  await initDb();

  const s = app.listen(config.port, () => {
    console.log(`\n  ▶ http://localhost:${config.port}`);
    console.log(`    database : ${db().driver} (${db().location})`);
    console.log(
      `    claude   : ${
        hasClaudeKey() ? `${config.claudeModel}, effort=${config.claudeEffort}` : 'NO API KEY - using local mock'
      }\n`
    );
  });

  return s;
}

// Close the DB handle cleanly so SQLite's WAL is checkpointed on exit.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} received, shutting down`);
    server.close();
    await db().close?.();
    process.exit(0);
  });
}

export { app };
