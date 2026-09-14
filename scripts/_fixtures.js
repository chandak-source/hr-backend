/**
 * Shared test fixtures for the verification scripts.
 *
 * There are no demo users any more — the only pre-existing account is the
 * bootstrap admin from .env. These helpers sign in as that admin and create the
 * handful of accounts the scripts need, through the same Create User endpoint
 * the app uses. Fixed addresses mean repeated runs reuse the same accounts.
 */
import 'dotenv/config';

export const BASE =
  (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, '') +
  (process.env.API_PREFIX ?? '/api/v1');

export const PASSWORD = process.env.SEED_PASSWORD ?? 'demo@1234';
export const DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? '@superaip.com';

export const ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL;
export const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD;

export const QA = {
  manager: `qa.manager${DOMAIN}`,
  employee: `qa.employee${DOMAIN}`,
  spare: `qa.spare${DOMAIN}`,
};

export async function call(method, path, { token, body } = {}) {
  const url = path.startsWith('/health')
    ? `${BASE.replace(process.env.API_PREFIX ?? '/api/v1', '')}${path}`
    : `${BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

export async function login(email, password = PASSWORD) {
  const { status, json } = await call('POST', '/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`login ${email} returned ${status}`);
  return json.data;
}

export function requireBootstrap() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set in .env — ' +
        'these scripts sign in as that account to create their fixtures.',
    );
  }
}

async function findByEmail(token, email) {
  const { json } = await call('GET', '/admin/employees', { token });
  return (json?.data ?? []).find((e) => e.email === email) ?? null;
}

/** Creates the account if missing, and keeps its reporting line correct. */
async function ensureUser(token, email, role, { reportingToCode } = {}) {
  const { status } = await call('POST', '/admin/employees', {
    token,
    body: {
      name: `QA ${role[0].toUpperCase()}${role.slice(1)}`,
      email,
      role,
      designation: 'QA Engineer',
      department: 'Product Engineering',
      dateOfJoining: new Date().toISOString().slice(0, 10),
      annualCtc: 900000,
      ...(reportingToCode ? { reportingToCode } : {}),
    },
  });

  if (status !== 201 && status !== 409) {
    throw new Error(`could not create ${email} (${status})`);
  }

  const user = await findByEmail(token, email);
  if (!user) throw new Error(`${email} missing after create`);

  if (reportingToCode && status === 409) {
    await call('PATCH', `/admin/employees/${user.id}`, { token, body: { reportingToCode } });
  }
  return user;
}

/**
 * Signs in as the bootstrap admin and guarantees a manager with an employee
 * reporting to them. Returns live sessions for all three.
 */
export async function ensureFixtures() {
  requireBootstrap();

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const manager = await ensureUser(admin.token, QA.manager, 'manager');
  const employee = await ensureUser(admin.token, QA.employee, 'employee', {
    reportingToCode: manager.empCode,
  });

  return {
    admin,
    manager: await login(QA.manager),
    employee: await login(QA.employee),
    codes: { manager: manager.empCode, employee: employee.empCode },
  };
}
