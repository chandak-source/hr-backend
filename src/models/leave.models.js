import mongoose from 'mongoose';

import { dateField, schemaOptions } from './base.js';

export const REQUEST_STATUS = ['pending', 'approved', 'rejected', 'cancelled'];

const leaveTypeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, maxlength: 10 },
    name: { type: String, required: true, maxlength: 80 },
    annualQuota: { type: Number, default: 0 },
    isPaid: { type: Boolean, default: true },
    requiresProof: { type: Boolean, default: false },
    color: { type: String, default: '#1B3C8C' },
    isActive: { type: Boolean, default: true },
    // Preserves the display order the seeder defines (SQL ordered by id).
    sortOrder: { type: Number, default: 0 },
  },
  schemaOptions(),
);

const leaveBalanceSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    financialYear: { type: String, required: true, maxlength: 9 },
    allotted: { type: Number, default: 0 },
    used: { type: Number, default: 0 },
    carriedForward: { type: Number, default: 0 },
  },
  schemaOptions(),
);

leaveBalanceSchema.index(
  { employeeId: 1, leaveTypeId: 1, financialYear: 1 },
  { unique: true },
);

const leaveRequestSchema = new mongoose.Schema(
  {
    requestCode: { type: String, required: true, unique: true, maxlength: 20 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    fromDate: dateField({ required: true }),
    toDate: dateField({ required: true }),
    dayType: {
      type: String,
      enum: ['full_day', 'first_half', 'second_half'],
      default: 'full_day',
    },
    days: { type: Number, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: REQUEST_STATUS, default: 'pending', index: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    appliedOn: dateField({ required: true }),
    actionOn: { type: Date, default: null },
    actionRemark: { type: String, default: null, maxlength: 255 },
    attachmentPath: { type: String, default: null },
  },
  schemaOptions(),
);

leaveRequestSchema.index({ fromDate: 1, toDate: 1 });

export const LeaveType = mongoose.model('LeaveType', leaveTypeSchema);
export const LeaveBalance = mongoose.model('LeaveBalance', leaveBalanceSchema);
export const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);
