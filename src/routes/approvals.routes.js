import { Router } from 'express';
import { z } from 'zod';

import { query, queryOne, transaction } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, financialYearOf, ok, parseWith } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireRole('manager'));

/** Admins approve for everyone; managers only for their own reports. */
const approverScope = (user, alias) =>
  user.role === 'admin'
    ? { sql: '1 = 1', params: [] }
    : { sql: `${alias}.reporting_to = ?`, params: [user.id] };

const actionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  remark: z.string().trim().max(255).optional(),
});

const statusFilter = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('all'),
});

// ---------------------------------------------------------------- summary --
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const scope = approverScope(req.user, 'e');
    const counts = await queryOne(
      `SELECT
        (SELECT COUNT(*) FROM leave_requests r JOIN employees e ON e.id = r.employee_id
          WHERE r.status = 'pending' AND ${scope.sql}) AS leaves,
        (SELECT COUNT(*) FROM expense_claims r JOIN employees e ON e.id = r.employee_id
          WHERE r.status = 'pending' AND ${scope.sql}) AS expenses,
        (SELECT COUNT(*) FROM regularization_requests r JOIN employees e ON e.id = r.employee_id
          WHERE r.status = 'pending' AND ${scope.sql}) AS regularizations`,
      [...scope.params, ...scope.params, ...scope.params],
    );
    const total = Number(counts.leaves) + Number(counts.expenses) + Number(counts.regularizations);
    ok(res, { ...counts, total });
  }),
);

// ------------------------------------------------------------------ leave --
const LEAVE_SELECT = `
  lr.id, lr.request_code AS code, lr.from_date AS fromDate, lr.to_date AS toDate,
  lr.day_type AS dayType, lr.days, lr.reason, lr.status, lr.applied_on AS appliedOn,
  lr.action_on AS actionOn, lr.action_remark AS actionRemark,
  lt.name AS leaveType, lt.code AS leaveTypeCode, lt.color_hex AS color,
  e.id AS employeeId, e.name AS employeeName, e.emp_code AS employeeCode, e.designation
`;

