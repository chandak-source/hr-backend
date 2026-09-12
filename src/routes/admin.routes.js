import bcrypt from 'bcryptjs';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import {
  Announcement,
  Attendance,
  Department,
  Employee,
  ExpenseClaim,
  LeaveBalance,
  LeaveRequest,
  Location,
  Notification,
  PayrollRun,
  Payslip,
  RegularizationRequest,
  SalaryStructure,
  Shift,
} from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import {
  asyncHandler,
  created,
  daysAgoString,
  monthRange,
  ok,
  parseWith,
  round2,
  searchFilter,
  todayString,
} from '../utils/helpers.js';
import { findEmployees, idForEmpCode } from '../services/employee.service.js';
import { nextCode } from '../services/sequence.service.js';
import { computePayslip, countLopDays, MONTH_NAMES } from '../services/payroll.service.js';

const router = Router();
router.use(authenticate, requireRole('admin'));

const WORKED = ['present', 'late_in', 'half_day'];
const OFF = ['week_off', 'holiday'];

/** Percentage of non-off days that were actually worked, over a date range. */
const attendancePercentStage = {
  $group: {
    _id: '$workDate',
    worked: { $sum: { $cond: [{ $in: ['$status', WORKED] }, 1, 0] } },
    counted: { $sum: { $cond: [{ $in: ['$status', OFF] }, 0, 1] } },
  },
};

// ============================================================== overview ====
router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const monthStart = `${todayString().slice(0, 7)}-01`;

    const [headcountRow] = await Employee.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          newJoinees: { $sum: { $cond: [{ $gte: ['$dateOfJoining', monthStart] }, 1, 0] } },
          exitsThisMonth: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'exited'] },
                    { $gte: [{ $ifNull: ['$exitDate', ''] }, monthStart] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $project: { _id: 0 } },
    ]);

    const last30 = await Attendance.aggregate([
      { $match: { workDate: { $gte: daysAgoString(30) } } },
      {
        $group: {
          _id: null,
          worked: { $sum: { $cond: [{ $in: ['$status', WORKED] }, 1, 0] } },
          counted: { $sum: { $cond: [{ $in: ['$status', OFF] }, 0, 1] } },
        },
      },
    ]);
    const avgAttendance = last30[0]?.counted
      ? round2((100 * last30[0].worked) / last30[0].counted)
      : 0;

    const [leaves, expenses, regularizations] = await Promise.all([
      LeaveRequest.countDocuments({ status: 'pending' }),
      ExpenseClaim.countDocuments({ status: 'pending' }),
      RegularizationRequest.countDocuments({ status: 'pending' }),
    ]);

    const payroll = await PayrollRun.findOne().sort({ payYear: -1, payMonth: -1 }).lean();

    const byDept = await Department.aggregate([
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
      { $project: { _id: 0, name: 1, headcount: { $ifNull: [{ $first: '$staff.n' }, 0] } } },
      { $sort: { headcount: -1 } },
    ]);

    const trend = await Attendance.aggregate([
      { $match: { workDate: { $gte: daysAgoString(7) } } },
      attendancePercentStage,
      {
        $project: {
          _id: 0,
          date: '$_id',
          percent: {
            $cond: [
              { $gt: ['$counted', 0] },
              { $round: [{ $multiply: [100, { $divide: ['$worked', '$counted'] }] }, 0] },
              null,
            ],
          },
        },
      },
      { $sort: { date: 1 } },
    ]);

    ok(res, {
      headcount: headcountRow ?? { total: 0, active: 0, newJoinees: 0, exitsThisMonth: 0 },
      avgAttendance,
      pendingApprovals: leaves + expenses + regularizations,
      latestPayroll: payroll && {
        month: payroll.payMonth,
        year: payroll.payYear,
        status: payroll.status,
        totalNet: payroll.totalNet,
        employees: payroll.employeeCount,
        period: `${MONTH_NAMES[payroll.payMonth - 1]} ${payroll.payYear}`,
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

    const match = {};
    if (q) Object.assign(match, searchFilter(q, ['name', 'empCode', 'designation']));
    if (status) match.status = status;
    if (department && department !== 'All') {
      const dept = await Department.findOne({ name: department }).select('_id').lean();
      match.departmentId = dept?._id ?? null;
    }

    const rows = await findEmployees(match, { sort: { name: 1 }, limit });
    ok(res, rows, { count: rows.length });
  }),
);

