import { Router } from 'express';
import { z } from 'zod';

import { query, queryOne } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, ok, parseWith, todayString } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireRole('manager'));

/** Admins see the whole org, managers only their direct reports. */
const scopeClause = (user, alias = 'e') =>
  user.role === 'admin'
    ? { sql: `${alias}.status <> 'exited'`, params: [] }
    : { sql: `${alias}.reporting_to = ? AND ${alias}.status <> 'exited'`, params: [user.id] };

const MEMBER_SELECT = `
  e.id, e.emp_code AS empCode, e.name, e.designation, e.phone, e.email,
  d.name AS department,
  COALESCE(a.status, 'absent') AS todayStatus,
  a.punch_in  AS inTime,
  a.punch_out AS outTime,
  a.work_mode AS workMode
`;

// GET /team/members?q&status --------------------------------------------------
router.get(
  '/members',
  asyncHandler(async (req, res) => {
    const { q, status, date } = parseWith(
      z.object({
        q: z.string().trim().max(80).optional(),
        status: z.string().trim().max(20).optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.query,
    );

    const on = date ?? todayString();
    const scope = scopeClause(req.user);
    const where = [scope.sql];
    const params = [on, ...scope.params];

    if (q) {
      where.push('(e.name LIKE ? OR e.emp_code LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status && status !== 'all') {
      where.push('COALESCE(a.status, \'absent\') = ?');
      params.push(status);
    }

    const rows = await query(
      `SELECT ${MEMBER_SELECT}
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN attendance  a ON a.employee_id = e.id AND a.work_date = ?
        WHERE ${where.join(' AND ')}
        ORDER BY e.name`,
      params,
    );
    ok(res, rows, { date: on, count: rows.length });
  }),
);

// GET /team/stats -------------------------------------------------------------
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const on = req.query.date ?? todayString();
    const scope = scopeClause(req.user);

    const row = await queryOne(
      `SELECT
         COUNT(*) AS teamSize,
         SUM(COALESCE(a.status,'absent') IN ('present','late_in','half_day')) AS present,
         SUM(COALESCE(a.status,'absent') = 'late_in')  AS lateIn,
         SUM(COALESCE(a.status,'absent') = 'leave')    AS onLeave,
         SUM(COALESCE(a.status,'absent') = 'absent')   AS absent,
         SUM(COALESCE(a.status,'absent') = 'week_off') AS weekOff
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = ?
      WHERE ${scope.sql}`,
      [on, ...scope.params],
    );

    const size = Number(row.teamSize) || 0;
    const present = Number(row.present) || 0;

    ok(res, {
      date: on,
      teamSize: size,
      present,
      lateIn: Number(row.lateIn) || 0,
      onLeave: Number(row.onLeave) || 0,
      absent: Number(row.absent) || 0,
      weekOff: Number(row.weekOff) || 0,
      attendancePercent: size ? Math.round((present / size) * 100) : 0,
    });
  }),
);

// GET /team/trend -------------------------------------------------------------
router.get(
  '/trend',
  asyncHandler(async (req, res) => {
    const { days } = parseWith(
      z.object({ days: z.coerce.number().int().min(3).max(31).default(7) }),
      req.query,
    );
    const scope = scopeClause(req.user);

    const rows = await query(
      `SELECT a.work_date AS date,
              ROUND(100 * SUM(a.status IN ('present','late_in','half_day')) / NULLIF(COUNT(*), 0)) AS percent
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
        WHERE ${scope.sql}
          AND a.work_date >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
        GROUP BY a.work_date
        ORDER BY a.work_date`,
      scope.params,
    );
    ok(res, rows);
  }),
);

// GET /team/members/:id -------------------------------------------------------
router.get(
  '/members/:id',
  asyncHandler(async (req, res) => {
    const scope = scopeClause(req.user);
    const member = await queryOne(
      `SELECT ${MEMBER_SELECT}, e.date_of_joining AS dateOfJoining
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN attendance  a ON a.employee_id = e.id AND a.work_date = ?
        WHERE e.id = ? AND ${scope.sql}`,
      [todayString(), req.params.id, ...scope.params],
    );
    if (!member) throw ApiError.notFound('Team member not found in your reporting line');

    const mtd = await queryOne(
      `SELECT SUM(status IN ('present','late_in')) AS present,
              SUM(status = 'leave')   AS leaves,
              SUM(status = 'late_in') AS lateMarks,
              SUM(status IN ('absent','miss_punch')) AS absents
         FROM attendance
        WHERE employee_id = ? AND MONTH(work_date) = MONTH(CURDATE()) AND YEAR(work_date) = YEAR(CURDATE())`,
      [req.params.id],
    );

    ok(res, { ...member, monthToDate: mtd });
  }),
);

export default router;
