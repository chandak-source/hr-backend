import dns from 'node:dns';

import mongoose from 'mongoose';

import { env } from './env.js';

if (env.mongo.dnsServers.length) dns.setServers(env.mongo.dnsServers);

mongoose.set('strictQuery', true);
// Fail fast instead of buffering a query forever when the pool is down.
mongoose.set('bufferCommands', false);

export async function connectDatabase() {
  await mongoose.connect(env.mongo.uri, {
    dbName: env.mongo.dbName,
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 10,
  });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

export async function pingDatabase() {
  if (mongoose.connection.readyState !== 1) throw new Error('Not connected');
  await mongoose.connection.db.admin().command({ ping: 1 });
}

let transactionsUnsupported = false;

/**
 * Run `fn` inside a multi-document transaction.
 *
 * Atlas (a replica set) supports these. A standalone `mongod` does not, so the
 * first such failure downgrades to running without a session — the writes still
 * happen, just without all-or-nothing rollback. The warning is printed once.
 */
export async function withTransaction(fn) {
  if (transactionsUnsupported) return fn(null);

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      transactionsUnsupported = true;
      console.warn(
        'This MongoDB deployment does not support transactions (standalone server?) — ' +
          'writes will run unbatched, without rollback. Use a replica set or Atlas for atomicity.',
      );
      return fn(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

function isTransactionUnsupported(err) {
  const message = String(err?.message ?? '');
  return (
    err?.code === 20 ||
    err?.codeName === 'IllegalOperation' ||
    message.includes('Transaction numbers are only allowed') ||
    message.includes('replica set') ||
    message.includes('transactions are not supported')
  );
}

export { mongoose };
