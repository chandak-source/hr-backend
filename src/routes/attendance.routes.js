import { Router } from 'express';
import { z } from 'zod';

import { Attendance, Employee, PunchLog, RegularizationRequest } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { nextCode } from '../services/sequence.service.js';
import {
  evaluateAttendance,
  policyForEmployee,
} from '../services/attendance-policy.service.js';
import {
  asyncHandler,
  created,
  monthFilter,
  ok,
  parseWith,
  todayString,
  toTimeString,
} from '../utils/helpers.js';

const router = Router();
router.use(authenticate);

/** The attendance row shape every endpoint here returns. */
const toAttendance = (d) =>
  d && {
    id: d._id.toString(),
    date: d.workDate,
    punchIn: d.punchIn,
    punchOut: d.punchOut,
    totalMinutes: d.totalMinutes,
    status: d.status,
    workMode: d.workMode,
    inLocation: d.inLocation,
    isRegularized: d.isRegularized,
  };

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
    const row = await Attendance.findOne({
      employeeId: req.user._id,
      workDate: todayString(),
    }).lean();

    ok(res, {
      date: todayString(),
      isPunchedIn: Boolean(row?.punchIn && !row?.punchOut),
      record: toAttendance(row),
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

    const existing = await Attendance.findOne({ employeeId: req.user._id, workDate: date }).lean();
    if (existing?.punchIn && !existing?.punchOut) {
      throw ApiError.conflict('You are already punched in');
    }

    // Graded against the employee's own shift — HR owns every threshold.
    const policy = await policyForEmployee(req.user._id);
    const verdict = evaluateAttendance({ policy, punchIn: time, punchOut: null });

    await Attendance.updateOne(
      { employeeId: req.user._id, workDate: date },
      {
        $set: {
          punchIn: time,
          punchOut: null,
          totalMinutes: 0,
          status: verdict.status,
          workMode: body.workMode,
          inLocation: body.address ?? null,
          shiftId: policy.id,
        },
      },
      { upsert: true },
    );

    await PunchLog.create({
      employeeId: req.user._id,
      punchedAt: new Date(`${date}T${time}`),
      punchType: 'in',
      workMode: body.workMode,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      address: body.address ?? null,
    });

    created(res, {
      date,
      punchIn: time,
      status: verdict.status,
      workMode: body.workMode,
      lateByMinutes: verdict.lateByMinutes,
      shift: policy.name,
      reason: verdict.reason,
    });
  }),
);

// POST /attendance/punch-out --------------------------------------------------
router.post(
  '/punch-out',
  asyncHandler(async (req, res) => {
    const date = todayString();
    const time = toTimeString();

    const row = await Attendance.findOne({ employeeId: req.user._id, workDate: date }).lean();
    if (!row?.punchIn) throw ApiError.badRequest('Punch in first');
    if (row.punchOut) throw ApiError.conflict('You have already punched out today');

    // Now that both punches exist the day gets its final grade: how late the
    // arrival was and how much of the required day was worked, whichever is
    // worse. Every threshold is HR's, none of them is in this file.
    const policy = await policyForEmployee(req.user._id);
    const verdict = evaluateAttendance({ policy, punchIn: row.punchIn, punchOut: time });
    const minutes = verdict.workedMinutes;

    await Attendance.updateOne(
      { _id: row._id },
      { $set: { punchOut: time, totalMinutes: minutes, status: verdict.status } },
    );
    await PunchLog.create({
      employeeId: req.user._id,
      punchedAt: new Date(`${date}T${time}`),
      punchType: 'out',
      workMode: row.workMode ?? 'office',
    });

    ok(res, {
      date,
      punchIn: row.punchIn,
      punchOut: time,
      totalMinutes: minutes,
      totalHours: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      status: verdict.status,
      lateByMinutes: verdict.lateByMinutes,
      shortfallMinutes: verdict.shortfallMinutes,
      lopFactor: verdict.lopFactor,
      reason: verdict.reason,
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

    const filter = { employeeId: req.user._id };
    if (from || to) {
      filter.workDate = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    }
    if (status) filter.status = status;

    const rows = await Attendance.find(filter).sort({ workDate: -1 }).limit(limit).lean();
    ok(res, rows.map(toAttendance), { count: rows.length });
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

    const rows = await Attendance.aggregate([
      { $match: { employeeId: req.user._id, workDate: monthFilter(month, year) } },
      { $group: { _id: '$status', total: { $sum: 1 }, minutes: { $sum: '$totalMinutes' } } },
    ]);

    const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.total]));
    const workedMinutes = rows.reduce((s, r) => s + Number(r.minutes), 0);
    const workedDays =
      (byStatus.present ?? 0) +
      (byStatus.late_in ?? 0) +
      (byStatus.quarter_day ?? 0) +
      (byStatus.half_day ?? 0);
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
      quarterDays: byStatus.quarter_day ?? 0,
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

    const rows = await Attendance.find({
      employeeId: req.user._id,
      workDate: monthFilter(month, year),
    })
      .sort({ workDate: 1 })
      .lean();

    ok(res, rows.map(toAttendance), { month, year, count: rows.length });
  }),
);

// Regularization --------------------------------------------------------------
router.get(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const rows = await RegularizationRequest.find({ employeeId: req.user._id })
      .sort({ createdAt: -1 })
      .populate('approverId', 'name')
      .lean();

    ok(
      res,
      rows.map((r) => ({
        id: r._id.toString(),
        code: r.requestCode,
        date: r.workDate,
        punchIn: r.punchIn,
        punchOut: r.punchOut,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
        approver: r.approverId?.name ?? null,
      })),
    );
  }),
);

router.post(
  '/regularizations',
  asyncHandler(async (req, res) => {
    const body = parseWith(regularizeSchema, req.body);

    const duplicate = await RegularizationRequest.exists({
      employeeId: req.user._id,
      workDate: body.date,
      status: 'pending',
    });
    if (duplicate) throw ApiError.conflict('A pending request already exists for this date');

    const doc = await RegularizationRequest.create({
      requestCode: await nextCode('RG-', 'regularization'),
      employeeId: req.user._id,
      workDate: body.date,
      punchIn: withSeconds(body.punchIn),
      punchOut: withSeconds(body.punchOut),
      reason: body.reason,
      approverId: req.user.reportingTo ?? null,
    });

    created(res, { id: doc.id, code: doc.requestCode, status: doc.status, ...body });
  }),
);

export default router;
