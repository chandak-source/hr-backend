import { Counter } from '../models/index.js';

/**
 * Bases that keep the generated codes continuing from where the MySQL build
 * left off (LV-2310, RG-312, EX-790, T-401, EMP1170).
 */
export const SEQUENCE_BASES = {
  leaveRequest: 2310,
  regularization: 312,
  expenseClaim: 790,
  // 402, not 401: the seeder hand-writes T-401 and taskCode is unique.
  task: 402,
  employee: 1170,
};

/**
 * Atomically reserve the next number in a sequence.
 *
 * `$inc` with `upsert` is a single round trip and cannot hand the same value to
 * two concurrent callers, unlike the `SELECT COUNT(*) + offset` this replaced.
 */
export async function nextSequence(key, session = null) {
  const base = SEQUENCE_BASES[key] ?? 1;
  const query = Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 }, $setOnInsert: { _id: key } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  );
  if (session) query.session(session);
  const counter = await query.lean();
  return base + counter.seq - 1;
}

/** e.g. nextCode('LV-', 'leaveRequest') -> 'LV-2310' */
export async function nextCode(prefix, key, session = null) {
  return `${prefix}${await nextSequence(key, session)}`;
}

/**
 * Point a counter at a known value — used by the seeder so codes it inserts by
 * hand don't collide with codes the API generates later.
 */
export async function setSequence(key, used) {
  await Counter.findByIdAndUpdate(key, { seq: used }, { upsert: true });
}
