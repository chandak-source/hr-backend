import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import {
  Announcement,
  Department,
  ExpenseCategory,
  ExpenseClaim,
  Holiday,
  Notification,
  Task,
} from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { nextCode } from '../services/sequence.service.js';
import { findEmployees } from '../services/employee.service.js';
import {
  asyncHandler,
  created,
  ok,
  parseWith,
  searchFilter,
  todayString,
} from '../utils/helpers.js';

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

const toClaim = (c) => ({
  id: c._id.toString(),
  code: c.claimCode,
  amount: c.amount,
  expenseDate: c.expenseDate,
  note: c.note,
  status: c.status,
  createdAt: c.createdAt,
  category: c.categoryId?.name ?? null,
  employeeName: c.employeeId?.name ?? null,
  employeeCode: c.employeeId?.empCode ?? null,
  approver: c.approverId?.name ?? null,
});

const CLAIM_POPULATE = [
  { path: 'categoryId', select: 'name' },
  { path: 'employeeId', select: 'name empCode' },
  { path: 'approverId', select: 'name' },
];

router.get(
  '/expenses/categories',
  asyncHandler(async (_req, res) => {
    const rows = await ExpenseCategory.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    ok(res, rows.map((c) => ({ id: c._id.toString(), name: c.name, maxLimit: c.maxLimit })));
  }),
);

router.get(
  '/expenses',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(
      z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }),
      req.query,
    );

    const filter = { employeeId: req.user._id, ...(status ? { status } : {}) };
    const rows = await ExpenseClaim.find(filter)
      .sort({ createdAt: -1 })
      .populate(CLAIM_POPULATE)
      .lean();

    const [totals] = await ExpenseClaim.aggregate([
      { $match: { employeeId: req.user._id } },
      {
        $group: {
          _id: null,
          pendingAmount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
          approvedAmount: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, '$amount', 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]);

    ok(res, rows.map(toClaim), totals ?? { pendingAmount: 0, approvedAmount: 0 });
  }),
);

router.post(
  '/expenses',
  asyncHandler(async (req, res) => {
    const body = parseWith(expenseSchema, req.body);

    const category = await ExpenseCategory.findOne({ name: body.category, isActive: true }).lean();
    if (!category) throw ApiError.badRequest(`Unknown expense category "${body.category}"`);
    if (category.maxLimit && body.amount > Number(category.maxLimit)) {
      throw ApiError.badRequest(`${category.name} claims are capped at ₹${category.maxLimit}`);
    }
    if (body.expenseDate > todayString()) {
      throw ApiError.badRequest('Expense date cannot be in the future');
    }

    const doc = await ExpenseClaim.create({
      claimCode: await nextCode('EX-', 'expenseClaim'),
      employeeId: req.user._id,
      categoryId: category._id,
      amount: body.amount,
      expenseDate: body.expenseDate,
      note: body.note,
      approverId: req.user.reportingTo ?? null,
    });

    created(res, toClaim(await ExpenseClaim.findById(doc._id).populate(CLAIM_POPULATE).lean()));
  }),
);

// ================================================================= tasks ====
const toTask = (t) => ({
  id: t._id.toString(),
  code: t.taskCode,
  title: t.title,
  project: t.project,
  dueDate: t.dueDate,
  priority: t.priority,
  progress: t.progress,
  isDone: t.isDone,
  completedAt: t.completedAt,
  assignedBy: t.assignedBy?.name ?? null,
});

