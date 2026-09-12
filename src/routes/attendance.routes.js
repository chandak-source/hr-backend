import { Router } from 'express';
import { z } from 'zod';

import { execute, query, queryOne } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import {
  asyncHandler,
  created,
  minutesBetween,
  ok,
  parseWith,
  todayString,
  toTimeString,
} from '../utils/helpers.js';

const router = Router();
router.use(authenticate);

const ATTENDANCE_SELECT = `
  a.id,
  a.work_date     AS date,
  a.punch_in      AS punchIn,
  a.punch_out     AS punchOut,
  a.total_minutes AS totalMinutes,
  a.status,
  a.work_mode     AS workMode,
  a.in_location   AS inLocation,
  a.is_regularized AS isRegularized
`;

const punchInSchema = z.object({
  workMode: z.enum(['office', 'wfh', 'client_site', 'on_duty']).default('office'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  address: z.string().max(255).optional(),
});

const regularizeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  punchIn: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:mm'),
  punchOut: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:mm'),
  reason: z.string().trim().min(5, 'Add a reason (min 5 characters)').max(500),
});

const withSeconds = (t) => (t.length === 5 ? `${t}:00` : t);

// GET /attendance/today -------------------------------------------------------
router.get(
  '/today',
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT ${ATTENDANCE_SELECT} FROM attendance a WHERE a.employee_id = ? AND a.work_date = ?`,
      [req.user.id, todayString()],
    );

    ok(res, {
      date: todayString(),
      isPunchedIn: Boolean(row?.punchIn && !row?.punchOut),
      record: row,
    });
  }),
);

// POST /attendance/punch-in ---------------------------------------------------
router.post(
  '/punch-in',
  asyncHandler(async (req, res) => {
    const body = parseWith(punchInSchema, req.body ?? {});
    const date = todayString();
    const time = toTimeString();

    const existing = await queryOne(
      'SELECT id, punch_in AS punchIn, punch_out AS punchOut FROM attendance WHERE employee_id = ? AND work_date = ?',
      [req.user.id, date],
    );
    if (existing?.punchIn && !existing?.punchOut) {
      throw ApiError.conflict('You are already punched in');
    }

    const shift = await queryOne(
      `SELECT s.start_time AS startTime, s.grace_minutes AS grace
         FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = ?`,
      [req.user.id],
    );
    const lateBy = shift?.startTime ? minutesBetween(shift.startTime, time) : 0;
    const status = lateBy > (shift?.grace ?? 15) ? 'late_in' : 'present';

    if (existing) {
      await execute(
        `UPDATE attendance
            SET punch_in = ?, punch_out = NULL, total_minutes = 0, status = ?,
                work_mode = ?, in_location = ?
          WHERE id = ?`,
        [time, status, body.workMode, body.address ?? null, existing.id],
      );
    } else {
      await execute(
        `INSERT INTO attendance
           (employee_id, work_date, punch_in, status, work_mode, in_location, shift_id)
         VALUES (?,?,?,?,?,?,(SELECT shift_id FROM employees WHERE id = ?))`,
        [req.user.id, date, time, status, body.workMode, body.address ?? null, req.user.id],
      );
    }

    await execute(
      `INSERT INTO punch_logs (employee_id, punched_at, punch_type, work_mode, latitude, longitude, address)
       VALUES (?, ?, 'in', ?, ?, ?, ?)`,
      [
        req.user.id,
        `${date} ${time}`,
        body.workMode,
        body.latitude ?? null,
        body.longitude ?? null,
        body.address ?? null,
      ],
    );

    created(res, { date, punchIn: time, status, workMode: body.workMode, lateByMinutes: lateBy });
  }),
);

// POST /attendance/punch-out --------------------------------------------------
router.post(
  '/punch-out',
  asyncHandler(async (req, res) => {
    const date = todayString();
    const time = toTimeString();

    const row = await queryOne(
      'SELECT id, punch_in AS punchIn, punch_out AS punchOut, status FROM attendance WHERE employee_id = ? AND work_date = ?',
      [req.user.id, date],
    );
    if (!row?.punchIn) throw ApiError.badRequest('Punch in first');
    if (row.punchOut) throw ApiError.conflict('You have already punched out today');

    const minutes = minutesBetween(row.punchIn, time);
    const status = minutes < 240 ? 'half_day' : row.status;

    await execute(
      'UPDATE attendance SET punch_out = ?, total_minutes = ?, status = ? WHERE id = ?',
      [time, minutes, status, row.id],
    );
    await execute(
      `INSERT INTO punch_logs (employee_id, punched_at, punch_type, work_mode)
       VALUES (?, ?, 'out', (SELECT work_mode FROM attendance WHERE id = ?))`,
      [req.user.id, `${date} ${time}`, row.id],
    );

    ok(res, {
      date,
      punchIn: row.punchIn,
      punchOut: time,
      totalMinutes: minutes,
      totalHours: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      status,
    });
  }),
);

// GET /attendance/log?from&to&status&limit -----------------------------------
router.get(
  '/log',
  asyncHandler(async (req, res) => {
    const { from, to, status, limit } = parseWith(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      }),
      req.query,
    );

    const where = ['a.employee_id = ?'];
    const params = [req.user.id];
    if (from) { where.push('a.work_date >= ?'); params.push(from); }
    if (to) { where.push('a.work_date <= ?'); params.push(to); }
    if (status) { where.push('a.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ${ATTENDANCE_SELECT} FROM attendance a
        WHERE ${where.join(' AND ')}
        ORDER BY a.work_date DESC
        LIMIT ${limit}`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

// GET /attendance/summary?month&year ------------------------------------------
router.get(
  '/summary',
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
      `SELECT status, COUNT(*) AS total, COALESCE(SUM(total_minutes), 0) AS minutes
         FROM attendance
        WHERE employee_id = ? AND MONTH(work_date) = ? AND YEAR(work_date) = ?
        GROUP BY status`,
      [req.user.id, month, year],
    );

    const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
    const workedMinutes = rows.reduce((s, r) => s + Number(r.minutes), 0);
    const workedDays = (byStatus.present ?? 0) + (byStatus.late_in ?? 0) + (byStatus.half_day ?? 0);
    const present = (byStatus.present ?? 0) + (byStatus.late_in ?? 0);
    const workingDays =
      Object.values(byStatus).reduce((a, b) => a + b, 0) -
      (byStatus.week_off ?? 0) -
      (byStatus.holiday ?? 0);
    const avg = workedDays ? Math.round(workedMinutes / workedDays) : 0;

    ok(res, {
      month,
      year,
      summary: {
        Present: present,
        Leave: byStatus.leave ?? 0,
        Absent: (byStatus.absent ?? 0) + (byStatus.miss_punch ?? 0),
        'Week Off': byStatus.week_off ?? 0,
        Holiday: byStatus.holiday ?? 0,
      },
      halfDays: byStatus.half_day ?? 0,
      lateIns: byStatus.late_in ?? 0,
      workingDays,
      attendancePercent: workingDays ? Math.round((present / workingDays) * 100) : 0,
      avgWorkedMinutes: avg,
      avgWorkedHours: `${String(Math.floor(avg / 60)).padStart(2, '0')}:${String(avg % 60).padStart(2, '0')}`,
    });
  }),
);

