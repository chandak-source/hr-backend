import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { execute, queryOne } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, ok, parseWith } from '../utils/helpers.js';
import { getEmployeeByEmail, getEmployeeById } from '../services/employee.service.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, code: user.empCode }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

async function issueRefreshToken(employeeId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date();
  expires.setDate(expires.getDate() + env.jwt.refreshDays);
  await execute(
    'INSERT INTO refresh_tokens (employee_id, token, expires_at) VALUES (?,?,?)',
    [employeeId, token, expires.toISOString().slice(0, 19).replace('T', ' ')],
  );
  return token;
}

const publicUser = ({ passwordHash, ...user }) => user;

// POST /auth/login
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = parseWith(loginSchema, req.body);

    const user = await getEmployeeByEmail(email);
    if (!user) throw ApiError.unauthorized('Invalid email or password');
    if (user.status === 'exited') throw ApiError.forbidden('This account has been deactivated');

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) throw ApiError.unauthorized('Invalid email or password');

    ok(res, {
      token: signAccessToken(user),
      refreshToken: await issueRefreshToken(user.id),
      expiresIn: env.jwt.expiresIn,
      user: publicUser(user),
    });
  }),
);

// POST /auth/refresh
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = parseWith(
      z.object({ refreshToken: z.string().length(64) }),
      req.body,
    );

    const row = await queryOne(
      `SELECT employee_id AS employeeId FROM refresh_tokens
        WHERE token = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [refreshToken],
    );
    if (!row) throw ApiError.unauthorized('Refresh token is invalid or expired');

    const user = await getEmployeeById(row.employeeId);
    if (!user) throw ApiError.unauthorized('Account no longer exists');

    await execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = ?', [refreshToken]);

    ok(res, {
      token: signAccessToken(user),
      refreshToken: await issueRefreshToken(user.id),
      expiresIn: env.jwt.expiresIn,
      user,
    });
  }),
);

// POST /auth/logout
router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    await execute(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE employee_id = ? AND revoked_at IS NULL',
      [req.user.id],
    );
    ok(res, { message: 'Signed out' });
  }),
);

// GET /auth/me
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await getEmployeeById(req.user.id))),
);

// POST /auth/change-password
router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parseWith(changePasswordSchema, req.body);

    const row = await queryOne('SELECT password_hash AS hash FROM employees WHERE id = ?', [
      req.user.id,
    ]);
    const matches = await bcrypt.compare(currentPassword, row.hash);
    if (!matches) throw ApiError.badRequest('Current password is incorrect');

    await execute('UPDATE employees SET password_hash = ? WHERE id = ?', [
      await bcrypt.hash(newPassword, 10),
      req.user.id,
    ]);
    await execute(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE employee_id = ? AND revoked_at IS NULL',
      [req.user.id],
    );

    ok(res, { message: 'Password updated — please sign in again' });
  }),
);

export default router;
