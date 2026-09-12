import { queryOne } from '../config/db.js';

/** Columns shared by every "employee" shaped response. */
export const EMPLOYEE_SELECT = `
  e.id,
  e.emp_code       AS empCode,
  e.name,
  e.email,
  e.phone,
  e.role,
  e.designation,
  e.status,
  e.date_of_joining AS dateOfJoining,
  e.pan,
  e.uan,
  e.bank_name       AS bankName,
  e.bank_account    AS bankAccount,
  d.name            AS department,
  l.name            AS location,
  m.name            AS reportingTo,
  m.id              AS reportingToId,
  CONCAT(s.name, ' • ', DATE_FORMAT(s.start_time, '%H:%i'), ' - ', DATE_FORMAT(s.end_time, '%H:%i')) AS shift
`;

export const EMPLOYEE_JOINS = `
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations   l ON l.id = e.location_id
  LEFT JOIN shifts      s ON s.id = e.shift_id
  LEFT JOIN employees   m ON m.id = e.reporting_to
`;

export function getEmployeeById(id) {
  return queryOne(`SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_JOINS} WHERE e.id = ?`, [id]);
}

export function getEmployeeByEmail(email) {
  return queryOne(
    `SELECT ${EMPLOYEE_SELECT}, e.password_hash AS passwordHash ${EMPLOYEE_JOINS} WHERE e.email = ?`,
    [email],
  );
}

/**
 * Ids a manager may act on: their direct reports (admins see everyone).
 * Returns null when the caller can see all employees.
 */
export async function scopeForApprover(user) {
  if (user.role === 'admin') return null;
  return user.id;
}
