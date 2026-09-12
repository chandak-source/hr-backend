import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import {
  Announcement,
  Attendance,
  AuditLog,
  Counter,
  Department,
  Employee,
  ExpenseCategory,
  ExpenseClaim,
  Holiday,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  Location,
  Notification,
  PayrollRun,
  Payslip,
  PunchLog,
  RefreshToken,
  RegularizationRequest,
  SalaryStructure,
  Shift,
  Task,
} from '../models/index.js';
import { computePayslip } from '../services/payroll.service.js';
import { financialYearOf, isWeekOff, round2, toDateString } from '../utils/helpers.js';

const TODAY = new Date();
const FY = financialYearOf(TODAY);

// ---------------------------------------------------------------- masters --
const DEPARTMENTS = [
  ['Product Engineering', 'ENG'],
  ['Design', 'DSN'],
  ['Platform', 'PLT'],
  ['Product', 'PRD'],
  ['Human Resources', 'HR'],
  ['Finance', 'FIN'],
  ['Sales', 'SLS'],
  ['Support', 'SUP'],
];

const SHIFTS = [
  ['General', '09:30:00', '18:30:00', 15, '13:30:00'],
  ['Early', '07:30:00', '16:30:00', 10, '11:30:00'],
  ['Night', '21:00:00', '06:00:00', 15, '01:30:00'],
];

const LOCATIONS = [
  ['Ahmedabad HO', 'Prahlad Nagar, Ahmedabad, Gujarat 380015', 23.0121, 72.5106, 200],
  ['Mumbai Office', 'Andheri East, Mumbai, Maharashtra 400069', 19.1136, 72.8697, 200],
  ['Remote', null, null, null, 0],
];

const LEAVE_TYPES = [
  ['CL', 'Casual Leave', 12, true, false, '#0A8FD8'],
  ['SL', 'Sick Leave', 8, true, true, '#F7901E'],
  ['EL', 'Earned Leave', 18, true, false, '#1DA65C'],
  ['CO', 'Comp Off', 4, true, false, '#7B5CD6'],
  ['LOP', 'Loss of Pay', 0, false, false, '#E5484D'],
  ['MP', 'Maternity / Paternity', 0, true, true, '#12A8A0'],
];

const EXPENSE_CATEGORIES = [
  ['Travel', 50000],
  ['Food', 5000],
  ['Accommodation', 30000],
  ['Internet', 2000],
  ['Fuel', 8000],
  ['Others', 10000],
];

const HOLIDAYS = [
  ['2026-01-26', 'Republic Day', 'national'],
  ['2026-03-04', 'Holi', 'festival'],
  ['2026-04-14', 'Dr. Ambedkar Jayanti', 'national'],
  ['2026-05-01', 'Labour Day', 'festival'],
  ['2026-08-15', 'Independence Day', 'national'],
  ['2026-08-26', 'Raksha Bandhan', 'festival'],
  ['2026-09-04', 'Janmashtami', 'festival'],
  ['2026-10-02', 'Gandhi Jayanti', 'national'],
  ['2026-10-20', 'Dussehra', 'festival'],
  ['2026-11-08', 'Diwali', 'festival'],
  ['2026-11-09', 'New Year (Gujarati)', 'festival'],
  ['2026-12-25', 'Christmas', 'national'],
];

