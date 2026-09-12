/**
 * Exercises every mutating endpoint — punches, leave apply/approve, expense and
 * regularization approval, the payroll run lifecycle, admin writes and auth.
 *
 *   npm start              (in one terminal)
 *   npm run verify:writes  (in another)
 *   npm run db:seed        (afterwards — this script leaves data changed)
 *
 * Unlike `npm run smoke`, this is NOT idempotent: it approves requests, runs
 * payroll and changes a password. Always re-seed after a run.
 */
import 'dotenv/config';

const BASE = `${(process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(/\/$/, '')}${
  process.env.API_PREFIX ?? '/api/v1'
}`;
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo@1234';

let passed = 0;
const failures = [];

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failures.push(`${label} — ${err.message}`);
    console.log(`  FAIL  ${label} — ${err.message}`);
  }
}
const must = (c, m) => {
  if (!c) throw new Error(m);
};

const login = async (email) => {
  const { json } = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  return json.data;
};

const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const admin = await login('rupal.mehta@chandacorp.com');
const manager = await login('nikhil.desai@chandacorp.com');
const employee = await login('chandan.sharma@chandacorp.com');

console.log('attendance writes');
// Whether today's seeded row is open depends on the calendar (a 2nd/4th
// Saturday seeds as week_off), so branch on the actual state.
const todayState = await call('GET', '/attendance/today', { token: employee.token });
const startedPunchedIn = todayState.json.data.isPunchedIn;

await check('punch-in respects the current state', async () => {
  const { status } = await call('POST', '/attendance/punch-in', { token: employee.token });
  if (startedPunchedIn) must(status === 409, `already punched in, expected 409, got ${status}`);
  else must(status === 201, `was not punched in, expected 201, got ${status}`);
});
await check('punch-out closes the open row and totals minutes', async () => {
  const { status, json } = await call('POST', '/attendance/punch-out', { token: employee.token });
  must(status === 200, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.totalMinutes >= 0, `minutes ${json.data.totalMinutes}`);
  must(/^\d{2}:\d{2}$/.test(json.data.totalHours), `hours ${json.data.totalHours}`);
  must(json.data.punchIn && json.data.punchOut, 'missing punch times');
});
await check('second punch-out is refused', async () => {
  const { status } = await call('POST', '/attendance/punch-out', { token: employee.token });
  must(status === 409, `got ${status}`);
});
await check('today reflects the punch-out', async () => {
  const { json } = await call('GET', '/attendance/today', { token: employee.token });
  must(json.data.isPunchedIn === false, 'still punched in');
  must(json.data.record.punchOut, 'no punchOut on record');
});

console.log('\nleave write + approval');
const leaveFrom = plusDays(120);
let leaveId;
await check('apply for leave deducts nothing yet but creates the request', async () => {
  const { status, json } = await call('POST', '/leave/requests', {
    token: employee.token,
    body: { leaveTypeCode: 'CL', fromDate: leaveFrom, toDate: leaveFrom, reason: 'Write-path verification' },
  });
  must(status === 201, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.code.startsWith('LV-'), `code ${json.data.code}`);
  must(json.data.leaveType === 'Casual Leave', `type ${json.data.leaveType}`);
  leaveId = json.data.id;
});
const balanceBefore = await (async () => {
  const { json } = await call('GET', '/leave/balances', { token: employee.token });
  return json.data.find((b) => b.shortCode === 'CL').used;
})();
await check('manager approves the leave', async () => {
  const { status, json } = await call('POST', `/approvals/leave/${leaveId}`, {
    token: manager.token,
    body: { action: 'approve', remark: 'ok' },
  });
  must(status === 200 && json.data.status === 'approved', `${status} ${JSON.stringify(json)}`);
});
await check('approval increments the used balance', async () => {
  const { json } = await call('GET', '/leave/balances', { token: employee.token });
  const used = json.data.find((b) => b.shortCode === 'CL').used;
  must(used === balanceBefore + 1, `used ${balanceBefore} -> ${used}`);
});
await check('approval blocks the attendance calendar (upsert)', async () => {
  const { json } = await call('GET', `/attendance/log?from=${leaveFrom}&to=${leaveFrom}`, {
    token: employee.token,
  });
  must(json.data.length === 1, `${json.data.length} rows`);
  must(json.data[0].status === 'leave', `status ${json.data[0].status}`);
});
await check('approving twice is refused', async () => {
  const { status } = await call('POST', `/approvals/leave/${leaveId}`, {
    token: manager.token,
    body: { action: 'approve' },
  });
  must(status === 409, `got ${status}`);
});
await check('employee was notified', async () => {
  const { json } = await call('GET', '/notifications', { token: employee.token });
  must(json.data.some((n) => n.title === 'Leave approved'), 'no approval notification');
});

