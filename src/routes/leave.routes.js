import { Router } from 'express';
import { z } from 'zod';

import { execute, query, queryOne, transaction } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import {
  asyncHandler,
  created,
  daysBetweenInclusive,
  financialYearOf,
  ok,
  parseWith,
  todayString,
} from '../utils/helpers.js';

const router = Router();
router.use(authenticate);

const LEAVE_SELECT = `
  lr.id,
  lr.request_code AS code,
  lr.from_date    AS fromDate,
  lr.to_date      AS toDate,
  lr.day_type     AS dayType,
  lr.days,
  lr.reason,
  lr.status,
  lr.applied_on   AS appliedOn,
  lr.action_on    AS actionOn,
  lr.action_remark AS actionRemark,
  lt.name         AS leaveType,
  lt.code         AS leaveTypeCode,
  lt.color_hex    AS color,
  e.name          AS employeeName,
  e.emp_code      AS employeeCode,
  ap.name         AS approver
`;

const LEAVE_JOINS = `
  FROM leave_requests lr
  JOIN leave_types lt ON lt.id = lr.leave_type_id
  JOIN employees   e  ON e.id  = lr.employee_id
  LEFT JOIN employees ap ON ap.id = lr.approver_id
`;

const applySchema = z
  .object({
    leaveTypeCode: z.string().trim().min(2).max(10),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    dayType: z.enum(['full_day', 'first_half', 'second_half']).default('full_day'),
    reason: z.string().trim().min(5, 'Add a reason (min 5 characters)').max(500),
  })
  .refine((v) => v.toDate >= v.fromDate, {
    message: 'To date cannot be before from date',
    path: ['toDate'],
  })
  .refine((v) => v.dayType === 'full_day' || v.fromDate === v.toDate, {
    message: 'Half day leave must be for a single date',
    path: ['dayType'],
  });

// GET /leave/types ------------------------------------------------------------
router.get(
  '/types',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT id, code, name, annual_quota AS annualQuota, is_paid AS isPaid,
              requires_proof AS requiresProof, color_hex AS color
         FROM leave_types WHERE is_active = 1 ORDER BY id`,
    );
    ok(res, rows);
  }),
);

// GET /leave/balances ---------------------------------------------------------
router.get(
  '/balances',
  asyncHandler(async (req, res) => {
    const fy = req.query.financialYear ?? financialYearOf();
    const rows = await query(
      `SELECT lt.code AS shortCode, lt.name AS type, lt.color_hex AS color,
              lb.allotted + lb.carried_forward AS total,
              lb.used,
              (lb.allotted + lb.carried_forward - lb.used) AS available
         FROM leave_balances lb
         JOIN leave_types lt ON lt.id = lb.leave_type_id
        WHERE lb.employee_id = ? AND lb.financial_year = ?
        ORDER BY lt.id`,
      [req.user.id, fy],
    );
    ok(res, rows, { financialYear: fy });
  }),
);

// GET /leave/requests?status --------------------------------------------------
router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(
      z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }),
      req.query,
    );

    const where = ['lr.employee_id = ?'];
    const params = [req.user.id];
    if (status) { where.push('lr.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ${LEAVE_SELECT} ${LEAVE_JOINS} WHERE ${where.join(' AND ')} ORDER BY lr.created_at DESC`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

// POST /leave/requests --------------------------------------------------------
router.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const body = parseWith(applySchema, req.body);
    const fy = financialYearOf(body.fromDate);

    const type = await queryOne('SELECT id, name, annual_quota AS quota FROM leave_types WHERE code = ? AND is_active = 1', [
      body.leaveTypeCode,
    ]);
    if (!type) throw ApiError.badRequest(`Unknown leave type "${body.leaveTypeCode}"`);

    const days =
      body.dayType === 'full_day' ? daysBetweenInclusive(body.fromDate, body.toDate) : 0.5;

    const overlap = await queryOne(
      `SELECT request_code AS code FROM leave_requests
        WHERE employee_id = ? AND status IN ('pending','approved')
          AND from_date <= ? AND to_date >= ?`,
      [req.user.id, body.toDate, body.fromDate],
    );
    if (overlap) throw ApiError.conflict(`Overlaps with existing request ${overlap.code}`);

    const result = await transaction(async (conn) => {
      if (Number(type.quota) > 0) {
        const [balRows] = await conn.execute(
          `SELECT id, (allotted + carried_forward - used) AS available
             FROM leave_balances
            WHERE employee_id = ? AND leave_type_id = ? AND financial_year = ?
            FOR UPDATE`,
          [req.user.id, type.id, fy],
        );
        const balance = balRows[0];
        if (!balance) throw ApiError.badRequest(`No ${type.name} balance allotted for ${fy}`);
        if (Number(balance.available) < days) {
          throw ApiError.badRequest(
            `Only ${balance.available} day(s) of ${type.name} available`,
          );
        }
      }

      const [seq] = await conn.query('SELECT COUNT(*) AS n FROM leave_requests');
      const code = `LV-${2310 + Number(seq[0].n)}`;

      const [insert] = await conn.execute(
        `INSERT INTO leave_requests
           (request_code, employee_id, leave_type_id, from_date, to_date, day_type, days,
            reason, applied_on, approver_id)
         VALUES (?,?,?,?,?,?,?,?,?,(SELECT reporting_to FROM employees WHERE id = ?))`,
        [
          code,
          req.user.id,
          type.id,
          body.fromDate,
          body.toDate,
          body.dayType,
          days,
          body.reason,
          todayString(),
          req.user.id,
        ],
      );

      await conn.execute(
        `INSERT INTO notifications (employee_id, title, subtitle, kind)
         SELECT reporting_to, 'New leave request',
                CONCAT(?, ' applied for ', ?, ' day(s) of ', ?), 'leave'
           FROM employees WHERE id = ? AND reporting_to IS NOT NULL`,
        [req.user.name, days, type.name, req.user.id],
      );

      return { id: insert.insertId, code };
    });

    const request = await queryOne(`SELECT ${LEAVE_SELECT} ${LEAVE_JOINS} WHERE lr.id = ?`, [
      result.id,
    ]);
    created(res, request);
  }),
);

// POST /leave/requests/:id/cancel ---------------------------------------------
router.post(
  '/requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      'SELECT id, status FROM leave_requests WHERE id = ? AND employee_id = ?',
      [req.params.id, req.user.id],
    );
    if (!row) throw ApiError.notFound('Leave request not found');
    if (row.status !== 'pending') {
      throw ApiError.badRequest(`Only pending requests can be cancelled (this one is ${row.status})`);
    }

    await execute("UPDATE leave_requests SET status = 'cancelled', action_on = NOW() WHERE id = ?", [
      row.id,
    ]);
    ok(res, await queryOne(`SELECT ${LEAVE_SELECT} ${LEAVE_JOINS} WHERE lr.id = ?`, [row.id]));
  }),
);

export default router;