// GET /attendance/calendar?month&year -----------------------------------------
router.get(
  '/calendar',
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
      `SELECT ${ATTENDANCE_SELECT} FROM attendance a
        WHERE a.employee_id = ? AND MONTH(a.work_date) = ? AND YEAR(a.work_date) = ?
        ORDER BY a.work_date`,
      [req.user.id, month, year],
    );
    ok(res, rows, { month, year, count: rows.length });
  }),
);

// Regularization --------------------------------------------------------------
router.get(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT r.id, r.request_code AS code, r.work_date AS date, r.punch_in AS punchIn,
              r.punch_out AS punchOut, r.reason, r.status, r.created_at AS createdAt,
              a.name AS approver
         FROM regularization_requests r
         LEFT JOIN employees a ON a.id = r.approver_id
        WHERE r.employee_id = ?
        ORDER BY r.created_at DESC`,
      [req.user.id],
    );
    ok(res, rows);
  }),
);

router.post(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const body = parseWith(regularizeSchema, req.body);

    const duplicate = await queryOne(
      `SELECT id FROM regularization_requests
        WHERE employee_id = ? AND work_date = ? AND status = 'pending'`,
      [req.user.id, body.date],
    );
    if (duplicate) throw ApiError.conflict('A pending request already exists for this date');

    const seq = await queryOne('SELECT COUNT(*) AS n FROM regularization_requests');
    const code = `RG-${312 + Number(seq.n)}`;

    const result = await execute(
      `INSERT INTO regularization_requests
         (request_code, employee_id, work_date, punch_in, punch_out, reason, approver_id)
       VALUES (?,?,?,?,?,?,(SELECT reporting_to FROM employees WHERE id = ?))`,
      [
        code,
        req.user.id,
        body.date,
        withSeconds(body.punchIn),
        withSeconds(body.punchOut),
        body.reason,
        req.user.id,
      ],
    );

    created(res, { id: result.insertId, code, status: 'pending', ...body });
  }),
);

export default router;
