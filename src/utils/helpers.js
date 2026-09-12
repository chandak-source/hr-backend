import { ApiError } from './ApiError.js';

/** Wrap an async route handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Uniform success envelope: { success, data, meta? }. */
export const ok = (res, data, meta) =>
  res.json(meta ? { success: true, data, meta } : { success: true, data });

export const created = (res, data) => res.status(201).json({ success: true, data });

/** Validate a body/query/params object with a zod schema. */
export function parseWith(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw ApiError.unprocessable('Validation failed', details);
  }
  return result.data;
}

// ------------------------------------------------------------------ dates --
export const toDateString = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const todayString = () => toDateString(new Date());

export const toTimeString = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const daysBetweenInclusive = (from, to) => {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b - a) / 86400000) + 1;
};

export const minutesBetween = (start, end) => {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
};

export const daysInMonth = (month, year) => new Date(year, month, 0).getDate();

/** Indian financial year label for a date, e.g. "2026-2027". */
export const financialYearOf = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  return d.getMonth() + 1 >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};

/** Sunday off + 2nd/4th Saturday off — the pattern used across the app. */
export const isWeekOff = (dateString) => {
  const d = new Date(`${dateString}T00:00:00`);
  const day = d.getDay();
  if (day === 0) return true;
  if (day === 6) {
    const nth = Math.ceil(d.getDate() / 7);
    return nth === 2 || nth === 4;
  }
  return false;
};

/** Sequential business code, e.g. nextCode('LV', 2291) -> 'LV-2292'. */
export const buildCode = (prefix, seq) => `${prefix}-${seq}`;

export const round2 = (n) => Math.round(Number(n) * 100) / 100;
