import mongoose from 'mongoose';

import { dateField, schemaOptions } from './base.js';

const employeeSchema = new mongoose.Schema(
  {
    empCode: { type: String, required: true, unique: true, trim: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 160 },
    phone: { type: String, default: null, maxlength: 20 },
    // Never leaves the server: `select: false` keeps it out of every read that
    // doesn't ask for it explicitly.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['employee', 'manager', 'admin'], default: 'employee', index: true },
    designation: { type: String, required: true, trim: true, maxlength: 120 },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    reportingTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    dateOfJoining: dateField({ required: true }),
    dateOfBirth: dateField({ default: null }),
    gender: { type: String, enum: ['male', 'female', 'other', null], default: null },
    status: { type: String, enum: ['active', 'on_notice', 'exited'], default: 'active', index: true },
    exitDate: dateField({ default: null }),
    pan: { type: String, default: null, maxlength: 15 },
    uan: { type: String, default: null, maxlength: 25 },
    bankName: { type: String, default: null, maxlength: 80 },
    bankAccount: { type: String, default: null, maxlength: 30 },
  },
  schemaOptions(),
);

// Backs the `q` search on the directory, team and admin employee lists.
employeeSchema.index({ name: 'text', empCode: 'text', designation: 'text' });

const refreshTokenSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  schemaOptions(),
);

// Mongo drops expired tokens on its own — no cleanup job needed.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const salaryStructureSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    effectiveFrom: dateField({ required: true }),
    annualCtc: { type: Number, required: true },
    basic: { type: Number, required: true },
    hra: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    isCurrent: { type: Boolean, default: true },
  },
  schemaOptions(),
);

salaryStructureSchema.index({ employeeId: 1, isCurrent: 1 });

export const Employee = mongoose.model('Employee', employeeSchema);
export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
export const SalaryStructure = mongoose.model('SalaryStructure', salaryStructureSchema);
