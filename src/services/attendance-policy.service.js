import { Employee, Shift } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * The one place attendance is graded.
 *
 * Every threshold comes from the employee's shift, which HR edits from
 * Admin → Attendance Policy. Nothing here contains a clock time or a cut-off:
 * change the shift and the next punch, regularization and payroll run all use
 * the new rules without a deploy.
 *
 * Two independent checks run on a completed day and the worse one wins:
 *
 *   arrival   — how late the punch-in was against `startTime`, `graceMinutes`,
 *               `quarterDayAfter` and `halfDayAfter`
 *   duration  — how much of `fullDayMinutes` was actually worked
 *
 * So arriving on time and leaving after two hours is a half day, and so is
 * arriving at lunchtime and staying till midnight.
 */

/** Increasing severity. `worse()` walks this, so order is the contract. */
const SEVERITY = ['present', 'late_in', 'quarter_day', 'half_day', 'absent'];

/**
 * Share of a day lost per status, used by payroll.
 *
 * These are what the words mean — a quarter day is a quarter — not policy.
 * What HR configures is the thresholds that decide which status a day gets.
 */
export const LOP_FACTOR = {
  present: 0,
  late_in: 0,
  leave: 0,
  week_off: 0,
  holiday: 0,
  quarter_day: 0.25,
  half_day: 0.5,
  absent: 1,
  miss_punch: 1,
};

/** Statuses payroll has to look at at all. */
export const DEDUCTIBLE_STATUSES = Object.keys(LOP_FACTOR).filter((s) => LOP_FACTOR[s] > 0);

/**
 * The fraction of a full day each shortfall band still earns. A day worked
 * short of `fullDayMinutes` is credited down to the next band.
 */
const DURATION_BANDS = [
  { earns: 1, status: 'present' },
  { earns: 0.75, status: 'quarter_day' },
  { earns: 0.5, status: 'half_day' },
];

/** Anything further from the shift start than this is an early arrival, not a late one. */
const EARLY_ARRIVAL_WINDOW = 720;

const toMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

/**
 * Minutes from `from` to `to`, wrapping over midnight so a 21:00–06:00 shift
 * and a punch-out after midnight both measure correctly.
 */
export const wrappedMinutes = (from, to) => (toMinutes(to) - toMinutes(from) + 1440) % 1440;

/**
 * How far past the shift start a clock time falls. Arriving before the shift
 * starts wraps to nearly a full day, which is read back as "early" → 0.
 */
const pastStart = (policy, time) => {
  const diff = wrappedMinutes(policy.startTime, time);
  return diff > EARLY_ARRIVAL_WINDOW ? 0 : diff;
};

const worse = (a, b) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

/**
 * A shift document read with `.lean()` is raw BSON, so a field added to the
 * schema after the document was written comes back missing rather than
 * defaulted. Falling back to the schema's own default keeps the number in one
 * place instead of repeating it here.
 */
const configured = (shift, field) => shift[field] ?? Shift.schema.path(field).getDefault();

/** Normalised, self-describing view of a shift's rules. */
export function toPolicy(shift) {
  return {
    id: shift._id?.toString() ?? shift.id,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    graceMinutes: configured(shift, 'graceMinutes'),
    quarterDayAfter: shift.quarterDayAfter ?? null,
    halfDayAfter: shift.halfDayAfter ?? null,
    fullDayMinutes: configured(shift, 'fullDayMinutes'),
  };
}

/**
 * The rules that apply to one employee: their own shift, or the first shift HR
 * configured when they have not been assigned one.
 *
 * Throws rather than falling back to built-in numbers — a day cannot be graded
 * against a policy that does not exist, and silently inventing one is how
 * hardcoded thresholds creep back in.
 */
export async function policyForEmployee(employeeId, session = null) {
  const employee = await Employee.findById(employeeId).select('shiftId').session(session).lean();

  const shift = employee?.shiftId
    ? await Shift.findById(employee.shiftId).session(session).lean()
    : null;

  const effective = shift ?? (await Shift.findOne().sort({ createdAt: 1 }).session(session).lean());
  if (!effective) {
    throw ApiError.badRequest(
      'No attendance policy is configured. Ask HR to set up a shift before punching in.',
    );
  }
  return toPolicy(effective);
}

/**
 * Grades one day.
 *
 * `punchOut` missing means the day is still open: only the arrival is known, so
 * that verdict stands until the employee punches out.
 *
 * Returns the status plus the numbers behind it, so the API can tell an
 * employee *why* a day was marked the way it was.
 */
export function evaluateAttendance({ policy, punchIn, punchOut }) {
  if (!punchIn) {
    return {
      status: 'absent',
      workedMinutes: 0,
      lateByMinutes: 0,
      shortfallMinutes: policy.fullDayMinutes,
      lopFactor: LOP_FACTOR.absent,
      complete: true,
      reason: 'No punch-in recorded',
    };
  }

  const lateByMinutes = Math.max(0, pastStart(policy, punchIn) - policy.graceMinutes);
  const arrival = arrivalVerdict(policy, punchIn, lateByMinutes);

  if (!punchOut) {
    return {
      status: arrival,
      workedMinutes: 0,
      lateByMinutes,
      shortfallMinutes: policy.fullDayMinutes,
      lopFactor: LOP_FACTOR[arrival],
      complete: false,
      reason: arrivalReason(policy, arrival, lateByMinutes),
    };
  }

  const workedMinutes = wrappedMinutes(punchIn, punchOut);
  const duration = durationVerdict(policy, workedMinutes);
  const status = worse(arrival, duration);

  return {
    status,
    workedMinutes,
    lateByMinutes,
    shortfallMinutes: Math.max(0, policy.fullDayMinutes - workedMinutes),
    lopFactor: LOP_FACTOR[status],
    complete: true,
    reason:
      status === duration && duration !== arrival
        ? durationReason(policy, workedMinutes)
        : arrivalReason(policy, arrival, lateByMinutes),
  };
}

function arrivalVerdict(policy, punchIn, lateByMinutes) {
  const arrived = pastStart(policy, punchIn);

  if (policy.halfDayAfter && arrived > pastStart(policy, policy.halfDayAfter)) return 'half_day';
  if (policy.quarterDayAfter && arrived > pastStart(policy, policy.quarterDayAfter)) {
    return 'quarter_day';
  }
  return lateByMinutes > 0 ? 'late_in' : 'present';
}

function durationVerdict(policy, workedMinutes) {
  const band = DURATION_BANDS.find((b) => workedMinutes >= policy.fullDayMinutes * b.earns);
  return band?.status ?? 'absent';
}

const arrivalReason = (policy, status, lateByMinutes) => {
  if (status === 'present') return `Punched in within the ${policy.graceMinutes}-minute grace period`;
  if (status === 'late_in') return `Punched in ${lateByMinutes} minute(s) past the grace period`;
  if (status === 'quarter_day') return `Punched in after ${policy.quarterDayAfter}`;
  return `Punched in after ${policy.halfDayAfter}`;
};

const durationReason = (policy, workedMinutes) =>
  `Worked ${workedMinutes} of the ${policy.fullDayMinutes} minutes required for a full day`;

/**
 * `$switch` that turns a status field into its LOP share, so the payroll
 * aggregation and the punch flow cannot drift apart.
 */
export const lopExpression = (field = '$status') => ({
  $switch: {
    branches: DEDUCTIBLE_STATUSES.map((status) => ({
      case: { $eq: [field, status] },
      then: LOP_FACTOR[status],
    })),
    default: 0,
  },
});
