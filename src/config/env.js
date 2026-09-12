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

  mongo: {
    uri: required('MONGODB_URI'),
    // Optional override — otherwise the database in the URI path is used.
    dbName: process.env.MONGODB_DB || undefined,
    /**
     * Node's bundled DNS resolver refuses SRV lookups on some Windows/router
     * setups, which breaks `mongodb+srv://` locally even though the cluster is
     * reachable. Set DNS_SERVERS=8.8.8.8,1.1.1.1 to work around it. Not needed
     * on a normal Linux host, so leave it empty in production.
     */
    dnsServers: (process.env.DNS_SERVERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: required('JWT_EXPIRES_IN', '1d'),
    refreshDays: Number(required('REFRESH_TOKEN_EXPIRES_IN_DAYS', 30)),
  },

  seedPassword: required('SEED_PASSWORD', 'demo@1234'),
};
