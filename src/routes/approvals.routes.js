import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import { withTransaction } from '../config/db.js';
import {
  Attendance,
  AuditLog,
  Employee,
  ExpenseClaim,
  LeaveBalance,
  LeaveRequest,
  Notification,
  RegularizationRequest,
} from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import {
  evaluateAttendance,
  policyForEmployee,
} from '../services/attendance-policy.service.js';
import { asyncHandler, eachDate, financialYearOf, ok, parseWith } from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireRole('manager'));

/**
 * Admins approve for everyone; managers only for their own reports.
 * Returns `null` for "no restriction", otherwise the employee ids in scope.
 */
async function scopedEmployeeIds(user) {
  if (user.role === 'admin') return null;
  const rows = await Employee.find({ reportingTo: user._id }).select('_id').lean();
  return rows.map((r) => r._id);
}

const scopeMatch = (ids) => (ids === null ? {} : { employeeId: { $in: ids } });

/** Pending first, then newest — the SQL `FIELD(status,'pending') DESC` ordering. */
const pendingFirst = (a, b) =>
  (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
  new Date(b.createdAt) - new Date(a.createdAt);

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
    const ids = await scopedEmployeeIds(req.user);
    const base = { status: 'pending', ...scopeMatch(ids) };

    const [leaves, expenses, regularizations] = await Promise.all([
      LeaveRequest.countDocuments(base),
      ExpenseClaim.countDocuments(base),
      RegularizationRequest.countDocuments(base),
    ]);

    ok(res, {
      leaves,
      expenses,
      regularizations,
      total: leaves + expenses + regularizations,
    });
  }),
);

// ------------------------------------------------------------------ leave --
const toApprovalLeave = (r) => ({
  id: r._id.toString(),
  code: r.requestCode,
  fromDate: r.fromDate,
  toDate: r.toDate,
  dayType: r.dayType,
  days: r.days,
  reason: r.reason,
  status: r.status,
  appliedOn: r.appliedOn,
  actionOn: r.actionOn,
  actionRemark: r.actionRemark,
  leaveType: r.leaveTypeId?.name ?? null,
  leaveTypeCode: r.leaveTypeId?.code ?? null,
  color: r.leaveTypeId?.color ?? null,
  employeeId: r.employeeId?._id?.toString() ?? null,
  employeeName: r.employeeId?.name ?? null,
  employeeCode: r.employeeId?.empCode ?? null,
  designation: r.employeeId?.designation ?? null,
});

router.get(
  '/leave',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const ids = await scopedEmployeeIds(req.user);

    const filter = { ...scopeMatch(ids), ...(status !== 'all' ? { status } : {}) };
    const rows = await LeaveRequest.find(filter)
      .populate('leaveTypeId', 'name code color')
      .populate('employeeId', 'name empCode designation')
      .lean();

    ok(res, rows.sort(pendingFirst).map(toApprovalLeave), { count: rows.length });
  }),
);

// Declared before "/leave/:id" so the literal path wins the match.
router.post(
  '/leave/bulk-approve',
  asyncHandler(async (req, res) => {
    const ids = await scopedEmployeeIds(req.user);
    const pending = await LeaveRequest.find({ status: 'pending', ...scopeMatch(ids) })
      .select('_id')
      .lean();

    for (const row of pending) {
      // Sequential on purpose: each approval mutates balances and attendance.
      // eslint-disable-next-line no-await-in-loop
      await applyLeaveDecision(req.user, row._id, true, 'Bulk approved');
    }
    ok(res, { approved: pending.length });
  }),
);

