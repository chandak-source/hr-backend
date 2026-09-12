import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import { Attendance, Employee } from '../models/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { reportingScope } from '../services/employee.service.js';
import {
  asyncHandler,
  daysAgoString,
  monthFilter,
  ok,
  parseWith,
  searchFilter,
  todayString,
} from '../utils/helpers.js';

const router = Router();
router.use(authenticate, requireRole('manager'));

/** Admins see the whole org, managers only their direct reports. */
const scopeFilter = (user) => ({ ...reportingScope(user), status: { $ne: 'exited' } });

/** Attaches the employee's attendance row for `date`, or nothing. */
const attendanceOn = (date) => [
  {
    $lookup: {
      from: 'attendances',
      let: { eid: '$_id' },
      pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$employeeId', '$$eid'] }, { $eq: ['$workDate', date] }] } } },
        { $limit: 1 },
      ],
      as: 'att',
    },
  },
  { $addFields: { att: { $first: '$att' } } },
];

const MEMBER_PROJECT = {
  _id: 0,
  id: { $toString: '$_id' },
  empCode: 1,
  name: 1,
  designation: 1,
  phone: 1,
  email: 1,
  department: { $ifNull: [{ $first: '$dept.name' }, null] },
  todayStatus: { $ifNull: ['$att.status', 'absent'] },
  inTime: { $ifNull: ['$att.punchIn', null] },
  outTime: { $ifNull: ['$att.punchOut', null] },
  workMode: { $ifNull: ['$att.workMode', null] },
};

const withDepartment = {
  $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'dept' },
};

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
    const match = { ...scopeFilter(req.user) };
    if (q) Object.assign(match, searchFilter(q, ['name', 'empCode']));

    const rows = await Employee.aggregate([
      { $match: match },
      withDepartment,
      ...attendanceOn(on),
      { $project: MEMBER_PROJECT },
      // Filtering on todayStatus has to happen after the projection computes it.
      ...(status && status !== 'all' ? [{ $match: { todayStatus: status } }] : []),
      { $sort: { name: 1 } },
    ]);

    ok(res, rows, { date: on, count: rows.length });
  }),
);

// GET /team/stats -------------------------------------------------------------
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const on = req.query.date ?? todayString();

    const rows = await Employee.aggregate([
      { $match: scopeFilter(req.user) },
      ...attendanceOn(on),
      { $addFields: { todayStatus: { $ifNull: ['$att.status', 'absent'] } } },
      { $group: { _id: '$todayStatus', total: { $sum: 1 } } },
    ]);

    const by = Object.fromEntries(rows.map((r) => [r._id, r.total]));
    const size = rows.reduce((s, r) => s + r.total, 0);
    const present = (by.present ?? 0) + (by.late_in ?? 0) + (by.half_day ?? 0);

    ok(res, {
      date: on,
      teamSize: size,
      present,
      lateIn: by.late_in ?? 0,
      onLeave: by.leave ?? 0,
      absent: by.absent ?? 0,
      weekOff: by.week_off ?? 0,
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

    const scoped = await Employee.find(scopeFilter(req.user)).select('_id').lean();
    const ids = scoped.map((e) => e._id);

    const rows = await Attendance.aggregate([
      { $match: { employeeId: { $in: ids }, workDate: { $gte: daysAgoString(days) } } },
      {
        $group: {
          _id: '$workDate',
          total: { $sum: 1 },
          present: {
            $sum: { $cond: [{ $in: ['$status', ['present', 'late_in', 'half_day']] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          date: '$_id',
          percent: {
            $cond: [
              { $gt: ['$total', 0] },
              { $round: [{ $multiply: [100, { $divide: ['$present', '$total'] }] }, 0] },
              null,
            ],
          },
        },
      },
      { $sort: { date: 1 } },
    ]);

    ok(res, rows);
  }),
);

// GET /team/members/:id -------------------------------------------------------
router.get(
  '/members/:id',
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      throw ApiError.notFound('Team member not found in your reporting line');
    }
    const memberId = new mongoose.Types.ObjectId(String(req.params.id));

    const [member] = await Employee.aggregate([
      { $match: { _id: memberId, ...scopeFilter(req.user) } },
      withDepartment,
      ...attendanceOn(todayString()),
      { $project: { ...MEMBER_PROJECT, dateOfJoining: 1 } },
    ]);
    if (!member) throw ApiError.notFound('Team member not found in your reporting line');

    const now = new Date();
    const [mtd] = await Attendance.aggregate([
      {
        $match: {
          employeeId: memberId,
          workDate: monthFilter(now.getMonth() + 1, now.getFullYear()),
        },
      },
      {
        $group: {
          _id: null,
          present: { $sum: { $cond: [{ $in: ['$status', ['present', 'late_in']] }, 1, 0] } },
          leaves: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
          lateMarks: { $sum: { $cond: [{ $eq: ['$status', 'late_in'] }, 1, 0] } },
          absents: { $sum: { $cond: [{ $in: ['$status', ['absent', 'miss_punch']] }, 1, 0] } },
        },
      },
      { $project: { _id: 0 } },
    ]);

    ok(res, {
      ...member,
      monthToDate: mtd ?? { present: 0, leaves: 0, lateMarks: 0, absents: 0 },
    });
  }),
);

export default router;
