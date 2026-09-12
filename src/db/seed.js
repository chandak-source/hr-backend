import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { computePayslip } from '../services/payroll.service.js';
import { financialYearOf, isWeekOff, toDateString } from '../utils/helpers.js';

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
  ['CL', 'Casual Leave', 12, 1, 0, '#0A8FD8'],
  ['SL', 'Sick Leave', 8, 1, 1, '#F7901E'],
  ['EL', 'Earned Leave', 18, 1, 0, '#1DA65C'],
  ['CO', 'Comp Off', 4, 1, 0, '#7B5CD6'],
  ['LOP', 'Loss of Pay', 0, 0, 0, '#E5484D'],
  ['MP', 'Maternity / Paternity', 0, 1, 1, '#12A8A0'],
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

async function seed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    console.log('• clearing existing data');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'audit_logs', 'notifications', 'announcements', 'holidays', 'tasks',
      'payslip_components', 'payslips', 'payroll_runs', 'salary_structures',
      'expense_claims', 'expense_categories', 'leave_requests', 'leave_balances',
      'leave_types', 'regularization_requests', 'punch_logs', 'attendance',
      'refresh_tokens', 'employees', 'locations', 'shifts', 'departments',
    ]) {
      await conn.query(`TRUNCATE TABLE \`${table}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // ------------------------------------------------------------ masters --
    await conn.query('INSERT INTO departments (name, code) VALUES ?', [DEPARTMENTS]);
    await conn.query(
      'INSERT INTO shifts (name, start_time, end_time, grace_minutes, half_day_after) VALUES ?',
      [SHIFTS],
    );
    await conn.query(
      'INSERT INTO locations (name, address, latitude, longitude, geofence_radius_m) VALUES ?',
      [LOCATIONS],
    );
    await conn.query(
      'INSERT INTO leave_types (code, name, annual_quota, is_paid, requires_proof, color_hex) VALUES ?',
      [LEAVE_TYPES],
    );
    await conn.query('INSERT INTO expense_categories (name, max_limit) VALUES ?', [
      EXPENSE_CATEGORIES,
    ]);
    await conn.query('INSERT INTO holidays (holiday_date, name, holiday_type) VALUES ?', [HOLIDAYS]);
    console.log('• masters seeded');

    const idMap = async (table, keyCol) => {
      const [rows] = await conn.query(`SELECT id, \`${keyCol}\` AS k FROM \`${table}\``);
      return Object.fromEntries(rows.map((r) => [r.k, r.id]));
    };

    const deptIds = await idMap('departments', 'name');
    const locIds = await idMap('locations', 'name');
    const shiftIds = await idMap('shifts', 'name');
    const leaveTypeIds = await idMap('leave_types', 'code');
    const categoryIds = await idMap('expense_categories', 'name');

    // ---------------------------------------------------------- employees --
    const passwordHash = await bcrypt.hash(env.seedPassword, 10);
    const empIds = {};

    for (const [code, name, email, role, designation, dept, loc, mgrCode, doj, ctc] of PEOPLE) {
      const [res] = await conn.execute(
        `INSERT INTO employees
           (emp_code, name, email, phone, password_hash, role, designation, department_id,
            location_id, shift_id, reporting_to, date_of_joining, status, pan, uan,
            bank_name, bank_account)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
        [
          code,
          name,
          email,
          `+91 9${String(8250000000 + Number(code.replace(/\D/g, ''))).slice(0, 9)}`,
          passwordHash,
          role,
          designation,
          deptIds[dept] ?? null,
          locIds[loc] ?? null,
          shiftIds.General,
          mgrCode ? empIds[mgrCode] : null,
          doj,
          `ABCPS${String(1000 + Object.keys(empIds).length)}F`,
          `10024589${String(7700 + Object.keys(empIds).length)}`,
          'HDFC Bank',
          `50100${String(234400 + Object.keys(empIds).length)}`,
        ],
      );
      empIds[code] = res.insertId;

      // salary structure — 60/25/5/10 split of monthly CTC
      const monthly = ctc / 12;
      await conn.execute(
        `INSERT INTO salary_structures
           (employee_id, effective_from, annual_ctc, basic, hra, conveyance, special_allowance, is_current)
         VALUES (?,?,?,?,?,?,?,1)`,
        [
          res.insertId,
          doj,
          ctc,
          Math.round(monthly * 0.5),
          Math.round(monthly * 0.2),
          Math.round(monthly * 0.05),
          Math.round(monthly * 0.25),
        ],
      );
    }

    await conn.execute('UPDATE departments SET head_id = ? WHERE code = ?', [empIds.MGR2007, 'ENG']);
    await conn.execute('UPDATE departments SET head_id = ? WHERE code = ?', [empIds.HRA3001, 'HR']);
    await conn.execute('UPDATE departments SET head_id = ? WHERE code = ?', [empIds.MGR2011, 'SLS']);
    console.log(`• ${PEOPLE.length} employees seeded (password: ${env.seedPassword})`);

    // ---------------------------------------------------------- attendance --
    const holidaySet = new Set(HOLIDAYS.map((h) => h[0]));
    const attendanceRows = [];
    const punchRows = [];
    const IN_TIMES = ['09:24:00', '09:31:00', '09:28:00', '09:39:00', '09:22:00', '09:47:00'];
    const OUT_TIMES = ['18:44:00', '19:02:00', '18:36:00', '18:58:00', '18:31:00', '19:20:00'];

    for (const [index, person] of PEOPLE.entries()) {
      const empId = empIds[person[0]];
      for (let back = 0; back < ATTENDANCE_DAYS; back += 1) {
        const day = new Date(TODAY);
        day.setDate(day.getDate() - back);
        const date = toDateString(day);
        if (date < person[8]) continue;

        if (isWeekOff(date)) {
          attendanceRows.push([empId, date, null, null, 0, 'week_off', null, null, shiftIds.General]);
          continue;
        }
        if (holidaySet.has(date)) {
          attendanceRows.push([empId, date, null, null, 0, 'holiday', null, null, shiftIds.General]);
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
          attendanceRows.push([empId, date, null, null, 0, status, null, null, shiftIds.General]);
          continue;
        }

        // today's row for the demo employee stays open (punched in, not out)
        const isTodayOpen = back === 0;
        if (isTodayOpen) punchOut = null;

        const minutes = punchOut
          ? (Number(punchOut.slice(0, 2)) * 60 + Number(punchOut.slice(3, 5))) -
            (Number(punchIn.slice(0, 2)) * 60 + Number(punchIn.slice(3, 5)))
          : 0;

        attendanceRows.push([
          empId, date, punchIn, punchOut, Math.max(0, minutes), status, workMode, inLocation, shiftIds.General,
        ]);

        punchRows.push([empId, `${date} ${punchIn}`, 'in', workMode, inLocation]);
        if (punchOut) punchRows.push([empId, `${date} ${punchOut}`, 'out', workMode, inLocation]);
      }
    }

    for (let i = 0; i < attendanceRows.length; i += 500) {
      await conn.query(
        `INSERT INTO attendance
           (employee_id, work_date, punch_in, punch_out, total_minutes, status, work_mode, in_location, shift_id)
         VALUES ?`,
        [attendanceRows.slice(i, i + 500)],
      );
    }
    for (let i = 0; i < punchRows.length; i += 500) {
      await conn.query(
        'INSERT INTO punch_logs (employee_id, punched_at, punch_type, work_mode, address) VALUES ?',
        [punchRows.slice(i, i + 500)],
      );
    }
    console.log(`• ${attendanceRows.length} attendance rows, ${punchRows.length} punch logs`);

    // -------------------------------------------------------- leave module --
    const balanceRows = [];
    for (const code of Object.keys(empIds)) {
      for (const [ltCode, , quota] of LEAVE_TYPES) {
        if (Number(quota) === 0) continue;
        const used = { CL: 5, SL: 2, EL: 7, CO: 1 }[ltCode] ?? 0;
        balanceRows.push([empIds[code], leaveTypeIds[ltCode], FY, quota, used, 0]);
      }
    }
    await conn.query(
      `INSERT INTO leave_balances
         (employee_id, leave_type_id, financial_year, allotted, used, carried_forward) VALUES ?`,
      [balanceRows],
    );

    const d = (offset) => {
      const x = new Date(TODAY);
      x.setDate(x.getDate() + offset);
      return toDateString(x);
    };

    const leaveRows = [
      ['LV-2291', empIds.EMP1042, leaveTypeIds.CL, d(7), d(8), 'full_day', 2, 'Family function at native place.', 'pending', empIds.MGR2007, d(-3)],
      ['LV-2301', empIds.EMP1088, leaveTypeIds.SL, d(1), d(2), 'full_day', 2, 'Down with dengue, medical certificate attached.', 'pending', empIds.MGR2007, d(0)],
      ['LV-2299', empIds.EMP1103, leaveTypeIds.EL, d(14), d(18), 'full_day', 5, 'Pre-planned trip to Manali.', 'pending', empIds.MGR2007, d(-1)],
      ['LV-2288', empIds.EMP1134, leaveTypeIds.CO, d(4), d(4), 'full_day', 1, 'Worked on the release weekend.', 'pending', empIds.MGR2007, d(-2)],
      ['LV-2280', empIds.EMP1121, leaveTypeIds.CO, d(-5), d(-5), 'full_day', 1, 'Comp off for design sprint weekend.', 'approved', empIds.MGR2007, d(-12)],
      ['LV-2188', empIds.EMP1042, leaveTypeIds.SL, d(-9), d(-9), 'full_day', 1, 'Viral fever, consulted doctor.', 'approved', empIds.MGR2007, d(-9)],
      ['LV-2044', empIds.EMP1042, leaveTypeIds.EL, d(-35), d(-31), 'full_day', 5, 'Annual vacation with family.', 'approved', empIds.MGR2007, d(-55)],
      ['LV-1987', empIds.EMP1042, leaveTypeIds.CL, d(-59), d(-59), 'first_half', 0.5, 'Personal errand.', 'rejected', empIds.MGR2007, d(-60)],
      ['LV-2305', empIds.EMP1160, leaveTypeIds.CL, d(3), d(3), 'full_day', 1, 'Bank work.', 'pending', empIds.MGR2011, d(0)],
    ];
    await conn.query(
      `INSERT INTO leave_requests
         (request_code, employee_id, leave_type_id, from_date, to_date, day_type, days,
          reason, status, approver_id, applied_on) VALUES ?`,
      [leaveRows],
    );
    console.log(`• ${balanceRows.length} leave balances, ${leaveRows.length} leave requests`);

    // ---------------------------------------------------- regularizations --
    await conn.query(
      `INSERT INTO regularization_requests
         (request_code, employee_id, work_date, punch_in, punch_out, reason, status, approver_id) VALUES ?`,
      [[
        ['RG-311', empIds.EMP1121, d(-3), '09:35:00', '18:40:00', 'Biometric device was down at gate 2.', 'pending', empIds.MGR2007],
        ['RG-308', empIds.EMP1042, d(-8), '09:38:00', '18:52:00', 'Forgot to punch out, left for a client call.', 'pending', empIds.MGR2007],
        ['RG-301', empIds.EMP1103, d(-27), '10:05:00', '19:15:00', 'Late in due to metro breakdown.', 'approved', empIds.MGR2007],
      ]],
    );

    // -------------------------------------------------------------- claims --
    await conn.query(
      `INSERT INTO expense_claims
         (claim_code, employee_id, category_id, amount, expense_date, note, status, approver_id) VALUES ?`,
      [[
        ['EX-780', empIds.EMP1103, categoryIds.Travel, 7650, d(-2), 'Vendor audit trip — Pune.', 'pending', empIds.MGR2007],
        ['EX-771', empIds.EMP1042, categoryIds.Travel, 4820, d(-6), 'Client visit — Ahmedabad to Mumbai flight.', 'pending', empIds.MGR2007],
        ['EX-769', empIds.EMP1088, categoryIds.Internet, 1499, d(-9), 'WFH broadband — July.', 'pending', empIds.MGR2007],
        ['EX-762', empIds.EMP1042, categoryIds.Internet, 1299, d(-22), 'Monthly broadband reimbursement.', 'approved', empIds.MGR2007],
        ['EX-740', empIds.EMP1042, categoryIds.Food, 640, d(-29), 'Team dinner after release.', 'approved', empIds.MGR2007],
        ['EX-728', empIds.EMP1042, categoryIds.Others, 2500, d(-45), 'Mechanical keyboard (no prior approval).', 'rejected', empIds.MGR2007],
        ['EX-715', empIds.EMP1160, categoryIds.Fuel, 3200, d(-11), 'Field visits — Mumbai west zone.', 'pending', empIds.MGR2011],
      ]],
    );

    // --------------------------------------------------------------- tasks --
    await conn.query(
      `INSERT INTO tasks
         (task_code, employee_id, assigned_by, title, project, due_date, priority, progress, is_done) VALUES ?`,
      [[
        ['T-401', empIds.EMP1042, empIds.MGR2007, 'Ship attendance geo-fencing module', 'ESS Mobile App', d(2), 'high', 0.72, 0],
        ['T-398', empIds.EMP1042, empIds.MGR2007, 'Review payroll export API contract', 'Payroll Core', d(4), 'medium', 0.35, 0],
        ['T-392', empIds.EMP1042, empIds.MGR2007, 'Fix leave balance rounding bug', 'Leave Engine', d(-2), 'high', 1, 1],
        ['T-385', empIds.EMP1042, empIds.MGR2007, 'Update onboarding checklist UI', 'Onboarding', d(9), 'low', 0.1, 0],
        ['T-377', empIds.EMP1088, empIds.MGR2007, 'Regression suite for leave approvals', 'QA Automation', d(5), 'medium', 0.5, 0],
        ['T-370', empIds.EMP1103, empIds.MGR2007, 'Payslip PDF generation service', 'Payroll Core', d(6), 'high', 0.4, 0],
      ]],
    );

    // ------------------------------------------------------- broadcast bits --
    await conn.query(
      'INSERT INTO announcements (title, body, category, published_by, published_at) VALUES ?',
      [[
        ['Q2 Town Hall — 30 July, 4 PM', 'Join us in the Auditorium (or on Meet) for the quarterly business review, product roadmap and the Q2 award ceremony.', 'Event', empIds.HRA3001, `${d(-1)} 10:00:00`],
        ['Mediclaim policy renewed for FY 26-27', 'Coverage increased to ₹7,00,000 per family. Add your dependants on the portal before 10 August 2026.', 'Policy', empIds.HRA3001, `${d(-5)} 11:30:00`],
        ['New attendance regularization SLA', 'Regularization requests must now be raised within 5 working days of the discrepancy date.', 'HR Update', empIds.HRA3001, `${d(-12)} 09:15:00`],
        ['Welcome our new joinees', 'Nine new colleagues joined us this month across Engineering, Sales and Support. Say hello on Slack!', 'Celebration', empIds.HRA3001, `${d(-18)} 16:00:00`],
      ]],
    );

    const notificationRows = [];
    for (const code of Object.keys(empIds)) {
      notificationRows.push(
        [empIds[code], 'Payslip available', 'Your latest payslip has been published.', 'payroll', 0],
        [empIds[code], 'Timesheet reminder', 'Fill your weekly timesheet before Friday 6 PM.', 'task', 1],
      );
    }
    notificationRows.push(
      [empIds.EMP1042, 'Leave approved', 'Your sick leave was approved by Nikhil Desai.', 'leave', 0],
      [empIds.EMP1042, 'Miss punch detected', 'Punch out missing. Raise a regularization request.', 'attendance', 0],
      [empIds.MGR2007, 'New approval request', '4 requests are waiting for your action.', 'leave', 0],
      [empIds.HRA3001, 'Payroll pending', 'July 2026 payroll has not been processed yet.', 'payroll', 0],
    );
    await conn.query(
      'INSERT INTO notifications (employee_id, title, subtitle, kind, is_read) VALUES ?',
      [notificationRows],
    );

    // ------------------------------------------------------------- payroll --
    const [structures] = await conn.query(
      'SELECT * FROM salary_structures WHERE is_current = 1',
    );
    const structureByEmployee = Object.fromEntries(structures.map((s) => [s.employee_id, s]));

    const periods = [];
    for (let back = 4; back >= 1; back -= 1) {
      const p = new Date(TODAY.getFullYear(), TODAY.getMonth() - back, 1);
      periods.push([p.getMonth() + 1, p.getFullYear()]);
    }

    for (const [month, year] of periods) {
      const [runRes] = await conn.execute(
        `INSERT INTO payroll_runs
           (pay_month, pay_year, status, processed_by, processed_at, published_at)
         VALUES (?,?,'published',?,NOW(),NOW())`,
        [month, year, empIds.HRA3001],
      );
      const runId = runRes.insertId;

      let totals = { gross: 0, deductions: 0, net: 0, count: 0 };

      for (const [code, empId] of Object.entries(empIds)) {
        const structure = structureByEmployee[empId];
        if (!structure) continue;

        const [lopRows] = await conn.execute(
          `SELECT COALESCE(SUM(CASE WHEN status = 'half_day' THEN 0.5 ELSE 1 END), 0) AS lop
             FROM attendance
            WHERE employee_id = ? AND MONTH(work_date) = ? AND YEAR(work_date) = ?
              AND status IN ('absent','miss_punch','half_day')`,
          [empId, month, year],
        );
        const lopDays = Number(lopRows[0]?.lop ?? 0);
        const slip = computePayslip({ structure, month, year, lopDays });

        const [slipRes] = await conn.execute(
          `INSERT INTO payslips
             (payroll_run_id, employee_id, paid_days, lop_days, gross, deductions, net,
              bank_account, credited_on)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            runId, empId, slip.paidDays, slip.lopDays, slip.gross, slip.deductions, slip.net,
            'HDFC •••• 4412', toDateString(new Date(year, month, 1)),
          ],
        );

        const components = [
          ...slip.earnings.map((c, i) => [slipRes.insertId, c.label, 'earning', c.amount, i]),
          ...slip.deductionItems.map((c, i) => [slipRes.insertId, c.label, 'deduction', c.amount, i]),
        ];
        await conn.query(
          'INSERT INTO payslip_components (payslip_id, label, component_type, amount, sort_order) VALUES ?',
          [components],
        );

        totals = {
          gross: totals.gross + slip.gross,
          deductions: totals.deductions + slip.deductions,
          net: totals.net + slip.net,
          count: totals.count + 1,
        };
        void code;
      }

      await conn.execute(
        `UPDATE payroll_runs
            SET employee_count = ?, total_gross = ?, total_deductions = ?, total_net = ?
          WHERE id = ?`,
        [totals.count, totals.gross.toFixed(2), totals.deductions.toFixed(2), totals.net.toFixed(2), runId],
      );
    }
    console.log(`• ${periods.length} payroll runs with payslips`);

    await conn.commit();
    console.log('\nSeed complete.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

seed()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\nSeed failed:', err);
    await pool.end();
    process.exit(1);
  });