router.post(
  '/leave/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw ApiError.notFound('Request not found in your approval queue');
    }
    const ids = await scopedEmployeeIds(req.user);

    const request = await LeaveRequest.findOne({
      _id: req.params.id,
      ...scopeMatch(ids),
    }).lean();
    if (!request) throw ApiError.notFound('Request not found in your approval queue');
    if (request.status !== 'pending') throw ApiError.conflict(`Request is already ${request.status}`);

    await applyLeaveDecision(req.user, request._id, action === 'approve', remark);

    ok(res, {
      id: request._id.toString(),
      code: request.requestCode,
      status: action === 'approve' ? 'approved' : 'rejected',
    });
  }),
);

/**
 * Single place that applies a leave decision: updates the request, deducts the
 * balance, blocks the attendance calendar and notifies the employee.
 */
async function applyLeaveDecision(actor, id, approved, remark) {
  const request = await LeaveRequest.findById(id).populate('leaveTypeId', 'name annualQuota').lean();
  if (!request || request.status !== 'pending') return;

  const leaveType = request.leaveTypeId;

  await withTransaction(async (session) => {
    await LeaveRequest.updateOne(
      { _id: request._id },
      {
        $set: {
          status: approved ? 'approved' : 'rejected',
          approverId: actor._id,
          actionOn: new Date(),
          actionRemark: remark ?? null,
        },
      },
      { session },
    );

    if (approved) {
      if (Number(leaveType?.annualQuota) > 0) {
        await LeaveBalance.updateOne(
          {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId._id,
            financialYear: financialYearOf(request.fromDate),
          },
          { $inc: { used: request.days } },
          { session },
        );
      }

      // Block out every date in the range so payroll reads leave, not absent.
      const dates = eachDate(request.fromDate, request.toDate);
      if (dates.length) {
        await Attendance.bulkWrite(
          dates.map((workDate) => ({
            updateOne: {
              filter: { employeeId: request.employeeId, workDate },
              update: {
                $set: { status: 'leave', punchIn: null, punchOut: null, totalMinutes: 0 },
              },
              upsert: true,
            },
          })),
          { session },
        );
      }
    }

    await Notification.create(
      [
        {
          employeeId: request.employeeId,
          title: approved ? 'Leave approved' : 'Leave rejected',
          subtitle: `${leaveType?.name ?? 'Leave'} (${request.requestCode}) was ${
            approved ? 'approved' : 'rejected'
          } by ${actor.name}.`,
          kind: 'leave',
        },
      ],
      { session },
    );

    await AuditLog.create(
      [
        {
          actorId: actor._id,
          action: approved ? 'approve' : 'reject',
          entity: 'leave_request',
          entityId: request._id.toString(),
          meta: { remark: remark ?? null },
        },
      ],
      { session },
    );
  });
}

// --------------------------------------------------------------- expenses --
router.get(
  '/expenses',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const ids = await scopedEmployeeIds(req.user);

    const rows = await ExpenseClaim.find({
      ...scopeMatch(ids),
      ...(status !== 'all' ? { status } : {}),
    })
      .populate('categoryId', 'name')
      .populate('employeeId', 'name empCode')
      .lean();

    ok(
      res,
      rows.sort(pendingFirst).map((c) => ({
        id: c._id.toString(),
        code: c.claimCode,
        amount: c.amount,
        expenseDate: c.expenseDate,
        note: c.note,
        status: c.status,
        category: c.categoryId?.name ?? null,
        employeeId: c.employeeId?._id?.toString() ?? null,
        employeeName: c.employeeId?.name ?? null,
        employeeCode: c.employeeId?.empCode ?? null,
      })),
      { count: rows.length },
    );
  }),
);

