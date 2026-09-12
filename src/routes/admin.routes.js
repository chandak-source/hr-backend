import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../config/env.js';
import { execute, query, queryOne, transaction } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, created, ok, parseWith, todayString } from '../utils/helpers.js';
import { EMPLOYEE_JOINS, EMPLOYEE_SELECT } from '../services/employee.service.js';
import { computePayslip, countLopDays, MONTH_NAMES } from '../services/payroll.service.js';

const router = Router();
router.use(authenticate, requireRole('admin'));

// ============================================================== overview ====
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const headcount = await queryOne(
      `SELECT
         COUNT(*) AS total,
         SUM(status = 'active') AS active,
         SUM(date_of_joining >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS newJoinees,
         SUM(status = 'exited' AND exit_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS exitsThisMonth
       FROM employees`,
    );

    const attendance = await queryOne(
      `SELECT ROUND(100 * SUM(status IN ('present','late_in','half_day')) / NULLIF(SUM(status NOT IN ('week_off','holiday')), 0), 1) AS avgAttendance
         FROM attendance
        WHERE work_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );

    const approvals = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') +
        (SELECT COUNT(*) FROM expense_claims WHERE status = 'pending') +
        (SELECT COUNT(*) FROM regularization_requests WHERE status = 'pending') AS pending`,
    );

    const payroll = await queryOne(
      `SELECT pr.pay_month AS month, pr.pay_year AS year, pr.status,
              pr.total_net AS totalNet, pr.employee_count AS employees
         FROM payroll_runs pr ORDER BY pr.pay_year DESC, pr.pay_month DESC LIMIT 1`,
    );

    const byDept = await query(
      `SELECT d.name, COUNT(e.id) AS headcount
         FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.status <> 'exited'
        GROUP BY d.id ORDER BY headcount DESC`,
    );

    const trend = await query(
      `SELECT work_date AS date,
              ROUND(100 * SUM(status IN ('present','late_in','half_day')) / NULLIF(SUM(status NOT IN ('week_off','holiday')), 0)) AS percent
         FROM attendance
        WHERE work_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY work_date ORDER BY work_date`,
    );

    ok(res, {
      headcount,
      avgAttendance: attendance.avgAttendance ?? 0,
      pendingApprovals: Number(approvals.pending),
      latestPayroll: payroll && {
        ...payroll,
        period: `${MONTH_NAMES[payroll.month - 1]} ${payroll.year}`,
      },
      headcountByDepartment: byDept,
      attendanceTrend: trend,
    });
  }),
);

// ============================================================= employees ====
const createEmployeeSchema = z.object({
  name: z.string().trim().min(3).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(20).optional(),
  role: z.enum(['employee', 'manager', 'admin']).default('employee'),
  designation: z.string().trim().min(2).max(120),
  department: z.string().trim().min(2).max(80),
  location: z.string().trim().max(80).optional(),
  reportingToCode: z.string().trim().max(20).optional(),
  dateOfJoining: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  annualCtc: z.coerce.number().positive().max(100000000),
});

