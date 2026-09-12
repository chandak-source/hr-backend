import mongoose from 'mongoose';

import { dateField, schemaOptions } from './base.js';
import { REQUEST_STATUS } from './leave.models.js';

const expenseCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, maxlength: 60 },
    maxLimit: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  schemaOptions(),
);

const expenseClaimSchema = new mongoose.Schema(
  {
    claimCode: { type: String, required: true, unique: true, maxlength: 20 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExpenseCategory', required: true },
    amount: { type: Number, required: true, min: 0 },
    expenseDate: dateField({ required: true }),
    note: { type: String, required: true, maxlength: 500 },
    receiptPath: { type: String, default: null },
    status: { type: String, enum: REQUEST_STATUS, default: 'pending', index: true },
    approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    actionOn: { type: Date, default: null },
    actionRemark: { type: String, default: null, maxlength: 255 },
    reimbursedOn: dateField({ default: null }),
  },
  schemaOptions(),
);

export const ExpenseCategory = mongoose.model('ExpenseCategory', expenseCategorySchema);
export const ExpenseClaim = mongoose.model('ExpenseClaim', expenseClaimSchema);