router.post(
  '/expenses/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw ApiError.notFound('Claim not found in your approval queue');
    }
    const ids = await scopedEmployeeIds(req.user);

    const claim = await ExpenseClaim.findOne({ _id: req.params.id, ...scopeMatch(ids) }).lean();
    if (!claim) throw ApiError.notFound('Claim not found in your approval queue');
    if (claim.status !== 'pending') throw ApiError.conflict(`Claim is already ${claim.status}`);

    const approved = action === 'approve';
    await withTransaction(async (session) => {
      await ExpenseClaim.updateOne(
        { _id: claim._id },
        {
          $set: {
            status: approved ? 'approved' : 'rejected',
            approverId: req.user._id,
            actionOn: new Date(),
            actionRemark: remark ?? null,
          },
        },
        { session },
      );
      await Notification.create(
        [
          {
            employeeId: claim.employeeId,
            title: approved ? 'Expense approved' : 'Expense rejected',
            subtitle: `Claim ${claim.claimCode} for ₹${claim.amount} was ${
              approved ? 'approved' : 'rejected'
            }.`,
            kind: 'expense',
          },
        ],
        { session },
      );
    });

    ok(res, {
      id: claim._id.toString(),
      code: claim.claimCode,
      status: approved ? 'approved' : 'rejected',
    });
  }),
);

// -------------------------------------------------------- regularizations --
router.get(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(statusFilter, req.query);
    const ids = await scopedEmployeeIds(req.user);

    const rows = await RegularizationRequest.find({
      ...scopeMatch(ids),
      ...(status !== 'all' ? { status } : {}),
    })
      .populate('employeeId', 'name empCode')
      .lean();

    ok(
      res,
      rows.sort(pendingFirst).map((r) => ({
        id: r._id.toString(),
        code: r.requestCode,
        date: r.workDate,
        punchIn: r.punchIn,
        punchOut: r.punchOut,
        reason: r.reason,
        status: r.status,
        employeeId: r.employeeId?._id?.toString() ?? null,
        employeeName: r.employeeId?.name ?? null,
        employeeCode: r.employeeId?.empCode ?? null,
      })),
      { count: rows.length },
    );
  }),
);

router.post(
  '/regularizations/:id',
  asyncHandler(async (req, res) => {
    const { action, remark } = parseWith(actionSchema, req.body);
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw ApiError.notFound('Request not found in your approval queue');
    }
    const ids = await scopedEmployeeIds(req.user);

    const request = await RegularizationRequest.findOne({
      _id: req.params.id,
      ...scopeMatch(ids),
    }).lean();
    if (!request) throw ApiError.notFound('Request not found in your approval queue');
    if (request.status !== 'pending') throw ApiError.conflict(`Request is already ${request.status}`);

    const approved = action === 'approve';
    await withTransaction(async (session) => {
      await RegularizationRequest.updateOne(
        { _id: request._id },
        {
          $set: {
            status: approved ? 'approved' : 'rejected',
            approverId: req.user._id,
            actionOn: new Date(),
            actionRemark: remark ?? null,
          },
        },
        { session },
      );

      if (approved) {
        // Regularizing supplies the missing punches; it does not hand out a
        // full day. The corrected times go through the same policy as a live
        // punch, so a manager approving 11:00–14:00 gets a half day, not
        // "present".
        const policy = await policyForEmployee(request.employeeId, session);
        const verdict = evaluateAttendance({
          policy,
          punchIn: request.punchIn,
          punchOut: request.punchOut,
        });

        await Attendance.updateOne(
          { employeeId: request.employeeId, workDate: request.workDate },
          {
            $set: {
              punchIn: request.punchIn,
              punchOut: request.punchOut,
              totalMinutes: verdict.workedMinutes,
              status: verdict.status,
              isRegularized: true,
            },
            $setOnInsert: { shiftId: policy.id },
          },
          { upsert: true, session },
        );
      }

      await Notification.create(
        [
          {
            employeeId: request.employeeId,
            title: approved ? 'Regularization approved' : 'Regularization rejected',
            subtitle: `${request.requestCode} for ${request.workDate} was ${
              approved ? 'approved' : 'rejected'
            }.`,
            kind: 'attendance',
          },
        ],
        { session },
      );
    });

    ok(res, {
      id: request._id.toString(),
      code: request.requestCode,
      status: approved ? 'approved' : 'rejected',
    });
  }),
);

export default router;
