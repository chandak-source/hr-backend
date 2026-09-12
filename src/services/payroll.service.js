import { Attendance } from '../models/index.js';
import { daysInMonth, monthFilter, round2 } from '../utils/helpers.js';

/**
 * Salary engine shared by the seeder and the admin payroll-run endpoint.
 *
 * Monthly gross is prorated on paid days; deductions follow the common Indian
 * payroll rules used by the app (PF 12% of basic capped at the ₹15,000 wage
 * ceiling, ₹200 professional tax, slab-based TDS, ₹500 group insurance).
 */
export function computePayslip({ structure, month, year, lopDays = 0 }) {
  const totalDays = daysInMonth(month, year);
  const paidDays = round2(Math.max(0, totalDays - lopDays));
  const factor = paidDays / totalDays;

  const earnings = [
    { label: 'Basic Salary', amount: round2(structure.basic * factor) },
    { label: 'House Rent Allowance', amount: round2(structure.hra * factor) },
    { label: 'Conveyance Allowance', amount: round2(structure.conveyance * factor) },
    { label: 'Special Allowance', amount: round2(structure.specialAllowance * factor) },
  ].filter((c) => c.amount > 0);

  const gross = round2(earnings.reduce((sum, c) => sum + c.amount, 0));

  const pfWageBase = Math.min(round2(structure.basic * factor), 15000);
  const providentFund = round2(pfWageBase * 0.12);
  const professionalTax = gross > 0 ? 200 : 0;
  const groupInsurance = gross > 0 ? 500 : 0;
  const tds = round2(estimateMonthlyTds(gross));

  const deductionItems = [
    { label: 'Provident Fund', amount: providentFund },
    { label: 'Professional Tax', amount: professionalTax },
    { label: 'Income Tax (TDS)', amount: tds },
    { label: 'Group Insurance', amount: groupInsurance },
  ].filter((c) => c.amount > 0);

  const deductions = round2(deductionItems.reduce((sum, c) => sum + c.amount, 0));

  return {
    paidDays,
    lopDays: round2(lopDays),
    gross,
    deductions,
    net: round2(gross - deductions),
    earnings,
    deductionItems,
  };
}

/** Simplified new-regime slab estimate, spread over 12 months. */
function estimateMonthlyTds(monthlyGross) {
  const annual = monthlyGross * 12;
  const slabs = [
    [400000, 0],
    [800000, 0.05],
    [1200000, 0.1],
    [1600000, 0.15],
    [2000000, 0.2],
    [2400000, 0.25],
    [Infinity, 0.3],
  ];

  let tax = 0;
  let previous = 0;
  for (const [ceiling, rate] of slabs) {
    if (annual <= previous) break;
    tax += (Math.min(annual, ceiling) - previous) * rate;
    previous = ceiling;
  }
  return (tax * 1.04) / 12; // + 4% cess
}

/** LOP days for a month straight from the attendance collection. */
export async function countLopDays(employeeId, month, year, session = null) {
  const pipeline = [
    {
      $match: {
        employeeId,
        workDate: monthFilter(month, year),
        status: { $in: ['absent', 'miss_punch', 'half_day'] },
      },
    },
    {
      $group: {
        _id: null,
        lop: { $sum: { $cond: [{ $eq: ['$status', 'half_day'] }, 0.5, 1] } },
      },
    },
  ];
  const [row] = await Attendance.aggregate(pipeline).session(session);
  return Number(row?.lop ?? 0);
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