router.post(
  '/employees',
  asyncHandler(async (req, res) => {
    const body = parseWith(createEmployeeSchema, req.body);

    const dept = await Department.findOne({ name: body.department }).select('_id').lean();
    if (!dept) throw ApiError.badRequest(`Unknown department "${body.department}"`);

    let managerId = null;
    if (body.reportingToCode) {
      managerId = await idForEmpCode(body.reportingToCode);
      if (!managerId) throw ApiError.badRequest(`Unknown manager code "${body.reportingToCode}"`);
    }

    const location = body.location
      ? await Location.findOne({ name: body.location }).select('_id').lean()
      : null;
    const generalShift = await Shift.findOne({ name: 'General' }).select('_id').lean();

    const passwordHash = await bcrypt.hash(env.seedPassword, 10);

    const result = await withTransaction(async (session) => {
      const empCode = await nextCode('EMP', 'employee', session);

      const [employee] = await Employee.create(
        [
          {
            empCode,
            name: body.name,
            email: body.email,
            phone: body.phone ?? null,
            passwordHash,
            role: body.role,
            designation: body.designation,
            departmentId: dept._id,
            locationId: location?._id ?? null,
            shiftId: generalShift?._id ?? null,
            reportingTo: managerId,
            dateOfJoining: body.dateOfJoining,
          },
        ],
        { session },
      );

      const monthly = body.annualCtc / 12;
      await SalaryStructure.create(
        [
          {
            employeeId: employee._id,
            effectiveFrom: body.dateOfJoining,
            annualCtc: body.annualCtc,
            basic: Math.round(monthly * 0.5),
            hra: Math.round(monthly * 0.2),
            conveyance: Math.round(monthly * 0.05),
            specialAllowance: Math.round(monthly * 0.25),
            isCurrent: true,
          },
        ],
        { session },
      );

      return { id: employee._id.toString(), empCode };
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

    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Employee not found');
    const exists = await Employee.exists({ _id: req.params.id });
    if (!exists) throw ApiError.notFound('Employee not found');

    const update = {};
    if (body.designation) update.designation = body.designation;
    if (body.role) update.role = body.role;
    if (body.status) {
      update.status = body.status;
      if (body.status === 'exited') update.exitDate = todayString();
    }
    if (body.department) {
      const dept = await Department.findOne({ name: body.department }).select('_id').lean();
      if (!dept) throw ApiError.badRequest(`Unknown department "${body.department}"`);
      update.departmentId = dept._id;
    }
    if (body.reportingToCode) {
      const managerId = await idForEmpCode(body.reportingToCode);
      if (!managerId) throw ApiError.badRequest(`Unknown manager code "${body.reportingToCode}"`);
      update.reportingTo = managerId;
    }
    if (!Object.keys(update).length) throw ApiError.badRequest('Nothing to update');

    await Employee.updateOne({ _id: req.params.id }, { $set: update });

    const [row] = await findEmployees({ _id: new mongoose.Types.ObjectId(String(req.params.id)) });
    ok(res, row);
  }),
);

// =============================================================== payroll ====
router.get(
  '/payroll/runs',
  asyncHandler(async (_req, res) => {
    const rows = await PayrollRun.find()
      .sort({ payYear: -1, payMonth: -1 })
      .populate('processedBy', 'name')
      .lean();

    ok(
      res,
      rows.map((r) => ({
        id: r._id.toString(),
        month: r.payMonth,
        year: r.payYear,
        status: r.status,
        employees: r.employeeCount,
        totalGross: r.totalGross,
        totalDeductions: r.totalDeductions,
        totalNet: r.totalNet,
        processedAt: r.processedAt,
        publishedAt: r.publishedAt,
        processedBy: r.processedBy?.name ?? null,
        period: `${MONTH_NAMES[r.payMonth - 1]} ${r.payYear}`,
      })),
    );
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

    const existing = await PayrollRun.findOne({ payMonth: month, payYear: year }).lean();
    if (existing && existing.status !== 'draft') {
      throw ApiError.conflict(
        `Payroll for ${MONTH_NAMES[month - 1]} ${year} is already ${existing.status}`,
      );
    }

    const actives = await Employee.find({ status: 'active' })
      .select('_id bankAccount')
      .lean();
    const structures = await SalaryStructure.find({
      employeeId: { $in: actives.map((e) => e._id) },
      isCurrent: true,
    }).lean();
    const structureBy = new Map(structures.map((s) => [s.employeeId.toString(), s]));

    const payable = actives.filter((e) => structureBy.has(e._id.toString()));
    if (!payable.length) throw ApiError.badRequest('No active employees with salary structures');

    const summary = await withTransaction(async (session) => {
      let runId = existing?._id;
      if (runId) {
        await Payslip.deleteMany({ payrollRunId: runId }, { session });
      } else {
        const [run] = await PayrollRun.create(
          [{ payMonth: month, payYear: year, status: 'draft', processedBy: req.user._id }],
          { session },
        );
        runId = run._id;
      }

      let totals = { gross: 0, deductions: 0, net: 0 };
      const slips = [];

      for (const emp of payable) {
        const structure = structureBy.get(emp._id.toString());
        // eslint-disable-next-line no-await-in-loop
        const lopDays = await countLopDays(emp._id, month, year, session);
        const slip = computePayslip({ structure, month, year, lopDays });

        slips.push({
          payrollRunId: runId,
          employeeId: emp._id,
          paidDays: slip.paidDays,
          lopDays: slip.lopDays,
          gross: slip.gross,
          deductions: slip.deductions,
          net: slip.net,
          bankAccount: emp.bankAccount ?? null,
          components: [
            ...slip.earnings.map((c, i) => ({ ...c, type: 'earning', sortOrder: i })),
            ...slip.deductionItems.map((c, i) => ({ ...c, type: 'deduction', sortOrder: i })),
          ],
        });

        totals = {
          gross: totals.gross + slip.gross,
          deductions: totals.deductions + slip.deductions,
          net: totals.net + slip.net,
        };
      }

      await Payslip.insertMany(slips, { session });

      await PayrollRun.updateOne(
        { _id: runId },
        {
          $set: {
            status: 'processed',
            employeeCount: payable.length,
            totalGross: round2(totals.gross),
            totalDeductions: round2(totals.deductions),
            totalNet: round2(totals.net),
            processedBy: req.user._id,
            processedAt: new Date(),
          },
        },
        { session },
      );

      return { runId: runId.toString(), employees: payable.length, ...totals };
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
    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Payroll run not found');

    const run = await PayrollRun.findById(req.params.id).lean();
    if (!run) throw ApiError.notFound('Payroll run not found');
    if (run.status === 'published') throw ApiError.conflict('Run is already published');
    if (run.status === 'draft') throw ApiError.badRequest('Process the run before publishing');

    const period = `${MONTH_NAMES[run.payMonth - 1]} ${run.payYear}`;

    await withTransaction(async (session) => {
      await PayrollRun.updateOne(
        { _id: run._id },
        { $set: { status: 'published', publishedAt: new Date() } },
        { session },
      );
      await Payslip.updateMany(
        { payrollRunId: run._id },
        { $set: { creditedOn: todayString() } },
        { session },
      );

      const slips = await Payslip.find({ payrollRunId: run._id })
        .select('employeeId net')
        .session(session)
        .lean();

      if (slips.length) {
        await Notification.insertMany(
          slips.map((p) => ({
            employeeId: p.employeeId,
            title: 'Payslip available',
            subtitle: `${period} payslip published. Net pay ₹${Math.round(p.net).toLocaleString('en-IN')}.`,
            kind: 'payroll',
          })),
          { session },
        );
      }
    });

    ok(res, { id: run._id.toString(), status: 'published' });
  }),
);

// POST /admin/payroll/runs/:id/unlock ----------------------------------------
router.post(
  '/payroll/runs/:id/unlock',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw ApiError.notFound('Run not found or already draft');
    }

    const result = await PayrollRun.updateOne(
      { _id: req.params.id, status: { $ne: 'draft' } },
      { $set: { status: 'draft', publishedAt: null } },
    );
    if (!result.matchedCount) throw ApiError.notFound('Run not found or already draft');

    ok(res, { id: req.params.id, status: 'draft' });
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

    const doc = await Announcement.create({ ...body, publishedBy: req.user._id });
    created(res, { id: doc._id.toString(), ...body, publishedBy: req.user.name });
  }),
);

router.delete(
  '/announcements/:id',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Announcement not found');

    const result = await Announcement.updateOne(
      { _id: req.params.id },
      { $set: { isActive: false } },
    );
    if (!result.matchedCount) throw ApiError.notFound('Announcement not found');

    ok(res, { id: req.params.id, archived: true });
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
    const { from, to } = monthRange(month, year);

    const rows = await Employee.aggregate([
      { $match: { status: { $ne: 'exited' } } },
      { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'dept' } },
      {
        $lookup: {
          from: 'attendances',
          let: { eid: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$employeeId', '$$eid'] },
                    { $gte: ['$workDate', from] },
                    { $lte: ['$workDate', to] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                present: { $sum: { $cond: [{ $in: ['$status', ['present', 'late_in']] }, 1, 0] } },
                halfDays: { $sum: { $cond: [{ $eq: ['$status', 'half_day'] }, 1, 0] } },
                leaves: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
                absent: { $sum: { $cond: [{ $in: ['$status', ['absent', 'miss_punch']] }, 1, 0] } },
                lateIns: { $sum: { $cond: [{ $eq: ['$status', 'late_in'] }, 1, 0] } },
                minutes: { $sum: '$totalMinutes' },
              },
            },
          ],
          as: 'a',
        },
      },
      { $addFields: { a: { $first: '$a' } } },
      {
        $project: {
          _id: 0,
          empCode: 1,
          name: 1,
          department: { $ifNull: [{ $first: '$dept.name' }, null] },
          present: { $ifNull: ['$a.present', 0] },
          halfDays: { $ifNull: ['$a.halfDays', 0] },
          leaves: { $ifNull: ['$a.leaves', 0] },
          absent: { $ifNull: ['$a.absent', 0] },
          lateIns: { $ifNull: ['$a.lateIns', 0] },
          totalHours: { $round: [{ $divide: [{ $ifNull: ['$a.minutes', 0] }, 60] }, 1] },
        },
      },
      { $sort: { name: 1 } },
    ]);

    ok(res, rows, { month, year, period: `${MONTH_NAMES[month - 1]} ${year}` });
  }),
);

