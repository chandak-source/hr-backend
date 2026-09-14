import mongoose from 'mongoose';

import { dateField, schemaOptions, timeField } from './base.js';

export const ATTENDANCE_STATUS = [
  'present', 'absent', 'week_off', 'holiday', 'leave',
  'quarter_day', 'half_day', 'late_in', 'miss_punch',
];

export const WORK_MODES = ['office', 'wfh', 'client_site', 'on_duty'];

const attendanceSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    workDate: dateField({ required: true }),
    punchIn: timeField({ default: null }),
    punchOut: timeField({ default: null }),
    totalMinutes: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ATTENDANCE_STATUS, default: 'absent', index: true },
    workMode: { type: String, enum: [...WORK_MODES, null], default: null },
    inLocation: { type: String, default: null, maxlength: 120 },
    outLocation: { type: String, default: null, maxlength: 120 },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    isRegularized: { type: Boolean, default: false },
    remark: { type: String, default: null, maxlength: 255 },
  },
  schemaOptions(),
);

// One row per employee per day — the punch and approval flows rely on this.
attendanceSchema.index({ employeeId: 1, workDate: 1 }, { unique: true });
attendanceSchema.index({ workDate: 1 });

const punchLogSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    punchedAt: { type: Date, required: true },
    punchType: { type: String, enum: ['in', 'out'], required: true },
    workMode: { type: String, enum: WORK_MODES, default: 'office' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    address: { type: String, default: null, maxlength: 255 },
    source: { type: String, enum: ['mobile', 'web', 'biometric'], default: 'mobile' },
  },
  schemaOptions(),
);

punchLogSchema.index({ employeeId: 1, punchedAt: -1 });

const regularizationSchema = new mongoose.Schema(
  {
    requestCode: { type: String, required: true, unique: true, maxlength: 20 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    workDate: dateField({ required: true }),
    punchIn: timeField({ required: true }),
    punchOut: timeField({ required: true }),
    reason: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    actionOn: { type: Date, default: null },
    actionRemark: { type: String, default: null, maxlength: 255 },
  },
  schemaOptions(),
);

export const Attendance = mongoose.model('Attendance', attendanceSchema);
export const PunchLog = mongoose.model('PunchLog', punchLogSchema);
export const RegularizationRequest = mongoose.model('RegularizationRequest', regularizationSchema);