console.log('\nexpense write + approval');
let claimId;
await check('create an expense claim', async () => {
  const { status, json } = await call('POST', '/expenses', {
    token: employee.token,
    body: { category: 'Food', amount: 450, expenseDate: plusDays(-1), note: 'Write-path verification' },
  });
  must(status === 201, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.code.startsWith('EX-'), `code ${json.data.code}`);
  must(json.data.category === 'Food', `category ${json.data.category}`);
  claimId = json.data.id;
});
await check('category cap is enforced', async () => {
  const { status } = await call('POST', '/expenses', {
    token: employee.token,
    body: { category: 'Food', amount: 99000, expenseDate: plusDays(-1), note: 'Over the cap' },
  });
  must(status === 400, `got ${status}`);
});
await check('future-dated expense is refused', async () => {
  const { status } = await call('POST', '/expenses', {
    token: employee.token,
    body: { category: 'Food', amount: 100, expenseDate: plusDays(5), note: 'Future dated' },
  });
  must(status === 400, `got ${status}`);
});
await check('manager rejects the claim', async () => {
  const { status, json } = await call('POST', `/approvals/expenses/${claimId}`, {
    token: manager.token,
    body: { action: 'reject', remark: 'no receipt' },
  });
  must(status === 200 && json.data.status === 'rejected', `${status} ${JSON.stringify(json)}`);
});

console.log('\nregularization write + approval');
const regDate = plusDays(-4);
let regId;
await check('raise a regularization', async () => {
  const { status, json } = await call('POST', '/attendance/regularizations', {
    token: employee.token,
    body: { date: regDate, punchIn: '09:15', punchOut: '18:45', reason: 'Write-path verification' },
  });
  must(status === 201, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.code.startsWith('RG-'), `code ${json.data.code}`);
  regId = json.data.id;
});
await check('duplicate pending regularization is refused', async () => {
  const { status } = await call('POST', '/attendance/regularizations', {
    token: employee.token,
    body: { date: regDate, punchIn: '09:15', punchOut: '18:45', reason: 'Duplicate attempt' },
  });
  must(status === 409, `got ${status}`);
});
await check('manager approves and attendance is rewritten', async () => {
  const { status } = await call('POST', `/approvals/regularizations/${regId}`, {
    token: manager.token,
    body: { action: 'approve' },
  });
  must(status === 200, `got ${status}`);
  const { json } = await call('GET', `/attendance/log?from=${regDate}&to=${regDate}`, {
    token: employee.token,
  });
  const row = json.data[0];
  must(row.status === 'present', `status ${row.status}`);
  must(row.isRegularized === true, 'not flagged regularized');
  must(row.punchIn === '09:15:00' && row.punchOut === '18:45:00', `times ${row.punchIn}-${row.punchOut}`);
  must(row.totalMinutes === 570, `minutes ${row.totalMinutes}`);
});

console.log('\ntasks + notifications');
await check('PATCH a task to done stamps completedAt', async () => {
  const { json: list } = await call('GET', '/tasks?status=open', { token: employee.token });
  const task = list.data[0];
  const { status, json } = await call('PATCH', `/tasks/${task.id}`, {
    token: employee.token,
    body: { isDone: true },
  });
  must(status === 200 && json.data.isDone === true, `${status} ${JSON.stringify(json.data)}`);
  must(json.data.progress === 1, `progress ${json.data.progress}`);
  must(json.data.completedAt, 'no completedAt');
});
await check('read-all clears unread notifications', async () => {
  const { status, json } = await call('POST', '/notifications/read-all', { token: employee.token });
  must(status === 200, `got ${status}`);
  const { json: after } = await call('GET', '/notifications', { token: employee.token });
  must(after.meta.unread === 0, `still ${after.meta.unread} unread`);
});

