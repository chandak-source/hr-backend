/** Verifies dynamic user creation + @superaip.com enforcement. */
import 'dotenv/config';

const BASE = 'http://localhost:4000/api/v1';
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
  } catch (e) {
    failures.push(`${label} — ${e.message}`);
    console.log(`  FAIL  ${label} — ${e.message}`);
  }
}
const must = (c, m) => {
  if (!c) throw new Error(m);
};

const login = async (email, password = process.env.SEED_PASSWORD ?? 'demo@1234') => {
  const { status, json } = await call('POST', '/auth/login', { body: { email, password } });
  if (status !== 200) throw new Error(`login ${email} → ${status} ${JSON.stringify(json)}`);
  return json.data;
};

const stamp = Date.now();
const newUser = (role, extra = {}) => ({
  name: `Test ${role} ${stamp}`,
  email: `test.${role}.${stamp}@superaip.com`,
  designation: 'QA Engineer',
  department: 'Product Engineering',
  dateOfJoining: new Date().toISOString().slice(0, 10),
  annualCtc: 900000,
  role,
  ...extra,
});

console.log('bootstrap');
const admin = await login(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
await check('bootstrap admin can sign in and is an admin', () => {
  must(admin.user.role === 'admin', `role is ${admin.user.role}`);
  must(admin.user.empCode.startsWith('ADM'), `code ${admin.user.empCode}`);
});
await check('the bootstrap admin is the only pre-seeded account', async () => {
  const { json } = await call('GET', '/admin/employees', { token: admin.token });
  const bootstrap = json.data.filter((u) => u.email === process.env.BOOTSTRAP_ADMIN_EMAIL);
  must(bootstrap.length === 1, `bootstrap admin appears ${bootstrap.length} times`);
  // Anything else present was created by this script or the app — never by the seeder.
  must(json.data.every((u) => u.email.endsWith('@superaip.com')), 'an off-domain account exists');
});

console.log('\nemail domain validation');
for (const bad of [
  'someone@chandacorp.com',
  'someone@gmail.com',
  'someone@superaip.com.evil.com',
  'not-an-email',
  '@superaip.com',
]) {
  await check(`rejects "${bad}"`, async () => {
    const { status, json } = await call('POST', '/admin/employees', {
      token: admin.token,
      body: newUser('employee', { email: bad }),
    });
    must(status === 422 || status === 400, `got ${status}`);
    const text = JSON.stringify(json);
    must(/superaip\.com|valid email/i.test(text), `unhelpful message: ${text}`);
  });
}

console.log('\ndynamic creation of all three roles');
const created = {};
for (const role of ['employee', 'manager', 'admin']) {
  await check(`creates a ${role}`, async () => {
    const payload = newUser(role);
    const { status, json } = await call('POST', '/admin/employees', {
      token: admin.token,
      body: payload,
    });
    must(status === 201, `got ${status} ${JSON.stringify(json)}`);
    must(json.data.role === role, `stored role ${json.data.role}`);
    created[role] = payload.email;
  });
}

await check('duplicate email is refused', async () => {
  const { status } = await call('POST', '/admin/employees', {
    token: admin.token,
    body: newUser('employee', { email: created.employee }),
  });
  must(status === 409, `got ${status}`);
});

console.log('\ncreated users are usable');
for (const role of ['employee', 'manager', 'admin']) {
  await check(`${role} can sign in with the right role`, async () => {
    const session = await login(created[role], process.env.SEED_PASSWORD ?? 'demo@1234');
    must(session.user.role === role, `logged in as ${session.user.role}`);
  });
}

await check('a new employee gets leave balances', async () => {
  const session = await login(created.employee, process.env.SEED_PASSWORD ?? 'demo@1234');
  const balances = await call('GET', '/leave/balances', { token: session.token });
  must(balances.json.data.length > 0, 'no leave balances allocated');
  must(balances.json.data.some((b) => b.shortCode === 'CL'), 'no casual leave');
});

await check('a new employee gets no attendance it never earned', async () => {
  const session = await login(created.employee, process.env.SEED_PASSWORD ?? 'demo@1234');
  const log = await call('GET', '/attendance/log', { token: session.token });

  // Provisioning lays out weekends and holidays and nothing else — punch times
  // come from punching, never from creating the account.
  const rows = log.json.data;
  const invented = rows.filter((r) => r.punchIn || r.punchOut);
  must(invented.length === 0, `${invented.length} fabricated punch row(s)`);
  must(
    rows.every((r) => r.status === 'week_off' || r.status === 'holiday'),
    `unexpected statuses: ${[...new Set(rows.map((r) => r.status))].join(', ')}`,
  );
});

console.log('\nself-service signup');
const signupStamp = Date.now();
const signedUp = {};

for (const bad of ['someone@gmail.com', 'someone@superaip.com.evil.com', 'nope']) {
  await check(`signup rejects "${bad}"`, async () => {
    const { status, json } = await call('POST', '/auth/signup', {
      body: {
        name: 'Should Not Exist',
        email: bad,
        password: 'test@12345',
        role: 'employee',
        designation: 'Engineer',
      },
    });
    must(status === 422 || status === 400, `got ${status}`);
    must(/superaip\.com|valid email/i.test(JSON.stringify(json)), 'unhelpful message');
  });
}

await check('signup rejects a short password', async () => {
  const { status } = await call('POST', '/auth/signup', {
    body: {
      name: 'Weak Password',
      email: `qa.weak.${signupStamp}@superaip.com`,
      password: 'abc',
      role: 'employee',
      designation: 'Engineer',
    },
  });
  must(status === 422, `got ${status}`);
});

for (const role of ['employee', 'manager', 'admin']) {
  await check(`signup registers a ${role} and signs them in`, async () => {
    const email = `qa.signup.${role}.${signupStamp}@superaip.com`;
    const { status, json } = await call('POST', '/auth/signup', {
      body: {
        name: `Signup ${role}`,
        email,
        password: 'test@12345',
        role,
        designation: 'QA Engineer',
      },
    });
    must(status === 201, `got ${status} ${JSON.stringify(json)}`);
    must(json.data.token, 'no token returned');
    must(json.data.user.role === role, `role ${json.data.user.role}`);
    signedUp[role] = { email, user: json.data.user };
  });
}

await check('the signed-up role survives a fresh sign-in', async () => {
  for (const [role, { email }] of Object.entries(signedUp)) {
    const session = await login(email, 'test@12345');
    must(session.user.role === role, `${email} came back as ${session.user.role}`);
  }
});

// The app maps both responses with the same Api.user(), so a field that exists
// on one path and not the other breaks the client rather than the server.
await check('signup and login describe the account identically', async () => {
  for (const [role, { email, user: fromSignup }] of Object.entries(signedUp)) {
    const { user: fromLogin } = await login(email, 'test@12345');

    const signupKeys = Object.keys(fromSignup).sort().join(',');
    const loginKeys = Object.keys(fromLogin).sort().join(',');
    must(signupKeys === loginKeys, `${role}: ${signupKeys} vs ${loginKeys}`);

    for (const field of ['id', 'empCode', 'email', 'role', 'status']) {
      must(
        fromSignup[field] === fromLogin[field],
        `${role}.${field}: ${fromSignup[field]} vs ${fromLogin[field]}`,
      );
    }
    must(!('passwordHash' in fromLogin), `${role}: login leaked passwordHash`);
  }
});

await check('a signed-up employee still cannot reach admin endpoints', async () => {
  const session = await login(signedUp.employee.email, 'test@12345');
  const { status } = await call('GET', '/admin/overview', { token: session.token });
  must(status === 403, `got ${status}`);
});

await check('signup refuses a duplicate email', async () => {
  const { status } = await call('POST', '/auth/signup', {
    body: {
      name: 'Duplicate',
      email: signedUp.employee.email,
      password: 'test@12345',
      role: 'employee',
      designation: 'Engineer',
    },
  });
  must(status === 409, `got ${status}`);
});


console.log('\nrole enforcement still holds');
await check('an employee cannot reach admin endpoints', async () => {
  const session = await login(created.employee, process.env.SEED_PASSWORD ?? 'demo@1234');
  const { status } = await call('GET', '/admin/overview', { token: session.token });
  must(status === 403, `got ${status}`);
});
await check('an employee cannot reach approvals', async () => {
  const session = await login(created.employee, process.env.SEED_PASSWORD ?? 'demo@1234');
  const { status } = await call('GET', '/approvals/summary', { token: session.token });
  must(status === 403, `got ${status}`);
});
await check('a manager can reach approvals but not admin', async () => {
  const session = await login(created.manager, process.env.SEED_PASSWORD ?? 'demo@1234');
  must((await call('GET', '/approvals/summary', { token: session.token })).status === 200, 'approvals blocked');
  must((await call('GET', '/admin/overview', { token: session.token })).status === 403, 'admin allowed');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
