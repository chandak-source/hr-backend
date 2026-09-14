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
import { provisionEmployee } from '../services/provisioning.service.js';

/**
 * Seeds the master data every module needs (departments, shifts, leave types…)
 * and exactly ONE administrator so somebody can sign in and use the Create User
 * flow.
 *
 * There are deliberately no demo employees, managers or admins in this file.
 * The bootstrap account comes from configuration, not source:
 *
 *   BOOTSTRAP_ADMIN_EMAIL=you@superaip.com
 *   BOOTSTRAP_ADMIN_PASSWORD=...
 *
 * Every other account — of any role — is created through the app.
 */

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

// A shift is also its attendance policy. These are opening values for a fresh
// database — HR changes them from Admin → Attendance Policy, and every
// calculation follows from there.
// [name, start, end, grace, quarter-day after, half-day after, full-day minutes]
const SHIFTS = [
  ['General', '09:30:00', '18:30:00', 15, '10:30:00', '13:30:00', 540],
  ['Early', '07:30:00', '16:30:00', 10, '08:30:00', '11:30:00', 540],
  ['Night', '21:00:00', '06:00:00', 15, '22:00:00', '01:30:00', 540],
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

function requireBootstrapConfig() {
  const { email, password } = env.bootstrapAdmin;

  if (!email || !password) {
    throw new Error(
      'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in .env.\n' +
        '  This is the only account the seeder creates; everyone else is added\n' +
        `  through the app. The address must end in ${env.allowedEmailDomain}.`,
    );
  }
  if (password.length < 8) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters.');
  }
}

async function seed() {
  requireBootstrapConfig();

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
  await Shift.insertMany(
    SHIFTS.map(
      ([name, startTime, endTime, graceMinutes, quarterDayAfter, halfDayAfter, fullDayMinutes]) => ({
        name, startTime, endTime, graceMinutes, quarterDayAfter, halfDayAfter, fullDayMinutes,
      }),
    ),
  );
  const locations = await Location.insertMany(
    LOCATIONS.map(([name, address, latitude, longitude, geofenceRadiusM]) => ({
      name, address, latitude, longitude, geofenceRadiusM,
    })),
  );
  await LeaveType.insertMany(
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
  console.log('• masters seeded (departments, shifts, locations, leave types, categories, holidays)');

  // ----------------------------------------------------- bootstrap admin --
  const hr = departments.find((d) => d.code === 'HR');
  const ho = locations.find((l) => l.name === 'Ahmedabad HO');

  const admin = await provisionEmployee({
    name: env.bootstrapAdmin.name,
    email: env.bootstrapAdmin.email,
    password: env.bootstrapAdmin.password,
    role: 'admin',
    designation: 'System Administrator',
    departmentId: hr?._id ?? null,
    locationId: ho?._id ?? null,
    dateOfJoining: new Date().toISOString().slice(0, 10),
    annualCtc: 1200000,
  });

  await Department.updateOne({ code: 'HR' }, { headId: admin._id });

  console.log(`• bootstrap admin: ${admin.email} (${admin.empCode})`);
  console.log('\nSeed complete — 1 account exists. Create the rest from the app:');
  console.log('  Sign in as the admin → Employees → Add');
}

seed()
  .then(async () => {
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nSeed failed:', err.message);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
