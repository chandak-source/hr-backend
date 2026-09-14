import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';

const app = createApp();

// Bind the port first so container health checks pass even while MongoDB is
// still connecting; `/health` reports the database separately.
const server = app.listen(env.port, () => {
  console.log(`SuperAipHr API  →  http://localhost:${env.port}${env.apiPrefix}  [${env.nodeEnv}]`);
});

try {
  const conn = await connectDatabase();
  console.log(`MongoDB connected  →  ${conn.host}/${conn.name}`);
} catch (err) {
  console.error(`MongoDB unreachable  →  ${err.message}`);
  console.error('API is up but every data route will fail until the database is reachable.');
}

/** Drain in-flight requests, close the connection, then exit. */
async function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(async () => {
    try {
      await disconnectDatabase();
    } catch {
      // already closed
    }
    process.exit(0);
  });
  // Don't let a hung connection block the exit forever.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
