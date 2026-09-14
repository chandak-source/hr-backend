/**
 * Attendance policy verification.
 *
 * Two halves:
 *
 *  1. The grading engine on its own — arrival rules, duration rules, which one
 *     wins, and the LOP share each verdict carries. No server, no database.
 *
 *  2. The same rules end to end against the running API: read the policy HR
 *     configured, change it, and prove an identical pair of punch times is
 *     graded differently afterwards. That is the requirement — new timings must
 *     take effect without a code change — so it is asserted, not assumed.
 *
 * The original policy is restored before the script exits.
 *
 *   node scripts/verify-attendance.js
 */
import 'dotenv/config';

import {
  evaluateAttendance,
  LOP_FACTOR,
  wrappedMinutes,
} from '../src/services/attendance-policy.service.js';
import { call, ensureFixtures, PASSWORD, QA } from './_fixtures.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------- engine ----
//
// A policy invented for the test, so the assertions describe the rules rather
// than whatever happens to be seeded: 09:00 start, 20 minutes of grace, a
// quarter day after 10:00, half a day after 12:00, 8 hours for a full day.
const POLICY = {
  id: 'test',
  name: 'Test Shift',
  startTime: '09:00:00',
  endTime: '18:00:00',
  graceMinutes: 20,
  quarterDayAfter: '10:00:00',
  halfDayAfter: '12:00:00',
  fullDayMinutes: 480,
};

const grade = (punchIn, punchOut) => evaluateAttendance({ policy: POLICY, punchIn, punchOut });

function engineTests() {
  section('Arrival rules (full day worked in every case)');

  check(
    'on time → present',
    grade('08:55:00', '17:30:00').status === 'present',
    grade('08:55:00', '17:30:00').status,
  );
  check(
    'within grace → present',
    grade('09:19:00', '17:45:00').status === 'present',
    grade('09:19:00', '17:45:00').status,
  );
  check(
    'past grace → late_in',
    grade('09:30:00', '18:00:00').status === 'late_in',
    grade('09:30:00', '18:00:00').status,
  );
  check(
    'past the quarter-day threshold → quarter_day',
    grade('10:15:00', '19:00:00').status === 'quarter_day',
    grade('10:15:00', '19:00:00').status,
  );
  check(
    'past the half-day threshold → half_day',
    grade('12:30:00', '21:00:00').status === 'half_day',
    grade('12:30:00', '21:00:00').status,
  );
  check('late_in reports how late', grade('09:30:00', '18:00:00').lateByMinutes === 10);
  check('on-time arrival reports zero lateness', grade('09:05:00', '18:00:00').lateByMinutes === 0);

  section('Duration rules (all arriving on time)');

  check(
    'a full 8 hours → present',
    grade('09:00:00', '17:00:00').status === 'present',
    grade('09:00:00', '17:00:00').status,
  );
  check(
    'three quarters of the day → quarter_day',
    grade('09:00:00', '15:00:00').status === 'quarter_day',
    grade('09:00:00', '15:00:00').status,
  );
  check(
    'half the day → half_day',
    grade('09:00:00', '13:00:00').status === 'half_day',
    grade('09:00:00', '13:00:00').status,
  );
  check(
    'under half the day → absent',
    grade('09:00:00', '11:00:00').status === 'absent',
    grade('09:00:00', '11:00:00').status,
  );
  check('shortfall is reported', grade('09:00:00', '15:00:00').shortfallMinutes === 120);

  section('The worse of the two verdicts wins');

  check(
    'on time but two hours worked → absent, not present',
    grade('09:00:00', '11:00:00').status === 'absent',
  );
  check(
    'arrived at lunchtime but worked a full day → half_day, not present',
    grade('12:30:00', '21:00:00').status === 'half_day',
  );
  // Arrival alone says quarter day; 4.5 of 8 hours says half day. Half wins.
  check(
    'late arrival plus short day takes the worse of the two',
    grade('10:30:00', '15:00:00').status === 'half_day',
    grade('10:30:00', '15:00:00').status,
  );

  section('Open and missing days');

  check('no punch at all → absent', grade(null, null).status === 'absent');
  check('punched in, not out → arrival verdict only', grade('09:05:00', null).status === 'present');
  check('an open day is flagged incomplete', grade('09:05:00', null).complete === false);
  check('a closed day is flagged complete', grade('09:05:00', '18:00:00').complete === true);

  section('Overnight spans');

  check('21:00 → 06:00 measures 540 minutes', wrappedMinutes('21:00:00', '06:00:00') === 540);
  check(
    'a punch-out after midnight is not a negative day',
    evaluateAttendance({
      policy: { ...POLICY, startTime: '21:00:00', endTime: '06:00:00', quarterDayAfter: '22:00:00', halfDayAfter: '01:00:00' },
      punchIn: '21:05:00',
      punchOut: '06:00:00',
    }).workedMinutes === 535,
  );

  section('Salary deduction follows the status');

  check('present costs nothing', LOP_FACTOR.present === 0);
  check('late_in costs nothing — it is a flag, not a deduction', LOP_FACTOR.late_in === 0);
  check('quarter_day costs a quarter of a day', LOP_FACTOR.quarter_day === 0.25);
  check('half_day costs half a day', LOP_FACTOR.half_day === 0.5);
  check('absent costs a whole day', LOP_FACTOR.absent === 1);
  check('a graded day carries its own LOP share', grade('09:00:00', '15:00:00').lopFactor === 0.25);

  section('No hardcoded times — the same punches graded by a different policy');

  const strict = { ...POLICY, graceMinutes: 0, quarterDayAfter: '09:05:00' };
  check(
    '09:10 is present under a 20-minute grace',
    grade('09:10:00', '17:30:00').status === 'present',
  );
  check(
    'the same 09:10 is a quarter day once HR tightens the rules',
    evaluateAttendance({ policy: strict, punchIn: '09:10:00', punchOut: '17:30:00' }).status ===
      'quarter_day',
  );

  const generous = { ...POLICY, fullDayMinutes: 300 };
  check(
    'six hours is a quarter day against an 8-hour full day',
    grade('09:00:00', '15:00:00').status === 'quarter_day',
  );
  check(
    'the same six hours is a full day once HR lowers the requirement to five',
    evaluateAttendance({ policy: generous, punchIn: '09:00:00', punchOut: '15:00:00' }).status ===
      'present',
  );
}

