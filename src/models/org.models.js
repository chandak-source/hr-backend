import mongoose from 'mongoose';

import { schemaOptions, timeField } from './base.js';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, unique: true, trim: true, maxlength: 20 },
    headId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  },
  schemaOptions(),
);

/**
 * A shift is also the attendance policy for everyone assigned to it. HR edits
 * these values from Admin → Attendance Policy and every calculation — punch,
 * regularization and payroll LOP — reads them on the next evaluation, so the
 * rules change without a code change.
 *
 * The values below are starting points for a fresh database, not business
 * rules: nothing outside this schema assumes a particular time or threshold.
 */
const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },

    /** Shift start and end. Wrapping past midnight is supported (night shift). */
    startTime: timeField({ required: true }),
    endTime: timeField({ required: true }),

    /** Arriving within this many minutes of `startTime` is still on time. */
    graceMinutes: { type: Number, default: 15, min: 0, max: 240 },

    /** Arriving after this clock time costs a quarter day. */
    quarterDayAfter: timeField({ default: null }),

    /** Arriving after this clock time costs half a day. */
    halfDayAfter: timeField({ default: null }),

    /** Minutes that have to be worked to earn a full day's credit. */
    fullDayMinutes: { type: Number, default: 540, min: 60, max: 1440 },
  },
  schemaOptions(),
);

const locationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    address: { type: String, default: null, maxlength: 255 },
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
    geofenceRadiusM: { type: Number, default: 200, min: 0 },
  },
  schemaOptions(),
);

export const Department = mongoose.model('Department', departmentSchema);
export const Shift = mongoose.model('Shift', shiftSchema);
export const Location = mongoose.model('Location', locationSchema);
