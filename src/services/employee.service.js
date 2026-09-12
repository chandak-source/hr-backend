import mongoose from 'mongoose';

import { Employee } from '../models/index.js';

/**
 * The "employee shaped" response used by /auth/me, the directory and the admin
 * employee list. This is the aggregation equivalent of the four LEFT JOINs the
 * SQL build used (department, location, shift, reporting manager).
 *
 * `withPasswordHash` is only ever true for the login lookup.
 */
export const employeePipeline = ({ withPasswordHash = false } = {}) => [
  { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'dept' } },
  { $lookup: { from: 'locations', localField: 'locationId', foreignField: '_id', as: 'loc' } },
  { $lookup: { from: 'shifts', localField: 'shiftId', foreignField: '_id', as: 'shft' } },
  { $lookup: { from: 'employees', localField: 'reportingTo', foreignField: '_id', as: 'mgr' } },
  {
    $project: {
      _id: 0,
      id: { $toString: '$_id' },
      empCode: 1,
      name: 1,
      email: 1,
      phone: 1,
      role: 1,
      designation: 1,
      status: 1,
      dateOfJoining: 1,
      pan: 1,
      uan: 1,
      bankName: 1,
      bankAccount: 1,
      ...(withPasswordHash ? { passwordHash: 1 } : {}),
      department: { $ifNull: [{ $first: '$dept.name' }, null] },
      location: { $ifNull: [{ $first: '$loc.name' }, null] },
      reportingTo: { $ifNull: [{ $first: '$mgr.name' }, null] },
      reportingToId: { $ifNull: [{ $toString: { $first: '$mgr._id' } }, null] },
      // "General • 09:30 - 18:30"
      shift: {
        $let: {
          vars: { s: { $first: '$shft' } },
          in: {
            $cond: [
              { $ifNull: ['$$s', false] },
              {
                $concat: [
                  '$$s.name',
                  ' • ',
                  { $substrBytes: ['$$s.startTime', 0, 5] },
                  ' - ',
                  { $substrBytes: ['$$s.endTime', 0, 5] },
                ],
              },
              null,
            ],
          },
        },
      },
    },
  },
];

/** Run the employee pipeline behind a `$match`, returning plain objects. */
export async function findEmployees(match, { sort, limit, withPasswordHash } = {}) {
  const pipeline = [{ $match: match }, ...employeePipeline({ withPasswordHash })];
  if (sort) pipeline.push({ $sort: sort });
  if (limit) pipeline.push({ $limit: limit });
  return Employee.aggregate(pipeline);
}

export async function getEmployeeById(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const [row] = await findEmployees({ _id: new mongoose.Types.ObjectId(String(id)) });
  return row ?? null;
}

export async function getEmployeeByEmail(email) {
  const [row] = await findEmployees({ email }, { withPasswordHash: true });
  return row ?? null;
}

/** Resolve an emp_code to an _id, or null. */
export async function idForEmpCode(empCode) {
  const row = await Employee.findOne({ empCode }).select('_id').lean();
  return row?._id ?? null;
}

/**
 * Who a request may act on: admins see everyone, managers only their direct
 * reports. Returns a filter fragment to spread into a query.
 */
export const reportingScope = (user) =>
  user.role === 'admin' ? {} : { reportingTo: user._id };
