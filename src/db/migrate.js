import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import '../models/index.js';

/**
 * MongoDB creates collections on first write, so "migrating" here means
 * building the indexes the schemas declare — the unique constraints the SQL
 * build got from UNIQUE KEY, plus the TTL index that expires refresh tokens.
 *
 * `--fresh` drops the whole database first.
 */
const fresh = process.argv.includes('--fresh');

async function migrate() {
  const conn = await connectDatabase();
  console.log(`• connected to ${conn.host}/${conn.name}`);

  if (fresh) {
    await conn.dropDatabase();
    console.log(`• dropped database ${conn.name}`);
  }

  const names = Object.keys(mongoose.models).sort();
  for (const name of names) {
    const model = mongoose.models[name];
    try {
      // Collections are otherwise created lazily on first write, and a model
      // with no extra indexes (Counter) would never materialise here.
      // eslint-disable-next-line no-await-in-loop
      await model.createCollection();
    } catch (err) {
      if (err.codeName !== 'NamespaceExists' && err.code !== 48) throw err;
    }
    // eslint-disable-next-line no-await-in-loop
    await model.createIndexes();
    // eslint-disable-next-line no-await-in-loop
    const indexes = await model.collection.indexes();
    console.log(`    - ${model.collection.collectionName} (${indexes.length} indexes)`);
  }

  console.log(`• indexes synced — ${names.length} collections`);
}

migrate()
  .then(async () => {
    console.log('\nMigration complete.');
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nMigration failed:', err.message);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