// ------------------------------------------------------------------ live ----
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Regularizes a date with the given times and approves it, then reads it back. */
async function gradeViaApi({ employee, manager, date, punchIn, punchOut }) {
  const submitted = await call('POST', '/attendance/regularizations', {
    token: employee.token,
    body: { date, punchIn, punchOut, reason: 'Attendance policy verification run' },
  });
  if (submitted.status !== 201) {
    return { error: `regularization returned ${submitted.status}` };
  }

  const approved = await call('POST', `/approvals/regularizations/${submitted.json.data.id}`, {
    token: manager.token,
    body: { action: 'approve' },
  });
  if (approved.status !== 200) return { error: `approval returned ${approved.status}` };

  const log = await call('GET', `/attendance/log?from=${date}&to=${date}`, {
    token: employee.token,
  });
  return { record: log.json?.data?.[0] ?? null };
}

async function liveTests() {
  const { admin, manager, employee } = await ensureFixtures();

  section('HR can read the configured policy');

  const read = await call('GET', '/admin/attendance-policy', { token: admin.token });
  check('GET /admin/attendance-policy → 200', read.status === 200, `got ${read.status}`);

  const general = (read.json?.data ?? []).find((p) => p.name === 'General');
  check('the General shift is returned', Boolean(general));
  if (!general) return;

  for (const field of [
    'startTime',
    'endTime',
    'graceMinutes',
    'quarterDayAfter',
    'halfDayAfter',
    'fullDayMinutes',
  ]) {
    check(`policy exposes ${field}`, general[field] !== undefined);
  }
  check('policy states what each status deducts', general.deduction?.half_day === 0.5);
  check('policy derives the late-after time', /^\d{2}:\d{2}$/.test(general.lateAfter ?? ''));

  section('Only an admin may change the policy');

  const asEmployee = await call('GET', '/admin/attendance-policy', { token: employee.token });
  check('employee is refused', asEmployee.status === 403, `got ${asEmployee.status}`);

  const original = {
    startTime: general.startTime,
    endTime: general.endTime,
    graceMinutes: general.graceMinutes,
    quarterDayAfter: general.quarterDayAfter,
    halfDayAfter: general.halfDayAfter,
    fullDayMinutes: general.fullDayMinutes,
  };
  const patch = (body) =>
    call('PATCH', `/admin/attendance-policy/${general.id}`, { token: admin.token, body });

  try {
    section('Thresholds that could never fire are rejected');

    const backwards = await patch({ graceMinutes: 60, quarterDayAfter: '09:40:00' });
    check(
      'a quarter-day threshold inside the grace period is refused',
      backwards.status === 400,
      `got ${backwards.status}`,
    );

    const inverted = await patch({ quarterDayAfter: '14:00:00', halfDayAfter: '11:00:00' });
    check(
      'a half-day threshold before the quarter-day one is refused',
      inverted.status === 400,
      `got ${inverted.status}`,
    );

    const impossible = await patch({ fullDayMinutes: 1200 });
    check(
      'a full day longer than the shift is refused',
      impossible.status === 400,
      `got ${impossible.status}`,
    );

    section('A change to the policy changes how the same times are graded');

    // Under a policy where a quarter day starts at 10:00, an 10:30–18:30 day
    // is a quarter day.
    const tightened = await patch({
      startTime: '09:30:00',
      graceMinutes: 15,
      quarterDayAfter: '10:00:00',
      halfDayAfter: '13:30:00',
      fullDayMinutes: 480,
    });
    check('PATCH → 200', tightened.status === 200, `got ${tightened.status}`);
    check('the saved policy echoes the new threshold', tightened.json?.data?.quarterDayAfter === '10:00:00');

    const dateA = daysAgo(9);
    const first = await gradeViaApi({
      employee,
      manager,
      date: dateA,
      punchIn: '10:30',
      punchOut: '18:30',
    });
    check(
      '10:30–18:30 is a quarter day while the threshold is 10:00',
      first.record?.status === 'quarter_day',
      first.error ?? first.record?.status,
    );

    // Now push the threshold past that arrival. The identical punch pair has to
    // grade differently — no code changed, only configuration.
    const relaxed = await patch({ quarterDayAfter: '11:00:00' });
    check('PATCH → 200', relaxed.status === 200, `got ${relaxed.status}`);

    const dateB = daysAgo(10);
    const second = await gradeViaApi({
      employee,
      manager,
      date: dateB,
      punchIn: '10:30',
      punchOut: '18:30',
    });
    check(
      'the same 10:30–18:30 is only a late-in once the threshold moves to 11:00',
      second.record?.status === 'late_in',
      second.error ?? second.record?.status,
    );

    section('Duration is graded from the configured full day');

    await patch({ quarterDayAfter: '10:00:00', fullDayMinutes: 480 });
    const dateC = daysAgo(11);
    const shortDay = await gradeViaApi({
      employee,
      manager,
      date: dateC,
      punchIn: '09:30',
      punchOut: '14:00',
    });
    check(
      '4.5 hours of an 8-hour day is a half day',
      shortDay.record?.status === 'half_day',
      shortDay.error ?? shortDay.record?.status,
    );
    check('the worked minutes are the real span', shortDay.record?.totalMinutes === 270);

    await patch({ fullDayMinutes: 240 });
    const dateD = daysAgo(12);
    const sameDay = await gradeViaApi({
      employee,
      manager,
      date: dateD,
      punchIn: '09:30',
      punchOut: '14:00',
    });
    check(
      'the same 4.5 hours is a full day once HR requires only four',
      sameDay.record?.status === 'present',
      sameDay.error ?? sameDay.record?.status,
    );

    section('No fabricated punch times anywhere');

    const spare = await call('POST', '/admin/employees', {
      token: admin.token,
      body: {
        name: 'QA Spare',
        email: QA.spare,
        role: 'employee',
        designation: 'QA Engineer',
        department: 'Product Engineering',
        dateOfJoining: new Date().toISOString().slice(0, 10),
        annualCtc: 600000,
      },
    });
    check(
      'a new account is created',
      spare.status === 201 || spare.status === 409,
      `got ${spare.status}`,
    );

    const spareSession = await call('POST', '/auth/login', {
      body: { email: QA.spare, password: PASSWORD },
    });
    check('the new account can sign in', spareSession.status === 200);

    const spareLog = await call('GET', '/attendance/log?limit=200', {
      token: spareSession.json?.data?.token,
    });
    const rows = spareLog.json?.data ?? [];
    const invented = rows.filter((r) => r.punchIn || r.punchOut);
    check(
      'a brand new account has no punch times it never made',
      invented.length === 0,
      `${invented.length} fabricated row(s), e.g. ${JSON.stringify(invented[0] ?? null)}`,
    );
    check(
      'only week offs and holidays are pre-marked',
      rows.every((r) => r.status === 'week_off' || r.status === 'holiday'),
      [...new Set(rows.map((r) => r.status))].join(', '),
    );

    section('Payroll deducts from the graded statuses');

    const summary = await call('GET', '/attendance/summary', { token: employee.token });
    check('the monthly summary reports quarter days', summary.json?.data?.quarterDays !== undefined);
    check('the monthly summary reports half days', summary.json?.data?.halfDays !== undefined);

    const report = await call('GET', '/admin/reports/attendance', { token: admin.token });
    const line = (report.json?.data ?? [])[0];
    check('the attendance report breaks out quarter days', line?.quarterDays !== undefined);
  } finally {
    const restored = await patch(original);
    check(
      'the original policy is restored',
      restored.status === 200,
      `got ${restored.status}`,
    );
  }
}

// ------------------------------------------------------------------ main ----
console.log('Attendance policy verification\n══════════════════════════════');

engineTests();

try {
  await liveTests();
} catch (err) {
  failed += 1;
  console.log(`\n  ✗ live checks could not run — ${err.message}`);
  console.log('    (is the server running, and are the bootstrap admin vars set?)');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
