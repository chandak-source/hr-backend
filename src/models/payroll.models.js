import mongoose from 'mongoose';

import { dateField, schemaOptions } from './base.js';

const payrollRunSchema = new mongoose.Schema(
  {
    payMonth: { type: Number, required: true, min: 1, max: 12 },
    payYear: { type: Number, required: true, min: 2000, max: 2100 },
    status: {
      type: String,
      enum: ['draft', 'processed', 'locked', 'published'],
      default: 'draft',
      index: true,
    },
    employeeCount: { type: Number, default: 0 },
    totalGross: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    totalNet: { type: Number, default: 0 },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    processedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  schemaOptions(),
);

payrollRunSchema.index({ payMonth: 1, payYear: 1 }, { unique: true });
payrollRunSchema.index({ payYear: -1, payMonth: -1 });

/**
 * Earnings and deductions are embedded rather than kept in their own
 * collection: they are only ever read as part of their payslip, never queried
 * across payslips, and there are ~8 of them per slip.
 */
const componentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, maxlength: 80 },
    type: { type: String, enum: ['earning', 'deduction'], required: true },
    amount: { type: Number, required: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const payslipSchema = new mongoose.Schema(
  {
    payrollRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    paidDays: { type: Number, required: true },
    lopDays: { type: Number, default: 0 },
    gross: { type: Number, required: true },
    deductions: { type: Number, required: true },
    net: { type: Number, required: true },
    bankAccount: { type: String, default: null, maxlength: 30 },
    creditedOn: dateField({ default: null }),
    pdfPath: { type: String, default: null },
    components: { type: [componentSchema], default: [] },
  },
  schemaOptions(),
);

payslipSchema.index({ payrollRunId: 1, employeeId: 1 }, { unique: true });

export const PayrollRun = mongoose.model('PayrollRun', payrollRunSchema);
export const Payslip = mongoose.model('Payslip', payslipSchema);
