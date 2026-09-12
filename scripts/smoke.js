/**
 * End-to-end smoke test — hits every route group against a running server.
 *
 *   npm start          (in one terminal)
 *   npm run smoke      (in another)
 *
 * Override the target with BASE_URL. Expects the seeded demo data.
 */
import 'dotenv/config';

const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, '');
const PREFIX = process.env.API_PREFIX ?? '/api/v1';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo@1234';

const ACCOUNTS = {
  admin: 'rupal.mehta@chandacorp.com',
  manager: 'nikhil.desai@chandacorp.com',
  employee: 'chandan.sharma@chandacorp.com',
};

let passed = 0;
const failures = [];

async function call(method, path, { token, body, expect = 200 } = {}) {
  const res = await fetch(`${BASE}${path.startsWith('/health') ? '' : PREFIX}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, okStatus: res.status === expect };
}

async function check(label, fn) {
  try {
    const result = await fn();
    if (result === false) throw new Error('assertion returned false');
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failures.push(`${label} — ${err.message}`);
    console.log(`  FAIL  ${label} — ${err.message}`);
  }
}

const must = (cond, message) => {
  if (!cond) throw new Error(message);
  return true;
};

async function login(email) {
  const { status, json } = await call('POST', '/auth/login', {
    body: { email, password: PASSWORD },
  });
  if (status !== 200) throw new Error(`login ${email} returned ${status}`);
  return json.data;
}

async function main() {
  console.log(`Smoke testing ${BASE}${PREFIX}\n`);

  console.log('health');
  await check('GET /health/live', async () => {
    const { status, json } = await call('GET', '/health/live');
    return must(status === 200 && json.status === 'ok', `got ${status}`);
  });
  await check('GET /health (database up)', async () => {
    const { status, json } = await call('GET', '/health');
    return must(status === 200 && json.database === 'up', `got ${status} ${JSON.stringify(json)}`);
  });

  console.log('\nauth');
  const admin = await login(ACCOUNTS.admin);
  const manager = await login(ACCOUNTS.manager);
  const employee = await login(ACCOUNTS.employee);
  await check('POST /auth/login issues a token', () =>
    must(admin.token && admin.user.role === 'admin', 'no token or wrong role'));
  await check('login response hides passwordHash', () =>
    must(admin.user.passwordHash === undefined, 'passwordHash leaked'));
  await check('GET /auth/me', async () => {
    const { status, json } = await call('GET', '/auth/me', { token: employee.token });
    return must(status === 200 && json.data.empCode === 'EMP1042', JSON.stringify(json));
  });
  await check('joined refs resolve (department, shift, manager)', async () => {
    const { json } = await call('GET', '/auth/me', { token: employee.token });
    const u = json.data;
    return must(
      u.department === 'Product Engineering' && u.shift?.includes('General') && u.reportingTo === 'Nikhil Desai',
      JSON.stringify({ department: u.department, shift: u.shift, reportingTo: u.reportingTo }),
    );
  });
  await check('POST /auth/refresh rotates the token', async () => {
    const { status, json } = await call('POST', '/auth/refresh', {
      body: { refreshToken: admin.refreshToken },
    });
    return must(status === 200 && json.data.refreshToken !== admin.refreshToken, JSON.stringify(json));
  });
  await check('bad password is rejected', async () => {
    const { status } = await call('POST', '/auth/login', {
      body: { email: ACCOUNTS.admin, password: 'wrong-password' },
    });
    return must(status === 401, `got ${status}`);
  });
  await check('no token is rejected', async () => {
    const { status } = await call('GET', '/auth/me');
    return must(status === 401, `got ${status}`);
  });

  console.log('\nattendance');
  for (const [label, path] of [
    ['today', '/attendance/today'],
    ['log', '/attendance/log?limit=10'],
    ['summary', '/attendance/summary'],
    ['calendar', '/attendance/calendar'],
    ['regularizations', '/attendance/regularizations'],
  ]) {
    await check(`GET /attendance/${label}`, async () => {
      const { status, json } = await call('GET', path, { token: employee.token });
      return must(status === 200 && json.success, `got ${status}`);
    });
  }
  await check('summary counts the seeded month', async () => {
    const { json } = await call('GET', '/attendance/summary', { token: employee.token });
    return must(json.data.workingDays > 0, JSON.stringify(json.data));
  });

  console.log('\nleave');
  for (const [label, path] of [
    ['types', '/leave/types'],
    ['balances', '/leave/balances'],
    ['requests', '/leave/requests'],
  ]) {
    await check(`GET /leave/${label}`, async () => {
      const { status, json } = await call('GET', path, { token: employee.token });
      return must(status === 200 && Array.isArray(json.data), `got ${status}`);
    });
  }
  await check('balances carry a computed available figure', async () => {
    const { json } = await call('GET', '/leave/balances', { token: employee.token });
    const cl = json.data.find((b) => b.shortCode === 'CL');
    return must(cl && cl.available === cl.total - cl.used, JSON.stringify(cl));
  });
  await check('overlapping leave is refused', async () => {
    const { json } = await call('GET', '/leave/requests', { token: employee.token });
    const existing = json.data.find((r) => r.status === 'pending');
    if (!existing) return must(true, 'no pending request to overlap');
    const { status } = await call('POST', '/leave/requests', {
      token: employee.token,
      body: {
        leaveTypeCode: 'CL',
        fromDate: existing.fromDate,
        toDate: existing.toDate,
        reason: 'Smoke test overlap check',
      },
      expect: 409,
    });
    return must(status === 409, `got ${status}`);
  });

  console.log('\npayroll');
  await check('GET /payroll/payslips', async () => {
    const { status, json } = await call('GET', '/payroll/payslips', { token: employee.token });
    return must(status === 200 && json.data.length > 0, `got ${status} with ${json?.data?.length} slips`);
  });
  await check('GET /payroll/payslips/:id splits earnings and deductions', async () => {
    const { json } = await call('GET', '/payroll/payslips', { token: employee.token });
    const { status, json: slip } = await call('GET', `/payroll/payslips/${json.data[0].id}`, {
      token: employee.token,
    });
    return must(
      status === 200 && slip.data.earnings.length > 0 && slip.data.deductionItems.length > 0,
      JSON.stringify(slip.data).slice(0, 200),
    );
  });
  await check('GET /payroll/ytd', async () => {
    const { status, json } = await call('GET', '/payroll/ytd', { token: employee.token });
    return must(status === 200 && json.data.net > 0, JSON.stringify(json.data));
  });

  console.log('\nworkspace');
  for (const [label, path] of [
    ['expenses', '/expenses'],
    ['expense categories', '/expenses/categories'],
    ['tasks', '/tasks'],
    ['holidays', '/holidays?year=2026'],
    ['announcements', '/announcements'],
    ['notifications', '/notifications'],
    ['directory', '/directory'],
    ['departments', '/departments'],
  ]) {
    await check(`GET /${label}`, async () => {
      const { status, json } = await call('GET', path, { token: employee.token });
      return must(status === 200 && Array.isArray(json.data), `got ${status}`);
    });
  }
  await check('departments report a headcount', async () => {
    const { json } = await call('GET', '/departments', { token: employee.token });
    const eng = json.data.find((x) => x.code === 'ENG');
    return must(eng && eng.headcount > 0 && eng.head, JSON.stringify(eng));
  });
  await check('directory search filters', async () => {
    const { json } = await call('GET', '/directory?q=Aarti', { token: employee.token });
    return must(json.data.length === 1 && json.data[0].name === 'Aarti Patel', JSON.stringify(json.data));
  });

  console.log('\nteam + approvals (manager)');
  for (const [label, path] of [
    ['members', '/team/members'],
    ['stats', '/team/stats'],
    ['trend', '/team/trend'],
    ['approval summary', '/approvals/summary'],
    ['approval leave', '/approvals/leave'],
    ['approval expenses', '/approvals/expenses'],
    ['approval regularizations', '/approvals/regularizations'],
  ]) {
    await check(`GET /${label}`, async () => {
      const { status, json } = await call('GET', path, { token: manager.token });
      return must(status === 200 && json.success, `got ${status}`);
    });
  }
  await check('manager sees only direct reports', async () => {
    const { json } = await call('GET', '/team/members', { token: manager.token });
    return must(json.data.length > 0 && json.data.length < 12, `saw ${json.data.length}`);
  });
  await check('employee cannot reach /approvals', async () => {
    const { status } = await call('GET', '/approvals/summary', { token: employee.token, expect: 403 });
    return must(status === 403, `got ${status}`);
  });
  await check('pending approvals are listed first', async () => {
    const { json } = await call('GET', '/approvals/leave', { token: manager.token });
    const firstNonPending = json.data.findIndex((r) => r.status !== 'pending');
    const lastPending = json.data.map((r) => r.status).lastIndexOf('pending');
    return must(firstNonPending === -1 || lastPending < firstNonPending, 'ordering is wrong');
  });

  console.log('\nadmin');
  for (const [label, path] of [
    ['overview', '/admin/overview'],
    ['employees', '/admin/employees'],
    ['payroll runs', '/admin/payroll/runs'],
    ['attendance report', '/admin/reports/attendance'],
    ['leave balance report', '/admin/reports/leave-balances'],
    ['payroll trend', '/admin/reports/payroll-trend'],
  ]) {
    await check(`GET /admin/${label}`, async () => {
      const { status, json } = await call('GET', path, { token: admin.token });
      return must(status === 200 && json.success, `got ${status}`);
    });
  }
  await check('overview aggregates headcount and payroll', async () => {
    const { json } = await call('GET', '/admin/overview', { token: admin.token });
    const d = json.data;
    return must(
      d.headcount.total === 12 && d.latestPayroll?.totalNet > 0 && d.headcountByDepartment.length > 0,
      JSON.stringify({ headcount: d.headcount, payroll: d.latestPayroll }),
    );
  });
  await check('manager cannot reach /admin', async () => {
    const { status } = await call('GET', '/admin/overview', { token: manager.token, expect: 403 });
    return must(status === 403, `got ${status}`);
  });

  console.log('\nerror handling');
  await check('unknown route is 404', async () => {
    const { status } = await call('GET', '/does-not-exist', { token: admin.token, expect: 404 });
    return must(status === 404, `got ${status}`);
  });
  await check('invalid body is 422 with field details', async () => {
    const { status, json } = await call('POST', '/auth/login', { body: {}, expect: 422 });
    return must(status === 422 && json.error.details?.length > 0, JSON.stringify(json));
  });
  await check('malformed id is 404, not a crash', async () => {
    const { status } = await call('GET', '/team/members/not-an-id', { token: manager.token, expect: 404 });
    return must(status === 404, `got ${status}`);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nSmoke run crashed:', err.message);
  process.exit(1);
});