router.get(
  '/leave',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const scope = approverScope(req.user, 'e');
    const where = [scope.sql];
    const params = [...scope.params];
    if (status !== 'all') { where.push('lr.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ${LEAVE_SELECT}
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(lr.status, 'pending') DESC, lr.created_at DESC`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

// Declared before "/leave/:id" so the literal path wins the match.
router.post(
  '/leave/bulk-approve',
  asyncHandler(async (req, res) => {
    const scope = approverScope(req.user, 'e');
    const pending = await query(
      `SELECT lr.id FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
        WHERE lr.status = 'pending' AND ${scope.sql}`,
      scope.params,
    );

    for (const row of pending) {
      // Sequential on purpose: each approval mutates balances and attendance.
      // eslint-disable-next-line no-await-in-loop
      await applyLeaveDecision(req.user, row.id, true, 'Bulk approved');
    }
    ok(res, { approved: pending.length });
  }),
);

router.post(
  '/leave/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    const scope = approverScope(req.user, 'e');

    const request = await queryOne(
      `SELECT lr.*, e.name AS employeeName, lt.name AS leaveTypeName, lt.annual_quota AS quota
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.id = ? AND ${scope.sql}`,
      [req.params.id, ...scope.params],
    );
    if (!request) throw ApiError.notFound('Request not found in your approval queue');
    if (request.status !== 'pending') {
      throw ApiError.conflict(`Request is already ${request.status}`);
    }

    await applyLeaveDecision(req.user, request.id, action === 'approve', remark);

    ok(res, {
      id: request.id,
      code: request.request_code,
      status: action === 'approve' ? 'approved' : 'rejected',
    });
  }),
);

/**
 * Single place that applies a leave decision: updates the request, deducts the
 * balance, blocks the attendance calendar and notifies the employee.
 */
async function applyLeaveDecision(actor, id, approved, remark) {
  const request = await queryOne(
    `SELECT lr.*, lt.annual_quota AS quota, lt.name AS leaveTypeName
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.id = ?`,
    [id],
  );
  if (!request || request.status !== 'pending') return;

  await transaction(async (conn) => {
    await conn.execute(
      `UPDATE leave_requests
          SET status = ?, approver_id = ?, action_on = NOW(), action_remark = ?
        WHERE id = ?`,
      [approved ? 'approved' : 'rejected', actor.id, remark ?? null, request.id],
    );

    if (approved) {
      if (Number(request.quota) > 0) {
        await conn.execute(
          `UPDATE leave_balances SET used = used + ?
            WHERE employee_id = ? AND leave_type_id = ? AND financial_year = ?`,
          [request.days, request.employee_id, request.leave_type_id, financialYearOf(request.from_date)],
        );
      }

      // Block out every date in the range so payroll reads leave, not absent.
      const rows = eachDate(request.from_date, request.to_date).map((date) => [
        request.employee_id,
        date,
      ]);
      if (rows.length) {
        await conn.query(
          `INSERT INTO attendance (employee_id, work_date, status)
           VALUES ${rows.map(() => "(?, ?, 'leave')").join(', ')}
           ON DUPLICATE KEY UPDATE
             status = 'leave', punch_in = NULL, punch_out = NULL, total_minutes = 0`,
          rows.flat(),
        );
      }
    }

    await conn.execute(
      `INSERT INTO notifications (employee_id, title, subtitle, kind) VALUES (?,?,?,'leave')`,
      [
        request.employee_id,
        approved ? 'Leave approved' : 'Leave rejected',
        `${request.leaveTypeName} (${request.request_code}) was ${approved ? 'approved' : 'rejected'} by ${actor.name}.`,
      ],
    );

    await conn.execute(
      `INSERT INTO audit_logs (actor_id, action, entity, entity_id, meta)
       VALUES (?,?,'leave_request',?,?)`,
      [
        actor.id,
        approved ? 'approve' : 'reject',
        String(request.id),
        JSON.stringify({ remark: remark ?? null }),
      ],
    );
  });
}

/** Inclusive list of YYYY-MM-DD strings between two dates. */
function eachDate(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  while (cursor <= end && dates.length < 366) {
    dates.push(fmt(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

// --------------------------------------------------------------- expenses --
router.get(
  '/expenses',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const scope = approverScope(req.user, 'e');
    const where = [scope.sql];
    const params = [...scope.params];
    if (status !== 'all') { where.push('ec.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT ec.id, ec.claim_code AS code, ec.amount, ec.expense_date AS expenseDate,
              ec.note, ec.status, c.name AS category,
              e.id AS employeeId, e.name AS employeeName, e.emp_code AS employeeCode
         FROM expense_claims ec
         JOIN employees e ON e.id = ec.employee_id
         JOIN expense_categories c ON c.id = ec.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(ec.status, 'pending') DESC, ec.created_at DESC`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

router.post(
  '/expenses/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    const scope = approverScope(req.user, 'e');

    const claim = await queryOne(
      `SELECT ec.* FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id
        WHERE ec.id = ? AND ${scope.sql}`,
      [req.params.id, ...scope.params],
    );
    if (!claim) throw ApiError.notFound('Claim not found in your approval queue');
    if (claim.status !== 'pending') throw ApiError.conflict(`Claim is already ${claim.status}`);

    const approved = action === 'approve';
    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE expense_claims
            SET status = ?, approver_id = ?, action_on = NOW(), action_remark = ?
          WHERE id = ?`,
        [approved ? 'approved' : 'rejected', req.user.id, remark ?? null, claim.id],
      );
      await conn.execute(
        `INSERT INTO notifications (employee_id, title, subtitle, kind) VALUES (?,?,?,'expense')`,
        [
          claim.employee_id,
          approved ? 'Expense approved' : 'Expense rejected',
          `Claim ${claim.claim_code} for ₹${claim.amount} was ${approved ? 'approved' : 'rejected'}.`,
        ],
      );
    });

    ok(res, { id: claim.id, code: claim.claim_code, status: approved ? 'approved' : 'rejected' });
  }),
);

// -------------------------------------------------------- regularizations --
router.get(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const scope = approverScope(req.user, 'e');
    const where = [scope.sql];
    const params = [...scope.params];
    if (status !== 'all') { where.push('r.status = ?'); params.push(status); }

    const rows = await query(
      `SELECT r.id, r.request_code AS code, r.work_date AS date, r.punch_in AS punchIn,
              r.punch_out AS punchOut, r.reason, r.status,
              e.id AS employeeId, e.name AS employeeName, e.emp_code AS employeeCode
         FROM regularization_requests r
         JOIN employees e ON e.id = r.employee_id
        WHERE ${where.join(' AND ')}
        ORDER BY FIELD(r.status, 'pending') DESC, r.created_at DESC`,
      params,
    );
    ok(res, rows, { count: rows.length });
  }),
);

router.post(
  '/regularizations/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    const scope = approverScope(req.user, 'e');

    const request = await queryOne(
      `SELECT r.* FROM regularization_requests r JOIN employees e ON e.id = r.employee_id
        WHERE r.id = ? AND ${scope.sql}`,
      [req.params.id, ...scope.params],
    );
    if (!request) throw ApiError.notFound('Request not found in your approval queue');
    if (request.status !== 'pending') throw ApiError.conflict(`Request is already ${request.status}`);

    const approved = action === 'approve';
    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE regularization_requests
            SET status = ?, approver_id = ?, action_on = NOW(), action_remark = ?
          WHERE id = ?`,
        [approved ? 'approved' : 'rejected', req.user.id, remark ?? null, request.id],
      );

      if (approved) {
        const minutes =
          Number(request.punch_out.slice(0, 2)) * 60 + Number(request.punch_out.slice(3, 5)) -
          (Number(request.punch_in.slice(0, 2)) * 60 + Number(request.punch_in.slice(3, 5)));

        await conn.execute(
          `INSERT INTO attendance
             (employee_id, work_date, punch_in, punch_out, total_minutes, status, is_regularized, shift_id)
           VALUES (?,?,?,?,?, 'present', 1, (SELECT shift_id FROM employees WHERE id = ?))
           ON DUPLICATE KEY UPDATE
             punch_in = VALUES(punch_in), punch_out = VALUES(punch_out),
             total_minutes = VALUES(total_minutes), status = 'present', is_regularized = 1`,
          [
            request.employee_id,
            request.work_date,
            request.punch_in,
            request.punch_out,
            Math.max(0, minutes),
            request.employee_id,
          ],
        );
      }

      await conn.execute(
        `INSERT INTO notifications (employee_id, title, subtitle, kind) VALUES (?,?,?,'attendance')`,
        [
          request.employee_id,
          approved ? 'Regularization approved' : 'Regularization rejected',
          `${request.request_code} for ${request.work_date} was ${approved ? 'approved' : 'rejected'}.`,
        ],
      );
    });

    ok(res, { id: request.id, code: request.request_code, status: approved ? 'approved' : 'rejected' });
  }),
);

export default router;
