import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool, pingDatabase } from './config/db.js';

const app = createApp();

// Bind the port first so container health checks pass even while MySQL warms up;
// `/health` reports the database separately.
const server = app.listen(env.port, () => {
  console.log(`Chanda HR API  →  http://localhost:${env.port}${env.apiPrefix}  [${env.nodeEnv}]`);
});

try {
  await pingDatabase();
  console.log(`MySQL connected  →  ${env.db.host}:${env.db.port}/${env.db.database}`);
} catch (err) {
  console.error(`MySQL unreachable  →  ${err.message}`);
  console.error('API is up but every data route will fail until the database is reachable.');
}

/** Drain in-flight requests, close the pool, then exit. */
async function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(async () => {
    try {
      await pool.end();
    } catch {
      // pool already closed
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
