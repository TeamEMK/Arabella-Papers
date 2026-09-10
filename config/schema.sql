-- =============================================
-- ARABELLA PAPER FMS - DATABASE SCHEMA
-- =============================================

CREATE DATABASE IF NOT EXISTS arabella_paper CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE arabella_paper;

-- =============================================
-- USERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  emp_id VARCHAR(50),
  username VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(100) NOT NULL DEFAULT 'Designer',
  domain VARCHAR(100),
  contact VARCHAR(30),
  dob VARCHAR(30),
  nationality VARCHAR(50),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- =============================================
-- ACTIVITY LOG
-- =============================================
CREATE TABLE IF NOT EXISTS activity_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(150),
  action VARCHAR(50),
  role VARCHAR(100),
  domain VARCHAR(100),
  logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- ORDER LOGS TABLE
-- Who changed what on an order, and when. One row per field that actually
-- changed, so a saved-but-untouched form leaves nothing behind.
-- =============================================
CREATE TABLE IF NOT EXISTS order_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL,
  action VARCHAR(40) NOT NULL,
  field VARCHAR(80),
  old_value VARCHAR(500),
  new_value VARCHAR(500),
  changed_by VARCHAR(150),
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order_logs_order (order_id),
  INDEX idx_order_logs_when (changed_at)
);

-- =============================================
-- DEALERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS dealers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(150),
  mobile VARCHAR(20),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- DESIGNERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS designers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  india_name VARCHAR(200),
  india_email VARCHAR(150),
  overseas_name VARCHAR(200),
  overseas_email VARCHAR(150),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- ORDERS TABLE (FMS)
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL UNIQUE,
  
  -- Punch Info
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  email_address VARCHAR(150),
  order_punched_by ENUM('India Team','Cassie') DEFAULT 'India Team',
  
  -- Parties
  dealer_name VARCHAR(200),
  dealer_email VARCHAR(150),
  client_name VARCHAR(2000),
  
  -- Design
  india_designer VARCHAR(200),
  overseas_designer VARCHAR(200),
  possible_design_time VARCHAR(50),
  special_remarks TEXT,
  upload_design_file TEXT,
  
  -- Design Stage
  design_status VARCHAR(100) DEFAULT 'Fresh Design',
  no_of_design_revision INT DEFAULT 0,
  revision_design_upload TEXT,
  upload_design TEXT,
  approved_design TEXT,
  remarks TEXT,
  planned_1 DATETIME,
  actual_1 DATETIME,
  doer_id VARCHAR(150),
  
  -- Client Approval Stage
  design_approval_status_from_client VARCHAR(100),
  actual_2 DATETIME,
  approval_updated_by VARCHAR(150),
  
  -- Production Stage
  guest_name VARCHAR(100),
  guest_name_actual_time DATETIME,
  paper_cutting VARCHAR(50),
  paper_cutting_actual_time DATETIME,
  
  -- Dye
  dye_status VARCHAR(100),
  dye_status_actual_time DATETIME,
  no_die_actual_time DATETIME,
  die_not_received_actual_time DATETIME,
  die_cutting_done_actual_time DATETIME,
  die_sent_actual_time DATETIME,
  
  -- Block
  block_status VARCHAR(100),
  block_status_actual_time DATETIME,
  no_block_actual_time DATETIME,
  block_not_received_actual_time DATETIME,
  block_printed_actual_time DATETIME,
  block_sent_actual_time DATETIME,
  
  -- Further Production
  printing VARCHAR(50),
  printing_actual_time DATETIME,
  printing_type VARCHAR(60),
  -- Set when someone moves an order off the production queue by hand. The
  -- August cutoff already sends the old work to the Backup Production board; this
  -- is for the newer orders nobody is going to finish either.
  production_archived_at DATETIME NULL,
  -- When production handed the order over to Dispatch. actual_4 below is a
  -- different day: when the parcel actually went.
  dispatch_ready_at DATETIME NULL,
  -- Pins the order to one dispatch board or the other, overriding the cutoff
  -- date. NULL means the date decides.
  dispatch_board VARCHAR(10) NULL,
  edges VARCHAR(50),
  edges_actual_time DATETIME,
  
  -- Laser
  laser_cutting VARCHAR(50),
  no_laser_cutting_actual_time DATETIME,
  done_laser_cutting_actual_time DATETIME,
  pending_laser_cutting_actual_time DATETIME,
  
  -- Output
  output VARCHAR(50),
  no_output_actual_time DATETIME,
  output_done_actual_time DATETIME,
  output_pending_actual_time DATETIME,
  
  -- Assembly
  card_assembly VARCHAR(50),
  card_assembly_actual_time DATETIME,
  remark TEXT,
  remark_actual_time DATETIME,
  reason_for_delay TEXT,
  reason_for_delay_actual_time DATETIME,
  production_updated_by VARCHAR(150),
  
  -- Dispatch Stage
  status_4 VARCHAR(100),
  courier VARCHAR(100),
  ups_dhl_fedex_tracking_number VARCHAR(200),
  actual_4 DATETIME,
  invoice_number VARCHAR(100),
  invoice_amount DECIMAL(12,2),
  number_of_boxes INT,
  weight VARCHAR(50),
  volumetric_weight VARCHAR(50),
  dispatch_updated_by VARCHAR(150),
  
  -- Meta
  is_deleted TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- =============================================