router.get(
  '/employees',
  asyncHandler(async (req, res) => {
    const { q, department, status, limit } = parseWith(
      z.object({
        q: z.string().trim().max(80).optional(),
        department: z.string().trim().max(80).optional(),
        status: z.enum(['active', 'on_notice', 'exited']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );

    const where = ['1 = 1'];
    const params = [];
    if (q) {
      where.push('(e.name LIKE ? OR e.emp_code LIKE ? OR e.designation LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (department && department !== 'All') { where.push('d.name = ?'); params.push(department); }
    if (status) { where.push('e.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_JOINS} WHERE ${where.join(' AND ')} ORDER BY e.name LIMIT ${limit}`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

router.post(
  '/employees',
  asyncHandler(async (req, res) => {
    const body = parseWith(createEmployeeSchema, req.body);

    const dept = await queryOne('SELECT id FROM departments WHERE name = ?', [body.department]);
    if (!dept) throw ApiError.badRequest(`Unknown department "${body.department}"`);

    const manager = body.reportingToCode
      ? await queryOne('SELECT id FROM employees WHERE emp_code = ?', [body.reportingToCode])
      : null;
    if (body.reportingToCode && !manager) {
      throw ApiError.badRequest(`Unknown manager code "${body.reportingToCode}"`);
    }

    const location = body.location
      ? await queryOne('SELECT id FROM locations WHERE name = ?', [body.location])
      : null;

    const result = await transaction(async (conn) => {
      const [seq] = await conn.query("SELECT COUNT(*) AS n FROM employees WHERE role = 'employee'");
      const empCode = `EMP${1170 + Number(seq[0].n)}`;

      const [insert] = await conn.execute(
        `INSERT INTO employees
           (emp_code, name, email, phone, password_hash, role, designation, department_id,
            location_id, shift_id, reporting_to, date_of_joining)
         VALUES (?,?,?,?,?,?,?,?,?,(SELECT id FROM shifts WHERE name = 'General'),?,?)`,
        [
          empCode,
          body.name,
          body.email,
          body.phone ?? null,
          await bcrypt.hash(env.seedPassword, 10),
          body.role,
          body.designation,
          dept.id,
          location?.id ?? null,
          manager?.id ?? null,
          body.dateOfJoining,
        ],
      );

      const monthly = body.annualCtc / 12;
      await conn.execute(
        `INSERT INTO salary_structures
           (employee_id, effective_from, annual_ctc, basic, hra, conveyance, special_allowance)
         VALUES (?,?,?,?,?,?,?)`,
        [
          insert.insertId,
          body.dateOfJoining,
          body.annualCtc,
          Math.round(monthly * 0.5),
          Math.round(monthly * 0.2),
          Math.round(monthly * 0.05),
          Math.round(monthly * 0.25),
        ],
      );

      return { id: insert.insertId, empCode };
    });

    created(res, {
      ...result,
      message: `Employee created with default password "${env.seedPassword}"`,
    });
  }),
);

router.patch(
  '/employees/:id',
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({
        designation: z.string().trim().min(2).max(120).optional(),
        role: z.enum(['employee', 'manager', 'admin']).optional(),
        department: z.string().trim().max(80).optional(),
        reportingToCode: z.string().trim().max(20).optional(),
        status: z.enum(['active', 'on_notice', 'exited']).optional(),
      }),
      req.body ?? {},
    );

    const employee = await queryOne('SELECT id FROM employees WHERE id = ?', [req.params.id]);
    if (!employee) throw ApiError.notFound('Employee not found');

    const sets = [];
    const params = [];

    if (body.designation) { sets.push('designation = ?'); params.push(body.designation); }
    if (body.role) { sets.push('role = ?'); params.push(body.role); }
    if (body.status) {
      sets.push('status = ?');
      params.push(body.status);
      if (body.status === 'exited') { sets.push('exit_date = ?'); params.push(todayString()); }
    }
    if (body.department) {
      const dept = await queryOne('SELECT id FROM departments WHERE name = ?', [body.department]);
      if (!dept) throw ApiError.badRequest(`Unknown department "${body.department}"`);
      sets.push('department_id = ?');
      params.push(dept.id);
    }
    if (body.reportingToCode) {
      const manager = await queryOne('SELECT id FROM employees WHERE emp_code = ?', [body.reportingToCode]);
      if (!manager) throw ApiError.badRequest(`Unknown manager code "${body.reportingToCode}"`);
      sets.push('reporting_to = ?');
      params.push(manager.id);
    }
    if (!sets.length) throw ApiError.badRequest('Nothing to update');

    await execute(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, [...params, req.params.id]);
    ok(res, await queryOne(`SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_JOINS} WHERE e.id = ?`, [req.params.id]));
  }),
);

// =============================================================== payroll ====
router.get(
  '/payroll/runs',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT pr.id, pr.pay_month AS month, pr.pay_year AS year, pr.status,
              pr.employee_count AS employees, pr.total_gross AS totalGross,
              pr.total_deductions AS totalDeductions, pr.total_net AS totalNet,
              pr.processed_at AS processedAt, pr.published_at AS publishedAt,
              e.name AS processedBy
         FROM payroll_runs pr LEFT JOIN employees e ON e.id = pr.processed_by
        ORDER BY pr.pay_year DESC, pr.pay_month DESC`,
    );
    ok(res, rows.map((r) => ({ ...r, period: `${MONTH_NAMES[r.month - 1]} ${r.year}` })));
  }),
);

const runSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

// POST /admin/payroll/run — compute payslips for every active employee.
router.post(
  '/payroll/run',
  asyncHandler(async (req, res) => {
    const { month, year } = parseWith(runSchema, req.body);

    const existing = await queryOne(
      'SELECT id, status FROM payroll_runs WHERE pay_month = ? AND pay_year = ?',
      [month, year],
    );
    if (existing && existing.status !== 'draft') {
      throw ApiError.conflict(`Payroll for ${MONTH_NAMES[month - 1]} ${year} is already ${existing.status}`);
    }

    const employees = await query(
      `SELECT e.id, s.id AS structureId, s.basic, s.hra, s.conveyance, s.special_allowance, e.bank_account
         FROM employees e
         JOIN salary_structures s ON s.employee_id = e.id AND s.is_current = 1
        WHERE e.status = 'active'`,
    );
    if (!employees.length) throw ApiError.badRequest('No active employees with salary structures');

    const summary = await transaction(async (conn) => {
      let runId = existing?.id;
      if (runId) {
        await conn.execute('DELETE FROM payslips WHERE payroll_run_id = ?', [runId]);
      } else {
        const [runInsert] = await conn.execute(
          `INSERT INTO payroll_runs (pay_month, pay_year, status, processed_by) VALUES (?,?,'draft',?)`,
          [month, year, req.user.id],
        );
        runId = runInsert.insertId;
      }

      let totals = { gross: 0, deductions: 0, net: 0 };

      for (const emp of employees) {
        // eslint-disable-next-line no-await-in-loop
        const lopDays = await countLopDays(conn, emp.id, month, year);
        const slip = computePayslip({ structure: emp, month, year, lopDays });

        // eslint-disable-next-line no-await-in-loop
        const [slipInsert] = await conn.execute(
          `INSERT INTO payslips
             (payroll_run_id, employee_id, paid_days, lop_days, gross, deductions, net, bank_account)
           VALUES (?,?,?,?,?,?,?,?)`,
          [runId, emp.id, slip.paidDays, slip.lopDays, slip.gross, slip.deductions, slip.net, emp.bank_account],
        );

        const components = [
          ...slip.earnings.map((c, i) => [slipInsert.insertId, c.label, 'earning', c.amount, i]),
          ...slip.deductionItems.map((c, i) => [slipInsert.insertId, c.label, 'deduction', c.amount, i]),
        ];
        // eslint-disable-next-line no-await-in-loop
        await conn.query(
          'INSERT INTO payslip_components (payslip_id, label, component_type, amount, sort_order) VALUES ?',
          [components],
        );

        totals = {
          gross: totals.gross + slip.gross,
          deductions: totals.deductions + slip.deductions,
          net: totals.net + slip.net,
        };
      }

      await conn.execute(
        `UPDATE payroll_runs
            SET status = 'processed', employee_count = ?, total_gross = ?, total_deductions = ?,
                total_net = ?, processed_by = ?, processed_at = NOW()
          WHERE id = ?`,
        [employees.length, totals.gross.toFixed(2), totals.deductions.toFixed(2), totals.net.toFixed(2), req.user.id, runId],
      );

      return { runId, employees: employees.length, ...totals };
    });

    ok(res, {
      ...summary,
      period: `${MONTH_NAMES[month - 1]} ${year}`,
      status: 'processed',
    });
  }),
);

// POST /admin/payroll/runs/:id/publish ---------------------------------------
router.post(
  '/payroll/runs/:id/publish',
  asyncHandler(async (req, res) => {
    const run = await queryOne('SELECT * FROM payroll_runs WHERE id = ?', [req.params.id]);
    if (!run) throw ApiError.notFound('Payroll run not found');
    if (run.status === 'published') throw ApiError.conflict('Run is already published');
    if (run.status === 'draft') throw ApiError.badRequest('Process the run before publishing');

    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE payroll_runs SET status = 'published', published_at = NOW() WHERE id = ?`,
        [run.id],
      );
      await conn.execute(
        `UPDATE payslips SET credited_on = CURDATE() WHERE payroll_run_id = ?`,
        [run.id],
      );
      await conn.execute(
        `INSERT INTO notifications (employee_id, title, subtitle, kind)
         SELECT p.employee_id, 'Payslip available',
                CONCAT('${MONTH_NAMES[run.pay_month - 1]} ${run.pay_year} payslip published. Net pay ₹', FORMAT(p.net, 0), '.'),
                'payroll'
           FROM payslips p WHERE p.payroll_run_id = ?`,
        [run.id],
      );
    });

    ok(res, { id: run.id, status: 'published' });
  }),
);

// POST /admin/payroll/runs/:id/unlock ----------------------------------------
router.post(
  '/payroll/runs/:id/unlock',
  asyncHandler(async (req, res) => {
    const result = await execute(
      `UPDATE payroll_runs SET status = 'draft', published_at = NULL WHERE id = ? AND status <> 'draft'`,
      [req.params.id],
    );
    if (!result.affectedRows) throw ApiError.notFound('Run not found or already draft');
    ok(res, { id: Number(req.params.id), status: 'draft' });
  }),
);

// ========================================================= announcements ====
router.post(
  '/announcements',
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({
        title: z.string().trim().min(4).max(180),
        body: z.string().trim().min(10).max(5000),
        category: z.enum(['Event', 'Policy', 'HR Update', 'Celebration']).default('HR Update'),
      }),
      req.body,
    );

    const result = await execute(
      'INSERT INTO announcements (title, body, category, published_by) VALUES (?,?,?,?)',
      [body.title, body.body, body.category, req.user.id],
    );
    created(res, { id: result.insertId, ...body, publishedBy: req.user.name });
  }),
);

