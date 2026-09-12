import mysql from 'mysql2/promise';

import { env } from './env.js';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  dateStrings: ['DATE', 'DATETIME'],
  timezone: 'local',
  charset: 'utf8mb4_unicode_ci',
  decimalNumbers: true,
});

/** Run a query, return all rows. */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Run a query, return the first row or null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE — returns the raw ResultSetHeader. */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

/** Run `fn` inside a transaction; rolls back on any throw. */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function pingDatabase() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}
