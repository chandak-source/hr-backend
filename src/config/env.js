import 'dotenv/config';

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${key}`);
  return value;
};

/**
 * Managed MySQL (Aiven, PlanetScale, RDS…) requires TLS. Returns a mysql2 `ssl`
 * option, or `undefined` for a plain local connection.
 *
 * `DB_SSL_CA` holds the provider's CA certificate as PEM — real newlines or
 * `\n` escapes both work, since some dashboards flatten multi-line values.
 */
const dbSsl = () => {
  if (String(process.env.DB_SSL ?? 'false').toLowerCase() !== 'true') return undefined;
  const ca = process.env.DB_SSL_CA?.replace(/\\n/g, '\n').trim();
  // Without a CA the connection is still encrypted, just unverified.
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
};

export const env = {
  port: Number(required('PORT', 4000)),
  nodeEnv: required('NODE_ENV', 'development'),
  apiPrefix: required('API_PREFIX', '/api/v1'),
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',

  db: {
    host: required('DB_HOST', '127.0.0.1'),
    port: Number(required('DB_PORT', 3306)),
    user: required('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
    database: required('DB_NAME', 'chanda_hr'),
    connectionLimit: Number(required('DB_CONNECTION_LIMIT', 10)),
    ssl: dbSsl(),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: required('JWT_EXPIRES_IN', '1d'),
    refreshDays: Number(required('REFRESH_TOKEN_EXPIRES_IN_DAYS', 30)),
  },

  seedPassword: required('SEED_PASSWORD', 'demo@1234'),
};
