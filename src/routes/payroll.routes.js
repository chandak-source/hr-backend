import { Router } from 'express';
import { z } from 'zod';

import { query, queryOne } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, ok, parseWith } from '../utils/helpers.js';
import { MONTH_NAMES } from '../services/payroll.service.js';

const router = Router();
router.use(authenticate);

const PAYSLIP_SELECT = `
  p.id,
  pr.pay_month  AS month,
  pr.pay_year   AS year,
  p.paid_days   AS paidDays,
  p.lop_days    AS lopDays,
  p.gross,
  p.deductions,
  p.net,
  p.bank_account AS bankAccount,
  p.credited_on  AS creditedOn,
  pr.status      AS runStatus
`;

const decorate = (row) =>
  row && { ...row, monthName: MONTH_NAMES[row.month - 1], period: `${MONTH_NAMES[row.month - 1]} ${row.year}` };

// GET /payroll/payslips -------------------------------------------------------
router.get(
  '/payslips',
  asyncHandler(async (req, res) => {
    const { year, limit } = parseWith(
      z.object({
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        limit: z.coerce.number().int().min(1).max(48).default(12),
      }),
      req.query,
    );

    const where = ['p.employee_id = ?', "pr.status IN ('locked','published')"];
    const params = [req.user.id];
    if (year) { where.push('pr.pay_year = ?'); params.push(year); }

    const rows = await query(
      `SELECT ${PAYSLIP_SELECT}
         FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
        WHERE ${where.join(' AND ')}
        ORDER BY pr.pay_year DESC, pr.pay_month DESC
        LIMIT ${limit}`,
      params,
    );
    ok(res, rows.map(decorate), { count: rows.length });
  }),
);

// GET /payroll/payslips/:id ---------------------------------------------------
router.get(
  '/payslips/:id',
  asyncHandler(async (req, res) => {
    const slip = await queryOne(
      `SELECT ${PAYSLIP_SELECT}, e.name AS employeeName, e.emp_code AS employeeCode,
              e.designation, e.uan, e.pan
         FROM payslips p
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
         JOIN employees e ON e.id = p.employee_id
        WHERE p.id = ? AND p.employee_id = ?`,
      [req.params.id, req.user.id],
    );
    if (!slip) throw ApiError.notFound('Payslip not found');

    const components = await query(
      `SELECT label, component_type AS type, amount
         FROM payslip_components WHERE payslip_id = ? ORDER BY component_type, sort_order`,
      [slip.id],
    );

    ok(res, {
      ...decorate(slip),
      earnings: components.filter((c) => c.type === 'earning').map(({ label, amount }) => ({ label, amount })),
      deductionItems: components.filter((c) => c.type === 'deduction').map(({ label, amount }) => ({ label, amount })),
    });
  }),
);

// GET /payroll/ytd ------------------------------------------------------------
router.get(
  '/ytd',
  asyncHandler(async (req, res) => {
    const totals = await queryOne(
      `SELECT COALESCE(SUM(p.gross), 0) AS gross,
              COALESCE(SUM(p.deductions), 0) AS deductions,
              COALESCE(SUM(p.net), 0) AS net,
              COUNT(*) AS months
         FROM payslips p JOIN payroll_runs pr ON pr.id = p.payroll_run_id
        WHERE p.employee_id = ? AND pr.status IN ('locked','published')`,
      [req.user.id],
    );

    const tax = await queryOne(
      `SELECT COALESCE(SUM(pc.amount), 0) AS tds
         FROM payslip_components pc
         JOIN payslips p ON p.id = pc.payslip_id
         JOIN payroll_runs pr ON pr.id = p.payroll_run_id
        WHERE p.employee_id = ? AND pc.label LIKE '%Tax%' AND pr.status IN ('locked','published')`,
      [req.user.id],
    );

    ok(res, { ...totals, tds: tax.tds });
  }),
);

export default router;
