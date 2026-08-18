/**
 * MongoDB implementation of the same repository interface.
 *
 * Set DB_DRIVER=mongo in .env and every route keeps working unchanged.
 * Use this when documents are schema-light / deeply nested, or when you want
 * horizontal sharding sooner than a relational store would give it to you.
 */
import { MongoClient, ObjectId } from 'mongodb';

function toNote(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    title: doc.title,
    body: doc.body ?? '',
    tags: doc.tags ?? [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function asObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

export async function createMongoRepo(config) {
  const client = new MongoClient(config.mongoUrl);
  await client.connect();

  const coll = client.db(config.mongoDb).collection('notes');

  // Indexes are created once at startup, not per query.
  await coll.createIndex({ createdAt: -1, _id: -1 });
  await coll.createIndex({ title: 'text', body: 'text' });

  const nowIso = () => new Date().toISOString();

  return {
    driver: 'mongo',
    location: `${config.mongoUrl}/${config.mongoDb}`,

    async listNotes({ q = '', limit = 20, offset = 0 } = {}) {
      const filter = q
        ? {
            $or: [
              { title: { $regex: q, $options: 'i' } },
              { body: { $regex: q, $options: 'i' } },
              { tags: { $regex: q, $options: 'i' } },
            ],
          }
        : {};

      const total = await coll.countDocuments(filter);
      const docs = await coll
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })  // _id tiebreaker keeps paging stable
        .skip(offset)
        .limit(limit)
        .toArray();

      return { items: docs.map(toNote), total };
    },

    async getNote(id) {
      const _id = asObjectId(id);
      if (!_id) return null;
      return toNote(await coll.findOne({ _id }));
    },

    async createNote({ title, body = '', tags = [] }) {
      const ts = nowIso();
      const doc = { title, body, tags, createdAt: ts, updatedAt: ts };
      const res = await coll.insertOne(doc);
      return toNote({ ...doc, _id: res.insertedId });
    },

    async updateNote(id, patch) {
      const _id = asObjectId(id);
      if (!_id) return null;

      const $set = { updatedAt: nowIso() };
      if (patch.title !== undefined) $set.title = patch.title;
      if (patch.body !== undefined) $set.body = patch.body;
      if (patch.tags !== undefined) $set.tags = patch.tags;

      const doc = await coll.findOneAndUpdate(
        { _id },
        { $set },
        { returnDocument: 'after' }
      );
      return toNote(doc);
    },

    async deleteNote(id) {
      const _id = asObjectId(id);
      if (!_id) return false;
      const res = await coll.deleteOne({ _id });
      return res.deletedCount > 0;
    },

    async bulkCreateNotes(notes) {
      if (!notes.length) return { inserted: 0 };
      const ts = nowIso();
      const res = await coll.insertMany(
        notes.map((n) => ({
          title: n.title,
          body: n.body ?? '',
          tags: n.tags ?? [],
          createdAt: ts,
          updatedAt: ts,
        }))
      );
      return { inserted: res.insertedCount };
    },

    async close() {
      await client.close();
    },
  };
}