router.get(
  '/reports/leave-balances',
  asyncHandler(async (_req, res) => {
    const rows = await LeaveBalance.find()
      .populate({ path: 'employeeId', select: 'name empCode status' })
      .populate({ path: 'leaveTypeId', select: 'code sortOrder' })
      .lean();

    const report = rows
      .filter((b) => b.employeeId && b.employeeId.status !== 'exited' && b.leaveTypeId)
      .sort(
        (a, b) =>
          a.employeeId.name.localeCompare(b.employeeId.name) ||
          (a.leaveTypeId.sortOrder ?? 0) - (b.leaveTypeId.sortOrder ?? 0),
      )
      .map((b) => ({
        empCode: b.employeeId.empCode,
        name: b.employeeId.name,
        leaveType: b.leaveTypeId.code,
        total: b.allotted + b.carriedForward,
        used: b.used,
        available: b.allotted + b.carriedForward - b.used,
      }));

    ok(res, report);
  }),
);

router.get(
  '/reports/payroll-trend',
  asyncHandler(async (_req, res) => {
    const rows = await PayrollRun.find({ status: { $in: ['processed', 'locked', 'published'] } })
      .sort({ payYear: 1, payMonth: 1 })
      .lean();

    ok(
      res,
      rows.map((r) => ({
        month: r.payMonth,
        year: r.payYear,
        totalNet: r.totalNet,
        employees: r.employeeCount,
        period: `${MONTH_NAMES[r.payMonth - 1]} ${r.payYear}`,
      })),
    );
  }),
);

export default router;
