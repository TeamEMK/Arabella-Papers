-- ════════════════════════════════════════════════════════════════════
-- Delegation + Checklist module — database schema (MySQL 8 / MariaDB 10.4+)
--
-- Arabella copy: modules/tasks/index.js runs this on the first task request
-- (every statement is IF NOT EXISTS / OR REPLACE, so it is safe on every boot).
-- ════════════════════════════════════════════════════════════════════

-- One-off tasks given to one person, with a due date (or one the doer sets).
CREATE TABLE IF NOT EXISTS delegation_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  description TEXT NOT NULL,
  assigned_to INT NOT NULL,                       -- users.id of the doer
  assigned_by INT NOT NULL,                       -- users.id of whoever gave it
  due_date DATE,                                  -- NULL while the doer still has to set it
  due_time TIME DEFAULT NULL,                     -- optional clock time on the deadline
  status ENUM('pending','completed','revised') DEFAULT 'pending',
  completed_at DATETIME DEFAULT NULL,             -- set on completion, cleared on reopen
  priority ENUM('low','medium','high','urgent') DEFAULT 'low',
  approval ENUM('yes','no') DEFAULT 'no',         -- 'yes': completion needs the assigner's approval
  waiting_approval TINYINT(1) DEFAULT 0,          -- a revise / completion request is pending
  awaiting_due_date TINYINT(1) DEFAULT 0,         -- "doer-defined due date": doer picks the date
  no_due_date_reason TEXT DEFAULT NULL,           -- why the doer cannot set a date yet
  no_due_date_reason_at TIMESTAMP NULL DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  client_ask TEXT DEFAULT NULL,                   -- what is still needed from the client
  client_ask_by DATETIME DEFAULT NULL,            -- … and by when
  client_id INT DEFAULT NULL,                     -- clients.id (optional)
  url VARCHAR(2048) DEFAULT NULL,
  delay_reason TEXT NULL,                         -- reason given for finishing late
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  seen_at DATETIME DEFAULT NULL,                  -- when the doer was shown it (new-task pop-up)
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_status (status),
  INDEX idx_due_date (due_date),
  INDEX idx_client (client_id),
  INDEX idx_unseen (assigned_to, seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Recurring tasks: one row per occurrence (the series is generated up front).
CREATE TABLE IF NOT EXISTS checklist_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  description TEXT NOT NULL,
  assigned_to INT NOT NULL,
  assigned_by INT NOT NULL,
  due_date DATE,
  status ENUM('pending','completed') DEFAULT 'pending',
  priority ENUM('low','medium','high') DEFAULT 'low',
  remarks TEXT DEFAULT NULL,
  client_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_status (status),
  INDEX idx_due_date (due_date),
  INDEX idx_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Revise-date requests and completion requests waiting on the assigner.
CREATE TABLE IF NOT EXISTS task_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  task_type VARCHAR(20) NOT NULL,                 -- 'delegation' | 'checklist'
  requested_by INT NOT NULL,
  requested_to INT NOT NULL,                      -- the task's assigned_by
  action_type VARCHAR(50) DEFAULT NULL,           -- 'revised' | 'completed'
  new_date DATE DEFAULT NULL,                     -- the date a revise asks for
  status ENUM('pending','approved','rejected') DEFAULT 'pending',
  note TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type),
  INDEX idx_requested_to (requested_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  task_type VARCHAR(20) NOT NULL,
  user_id INT NOT NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit log: every status change, reassignment and due-date move.
CREATE TABLE IF NOT EXISTS task_activity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  task_type VARCHAR(20) NOT NULL,
  old_status VARCHAR(20) DEFAULT NULL,
  new_status VARCHAR(20) DEFAULT NULL,
  field VARCHAR(20) NOT NULL DEFAULT 'status',    -- 'status' | 'due_date' | 'assigned_to' | 'no_due_date_reason'
  old_value VARCHAR(120) DEFAULT NULL,
  new_value VARCHAR(120) DEFAULT NULL,
  changed_by INT DEFAULT NULL,
  source VARCHAR(40) DEFAULT NULL,                -- where the change came from (page / cron / holiday …)
  note TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type),
  INDEX idx_changed_by (changed_by),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Requests to move tasks from one person to another.
CREATE TABLE IF NOT EXISTS task_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,
  task_type VARCHAR(20) NOT NULL,
  from_user INT NOT NULL,
  to_user INT NOT NULL,
  requested_by INT NOT NULL,
  status ENUM('pending','approved','rejected') DEFAULT 'pending',
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_task (task_id, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Follow-up asks nested under a delegation task.
CREATE TABLE IF NOT EXISTS task_subtasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NOT NULL,                           -- delegation_tasks.id
  description TEXT NOT NULL,
  priority ENUM('low','medium','high','urgent') DEFAULT 'low',
  remarks TEXT DEFAULT NULL,
  status ENUM('pending','completed') DEFAULT 'pending',
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Company holidays. Adding one removes that day's pending checklist tasks and
-- moves pending delegation tasks to the next working day.
CREATE TABLE IF NOT EXISTS holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_date (holiday_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every task / sub-task / comment / holiday is copied here before it is deleted.
CREATE TABLE IF NOT EXISTS deleted_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_table VARCHAR(64) NOT NULL,
  record_id INT DEFAULT NULL,
  record_data LONGTEXT NOT NULL,                  -- the row as JSON
  summary VARCHAR(255) DEFAULT '',
  deleted_by INT DEFAULT NULL,
  deleted_by_name VARCHAR(255) DEFAULT '',
  deleted_by_role VARCHAR(20) DEFAULT '',
  deleted_via VARCHAR(120) DEFAULT '',
  delete_reason TEXT,
  restored_at TIMESTAMP NULL DEFAULT NULL,
  restored_by INT DEFAULT NULL,
  deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_source (source_table, record_id),
  INDEX idx_deleted_by (deleted_by),
  INDEX idx_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;



-- Clients a task can be tagged with. If the project already has a `clients`
-- table these two statements do nothing — it must then have the columns below.
-- If it has no clients at all, these empty tables keep the task queries
-- working (they LEFT JOIN clients), and `clients: false` in the module config
-- hides the client fields.
CREATE TABLE IF NOT EXISTS clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  brand_name VARCHAR(255) DEFAULT NULL,
  is_active TINYINT(1) DEFAULT 1,
  handler_id INT DEFAULT NULL,                    -- users.id of the main handler
  whatsapp_group_id VARCHAR(100) DEFAULT NULL,    -- Waumfy group id for client messages
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS client_handlers (
  client_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (client_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ════════════════════════════════════════════════════════════════════
-- task_users — Arabella's people, in the shape the task module reads.
--
-- The module was written against the E-Marketing ERP's users table (name,
-- role admin/hod/pc/user, department …). Rather than add columns to Arabella's
-- own `users`, every query in modules/tasks reads this view instead, so the
-- users table is never touched:
--   name        ← username
--   role        ← 'admin' for a SuperAdmin, 'user' for everyone else
--   department  ← Arabella's role (Designer, Accounts, HR …)
--   phone       ← contact
-- The module only ever reads people; it never writes to users.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW task_users AS
SELECT
  u.id,
  u.username AS name,
  u.email,
  CASE WHEN u.role = 'SuperAdmin' THEN 'admin' ELSE 'user' END AS role,
  u.role AS department,
  u.contact AS phone,
  '' AS notification_email,
  '' AS week_off,
  NULL AS extra_off,
  0 AS exclude_from_reminder,
  NULL AS user_permissions,
  NULL AS extra_access,
  NULL AS client_id
FROM users u;
