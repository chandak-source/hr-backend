import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { withTransaction } from '../config/db.js';
import { Employee, RefreshToken } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, created, ok, parseWith, todayString } from '../utils/helpers.js';
import { getEmployeeByEmail, getEmployeeById } from '../services/employee.service.js';
import { provisionEmployee, SIGNUP_DEFAULT_CTC } from '../services/provisioning.service.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

const signupSchema = z.object({
  name: z.string().trim().min(3, 'Name must be at least 3 characters').max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .refine((v) => v.endsWith(env.allowedEmailDomain), {
      message: `Only ${env.allowedEmailDomain} email addresses are allowed`,
    }),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['employee', 'manager', 'admin']),
  designation: z.string().trim().min(2, 'Designation is required').max(120),
});

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, code: user.empCode }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

async function issueRefreshToken(employeeId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.jwt.refreshDays);
  await RefreshToken.create({ employeeId, token, expiresAt });
  return token;
}

const publicUser = ({ passwordHash, ...user }) => user;

// POST /auth/signup
//
// Self-registration. The role is whatever the caller picks, which is a
// deliberate product decision: anyone with a company address can register as an
// admin. Tighten it by making new accounts inactive until an admin approves.
router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const body = parseWith(signupSchema, req.body);

    // Same provisioning path as an admin-created account: salary structure,
    // leave balances and a starting attendance history.
    const employee = await withTransaction((session) =>
      provisionEmployee(
        {
          name: body.name,
          email: body.email,
          password: body.password,
          role: body.role,
          designation: body.designation,
          // An admin assigns the department and the real CTC afterwards.
          departmentId: null,
          dateOfJoining: todayString(),
          annualCtc: SIGNUP_DEFAULT_CTC,
        },
        session,
      ),
    );

    // Sign them straight in — same payload shape as /auth/login.
    const user = await getEmployeeById(employee._id);
    created(res, {
      token: signAccessToken(user),
      refreshToken: await issueRefreshToken(user.id),
      expiresIn: env.jwt.expiresIn,
      user,
    });
  }),
);

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

    // Rotate: the presented token is consumed whether or not it was valid.
    const row = await RefreshToken.findOneAndUpdate(
      { token: refreshToken, revokedAt: null, expiresAt: { $gt: new Date() } },
      { revokedAt: new Date() },
    ).lean();
    if (!row) throw ApiError.unauthorized('Refresh token is invalid or expired');

    const user = await getEmployeeById(row.employeeId);
    if (!user) throw ApiError.unauthorized('Account no longer exists');

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
    await RefreshToken.updateMany(
      { employeeId: req.user._id, revokedAt: null },
      { revokedAt: new Date() },
    );
    ok(res, { message: 'Signed out' });
  }),
);

// GET /auth/me
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await getEmployeeById(req.user._id))),
);

// POST /auth/change-password
router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parseWith(changePasswordSchema, req.body);

    const row = await Employee.findById(req.user._id).select('+passwordHash').lean();
    const matches = await bcrypt.compare(currentPassword, row.passwordHash);
    if (!matches) throw ApiError.badRequest('Current password is incorrect');

    await Employee.updateOne(
      { _id: req.user._id },
      { passwordHash: await bcrypt.hash(newPassword, 10) },
    );
    await RefreshToken.updateMany(
      { employeeId: req.user._id, revokedAt: null },
      { revokedAt: new Date() },
    );

    ok(res, { message: 'Password updated — please sign in again' });
  }),
);

export default router;
