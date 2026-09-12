import { Router } from 'express';
import { z } from 'zod';

import { Payslip } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler, ok, parseWith } from '../utils/helpers.js';
import { MONTH_NAMES } from '../services/payroll.service.js';

const router = Router();
router.use(authenticate);

const VISIBLE_RUNS = ['locked', 'published'];

/** Joins the payslip to its run — the payroll_runs JOIN from the SQL build. */
const withRun = [
  { $lookup: { from: 'payrollruns', localField: 'payrollRunId', foreignField: '_id', as: 'run' } },
  { $unwind: '$run' },
];

const PAYSLIP_PROJECT = {
  _id: 0,
  id: { $toString: '$_id' },
  month: '$run.payMonth',
  year: '$run.payYear',
  paidDays: 1,
  lopDays: 1,
  gross: 1,
  deductions: 1,
  net: 1,
  bankAccount: 1,
  creditedOn: 1,
  runStatus: '$run.status',
};

const decorate = (row) =>
  row && {
    ...row,
    monthName: MONTH_NAMES[row.month - 1],
    period: `${MONTH_NAMES[row.month - 1]} ${row.year}`,
  };

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

    const rows = await Payslip.aggregate([
      { $match: { employeeId: req.user._id } },
      ...withRun,
      {
        $match: {
          'run.status': { $in: VISIBLE_RUNS },
          ...(year ? { 'run.payYear': year } : {}),
        },
      },
      { $sort: { 'run.payYear': -1, 'run.payMonth': -1 } },
      { $limit: limit },
      { $project: PAYSLIP_PROJECT },
    ]);

    ok(res, rows.map(decorate), { count: rows.length });
  }),
);

// GET /payroll/payslips/:id ---------------------------------------------------
router.get(
  '/payslips/:id',
  asyncHandler(async (req, res) => {
    const slip = await Payslip.findOne({ _id: req.params.id, employeeId: req.user._id })
      .populate('payrollRunId', 'payMonth payYear status')
      .populate('employeeId', 'name empCode designation uan pan')
      .lean();
    if (!slip) throw ApiError.notFound('Payslip not found');

    const components = [...slip.components].sort(
      (a, b) => a.type.localeCompare(b.type) || a.sortOrder - b.sortOrder,
    );

    ok(res, {
      ...decorate({
        id: slip._id.toString(),
        month: slip.payrollRunId.payMonth,
        year: slip.payrollRunId.payYear,
        paidDays: slip.paidDays,
        lopDays: slip.lopDays,
        gross: slip.gross,
        deductions: slip.deductions,
        net: slip.net,
        bankAccount: slip.bankAccount,
        creditedOn: slip.creditedOn,
        runStatus: slip.payrollRunId.status,
        employeeName: slip.employeeId?.name ?? null,
        employeeCode: slip.employeeId?.empCode ?? null,
        designation: slip.employeeId?.designation ?? null,
        uan: slip.employeeId?.uan ?? null,
        pan: slip.employeeId?.pan ?? null,
      }),
      earnings: components
        .filter((c) => c.type === 'earning')
        .map(({ label, amount }) => ({ label, amount })),
      deductionItems: components
        .filter((c) => c.type === 'deduction')
        .map(({ label, amount }) => ({ label, amount })),
    });
  }),
);

// GET /payroll/ytd ------------------------------------------------------------
router.get(
  '/ytd',
  asyncHandler(async (req, res) => {
    const [totals] = await Payslip.aggregate([
      { $match: { employeeId: req.user._id } },
      ...withRun,
      { $match: { 'run.status': { $in: VISIBLE_RUNS } } },
      {
        $group: {
          _id: null,
          gross: { $sum: '$gross' },
          deductions: { $sum: '$deductions' },
          net: { $sum: '$net' },
          months: { $sum: 1 },
          // Income tax lines, wherever they sit in the embedded components.
          tds: {
            $sum: {
              $reduce: {
                input: {
                  $filter: {
                    input: '$components',
                    as: 'c',
                    cond: { $regexMatch: { input: '$$c.label', regex: 'Tax' } },
                  },
                },
                initialValue: 0,
                in: { $add: ['$$value', '$$this.amount'] },
              },
            },
          },
        },
      },
      { $project: { _id: 0 } },
    ]);

    ok(res, totals ?? { gross: 0, deductions: 0, net: 0, months: 0, tds: 0 });
  }),
);

export default router;
