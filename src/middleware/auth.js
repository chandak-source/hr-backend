import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { Employee } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/helpers.js';

/**
 * Verifies the bearer token and attaches `req.user`.
 *
 * `req.user._id` is the ObjectId to query with; `req.user.id` is its string
 * form for responses.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw ApiError.unauthorized('Bearer token missing');

  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.jwt.secret);
  } catch {
    throw ApiError.unauthorized('Token is invalid or has expired');
  }

  if (!mongoose.isValidObjectId(payload.sub)) throw ApiError.unauthorized('Malformed token subject');

  const user = await Employee.findById(payload.sub)
    .select('empCode name email role status departmentId reportingTo')
    .lean();

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status === 'exited') throw ApiError.forbidden('This account has been deactivated');

  req.user = { ...user, id: user._id.toString() };
  next();
});

/** Restricts a route to one or more roles. Admin always passes. */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    return next(ApiError.forbidden(`Requires role: ${roles.join(' or ')}`));
  };

/** Manager-or-admin guard for approval routes. */
export const requireApprover = requireRole('manager');
