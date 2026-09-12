import 'dotenv/config';

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var: ${key}`);
  return value;
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
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: required('JWT_EXPIRES_IN', '1d'),
    refreshDays: Number(required('REFRESH_TOKEN_EXPIRES_IN_DAYS', 30)),
  },

  seedPassword: required('SEED_PASSWORD', 'demo@1234'),
};