router.delete(
  '/announcements/:id',
  asyncHandler(async (req, res) => {
    const result = await execute('UPDATE announcements SET is_active = 0 WHERE id = ?', [
      req.params.id,
    ]);
    if (!result.affectedRows) throw ApiError.notFound('Announcement not found');
    ok(res, { id: Number(req.params.id), archived: true });
  }),
);

// =============================================================== reports ====
router.get(
  '/reports/attendance',
  asyncHandler(async (req, res) => {
    const now = new Date();
    const { month, year } = parseWith(
      z.object({
        month: z.coerce.number().int().min(1).max(12).default(now.getMonth() + 1),
        year: z.coerce.number().int().min(2000).max(2100).default(now.getFullYear()),
      }),
      req.query,
    );

    const rows = await query(
      `SELECT e.emp_code AS empCode, e.name, d.name AS department,
              SUM(a.status IN ('present','late_in')) AS present,
              SUM(a.status = 'half_day') AS halfDays,
              SUM(a.status = 'leave') AS leaves,
              SUM(a.status IN ('absent','miss_punch')) AS absent,
              SUM(a.status = 'late_in') AS lateIns,
              ROUND(SUM(a.total_minutes) / 60, 1) AS totalHours
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN attendance a ON a.employee_id = e.id
              AND MONTH(a.work_date) = ? AND YEAR(a.work_date) = ?
        WHERE e.status <> 'exited'
        GROUP BY e.id ORDER BY e.name`,
      [month, year],
    );
    ok(res, rows, { month, year, period: `${MONTH_NAMES[month - 1]} ${year}` });
  }),
);

router.get(
  '/reports/leave-balances',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT e.emp_code AS empCode, e.name,
              lt.code AS leaveType,
              lb.allotted + lb.carried_forward AS total, lb.used,
              lb.allotted + lb.carried_forward - lb.used AS available
         FROM leave_balances lb
         JOIN employees e ON e.id = lb.employee_id
         JOIN leave_types lt ON lt.id = lb.leave_type_id
        WHERE e.status <> 'exited'
        ORDER BY e.name, lt.id`,
    );
    ok(res, rows);
  }),
);

router.get(
  '/reports/payroll-trend',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT pay_month AS month, pay_year AS year, total_net AS totalNet, employee_count AS employees
         FROM payroll_runs WHERE status IN ('processed','locked','published')
        ORDER BY pay_year, pay_month`,
    );
    ok(res, rows.map((r) => ({ ...r, period: `${MONTH_NAMES[r.month - 1]} ${r.year}` })));
  }),
);

export default router;