-- SESSIONS TABLE (express-mysql-session)
-- =============================================
-- Staff records. Separate from `users`, which is only login accounts: most of
-- the people here have no reason to sign in, and the ones who do are matched
-- by email rather than being the same row.
CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company VARCHAR(50) NOT NULL DEFAULT 'AMIPL',
  name VARCHAR(150) NOT NULL,
  emp_code VARCHAR(50),
  mobile VARCHAR(30),
  email VARCHAR(150),
  emergency_no VARCHAR(30),
  designation VARCHAR(150),
  department VARCHAR(120),
  kra TEXT,
  reporting_manager VARCHAR(150),
  work_location VARCHAR(150),
  offer_letter_date VARCHAR(60),
  date_of_joining VARCHAR(60),
  probation_end_date VARCHAR(60),
  confirmation_date VARCHAR(60),
  appointment_nda_status VARCHAR(100),
  code_of_conduct VARCHAR(100),
  policy_handbook VARCHAR(100),
  background_verification VARCHAR(100),
  working_status VARCHAR(100),
  last_date_of_employment VARCHAR(60),
  record_log TEXT,
  performance_remarks TEXT,
  other_notes TEXT,
  is_deleted TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_employees_company (company),
  INDEX idx_employees_name (name)
);

-- Leave, work-from-home and extra-working requests. Raised by whoever is
-- logged in, decided by a SuperAdmin.
CREATE TABLE IF NOT EXISTS leave_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  leave_type VARCHAR(30) NOT NULL,
  -- The days chosen, one JSON array. from_date/to_date are the ends of that
  -- set, kept as columns so the list can be filtered and sorted by date
  -- without unpacking the JSON on every row.
  dates_json TEXT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  approver_id INT DEFAULT NULL,
  approver_note TEXT,
  decided_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leave_user (user_id),
  INDEX idx_leave_status (status),
  INDEX idx_leave_from (from_date)
);

-- Paper and ribbon stock. One row per item; `category` is the series it came
-- from, which in the source workbook was a tab of its own.
CREATE TABLE IF NOT EXISTS stock_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(120) NOT NULL,
  code VARCHAR(80),
  name VARCHAR(255),
  -- Free text, not a fixed set: the sheet says "In Stock", "out of stock" and
  -- "Please confirm before placing an order", and the office means all three.
  status VARCHAR(160),
  thickness VARCHAR(40),
  note TEXT,
  is_deleted TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_stock_category (category),
  INDEX idx_stock_code (code)
);

-- =============================================
-- FMS — work that lives in a Google Sheet
--
-- A sheet where each row is a job and each step of that job has its own block
-- of columns: a planned date, an actual date, the delay, and a checkbox. The
-- sheet stays the record; this app is a better way to write to it than opening
-- the sheet and hunting for the right cell.
--
-- What is stored here is only the MAPPING — which columns mean what, and who
-- works which step. No job data is copied; that would be a second copy of the
-- truth, and the two would drift apart within a week.
-- =============================================
CREATE TABLE IF NOT EXISTS fms_sheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fms_name VARCHAR(255) DEFAULT '',
  -- The tab, and the spreadsheet it lives in.
  sheet_name VARCHAR(255) NOT NULL,
  sheet_id VARCHAR(255) NOT NULL,
  -- Which row carries the column headings. Rarely 1: these sheets open with a
  -- banner block naming each step and who owns it.
  header_row INT DEFAULT 1,
  total_steps INT DEFAULT 0,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fms_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fms_id INT NOT NULL,
  step_order INT NOT NULL,
  step_name VARCHAR(255) NOT NULL,
  plan_col VARCHAR(10) DEFAULT '',
  actual_col VARCHAR(10) DEFAULT '',
  -- Where the sheet fills the actual date itself from a checkbox, completing
  -- the step means ticking that checkbox. Writing the date directly would
  -- delete the formula for every future row.
  complete_col VARCHAR(10) DEFAULT '',
  delay_reason_col VARCHAR(10) DEFAULT '',
  extra_input VARCHAR(10) DEFAULT 'no',
  extra_col VARCHAR(10) DEFAULT '',
  show_cols TEXT,
  -- The header NAME behind each mapped column. Letters are positions and
  -- positions move: insert one column in the sheet and every letter after it
  -- points at the wrong data, silently. See utils/fms/columns.js.
  header_map TEXT,
  INDEX idx_fms_steps_fms (fms_id),
  INDEX idx_fms_steps_order (fms_id, step_order)
);

