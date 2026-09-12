import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import { pingDatabase } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import adminRoutes from './routes/admin.routes.js';
import approvalsRoutes from './routes/approvals.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import authRoutes from './routes/auth.routes.js';
import leaveRoutes from './routes/leave.routes.js';
import payrollRoutes from './routes/payroll.routes.js';
import teamRoutes from './routes/team.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.use(
    `${env.apiPrefix}/auth`,
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-8' }),
  );

  app.get('/health', async (_req, res) => {
    try {
      await pingDatabase();
      res.json({ status: 'ok', database: 'up', uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/attendance', attendanceRoutes);
  api.use('/leave', leaveRoutes);
  api.use('/payroll', payrollRoutes);
  api.use('/team', teamRoutes);
  api.use('/approvals', approvalsRoutes);
  api.use('/admin', adminRoutes);
  api.use('/', workspaceRoutes); // expenses, tasks, holidays, announcements, notifications, directory

  app.use(env.apiPrefix, api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
