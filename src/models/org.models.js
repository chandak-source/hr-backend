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

const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 60 },
    startTime: timeField({ required: true }),
    endTime: timeField({ required: true }),
    graceMinutes: { type: Number, default: 15, min: 0 },
    halfDayAfter: timeField({ default: null }),
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