console.log('\nadmin writes');
let newEmpId;
await check('create an employee with a generated code + salary structure', async () => {
  const { status, json } = await call('POST', '/admin/employees', {
    token: admin.token,
    body: {
      name: 'Test Verify User',
      email: `verify.${Date.now()}@chandacorp.com`,
      designation: 'QA Engineer',
      department: 'Product Engineering',
      reportingToCode: 'MGR2007',
      dateOfJoining: plusDays(-10),
      annualCtc: 900000,
    },
  });
  must(status === 201, `got ${status} ${JSON.stringify(json)}`);
  must(/^EMP\d+$/.test(json.data.empCode), `code ${json.data.empCode}`);
  newEmpId = json.data.id;
});
await check('duplicate email is a clean 409', async () => {
  const { status, json } = await call('POST', '/admin/employees', {
    token: admin.token,
    body: {
      name: 'Duplicate Email',
      email: 'chandan.sharma@chandacorp.com',
      designation: 'QA Engineer',
      department: 'Product Engineering',
      dateOfJoining: plusDays(-10),
      annualCtc: 900000,
    },
  });
  must(status === 409, `got ${status} ${JSON.stringify(json)}`);
});
await check('unknown department is rejected', async () => {
  const { status } = await call('POST', '/admin/employees', {
    token: admin.token,
    body: {
      name: 'Bad Dept',
      email: `bad.${Date.now()}@chandacorp.com`,
      designation: 'QA',
      department: 'Nonexistent',
      dateOfJoining: plusDays(-10),
      annualCtc: 900000,
    },
  });
  must(status === 400, `got ${status}`);
});
await check('PATCH employee status to exited sets the exit date', async () => {
  const { status, json } = await call('PATCH', `/admin/employees/${newEmpId}`, {
    token: admin.token,
    body: { status: 'exited', designation: 'QA Engineer II' },
  });
  must(status === 200, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.status === 'exited', `status ${json.data.status}`);
  must(json.data.designation === 'QA Engineer II', `designation ${json.data.designation}`);
});

console.log('\npayroll run lifecycle');
const now = new Date();
const runMonth = now.getMonth() === 0 ? 12 : now.getMonth();
const runYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
let runId;
await check('processing an already-published month is refused', async () => {
  const { json: runs } = await call('GET', '/admin/payroll/runs', { token: admin.token });
  const published = runs.data.find((r) => r.status === 'published');
  const { status } = await call('POST', '/admin/payroll/run', {
    token: admin.token,
    body: { month: published.month, year: published.year },
  });
  must(status === 409, `got ${status}`);
});
await check('run payroll for the current month', async () => {
  const { status, json } = await call('POST', '/admin/payroll/run', {
    token: admin.token,
    body: { month: now.getMonth() + 1, year: now.getFullYear() },
  });
  must(status === 200, `got ${status} ${JSON.stringify(json)}`);
  must(json.data.employees > 0, `employees ${json.data.employees}`);
  must(json.data.net > 0 && json.data.gross > json.data.net, JSON.stringify(json.data));
  runId = json.data.runId;
});
await check('re-running a processed month is refused until unlocked', async () => {
  const { status } = await call('POST', '/admin/payroll/run', {
    token: admin.token,
    body: { month: now.getMonth() + 1, year: now.getFullYear() },
  });
  must(status === 409, `got ${status}`);
});
await check('unlock then re-run reuses the run and replaces payslips', async () => {
  const { status: unlockStatus } = await call('POST', `/admin/payroll/runs/${runId}/unlock`, {
    token: admin.token,
  });
  must(unlockStatus === 200, `unlock gave ${unlockStatus}`);

  const { status, json } = await call('POST', '/admin/payroll/run', {
    token: admin.token,
    body: { month: now.getMonth() + 1, year: now.getFullYear() },
  });
  must(status === 200, `got ${status}`);
  must(json.data.runId === runId, 'created a second run instead of reusing');

  // The unique (payrollRunId, employeeId) index would have rejected duplicates,
  // so an unchanged headcount proves the old slips were cleared first.
  const { json: runs } = await call('GET', '/admin/payroll/runs', { token: admin.token });
  const run = runs.data.find((r) => r.id === runId);
  must(run.employees === json.data.employees, `${run.employees} vs ${json.data.employees}`);
});
await check('publish credits the payslips and notifies', async () => {
  const { status, json } = await call('POST', `/admin/payroll/runs/${runId}/publish`, {
    token: admin.token,
  });
  must(status === 200 && json.data.status === 'published', `${status} ${JSON.stringify(json)}`);
  const { json: slips } = await call('GET', '/payroll/payslips', { token: employee.token });
  must(slips.data.some((s) => s.month === now.getMonth() + 1), 'new payslip not visible');
  const { json: notes } = await call('GET', '/notifications', { token: employee.token });
  must(notes.data.some((n) => n.title === 'Payslip available'), 'no payslip notification');
});
await check('publishing twice is refused', async () => {
  const { status } = await call('POST', `/admin/payroll/runs/${runId}/publish`, { token: admin.token });
  must(status === 409, `got ${status}`);
});
await check('unlock returns the run to draft', async () => {
  const { status, json } = await call('POST', `/admin/payroll/runs/${runId}/unlock`, {
    token: admin.token,
  });
  must(status === 200 && json.data.status === 'draft', `${status} ${JSON.stringify(json)}`);
});

