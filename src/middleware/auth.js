import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';
import { queryOne } from '../config/db.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/helpers.js';

/** Verifies the bearer token and attaches `req.user`. */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) throw ApiError.unauthorized('Bearer token missing');

  let payload;
  try {
    payload = jwt.verify(header.slice(7), env.jwt.secret);
  } catch {
    throw ApiError.unauthorized('Token is invalid or has expired');
  }

  const user = await queryOne(
    `SELECT e.id, e.emp_code, e.name, e.email, e.role, e.status, e.department_id, e.reporting_to
       FROM employees e WHERE e.id = ?`,
    [payload.sub],
  );

  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status === 'exited') throw ApiError.forbidden('This account has been deactivated');

  req.user = user;
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
