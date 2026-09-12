import { Router } from 'express';
import { z } from 'zod';

import { execute, query, queryOne } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, created, ok, parseWith, todayString } from '../utils/helpers.js';
import { EMPLOYEE_JOINS, EMPLOYEE_SELECT } from '../services/employee.service.js';

/**
 * Everything an employee touches that isn't attendance / leave / payroll:
 * expenses, tasks, holidays, announcements, notifications and the directory.
 */
const router = Router();
router.use(authenticate);

// ============================================================== expenses ====
const expenseSchema = z.object({
  category: z.string().trim().min(2).max(60),
  amount: z.coerce.number().positive('Amount must be greater than zero').max(1000000),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  note: z.string().trim().min(5, 'Add a short description').max(500),
});

const CLAIM_SELECT = `
  ec.id, ec.claim_code AS code, ec.amount, ec.expense_date AS expenseDate,
  ec.note, ec.status, ec.created_at AS createdAt,
  c.name AS category, e.name AS employeeName, e.emp_code AS employeeCode, ap.name AS approver
`;
const CLAIM_JOINS = `
  FROM expense_claims ec
  JOIN expense_categories c ON c.id = ec.category_id
  JOIN employees e ON e.id = ec.employee_id
  LEFT JOIN employees ap ON ap.id = ec.approver_id
`;

router.get(
  '/expenses/categories',
  asyncHandler(async (_req, res) =>
    ok(res, await query('SELECT id, name, max_limit AS maxLimit FROM expense_categories WHERE is_active = 1 ORDER BY id')),
  ),
);

router.get(
  '/expenses',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(
      z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }),
      req.query,
    );
    const where = ['ec.employee_id = ?'];
    const params = [req.user.id];
    if (status) { where.push('ec.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ${CLAIM_SELECT} ${CLAIM_JOINS} WHERE ${where.join(' AND ')} ORDER BY ec.created_at DESC`,
      params,
    );
    const totals = await queryOne(
      `SELECT COALESCE(SUM(CASE WHEN status='pending'  THEN amount END), 0) AS pendingAmount,
              COALESCE(SUM(CASE WHEN status='approved' THEN amount END), 0) AS approvedAmount
         FROM expense_claims WHERE employee_id = ?`,
      [req.user.id],
    );
    ok(res, rows, totals);
  }),
);

router.post(
  '/expenses',
  asyncHandler(async (req, res) => {
    const body = parseWith(expenseSchema, req.body);

    const category = await queryOne(
      'SELECT id, name, max_limit AS maxLimit FROM expense_categories WHERE name = ? AND is_active = 1',
      [body.category],
    );
    if (!category) throw ApiError.badRequest(`Unknown expense category "${body.category}"`);
    if (category.maxLimit && body.amount > Number(category.maxLimit)) {
      throw ApiError.badRequest(`${category.name} claims are capped at ₹${category.maxLimit}`);
    }
    if (body.expenseDate > todayString()) {
      throw ApiError.badRequest('Expense date cannot be in the future');
    }

    const seq = await queryOne('SELECT COUNT(*) AS n FROM expense_claims');
    const code = `EX-${790 + Number(seq.n)}`;

    const result = await execute(
      `INSERT INTO expense_claims
         (claim_code, employee_id, category_id, amount, expense_date, note, approver_id)
       VALUES (?,?,?,?,?,?,(SELECT reporting_to FROM employees WHERE id = ?))`,
      [code, req.user.id, category.id, body.amount, body.expenseDate, body.note, req.user.id],
    );

    created(res, await queryOne(`SELECT ${CLAIM_SELECT} ${CLAIM_JOINS} WHERE ec.id = ?`, [result.insertId]));
  }),
);

// ================================================================= tasks ====
const TASK_SELECT = `
  t.id, t.task_code AS code, t.title, t.project, t.due_date AS dueDate,
  t.priority, t.progress, t.is_done AS isDone, t.completed_at AS completedAt,
  a.name AS assignedBy
`;

router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(
      z.object({ status: z.enum(['open', 'completed', 'all']).default('all') }),
      req.query,
    );
    const where = ['t.employee_id = ?'];
    const params = [req.user.id];
    if (status === 'open') where.push('t.is_done = 0');
    if (status === 'completed') where.push('t.is_done = 1');

    const rows = await query(
      `SELECT ${TASK_SELECT} FROM tasks t LEFT JOIN employees a ON a.id = t.assigned_by
        WHERE ${where.join(' AND ')} ORDER BY t.is_done, t.due_date`,
      params,
    );
    ok(res, rows, { openCount: rows.filter((r) => !r.isDone).length });
  }),
);

