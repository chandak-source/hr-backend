/**
 * End-to-end smoke test — hits every route group against a running server.
 *
 *   npm start          (in one terminal)
 *   npm run smoke      (in another)
 *
 * Override the target with BASE_URL. There are no demo users, so this signs in
 * as the bootstrap admin from .env and creates the QA accounts it needs through
 * the app's own Create User flow. Safe to re-run.
 */
import { call, ensureFixtures, QA } from './_fixtures.js';

let passed = 0;
const failures = [];

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

async function main() {
  console.log('health');
  await check('GET /health/live', async () => {
    const { status, json } = await call('GET', '/health/live');
    return must(status === 200 && json.status === 'ok', `got ${status}`);
  });
  await check('GET /health (database up)', async () => {
    const { status, json } = await call('GET', '/health');
    return must(status === 200 && json.database === 'up', `got ${status} ${JSON.stringify(json)}`);
  });

  console.log('\nfixtures');
  const { admin, manager, employee } = await ensureFixtures();
  await check('bootstrap admin signs in as an admin', () =>
    must(admin.token && admin.user.role === 'admin', `role ${admin.user.role}`));
  await check('the QA manager and employee exist with the right roles', () =>
    must(manager.user.role === 'manager' && employee.user.role === 'employee',
      `${manager.user.role} / ${employee.user.role}`));
  await check('every account is on the company domain', () =>
    must([admin, manager, employee].every((s) => s.user.email.endsWith('@superaip.com')),
      'an account is off-domain'));

  console.log('\nauth');
  await check('login response hides passwordHash', () =>
    must(admin.user.passwordHash === undefined, 'passwordHash leaked'));
  await check('GET /auth/me', async () => {
    const { status, json } = await call('GET', '/auth/me', { token: employee.token });
    return must(status === 200 && json.data.email === QA.employee, JSON.stringify(json));
  });
  await check('joined refs resolve (department, shift, manager)', async () => {
    const { json } = await call('GET', '/auth/me', { token: employee.token });
    const u = json.data;
    return must(
      u.department === 'Product Engineering' && u.shift?.includes('General') && u.reportingTo,
      JSON.stringify({ department: u.department, shift: u.shift, reportingTo: u.reportingTo }),
    );
  });
  await check('POST /auth/refresh rotates the token', async () => {
    const { status, json } = await call('POST', '/auth/refresh', {
      body: { refreshToken: employee.refreshToken },
    });
    return must(status === 200 && json.data.refreshToken !== employee.refreshToken,
      JSON.stringify(json));
  });
  await check('bad password is rejected', async () => {
    const { status } = await call('POST', '/auth/login', {
      body: { email: QA.employee, password: 'wrong-password' },
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
  await check('a new account starts with backfilled attendance', async () => {
    const { json } = await call('GET', '/attendance/log', { token: employee.token });
    return must(json.data.length > 0, 'no attendance was provisioned');
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
  await check('a new account starts with leave balances', async () => {
    const { json } = await call('GET', '/leave/balances', { token: employee.token });
    const cl = json.data.find((b) => b.shortCode === 'CL');
    return must(cl && cl.available === cl.total - cl.used, JSON.stringify(cl));
  });

  console.log('\npayroll');
  for (const [label, path] of [
    ['payslips', '/payroll/payslips'],
    ['ytd', '/payroll/ytd'],
  ]) {
    await check(`GET /payroll/${label}`, async () => {
      const { status, json } = await call('GET', path, { token: employee.token });
      return must(status === 200 && json.success, `got ${status}`);
    });
  }

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
  await check('master data is present', async () => {
    const { json: cats } = await call('GET', '/expenses/categories', { token: employee.token });
    const { json: days } = await call('GET', '/holidays?year=2026', { token: employee.token });
    const { json: depts } = await call('GET', '/departments', { token: employee.token });
    return must(
      cats.data.length > 0 && days.data.length > 0 && depts.data.length > 0,
      'a master collection is empty — did the seeder run?',
    );
  });
  await check('directory search filters', async () => {
    const { json } = await call('GET', '/directory?q=QA%20Employee', { token: employee.token });
    return must(json.data.some((u) => u.email === QA.employee), JSON.stringify(json.data));
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
  await check('manager sees only their direct reports', async () => {
    const { json: team } = await call('GET', '/team/members', { token: manager.token });
    const { json: all } = await call('GET', '/admin/employees', { token: admin.token });
    return must(
      team.data.length > 0 && team.data.length < all.data.length,
      `${team.data.length} of ${all.data.length}`,
    );
  });
  await check('employee cannot reach /approvals', async () => {
    const { status } = await call('GET', '/approvals/summary', { token: employee.token });
    return must(status === 403, `got ${status}`);
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
  await check('overview aggregates headcount', async () => {
    const { json } = await call('GET', '/admin/overview', { token: admin.token });
    const d = json.data;
    return must(
      d.headcount.total >= 3 && d.headcountByDepartment.length > 0,
      JSON.stringify(d.headcount),
    );
  });
  await check('manager cannot reach /admin', async () => {
    const { status } = await call('GET', '/admin/overview', { token: manager.token });
    return must(status === 403, `got ${status}`);
  });

  console.log('\nuser creation rules');
  await check('a non-company email is refused', async () => {
    const { status, json } = await call('POST', '/admin/employees', {
      token: admin.token,
      body: {
        name: 'Should Not Exist',
        email: 'someone@gmail.com',
        role: 'employee',
        designation: 'QA Engineer',
        department: 'Product Engineering',
        dateOfJoining: '2026-01-01',
        annualCtc: 900000,
      },
    });
    return must(
      (status === 422 || status === 400) && /superaip\.com/i.test(JSON.stringify(json)),
      `got ${status} ${JSON.stringify(json)}`,
    );
  });
  await check('a manager cannot create users', async () => {
    const { status } = await call('POST', '/admin/employees', {
      token: manager.token,
      body: {
        name: 'Not Allowed',
        email: `qa.notallowed.${Date.now()}@superaip.com`,
        role: 'employee',
        designation: 'QA Engineer',
        department: 'Product Engineering',
        dateOfJoining: '2026-01-01',
        annualCtc: 900000,
      },
    });
    return must(status === 403, `got ${status}`);
  });

  console.log('\nerror handling');
  await check('unknown route is 404', async () => {
    const { status } = await call('GET', '/does-not-exist', { token: admin.token });
    return must(status === 404, `got ${status}`);
  });
  await check('invalid body is 422 with field details', async () => {
    const { status, json } = await call('POST', '/auth/login', { body: {} });
    return must(status === 422 && json.error.details?.length > 0, JSON.stringify(json));
  });
  await check('malformed id is 404, not a crash', async () => {
    const { status } = await call('GET', '/team/members/not-an-id', { token: manager.token });
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
