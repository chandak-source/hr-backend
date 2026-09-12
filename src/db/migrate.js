import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { env } from '../config/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const fresh = process.argv.includes('--fresh');

async function migrate() {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    ssl: env.db.ssl,
    multipleStatements: true,
  });

  try {
    if (fresh) {
      await conn.query(`DROP DATABASE IF EXISTS \`${env.db.database}\``);
      console.log(`• dropped database ${env.db.database}`);
    }

    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${env.db.database}\``);
    console.log(`• database ready: ${env.db.database}`);

    const schema = await readFile(join(here, 'schema.sql'), 'utf8');
    await conn.query(schema);

    const [tables] = await conn.query('SHOW TABLES');
    console.log(`• schema applied — ${tables.length} tables`);
    for (const row of tables) console.log(`    - ${Object.values(row)[0]}`);
  } finally {
    await conn.end();
  }
}

migrate()
  .then(() => {
    console.log('\nMigration complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nMigration failed:', err.message);
    process.exit(1);
  });