router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const { status } = parseWith(
      z.object({ status: z.enum(['open', 'completed', 'all']).default('all') }),
      req.query,
    );

    const filter = { employeeId: req.user._id };
    if (status === 'open') filter.isDone = false;
    if (status === 'completed') filter.isDone = true;

    const rows = await Task.find(filter)
      .sort({ isDone: 1, dueDate: 1 })
      .populate('assignedBy', 'name')
      .lean();

    ok(res, rows.map(toTask), { openCount: rows.filter((r) => !r.isDone).length });
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
    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Task not found');

    const task = await Task.findOne({ _id: req.params.id, employeeId: req.user._id }).lean();
    if (!task) throw ApiError.notFound('Task not found');

    const update = {};
    if (body.isDone !== undefined) {
      update.isDone = body.isDone;
      // Completing stamps the time; reopening clears it.
      update.completedAt = body.isDone ? new Date() : null;
    }
    if (body.progress !== undefined) update.progress = body.progress;
    else if (body.isDone === true) update.progress = 1;

    await Task.updateOne({ _id: task._id }, { $set: update });

    ok(res, toTask(await Task.findById(task._id).populate('assignedBy', 'name').lean()));
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

    const from = upcoming && `${year}-01-01` < todayString() ? todayString() : `${year}-01-01`;
    const rows = await Holiday.find({
      holidayDate: { $gte: from, $lte: `${year}-12-31` },
    })
      .sort({ holidayDate: 1 })
      .lean();

    ok(
      res,
      rows.map((h) => ({
        id: h._id.toString(),
        date: h.holidayDate,
        name: h.name,
        type: h.type,
      })),
      { year, count: rows.length },
    );
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

    const rows = await Announcement.find({ isActive: true })
      .sort({ publishedAt: -1 })
      .limit(limit)
      .populate('publishedBy', 'name')
      .lean();

    ok(
      res,
      rows.map((a) => ({
        id: a._id.toString(),
        title: a.title,
        body: a.body,
        category: a.category,
        publishedAt: a.publishedAt,
        publishedBy: a.publishedBy?.name ?? null,
      })),
    );
  }),
);

// ========================================================= notifications ====
router.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const rows = await Notification.find({ employeeId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    ok(
      res,
      rows.map((n) => ({
        id: n._id.toString(),
        title: n.title,
        subtitle: n.subtitle,
        kind: n.kind,
        isRead: n.isRead,
        createdAt: n.createdAt,
      })),
      { unread: rows.filter((r) => !r.isRead).length },
    );
  }),
);

router.patch(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Notification not found');

    const result = await Notification.updateOne(
      { _id: req.params.id, employeeId: req.user._id },
      { $set: { isRead: true } },
    );
    if (!result.matchedCount) throw ApiError.notFound('Notification not found');

    ok(res, { id: req.params.id, isRead: true });
  }),
);

router.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    const result = await Notification.updateMany(
      { employeeId: req.user._id, isRead: false },
      { $set: { isRead: true } },
    );
    ok(res, { marked: result.modifiedCount });
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

    const match = { status: { $ne: 'exited' } };
    if (q) Object.assign(match, searchFilter(q, ['name', 'empCode', 'designation']));
    if (department && department !== 'All') {
      const dept = await Department.findOne({ name: department }).select('_id').lean();
      // An unknown department name matches nobody rather than everybody.
      match.departmentId = dept?._id ?? null;
    }

    const rows = await findEmployees(match, { sort: { name: 1 }, limit });
    ok(res, rows, { count: rows.length });
  }),
);

router.get(
  '/departments',
  asyncHandler(async (_req, res) => {
    const rows = await Department.aggregate([
      { $lookup: { from: 'employees', localField: 'headId', foreignField: '_id', as: 'headEmp' } },
      {
        $lookup: {
          from: 'employees',
          let: { did: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ['$departmentId', '$$did'] }, { $ne: ['$status', 'exited'] }] },
              },
            },
            { $count: 'n' },
          ],
          as: 'staff',
        },
      },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          name: 1,
          code: 1,
          head: { $ifNull: [{ $first: '$headEmp.name' }, null] },
          headcount: { $ifNull: [{ $first: '$staff.n' }, 0] },
        },
      },
      { $sort: { name: 1 } },
    ]);

    ok(res, rows);
  }),
);

export default router;