router.patch(
  '/tasks/:id',
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({
        isDone: z.boolean().optional(),
        progress: z.coerce.number().min(0).max(1).optional(),
      }),
      req.body ?? {},
    );
    if (body.isDone === undefined && body.progress === undefined) {
      throw ApiError.badRequest('Provide isDone and/or progress');
    }

    const task = await queryOne('SELECT id FROM tasks WHERE id = ? AND employee_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!task) throw ApiError.notFound('Task not found');

    const isDone = body.isDone;
    const progress = body.progress ?? (isDone === true ? 1 : undefined);

    await execute(
      `UPDATE tasks
          SET is_done = COALESCE(?, is_done),
              progress = COALESCE(?, progress),
              completed_at = CASE WHEN ? = 1 THEN NOW() WHEN ? = 0 THEN NULL ELSE completed_at END
        WHERE id = ?`,
      [isDone === undefined ? null : Number(isDone), progress ?? null, Number(isDone ?? -1), Number(isDone ?? -1), task.id],
    );

    ok(res, await queryOne(`SELECT ${TASK_SELECT} FROM tasks t LEFT JOIN employees a ON a.id = t.assigned_by WHERE t.id = ?`, [task.id]));
  }),
);

// ============================================================== holidays ====
router.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const { year, upcoming } = parseWith(
      z.object({
        year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
        upcoming: z.coerce.boolean().optional(),
      }),
      req.query,
    );

    const where = ['YEAR(holiday_date) = ?'];
    const params = [year];
    if (upcoming) { where.push('holiday_date >= CURDATE()'); }

    const rows = await query(
      `SELECT id, holiday_date AS date, name, holiday_type AS type
         FROM holidays WHERE ${where.join(' AND ')} ORDER BY holiday_date`,
      params,
    );
    ok(res, rows, { year, count: rows.length });
  }),
);

// ========================================================= announcements ====
router.get(
  '/announcements',
  asyncHandler(async (req, res) => {
    const { limit } = parseWith(
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
      req.query,
    );
    const rows = await query(
      `SELECT a.id, a.title, a.body, a.category, a.published_at AS publishedAt, e.name AS publishedBy
         FROM announcements a LEFT JOIN employees e ON e.id = a.published_by
        WHERE a.is_active = 1 ORDER BY a.published_at DESC LIMIT ${limit}`,
    );
    ok(res, rows);
  }),
);

// ========================================================= notifications ====
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, title, subtitle, kind, is_read AS isRead, created_at AS createdAt
         FROM notifications WHERE employee_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id],
    );
    ok(res, rows, { unread: rows.filter((r) => !r.isRead).length });
  }),
);

router.patch(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const result = await execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND employee_id = ?',
      [req.params.id, req.user.id],
    );
    if (!result.affectedRows) throw ApiError.notFound('Notification not found');
    ok(res, { id: Number(req.params.id), isRead: true });
  }),
);

router.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    const result = await execute(
      'UPDATE notifications SET is_read = 1 WHERE employee_id = ? AND is_read = 0',
      [req.user.id],
    );
    ok(res, { marked: result.affectedRows });
  }),
);

// ============================================================= directory ====
router.get(
  '/directory',
  asyncHandler(async (req, res) => {
    const { q, department, limit } = parseWith(
      z.object({
        q: z.string().trim().max(80).optional(),
        department: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );

    const where = ["e.status <> 'exited'"];
    const params = [];
    if (q) {
      where.push('(e.name LIKE ? OR e.emp_code LIKE ? OR e.designation LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (department && department !== 'All') {
      where.push('d.name = ?');
      params.push(department);
    }

    const rows = await query(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_JOINS}
        WHERE ${where.join(' AND ')} ORDER BY e.name LIMIT ${limit}`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

router.get(
  '/departments',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT d.id, d.name, d.code, h.name AS head,
              (SELECT COUNT(*) FROM employees x WHERE x.department_id = d.id AND x.status <> 'exited') AS headcount
         FROM departments d LEFT JOIN employees h ON h.id = d.head_id
        ORDER BY d.name`,
    );
    ok(res, rows);
  }),
);

export default router;
