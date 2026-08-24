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