CREATE TABLE IF NOT EXISTS fms_step_doers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT NOT NULL,
  user_id INT NOT NULL,
  INDEX idx_fms_doers_step (step_id),
  INDEX idx_fms_doers_user (user_id),
  UNIQUE KEY uq_fms_step_user (step_id, user_id)
);

-- Anything else a doer types when finishing a step — a quantity, a courier, a
-- note. header_name/header_occ do for these what header_map does for a step.
CREATE TABLE IF NOT EXISTS fms_extra_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT NOT NULL,
  row_label VARCHAR(255) DEFAULT '',
  col_letter VARCHAR(10) DEFAULT '',
  field_type VARCHAR(20) DEFAULT 'text',
  dropdown_options TEXT,
  required TINYINT(1) DEFAULT 0,
  header_name VARCHAR(255) DEFAULT '',
  header_occ INT DEFAULT 0,
  INDEX idx_fms_extra_step (step_id)
);

-- =============================================
-- CORRECTIONS
-- A client sends changes by email after the order has already been designed.
-- Those used to live only in somebody's inbox: nobody could say how many were
-- outstanding, or which designer was sitting on one.
--
-- One row per correction, not per order. The same order comes back a second
-- and a third time, and each round is its own thing with its own date and its
-- own account of what was changed - collapsing them into one row would lose
-- exactly the history this is for.
-- =============================================
CREATE TABLE IF NOT EXISTS corrections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL,
  -- The designer this landed on, by name, because that is how an order carries
  -- one. Copied at the time it was raised: reassigning the order later must not
  -- silently move a correction somebody has already done.
  designer VARCHAR(200) NOT NULL,
  -- What the client asked for. Optional - whoever raises it may only have the
  -- order number to hand, and the designer has the mail anyway.
  client_note TEXT,
  raised_by VARCHAR(150),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  -- 'pending' until the designer answers, then 'done' or 'delayed'.
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- What was actually corrected, or why it was not. One or the other is
  -- required to leave pending; which one decides the status.
  work_note TEXT,
  delay_reason TEXT,
  closed_at DATETIME DEFAULT NULL,

  INDEX idx_corr_order (order_id),
  INDEX idx_corr_designer (designer),
  INDEX idx_corr_status (status)
);

-- =============================================
-- GNA DESIGNERS
-- A short list of people a correction can be handed to instead of whoever the
-- order says designed it. GNA work comes back for changes through a different
-- set of hands, and the order's own designer is sometimes somebody with no
-- login at all - Naman is on 26 orders and has never signed in, so a
-- correction sent his way would simply sit there.
--
-- Names, not user ids: a correction stores the designer by name, because that
-- is how an order carries one.
-- =============================================
CREATE TABLE IF NOT EXISTS gna_designers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  added_by VARCHAR(150),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gna_name (name)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  expires INT(11) UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  INDEX expires_idx (expires)
);

-- =============================================
-- DEFAULT ADMIN USER
-- Deliberately not seeded here. A password hash committed to the repo is a
-- password anyone with repo access knows, and rewriting history does not take
-- it back. config/initDb.js creates the first admin from ADMIN_EMAIL and
-- ADMIN_PASSWORD instead, hashing at runtime.
-- =============================================

-- =============================================
-- PER-PERSON SECTION ACCESS
-- Only what differs from the person's role: allowed = 1 is a section given to
-- them on top of it, allowed = 0 one taken away. A person with no rows here
-- opens exactly what their role opens, so an empty table is the behaviour the
-- app had before this existed — which is how it ships.
-- =============================================
CREATE TABLE IF NOT EXISTS user_sections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  section VARCHAR(40) NOT NULL,
  allowed TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(150),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_section (user_id, section),
  INDEX idx_user_sections_user (user_id)
);