// -------------------------------------------------------------- employees --
// [empCode, name, email, role, designation, dept, location, manager, doj, ctc]
const PEOPLE = [
  ['HRA3001', 'Rupal Mehta', 'rupal.mehta@chandacorp.com', 'admin', 'Head of People Ops', 'Human Resources', 'Ahmedabad HO', null, '2017-06-18', 3200000],
  ['MGR2007', 'Nikhil Desai', 'nikhil.desai@chandacorp.com', 'manager', 'Engineering Manager', 'Product Engineering', 'Ahmedabad HO', 'HRA3001', '2019-01-02', 2800000],
  ['MGR2011', 'Meera Shah', 'meera.shah@chandacorp.com', 'manager', 'Regional Sales Manager', 'Sales', 'Mumbai Office', 'HRA3001', '2020-07-13', 2400000],
  ['EMP1042', 'Chandan Sharma', 'chandan.sharma@chandacorp.com', 'employee', 'Senior Flutter Engineer', 'Product Engineering', 'Ahmedabad HO', 'MGR2007', '2022-04-12', 1800000],
  ['EMP1088', 'Aarti Patel', 'aarti.patel@chandacorp.com', 'employee', 'QA Lead', 'Product Engineering', 'Ahmedabad HO', 'MGR2007', '2021-09-06', 1650000],
  ['EMP1103', 'Rohit Vyas', 'rohit.vyas@chandacorp.com', 'employee', 'Backend Engineer', 'Product Engineering', 'Ahmedabad HO', 'MGR2007', '2022-11-21', 1450000],
  ['EMP1121', 'Sneha Joshi', 'sneha.joshi@chandacorp.com', 'employee', 'UI/UX Designer', 'Design', 'Ahmedabad HO', 'MGR2007', '2023-02-13', 1250000],
  ['EMP1134', 'Karan Bhatt', 'karan.bhatt@chandacorp.com', 'employee', 'DevOps Engineer', 'Platform', 'Ahmedabad HO', 'MGR2007', '2021-05-24', 1700000],
  ['EMP1147', 'Priya Nair', 'priya.nair@chandacorp.com', 'employee', 'Business Analyst', 'Product', 'Ahmedabad HO', 'MGR2007', '2023-08-01', 1150000],
  ['EMP1155', 'Devang Shah', 'devang.shah@chandacorp.com', 'employee', 'Associate Engineer', 'Product Engineering', 'Ahmedabad HO', 'MGR2007', '2025-01-06', 720000],
  ['EMP1160', 'Jay Trivedi', 'jay.trivedi@chandacorp.com', 'employee', 'Account Executive', 'Sales', 'Mumbai Office', 'MGR2011', '2024-03-18', 980000],
  ['EMP1166', 'Hetal Rana', 'hetal.rana@chandacorp.com', 'employee', 'Support Specialist', 'Support', 'Mumbai Office', 'MGR2011', '2024-10-07', 640000],
];

const ATTENDANCE_DAYS = 75;

/** YYYY-MM-DD, `offset` days from today. */
const d = (offset) => {
  const x = new Date(TODAY);
  x.setDate(x.getDate() + offset);
  return toDateString(x);
};

const salarySplit = (ctc) => {
  const monthly = ctc / 12;
  return {
    annualCtc: ctc,
    basic: Math.round(monthly * 0.5),
    hra: Math.round(monthly * 0.2),
    conveyance: Math.round(monthly * 0.05),
    specialAllowance: Math.round(monthly * 0.25),
  };
};

