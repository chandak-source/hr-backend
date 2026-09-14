import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';
import {
  Attendance,
  Employee,
  Holiday,
  LeaveBalance,
  LeaveType,
  SalaryStructure,
  Shift,
} from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import {
  daysAgoString,
  eachDate,
  financialYearOf,
  isWeekOff,
  todayString,
} from '../utils/helpers.js';
import { nextSequence } from './sequence.service.js';

/** How much attendance history a freshly created employee starts with. */
const BACKFILL_DAYS = 30;

/**
 * CTC given to self-registered accounts. Payroll needs a salary structure to
 * exist, but a user must not get to declare their own pay — an admin corrects
 * this from the employee record.
 */
export const SIGNUP_DEFAULT_CTC = 600000;

const CODE_PREFIX = { admin: 'ADM', manager: 'MGR', employee: 'EMP' };

/**
 * The only company domain an account may exist under.
 * Returns the normalised address, or throws with a message the UI can show.
 */
export function assertAllowedEmail(email) {
  const normalised = String(email ?? '').trim().toLowerCase();

  if (!normalised || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) {
    throw ApiError.badRequest('Enter a valid email address');
  }
  if (!normalised.endsWith(env.allowedEmailDomain)) {
    throw ApiError.badRequest(
      `Only ${env.allowedEmailDomain} email addresses are allowed`,
    );
  }
  // Reject "@superaip.com" with nothing in front of it.
  if (normalised.length <= env.allowedEmailDomain.length) {
    throw ApiError.badRequest('Enter a valid email address');
  }
  return normalised;
}

/** 60/20/5/25 split of monthly CTC — the structure the payroll engine reads. */
export function salarySplit(annualCtc) {
  const monthly = annualCtc / 12;
  return {
    annualCtc,
    basic: Math.round(monthly * 0.5),
    hra: Math.round(monthly * 0.2),
    conveyance: Math.round(monthly * 0.05),
    specialAllowance: Math.round(monthly * 0.25),
  };
}

/**
 * Creates an employee of any role along with everything the app needs for that
 * account to work: salary structure, leave balances for the current financial
 * year, and a short attendance history so the dashboards aren't blank.
 *
 * Used by both `POST /admin/employees` and the seeder's bootstrap admin, so
 * there is exactly one way an account comes into existence.
 */
export async function provisionEmployee(
  {
    name,
    email,
    password,
    role = 'employee',
    designation,
    departmentId = null,
    locationId = null,
    reportingTo = null,
    dateOfJoining,
    annualCtc,
    phone = null,
  },
  session = null,
) {
  const safeEmail = assertAllowedEmail(email);

  const existing = await Employee.findOne({ email: safeEmail }).session(session).lean();
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const shift = await Shift.findOne({ name: 'General' }).select('_id').session(session).lean();
  const empCode = `${CODE_PREFIX[role] ?? 'EMP'}${await nextSequence('employee', session)}`;

  const [employee] = await Employee.create(
    [
      {
        empCode,
        name,
        email: safeEmail,
        phone,
        passwordHash: await bcrypt.hash(password, 10),
        role,
        designation,
        departmentId,
        locationId,
        shiftId: shift?._id ?? null,
        reportingTo,
        dateOfJoining,
      },
    ],
    { session },
  );

  await SalaryStructure.create(
    [
      {
        employeeId: employee._id,
        effectiveFrom: dateOfJoining,
        ...salarySplit(annualCtc),
        isCurrent: true,
      },
    ],
    { session },
  );

  await allocateLeaveBalances(employee._id, session);
  await backfillAttendance(employee._id, dateOfJoining, session);

  return employee;
}

/**
 * Without these rows `POST /leave/requests` refuses every application with
 * "No balance allotted", so a new account cannot use the leave module at all.
 */
export async function allocateLeaveBalances(employeeId, session = null) {
  const types = await LeaveType.find({ isActive: true, annualQuota: { $gt: 0 } })
    .session(session)
    .lean();
  if (!types.length) return 0;

  const financialYear = financialYearOf();
  await LeaveBalance.insertMany(
    types.map((type) => ({
      employeeId,
      leaveTypeId: type._id,
      financialYear,
      allotted: type.annualQuota,
      used: 0,
      carriedForward: 0,
    })),
    { session },
  );
  return types.length;
}

/**
 * Marks the last 30 days (never before the joining date) so the calendar,
 * monthly summary and team roster have something to show on day one.
 * Weekends and holidays are respected; working days are recorded as present.
 */
export async function backfillAttendance(employeeId, dateOfJoining, session = null) {
  const from = dateOfJoining > daysAgoString(BACKFILL_DAYS)
    ? dateOfJoining
    : daysAgoString(BACKFILL_DAYS);
  const to = todayString();
  if (from > to) return 0;

  const holidays = await Holiday.find({ holidayDate: { $gte: from, $lte: to } })
    .select('holidayDate')
    .session(session)
    .lean();
  const holidaySet = new Set(holidays.map((h) => h.holidayDate));

  const rows = eachDate(from, to).map((workDate) => {
    if (isWeekOff(workDate)) {
      return { employeeId, workDate, status: 'week_off' };
    }
    if (holidaySet.has(workDate)) {
      return { employeeId, workDate, status: 'holiday' };
    }
    return {
      employeeId,
      workDate,
      punchIn: '09:30:00',
      punchOut: '18:30:00',
      totalMinutes: 540,
      status: 'present',
      workMode: 'office',
    };
  });

  if (rows.length) await Attendance.insertMany(rows, { session });
  return rows.length;
}
