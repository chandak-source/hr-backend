-- =============================================================================
--  Chanda HR — MySQL schema
--  Engine: InnoDB / utf8mb4  •  Tested on MySQL 8.4
-- =============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- --------------------------------------------------------------- masters ---
CREATE TABLE IF NOT EXISTS departments (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80)  NOT NULL,
  code        VARCHAR(20)  NOT NULL,
  head_id     INT UNSIGNED NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_departments_code (code),
  UNIQUE KEY uq_departments_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shifts (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(60) NOT NULL,
  start_time     TIME        NOT NULL,
  end_time       TIME        NOT NULL,
  grace_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  half_day_after TIME        NULL,
  UNIQUE KEY uq_shifts_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS locations (
  id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name     VARCHAR(80)  NOT NULL,
  address  VARCHAR(255) NULL,
  latitude  DECIMAL(10, 7) NULL,
  longitude DECIMAL(10, 7) NULL,
  geofence_radius_m SMALLINT UNSIGNED NOT NULL DEFAULT 200,
  UNIQUE KEY uq_locations_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- employees ---
CREATE TABLE IF NOT EXISTS employees (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  emp_code         VARCHAR(20)  NOT NULL,
  name             VARCHAR(120) NOT NULL,
  email            VARCHAR(160) NOT NULL,
  phone            VARCHAR(20)  NULL,
  password_hash    VARCHAR(255) NOT NULL,
  role             ENUM('employee','manager','admin') NOT NULL DEFAULT 'employee',
  designation      VARCHAR(120) NOT NULL,
  department_id    INT UNSIGNED NULL,
  location_id      INT UNSIGNED NULL,
  shift_id         INT UNSIGNED NULL,
  reporting_to     INT UNSIGNED NULL,
  date_of_joining  DATE         NOT NULL,
  date_of_birth    DATE         NULL,
  gender           ENUM('male','female','other') NULL,
  status           ENUM('active','on_notice','exited') NOT NULL DEFAULT 'active',
  exit_date        DATE         NULL,
  pan              VARCHAR(15)  NULL,
  uan              VARCHAR(25)  NULL,
  bank_name        VARCHAR(80)  NULL,
  bank_account     VARCHAR(30)  NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employees_code  (emp_code),
  UNIQUE KEY uq_employees_email (email),
  KEY idx_employees_department (department_id),
  KEY idx_employees_manager    (reporting_to),
  KEY idx_employees_status     (status),
  CONSTRAINT fk_employees_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_location   FOREIGN KEY (location_id)   REFERENCES locations (id)   ON DELETE SET NULL,
  CONSTRAINT fk_employees_shift      FOREIGN KEY (shift_id)      REFERENCES shifts (id)      ON DELETE SET NULL,
  CONSTRAINT fk_employees_manager    FOREIGN KEY (reporting_to)  REFERENCES employees (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE departments
  ADD CONSTRAINT fk_departments_head FOREIGN KEY (head_id) REFERENCES employees (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id INT UNSIGNED NOT NULL,
  token       CHAR(64)     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_refresh_token (token),
  KEY idx_refresh_employee (employee_id),
  CONSTRAINT fk_refresh_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------ attendance ---
CREATE TABLE IF NOT EXISTS attendance (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id   INT UNSIGNED NOT NULL,
  work_date     DATE         NOT NULL,
  punch_in      TIME         NULL,
  punch_out     TIME         NULL,
  total_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('present','absent','week_off','holiday','leave','half_day','late_in','miss_punch')
                NOT NULL DEFAULT 'absent',
  work_mode     ENUM('office','wfh','client_site','on_duty') NULL,
  in_location   VARCHAR(120) NULL,
  out_location  VARCHAR(120) NULL,
  shift_id      INT UNSIGNED NULL,
  is_regularized TINYINT(1)  NOT NULL DEFAULT 0,
  remark        VARCHAR(255) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attendance_employee_date (employee_id, work_date),
  KEY idx_attendance_date   (work_date),
  KEY idx_attendance_status (status),
  CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_shift    FOREIGN KEY (shift_id)    REFERENCES shifts (id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS punch_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id INT UNSIGNED NOT NULL,
  punched_at  DATETIME     NOT NULL,
  punch_type  ENUM('in','out') NOT NULL,
  work_mode   ENUM('office','wfh','client_site','on_duty') NOT NULL DEFAULT 'office',
  latitude    DECIMAL(10, 7) NULL,
  longitude   DECIMAL(10, 7) NULL,
  address     VARCHAR(255) NULL,
  source      ENUM('mobile','web','biometric') NOT NULL DEFAULT 'mobile',
  KEY idx_punch_employee_time (employee_id, punched_at),
  CONSTRAINT fk_punch_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS regularization_requests (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_code VARCHAR(20)  NOT NULL,
  employee_id  INT UNSIGNED NOT NULL,
  work_date    DATE         NOT NULL,
  punch_in     TIME         NOT NULL,
  punch_out    TIME         NOT NULL,
  reason       VARCHAR(500) NOT NULL,
  status       ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  approver_id  INT UNSIGNED NULL,
  action_on    DATETIME     NULL,
  action_remark VARCHAR(255) NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_regularization_code (request_code),
  KEY idx_regularization_employee (employee_id),
  KEY idx_regularization_status   (status),
  CONSTRAINT fk_regularization_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_regularization_approver FOREIGN KEY (approver_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- leave ---
CREATE TABLE IF NOT EXISTS leave_types (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(10)  NOT NULL,
  name          VARCHAR(80)  NOT NULL,
  annual_quota  DECIMAL(5,1) NOT NULL DEFAULT 0,
  is_paid       TINYINT(1)   NOT NULL DEFAULT 1,
  requires_proof TINYINT(1)  NOT NULL DEFAULT 0,
  color_hex     CHAR(7)      NOT NULL DEFAULT '#1B3C8C',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  UNIQUE KEY uq_leave_types_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_balances (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id    INT UNSIGNED NOT NULL,
  leave_type_id  INT UNSIGNED NOT NULL,
  financial_year CHAR(9)      NOT NULL,
  allotted       DECIMAL(5,1) NOT NULL DEFAULT 0,
  used           DECIMAL(5,1) NOT NULL DEFAULT 0,
  carried_forward DECIMAL(5,1) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_balance (employee_id, leave_type_id, financial_year),
  CONSTRAINT fk_balance_employee   FOREIGN KEY (employee_id)   REFERENCES employees (id)   ON DELETE CASCADE,
  CONSTRAINT fk_balance_leave_type FOREIGN KEY (leave_type_id) REFERENCES leave_types (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_requests (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_code   VARCHAR(20)  NOT NULL,
  employee_id    INT UNSIGNED NOT NULL,
  leave_type_id  INT UNSIGNED NOT NULL,
  from_date      DATE         NOT NULL,
  to_date        DATE         NOT NULL,
  day_type       ENUM('full_day','first_half','second_half') NOT NULL DEFAULT 'full_day',
  days           DECIMAL(4,1) NOT NULL,
  reason         VARCHAR(500) NOT NULL,
  status         ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  approver_id    INT UNSIGNED NULL,
  applied_on     DATE         NOT NULL,
  action_on      DATETIME     NULL,
  action_remark  VARCHAR(255) NULL,
  attachment_path VARCHAR(255) NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_leave_code (request_code),
  KEY idx_leave_employee (employee_id),
  KEY idx_leave_status   (status),
  KEY idx_leave_dates    (from_date, to_date),
  CONSTRAINT fk_leave_employee   FOREIGN KEY (employee_id)   REFERENCES employees (id)   ON DELETE CASCADE,
  CONSTRAINT fk_leave_type       FOREIGN KEY (leave_type_id) REFERENCES leave_types (id),
  CONSTRAINT fk_leave_approver   FOREIGN KEY (approver_id)   REFERENCES employees (id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------- expenses ---
CREATE TABLE IF NOT EXISTS expense_categories (
  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name      VARCHAR(60) NOT NULL,
  max_limit DECIMAL(10,2) NULL,
  is_active TINYINT(1)  NOT NULL DEFAULT 1,
  UNIQUE KEY uq_expense_category (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expense_claims (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  claim_code    VARCHAR(20)  NOT NULL,
  employee_id   INT UNSIGNED NOT NULL,
  category_id   INT UNSIGNED NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  expense_date  DATE         NOT NULL,
  note          VARCHAR(500) NOT NULL,
  receipt_path  VARCHAR(255) NULL,
  status        ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  approver_id   INT UNSIGNED NULL,
  action_on     DATETIME     NULL,
  action_remark VARCHAR(255) NULL,
  reimbursed_on DATE         NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_claim_code (claim_code),
  KEY idx_claim_employee (employee_id),
  KEY idx_claim_status   (status),
  CONSTRAINT fk_claim_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_category FOREIGN KEY (category_id) REFERENCES expense_categories (id),
  CONSTRAINT fk_claim_approver FOREIGN KEY (approver_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------- payroll ---
CREATE TABLE IF NOT EXISTS salary_structures (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id       INT UNSIGNED NOT NULL,
  effective_from    DATE         NOT NULL,
  annual_ctc        DECIMAL(12,2) NOT NULL,
  basic             DECIMAL(10,2) NOT NULL,
  hra               DECIMAL(10,2) NOT NULL DEFAULT 0,
  conveyance        DECIMAL(10,2) NOT NULL DEFAULT 0,
  special_allowance DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_current        TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_salary_employee (employee_id, is_current),
  CONSTRAINT fk_salary_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  pay_month         TINYINT UNSIGNED NOT NULL,
  pay_year          SMALLINT UNSIGNED NOT NULL,
  status            ENUM('draft','processed','locked','published') NOT NULL DEFAULT 'draft',
  employee_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total_gross       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deductions  DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_net         DECIMAL(14,2) NOT NULL DEFAULT 0,
  processed_by      INT UNSIGNED NULL,
  processed_at      DATETIME     NULL,
  published_at      DATETIME     NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payroll_period (pay_month, pay_year),
  CONSTRAINT fk_payroll_processor FOREIGN KEY (processed_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payslips (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id INT UNSIGNED NOT NULL,
  employee_id    INT UNSIGNED NOT NULL,
  paid_days      DECIMAL(4,1) NOT NULL,
  lop_days       DECIMAL(4,1) NOT NULL DEFAULT 0,
  gross          DECIMAL(12,2) NOT NULL,
  deductions     DECIMAL(12,2) NOT NULL,
  net            DECIMAL(12,2) NOT NULL,
  bank_account   VARCHAR(30)  NULL,
  credited_on    DATE         NULL,
  pdf_path       VARCHAR(255) NULL,
  UNIQUE KEY uq_payslip (payroll_run_id, employee_id),
  KEY idx_payslip_employee (employee_id),
  CONSTRAINT fk_payslip_run      FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_payslip_employee FOREIGN KEY (employee_id)    REFERENCES employees (id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payslip_components (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payslip_id    BIGINT UNSIGNED NOT NULL,
  label         VARCHAR(80)  NOT NULL,
  component_type ENUM('earning','deduction') NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  sort_order    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_component_payslip (payslip_id),
  CONSTRAINT fk_component_payslip FOREIGN KEY (payslip_id) REFERENCES payslips (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------- tasks ---
CREATE TABLE IF NOT EXISTS tasks (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_code   VARCHAR(20)  NOT NULL,
  employee_id INT UNSIGNED NOT NULL,
  assigned_by INT UNSIGNED NULL,
  title       VARCHAR(180) NOT NULL,
  project     VARCHAR(120) NOT NULL,
  due_date    DATE         NOT NULL,
  priority    ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  progress    DECIMAL(3,2) NOT NULL DEFAULT 0,
  is_done     TINYINT(1)   NOT NULL DEFAULT 0,
  completed_at DATETIME    NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_task_code (task_code),
  KEY idx_task_employee (employee_id, is_done),
  CONSTRAINT fk_task_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_task_assigner FOREIGN KEY (assigned_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------- holidays / broadcasts ---
CREATE TABLE IF NOT EXISTS holidays (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  holiday_date DATE        NOT NULL,
  name         VARCHAR(120) NOT NULL,
  holiday_type ENUM('national','festival','optional') NOT NULL DEFAULT 'festival',
  location_id  INT UNSIGNED NULL,
  UNIQUE KEY uq_holiday (holiday_date, name),
  CONSTRAINT fk_holiday_location FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(180) NOT NULL,
  body         TEXT         NOT NULL,
  category     ENUM('Event','Policy','HR Update','Celebration') NOT NULL DEFAULT 'HR Update',
  published_by INT UNSIGNED NULL,
  published_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_announcement_active (is_active, published_at),
  CONSTRAINT fk_announcement_author FOREIGN KEY (published_by) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id INT UNSIGNED NOT NULL,
  title       VARCHAR(180) NOT NULL,
  subtitle    VARCHAR(400) NOT NULL,
  kind        ENUM('leave','payroll','attendance','task','expense','general') NOT NULL DEFAULT 'general',
  is_read     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notification_employee (employee_id, is_read),
  CONSTRAINT fk_notification_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id    INT UNSIGNED NULL,
  action      VARCHAR(80)  NOT NULL,
  entity      VARCHAR(60)  NOT NULL,
  entity_id   VARCHAR(40)  NULL,
  meta        JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_actor (actor_id),
  KEY idx_audit_entity (entity, entity_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