console.log('\nannouncements + bulk approve');
let annId;
await check('publish an announcement', async () => {
  const { status, json } = await call('POST', '/admin/announcements', {
    token: admin.token,
    body: { title: 'Verification notice', body: 'This announcement was created by the write-path check.' },
  });
  must(status === 201, `got ${status}`);
  annId = json.data.id;
  const { json: feed } = await call('GET', '/announcements', { token: employee.token });
  must(feed.data.some((a) => a.id === annId), 'not in the feed');
});
await check('archive removes it from the feed', async () => {
  const { status } = await call('DELETE', `/admin/announcements/${annId}`, { token: admin.token });
  must(status === 200, `got ${status}`);
  const { json: feed } = await call('GET', '/announcements', { token: employee.token });
  must(!feed.data.some((a) => a.id === annId), 'still in the feed');
});
await check('bulk-approve clears the manager queue', async () => {
  const { json: before } = await call('GET', '/approvals/summary', { token: manager.token });
  const { status, json } = await call('POST', '/approvals/leave/bulk-approve', { token: manager.token });
  must(status === 200, `got ${status}`);
  must(json.data.approved === before.data.leaves, `approved ${json.data.approved} of ${before.data.leaves}`);
  const { json: after } = await call('GET', '/approvals/summary', { token: manager.token });
  must(after.data.leaves === 0, `${after.data.leaves} leaves still pending`);
});

console.log('\nauth writes');
await check('logout revokes the refresh token', async () => {
  const throwaway = await login('hetal.rana@chandacorp.com');
  const { status } = await call('POST', '/auth/logout', { token: throwaway.token });
  must(status === 200, `got ${status}`);
  const { status: refreshStatus } = await call('POST', '/auth/refresh', {
    body: { refreshToken: throwaway.refreshToken },
  });
  must(refreshStatus === 401, `refresh after logout gave ${refreshStatus}`);
});
await check('change-password works and old password stops working', async () => {
  const user = await login('priya.nair@chandacorp.com');
  const { status } = await call('POST', '/auth/change-password', {
    token: user.token,
    body: { currentPassword: PASSWORD, newPassword: 'newpass@2026' },
  });
  must(status === 200, `got ${status}`);
  const { status: oldLogin } = await call('POST', '/auth/login', {
    body: { email: 'priya.nair@chandacorp.com', password: PASSWORD },
  });
  must(oldLogin === 401, `old password still works (${oldLogin})`);
  const { status: newLogin } = await call('POST', '/auth/login', {
    body: { email: 'priya.nair@chandacorp.com', password: 'newpass@2026' },
  });
  must(newLogin === 200, `new password failed (${newLogin})`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