async function seed() {
  const conn = await connectDatabase();
  console.log(`• connected to ${conn.host}/${conn.name}`);

  console.log('• clearing existing data');
  await Promise.all(
    [
      AuditLog, Notification, Announcement, Holiday, Task,
      Payslip, PayrollRun, SalaryStructure,
      ExpenseClaim, ExpenseCategory, LeaveRequest, LeaveBalance, LeaveType,
      RegularizationRequest, PunchLog, Attendance,
      RefreshToken, Employee, Location, Shift, Department, Counter,
    ].map((Model) => Model.deleteMany({})),
  );

  // ------------------------------------------------------------- masters --
  const departments = await Department.insertMany(
    DEPARTMENTS.map(([name, code]) => ({ name, code })),
  );
  const shifts = await Shift.insertMany(
    SHIFTS.map(([name, startTime, endTime, graceMinutes, halfDayAfter]) => ({
      name, startTime, endTime, graceMinutes, halfDayAfter,
    })),
  );
  const locations = await Location.insertMany(
    LOCATIONS.map(([name, address, latitude, longitude, geofenceRadiusM]) => ({
      name, address, latitude, longitude, geofenceRadiusM,
    })),
  );
  const leaveTypes = await LeaveType.insertMany(
    LEAVE_TYPES.map(([code, name, annualQuota, isPaid, requiresProof, color], i) => ({
      code, name, annualQuota, isPaid, requiresProof, color, sortOrder: i,
    })),
  );
  await ExpenseCategory.insertMany(
    EXPENSE_CATEGORIES.map(([name, maxLimit], i) => ({ name, maxLimit, sortOrder: i })),
  );
  await Holiday.insertMany(
    HOLIDAYS.map(([holidayDate, name, type]) => ({ holidayDate, name, type })),
  );
  console.log('• masters seeded');

  const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r._id]));
  const deptIds = byKey(departments, 'name');
  const locIds = byKey(locations, 'name');
  const shiftIds = byKey(shifts, 'name');
  const leaveTypeIds = byKey(leaveTypes, 'code');
  const categories = await ExpenseCategory.find().lean();
  const categoryIds = byKey(categories, 'name');

  // ----------------------------------------------------------- employees --
  const passwordHash = await bcrypt.hash(env.seedPassword, 10);
  const empIds = {};

  for (const [i, person] of PEOPLE.entries()) {
    const [code, name, email, role, designation, dept, loc, mgrCode, doj, ctc] = person;

    // eslint-disable-next-line no-await-in-loop
    const employee = await Employee.create({
      empCode: code,
      name,
      email,
      phone: `+91 9${String(8250000000 + Number(code.replace(/\D/g, ''))).slice(0, 9)}`,
      passwordHash,
      role,
      designation,
      departmentId: deptIds[dept] ?? null,
      locationId: locIds[loc] ?? null,
      shiftId: shiftIds.General,
      reportingTo: mgrCode ? empIds[mgrCode] : null,
      dateOfJoining: doj,
      status: 'active',
      pan: `ABCPS${String(1000 + i)}F`,
      uan: `10024589${String(7700 + i)}`,
      bankName: 'HDFC Bank',
      bankAccount: `50100${String(234400 + i)}`,
    });
    empIds[code] = employee._id;

    // eslint-disable-next-line no-await-in-loop
    await SalaryStructure.create({
      employeeId: employee._id,
      effectiveFrom: doj,
      ...salarySplit(ctc),
      isCurrent: true,
    });
  }

  await Department.updateOne({ code: 'ENG' }, { headId: empIds.MGR2007 });
  await Department.updateOne({ code: 'HR' }, { headId: empIds.HRA3001 });
  await Department.updateOne({ code: 'SLS' }, { headId: empIds.MGR2011 });
  console.log(`• ${PEOPLE.length} employees seeded (password: ${env.seedPassword})`);

  // ---------------------------------------------------------- attendance --
  const holidaySet = new Set(HOLIDAYS.map((h) => h[0]));
  const attendanceRows = [];
  const punchRows = [];
  const IN_TIMES = ['09:24:00', '09:31:00', '09:28:00', '09:39:00', '09:22:00', '09:47:00'];
  const OUT_TIMES = ['18:44:00', '19:02:00', '18:36:00', '18:58:00', '18:31:00', '19:20:00'];

  for (const [index, person] of PEOPLE.entries()) {
    const employeeId = empIds[person[0]];

    for (let back = 0; back < ATTENDANCE_DAYS; back += 1) {
      const date = d(-back);
      if (date < person[8]) continue;

      if (isWeekOff(date)) {
        attendanceRows.push({ employeeId, workDate: date, status: 'week_off', shiftId: shiftIds.General });
        continue;
      }
      if (holidaySet.has(date)) {
        attendanceRows.push({ employeeId, workDate: date, status: 'holiday', shiftId: shiftIds.General });
        continue;
      }

      const seedNum = (back * 7 + index * 13) % 60;
      const slot = (back + index) % IN_TIMES.length;
      const workMode = seedNum % 9 === 0 ? 'wfh' : 'office';
      const inLocation = workMode === 'wfh' ? 'Work From Home' : person[6];

      let status = 'present';
      let punchIn = IN_TIMES[slot];
      let punchOut = OUT_TIMES[slot];

      if (seedNum === 11) status = 'leave';
      else if (seedNum === 23) status = 'absent';
      else if (seedNum === 31) {
        status = 'miss_punch';
        punchOut = null;
      } else if (seedNum === 43) {
        status = 'half_day';
        punchOut = '13:35:00';
      } else if (seedNum % 17 === 0) {
        status = 'late_in';
        punchIn = '10:22:00';
      }

      if (status === 'leave' || status === 'absent') {
        attendanceRows.push({ employeeId, workDate: date, status, shiftId: shiftIds.General });
        continue;
      }

      // Today's row stays open (punched in, not out) so the live timer has data.
      if (back === 0) punchOut = null;

      const minutes = punchOut
        ? Number(punchOut.slice(0, 2)) * 60 +
          Number(punchOut.slice(3, 5)) -
          (Number(punchIn.slice(0, 2)) * 60 + Number(punchIn.slice(3, 5)))
        : 0;

      attendanceRows.push({
        employeeId,
        workDate: date,
        punchIn,
        punchOut,
        totalMinutes: Math.max(0, minutes),
        status,
        workMode,
        inLocation,
        shiftId: shiftIds.General,
      });

      punchRows.push({
        employeeId,
        punchedAt: new Date(`${date}T${punchIn}`),
        punchType: 'in',
        workMode,
        address: inLocation,
      });
      if (punchOut) {
        punchRows.push({
          employeeId,
          punchedAt: new Date(`${date}T${punchOut}`),
          punchType: 'out',
          workMode,
          address: inLocation,
        });
      }
    }
  }

  for (let i = 0; i < attendanceRows.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    await Attendance.insertMany(attendanceRows.slice(i, i + 500));
  }
  for (let i = 0; i < punchRows.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    await PunchLog.insertMany(punchRows.slice(i, i + 500));
  }
  console.log(`• ${attendanceRows.length} attendance rows, ${punchRows.length} punch logs`);

  // -------------------------------------------------------- leave module --
  const balanceRows = [];
  for (const employeeId of Object.values(empIds)) {
    for (const [ltCode, , quota] of LEAVE_TYPES) {
      if (Number(quota) === 0) continue;
      balanceRows.push({
        employeeId,
        leaveTypeId: leaveTypeIds[ltCode],
        financialYear: FY,
        allotted: quota,
        used: { CL: 5, SL: 2, EL: 7, CO: 1 }[ltCode] ?? 0,
        carriedForward: 0,
      });
    }
  }
  await LeaveBalance.insertMany(balanceRows);

  const leaveRows = [
    ['LV-2291', 'EMP1042', 'CL', d(7), d(8), 'full_day', 2, 'Family function at native place.', 'pending', 'MGR2007', d(-3)],
    ['LV-2301', 'EMP1088', 'SL', d(1), d(2), 'full_day', 2, 'Down with dengue, medical certificate attached.', 'pending', 'MGR2007', d(0)],
    ['LV-2299', 'EMP1103', 'EL', d(14), d(18), 'full_day', 5, 'Pre-planned trip to Manali.', 'pending', 'MGR2007', d(-1)],
    ['LV-2288', 'EMP1134', 'CO', d(4), d(4), 'full_day', 1, 'Worked on the release weekend.', 'pending', 'MGR2007', d(-2)],
    ['LV-2280', 'EMP1121', 'CO', d(-5), d(-5), 'full_day', 1, 'Comp off for design sprint weekend.', 'approved', 'MGR2007', d(-12)],
    ['LV-2188', 'EMP1042', 'SL', d(-9), d(-9), 'full_day', 1, 'Viral fever, consulted doctor.', 'approved', 'MGR2007', d(-9)],
    ['LV-2044', 'EMP1042', 'EL', d(-35), d(-31), 'full_day', 5, 'Annual vacation with family.', 'approved', 'MGR2007', d(-55)],
    ['LV-1987', 'EMP1042', 'CL', d(-59), d(-59), 'first_half', 0.5, 'Personal errand.', 'rejected', 'MGR2007', d(-60)],
    ['LV-2305', 'EMP1160', 'CL', d(3), d(3), 'full_day', 1, 'Bank work.', 'pending', 'MGR2011', d(0)],
  ];
  await LeaveRequest.insertMany(
    leaveRows.map(
      ([requestCode, emp, lt, fromDate, toDate, dayType, days, reason, status, approver, appliedOn]) => ({
        requestCode,
        employeeId: empIds[emp],
        leaveTypeId: leaveTypeIds[lt],
        fromDate,
        toDate,
        dayType,
        days,
        reason,
        status,
        approverId: empIds[approver],
        appliedOn,
      }),
    ),
  );
  console.log(`• ${balanceRows.length} leave balances, ${leaveRows.length} leave requests`);

  // ------------------------------------------------------ regularizations --
  await RegularizationRequest.insertMany(
    [
      ['RG-311', 'EMP1121', d(-3), '09:35:00', '18:40:00', 'Biometric device was down at gate 2.', 'pending', 'MGR2007'],
      ['RG-308', 'EMP1042', d(-8), '09:38:00', '18:52:00', 'Forgot to punch out, left for a client call.', 'pending', 'MGR2007'],
      ['RG-301', 'EMP1103', d(-27), '10:05:00', '19:15:00', 'Late in due to metro breakdown.', 'approved', 'MGR2007'],
    ].map(([requestCode, emp, workDate, punchIn, punchOut, reason, status, approver]) => ({
      requestCode,
      employeeId: empIds[emp],
      workDate,
      punchIn,
      punchOut,
      reason,
      status,
      approverId: empIds[approver],
    })),
  );

  // ---------------------------------------------------------------- claims --
  await ExpenseClaim.insertMany(
    [
      ['EX-780', 'EMP1103', 'Travel', 7650, d(-2), 'Vendor audit trip — Pune.', 'pending', 'MGR2007'],
      ['EX-771', 'EMP1042', 'Travel', 4820, d(-6), 'Client visit — Ahmedabad to Mumbai flight.', 'pending', 'MGR2007'],
      ['EX-769', 'EMP1088', 'Internet', 1499, d(-9), 'WFH broadband — July.', 'pending', 'MGR2007'],
      ['EX-762', 'EMP1042', 'Internet', 1299, d(-22), 'Monthly broadband reimbursement.', 'approved', 'MGR2007'],
      ['EX-740', 'EMP1042', 'Food', 640, d(-29), 'Team dinner after release.', 'approved', 'MGR2007'],
      ['EX-728', 'EMP1042', 'Others', 2500, d(-45), 'Mechanical keyboard (no prior approval).', 'rejected', 'MGR2007'],
      ['EX-715', 'EMP1160', 'Fuel', 3200, d(-11), 'Field visits — Mumbai west zone.', 'pending', 'MGR2011'],
    ].map(([claimCode, emp, category, amount, expenseDate, note, status, approver]) => ({
      claimCode,
      employeeId: empIds[emp],
      categoryId: categoryIds[category],
      amount,
      expenseDate,
      note,
      status,
      approverId: empIds[approver],
    })),
  );

  // ----------------------------------------------------------------- tasks --
  await Task.insertMany(
    [
      ['T-401', 'EMP1042', 'Ship attendance geo-fencing module', 'ESS Mobile App', d(2), 'high', 0.72, false],
      ['T-398', 'EMP1042', 'Review payroll export API contract', 'Payroll Core', d(4), 'medium', 0.35, false],
      ['T-392', 'EMP1042', 'Fix leave balance rounding bug', 'Leave Engine', d(-2), 'high', 1, true],
      ['T-385', 'EMP1042', 'Update onboarding checklist UI', 'Onboarding', d(9), 'low', 0.1, false],
      ['T-377', 'EMP1088', 'Regression suite for leave approvals', 'QA Automation', d(5), 'medium', 0.5, false],
      ['T-370', 'EMP1103', 'Payslip PDF generation service', 'Payroll Core', d(6), 'high', 0.4, false],
    ].map(([taskCode, emp, title, project, dueDate, priority, progress, isDone]) => ({
      taskCode,
      employeeId: empIds[emp],
      assignedBy: empIds.MGR2007,
      title,
      project,
      dueDate,
      priority,
      progress,
      isDone,
      completedAt: isDone ? new Date(`${dueDate}T17:00:00`) : null,
    })),
  );

  // --------------------------------------------------------- broadcast bits --
  await Announcement.insertMany(
    [
      ['Q2 Town Hall — 30 July, 4 PM', 'Join us in the Auditorium (or on Meet) for the quarterly business review, product roadmap and the Q2 award ceremony.', 'Event', `${d(-1)}T10:00:00`],
      ['Mediclaim policy renewed for FY 26-27', 'Coverage increased to ₹7,00,000 per family. Add your dependants on the portal before 10 August 2026.', 'Policy', `${d(-5)}T11:30:00`],
      ['New attendance regularization SLA', 'Regularization requests must now be raised within 5 working days of the discrepancy date.', 'HR Update', `${d(-12)}T09:15:00`],
      ['Welcome our new joinees', 'Nine new colleagues joined us this month across Engineering, Sales and Support. Say hello on Slack!', 'Celebration', `${d(-18)}T16:00:00`],
    ].map(([title, body, category, publishedAt]) => ({
      title,
      body,
      category,
      publishedBy: empIds.HRA3001,
      publishedAt: new Date(publishedAt),
    })),
  );

  const notificationRows = [];
  for (const employeeId of Object.values(empIds)) {
    notificationRows.push(
      { employeeId, title: 'Payslip available', subtitle: 'Your latest payslip has been published.', kind: 'payroll', isRead: false },
      { employeeId, title: 'Timesheet reminder', subtitle: 'Fill your weekly timesheet before Friday 6 PM.', kind: 'task', isRead: true },
    );
  }
  notificationRows.push(
    { employeeId: empIds.EMP1042, title: 'Leave approved', subtitle: 'Your sick leave was approved by Nikhil Desai.', kind: 'leave', isRead: false },
    { employeeId: empIds.EMP1042, title: 'Miss punch detected', subtitle: 'Punch out missing. Raise a regularization request.', kind: 'attendance', isRead: false },
    { employeeId: empIds.MGR2007, title: 'New approval request', subtitle: '4 requests are waiting for your action.', kind: 'leave', isRead: false },
    { employeeId: empIds.HRA3001, title: 'Payroll pending', subtitle: 'July 2026 payroll has not been processed yet.', kind: 'payroll', isRead: false },
  );
  await Notification.insertMany(notificationRows);

  // ------------------------------------------------------------- payroll --
  const structures = await SalaryStructure.find({ isCurrent: true }).lean();
  const structureBy = new Map(structures.map((s) => [s.employeeId.toString(), s]));

  const periods = [];
  for (let back = 4; back >= 1; back -= 1) {
    const p = new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1);
    periods.push([p.getMonth() + 1, p.getFullYear()]);
  }

  for (const [month, year] of periods) {
    // eslint-disable-next-line no-await-in-loop
    const run = await PayrollRun.create({
      payMonth: month,
      payYear: year,
      status: 'published',
      processedBy: empIds.HRA3001,
      processedAt: new Date(),
      publishedAt: new Date(),
    });

    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    const totals = { gross: 0, deductions: 0, net: 0, count: 0 };
    const slips = [];

    for (const employeeId of Object.values(empIds)) {
      const structure = structureBy.get(employeeId.toString());
      if (!structure) continue;

      // The seeded attendance is in memory already — no need to query it back.
      const lopDays = attendanceRows
        .filter(
          (a) =>
            a.employeeId.equals(employeeId) &&
            a.workDate.startsWith(monthPrefix) &&
            ['absent', 'miss_punch', 'half_day'].includes(a.status),
        )
        .reduce((sum, a) => sum + (a.status === 'half_day' ? 0.5 : 1), 0);

      const slip = computePayslip({ structure, month, year, lopDays });

      slips.push({
        payrollRunId: run._id,
        employeeId,
        paidDays: slip.paidDays,
        lopDays: slip.lopDays,
        gross: slip.gross,
        deductions: slip.deductions,
        net: slip.net,
        bankAccount: 'HDFC •••• 4412',
        creditedOn: toDateString(new Date(year, month, 1)),
        components: [
          ...slip.earnings.map((c, i) => ({ ...c, type: 'earning', sortOrder: i })),
          ...slip.deductionItems.map((c, i) => ({ ...c, type: 'deduction', sortOrder: i })),
        ],
      });

      totals.gross += slip.gross;
      totals.deductions += slip.deductions;
      totals.net += slip.net;
      totals.count += 1;
    }

    // eslint-disable-next-line no-await-in-loop
    await Payslip.insertMany(slips);
    // eslint-disable-next-line no-await-in-loop
    await PayrollRun.updateOne(
      { _id: run._id },
      {
        employeeCount: totals.count,
        totalGross: round2(totals.gross),
        totalDeductions: round2(totals.deductions),
        totalNet: round2(totals.net),
      },
    );
  }
  console.log(`• ${periods.length} payroll runs with payslips`);

  console.log('\nSeed complete.');
}

seed()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nSeed failed:', err);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
