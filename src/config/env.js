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

  /**
   * Sign-in attempts allowed per IP per 15 minutes. The default protects a
   * deployed instance; the integration suite signs in on almost every test, so
   * a dev machine raises it.
   */
  authRateLimit: Number(required('AUTH_RATE_LIMIT', 50)),

  /**
   * The only company domain an account may be created under. Every other
   * address is rejected at creation time.
   */
  allowedEmailDomain: required('ALLOWED_EMAIL_DOMAIN', '@superaip.com').toLowerCase(),

  /**
   * The single account the seeder creates so somebody can sign in and use the
   * Create User flow. Supplied as configuration, never hardcoded in source —
   * there are no other pre-defined users.
   */
  bootstrapAdmin: {
    name: process.env.BOOTSTRAP_ADMIN_NAME ?? 'System Administrator',
    email: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? '',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
  },
};
