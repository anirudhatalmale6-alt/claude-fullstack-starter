/** Populate the configured database with a handful of demo notes. */
import { initDb, db } from '../server/db/index.js';

const SAMPLES = [
  {
    title: 'Project kickoff',
    body: 'Agreed the scope for phase one: responsive UI, Node API, and the Claude integration. Timeline is two weeks.',
    tags: ['work', 'planning'],
  },
  {
    title: 'SQL or NoSQL?',
    body: 'Relational wins when the data has real relationships and you need joins and transactions. Document stores win when the shape varies per record and you want to scale writes horizontally.',
    tags: ['architecture', 'database'],
  },
  {
    title: 'Bug: login redirect loop',
    body: 'After a successful POST /login users bounce back to the login page. Suspect the session cookie is being set without SameSite on the API subdomain.',
    tags: ['work', 'bug'],
  },
  {
    title: 'Deployment checklist',
    body: 'Set NODE_ENV=production, provision the database, add ANTHROPIC_API_KEY to the host secrets, point the health check at /api/health.',
    tags: ['devops'],
  },
];

await initDb();
const { inserted } = await db().bulkCreateNotes(SAMPLES);
console.log(`Seeded ${inserted} notes into ${db().driver} (${db().location})`);
await db().close?.();
process.exit(0);
