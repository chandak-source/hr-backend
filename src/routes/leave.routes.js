import { Router } from 'express';
import { z } from 'zod';

import { withTransaction } from '../config/db.js';
import { LeaveBalance, LeaveRequest, LeaveType, Notification } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { nextCode } from '../services/sequence.service.js';
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

const POPULATE = [
  { path: 'leaveTypeId', select: 'name code color' },
  { path: 'employeeId', select: 'name empCode' },
  { path: 'approverId', select: 'name' },
];

/** Flattens the populated refs into the response shape the SQL joins produced. */
const toLeave = (r) =>
  r && {
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
    employeeName: r.employeeId?.name ?? null,
    employeeCode: r.employeeId?.empCode ?? null,
    approver: r.approverId?.name ?? null,
  };

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
    const rows = await LeaveType.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    ok(
      res,
      rows.map((t) => ({
        id: t._id.toString(),
        code: t.code,
        name: t.name,
        annualQuota: t.annualQuota,
        isPaid: t.isPaid,
        requiresProof: t.requiresProof,
        color: t.color,
      })),
    );
  }),
);

// GET /leave/balances ---------------------------------------------------------
router.get(
  '/balances',
  asyncHandler(async (req, res) => {
    const fy = req.query.financialYear ?? financialYearOf();
    const rows = await LeaveBalance.find({ employeeId: req.user._id, financialYear: fy })
      .populate('leaveTypeId', 'name code color sortOrder')
      .lean();

    const balances = rows
      .filter((b) => b.leaveTypeId)
      .sort((a, b) => (a.leaveTypeId.sortOrder ?? 0) - (b.leaveTypeId.sortOrder ?? 0))
      .map((b) => ({
        shortCode: b.leaveTypeId.code,
        type: b.leaveTypeId.name,
        color: b.leaveTypeId.color,
        total: b.allotted + b.carriedForward,
        used: b.used,
        available: b.allotted + b.carriedForward - b.used,
      }));

    ok(res, balances, { financialYear: fy });
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

    const filter = { employeeId: req.user._id };
    if (status) filter.status = status;

    const rows = await LeaveRequest.find(filter).sort({ createdAt: -1 }).populate(POPULATE).lean();
    ok(res, rows.map(toLeave), { count: rows.length });
  }),
);

// POST /leave/requests --------------------------------------------------------
router.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const body = parseWith(applySchema, req.body);
    const fy = financialYearOf(body.fromDate);

    const type = await LeaveType.findOne({ code: body.leaveTypeCode, isActive: true }).lean();
    if (!type) throw ApiError.badRequest(`Unknown leave type "${body.leaveTypeCode}"`);

    const days =
      body.dayType === 'full_day' ? daysBetweenInclusive(body.fromDate, body.toDate) : 0.5;

    // Two ranges overlap when each starts on or before the other ends.
    const overlap = await LeaveRequest.findOne({
      employeeId: req.user._id,
      status: { $in: ['pending', 'approved'] },
      fromDate: { $lte: body.toDate },
      toDate: { $gte: body.fromDate },
    })
      .select('requestCode')
      .lean();
    if (overlap) throw ApiError.conflict(`Overlaps with existing request ${overlap.requestCode}`);

    const requestId = await withTransaction(async (session) => {
      if (Number(type.annualQuota) > 0) {
        const balance = await LeaveBalance.findOne({
          employeeId: req.user._id,
          leaveTypeId: type._id,
          financialYear: fy,
        })
          .session(session)
          .lean();

        if (!balance) throw ApiError.badRequest(`No ${type.name} balance allotted for ${fy}`);
        const available = balance.allotted + balance.carriedForward - balance.used;
        if (available < days) {
          throw ApiError.badRequest(`Only ${available} day(s) of ${type.name} available`);
        }
      }

      const [doc] = await LeaveRequest.create(
        [
          {
            requestCode: await nextCode('LV-', 'leaveRequest', session),
            employeeId: req.user._id,
            leaveTypeId: type._id,
            fromDate: body.fromDate,
            toDate: body.toDate,
            dayType: body.dayType,
            days,
            reason: body.reason,
            appliedOn: todayString(),
            approverId: req.user.reportingTo ?? null,
          },
        ],
        { session },
      );

      if (req.user.reportingTo) {
        await Notification.create(
          [
            {
              employeeId: req.user.reportingTo,
              title: 'New leave request',
              subtitle: `${req.user.name} applied for ${days} day(s) of ${type.name}`,
              kind: 'leave',
            },
          ],
          { session },
        );
      }

      return doc._id;
    });

    const request = await LeaveRequest.findById(requestId).populate(POPULATE).lean();
    created(res, toLeave(request));
  }),
);

// POST /leave/requests/:id/cancel ---------------------------------------------
router.post(
  '/requests/:id/cancel',
  asyncHandler(async (req, res) => {
    const row = await LeaveRequest.findOne({
      _id: req.params.id,
      employeeId: req.user._id,
    }).lean();
    if (!row) throw ApiError.notFound('Leave request not found');
    if (row.status !== 'pending') {
      throw ApiError.badRequest(`Only pending requests can be cancelled (this one is ${row.status})`);
    }

    await LeaveRequest.updateOne(
      { _id: row._id },
      { $set: { status: 'cancelled', actionOn: new Date() } },
    );

    ok(res, toLeave(await LeaveRequest.findById(row._id).populate(POPULATE).lean()));
  }),
);

export default router;
