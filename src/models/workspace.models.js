import mongoose from 'mongoose';

import { dateField, schemaOptions } from './base.js';

const taskSchema = new mongoose.Schema(
  {
    taskCode: { type: String, required: true, unique: true, maxlength: 20 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    title: { type: String, required: true, maxlength: 180 },
    project: { type: String, required: true, maxlength: 120 },
    dueDate: dateField({ required: true }),
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    progress: { type: Number, default: 0, min: 0, max: 1 },
    isDone: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  schemaOptions(),
);

taskSchema.index({ employeeId: 1, isDone: 1 });

const holidaySchema = new mongoose.Schema(
  {
    holidayDate: dateField({ required: true }),
    name: { type: String, required: true, maxlength: 120 },
    type: { type: String, enum: ['national', 'festival', 'optional'], default: 'festival' },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
  },
  schemaOptions(),
);

holidaySchema.index({ holidayDate: 1, name: 1 }, { unique: true });

const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 180 },
    body: { type: String, required: true },
    category: {
      type: String,
      enum: ['Event', 'Policy', 'HR Update', 'Celebration'],
      default: 'HR Update',
    },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    publishedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  schemaOptions(),
);

announcementSchema.index({ isActive: 1, publishedAt: -1 });

const notificationSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    title: { type: String, required: true, maxlength: 180 },
    subtitle: { type: String, required: true, maxlength: 400 },
    kind: {
      type: String,
      enum: ['leave', 'payroll', 'attendance', 'task', 'expense', 'general'],
      default: 'general',
    },
    isRead: { type: Boolean, default: false },
  },
  schemaOptions(),
);

notificationSchema.index({ employeeId: 1, isRead: 1 });
notificationSchema.index({ employeeId: 1, createdAt: -1 });

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    action: { type: String, required: true, maxlength: 80 },
    entity: { type: String, required: true, maxlength: 60 },
    entityId: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  schemaOptions(),
);

auditLogSchema.index({ entity: 1, entityId: 1 });

/**
 * Atomic sequence source for the business codes (LV-2310, EX-790, EMP1170…).
 * The MySQL build derived these from `SELECT COUNT(*)`, which hands two
 * concurrent requests the same number; `$inc` cannot.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export const Task = mongoose.model('Task', taskSchema);
export const Holiday = mongoose.model('Holiday', holidaySchema);
export const Announcement = mongoose.model('Announcement', announcementSchema);
export const Notification = mongoose.model('Notification', notificationSchema);
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
export const Counter = mongoose.model('Counter', counterSchema);
