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
  -- Where the person was when they signed in. The address on its own means
  -- little to whoever reads the log, so the town Vercel worked out at the
  -- edge is kept beside it. Both are blank on rows written before this, and
  -- on anything not running behind Vercel.
  ip_address VARCHAR(64) DEFAULT '',
  location VARCHAR(160) DEFAULT '',
  -- The browser's own position, when the person allows it. This is the only
  -- way to get nearer than a city: an address cannot be had from an IP, which
  -- maps a range to a town and an ISP and knows nothing of streets. Null
  -- wherever the prompt was refused, dismissed, or never answered in time -
  -- and the city above still stands in those cases.
  latitude DECIMAL(10,7) DEFAULT NULL,
  longitude DECIMAL(10,7) DEFAULT NULL,
  -- How wide the browser says its own guess is, in metres. Worth keeping:
  -- 20m is a phone with GPS, 3000m is a laptop working it out from the same
  -- network the IP came from, and the second is not worth calling a location.
  accuracy_m INT DEFAULT NULL,
  logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- =============================================
-- DESIGN CATALOGUE
-- What the office shows customers: forms, motifs and patterns, put up from
-- the admin page and read from a public link that needs no login.
--
-- The picture lives here rather than on Drive. Drive's share links open a
-- viewer page, not an image, so a gallery would need its undocumented
-- thumbnail endpoint - and that is a thing to depend on for an internal
-- screen, not for a page the client sends to their own customers. Serving
-- our own bytes has no sharing settings to come undone later.
-- =============================================
CREATE TABLE IF NOT EXISTS catalogue_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(40) NOT NULL,
  name VARCHAR(255) DEFAULT '',
  -- What the customer quotes back when they ring up about one.
  code VARCHAR(60) DEFAULT '',
  file_name VARCHAR(255) DEFAULT '',
  mime_type VARCHAR(100) DEFAULT '',
  -- The full-size picture, for zooming into. Rendered at a resolution that
  -- survives being opened: at the 140dpi it started at, a page of fonts went
  -- soft the moment anybody looked closely, which is the one thing a type
  -- catalogue cannot do.
  bytes MEDIUMBLOB,
  -- And a small one for the grid, because the other is 400KB and a customer
  -- scrolling the catalogue would otherwise pull down tens of megabytes to
  -- look at tiles 230 pixels wide. Null on anything uploaded by hand through
  -- the admin page; the route falls back to the full picture there.
  thumb MEDIUMBLOB,
  -- Taken down without being destroyed: a design pulled from the catalogue is
  -- usually back next season, and the orders that quote its code remain.
  is_active TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_catalogue_live (is_active, category, sort_order)
);

-- =============================================
-- VECTOR FILES
-- The print-ready artwork for an order, which is not the proofing image and
-- not the client's approval upload - the office keeps all three apart.
--
-- A row per version rather than a column on the order. The order table holds
-- `upload_design` for the first proof and `revision_design_upload` for every
-- revision after it, which means one box for all of them: on the 217 orders
-- that went past one revision, each upload wrote over the last and the older
-- files are simply gone. A client asking to go back to an earlier version
-- cannot be answered from a column that only ever holds the newest.
-- =============================================
CREATE TABLE IF NOT EXISTS order_vector_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(50) NOT NULL,
  -- 1, 2, 3... per order, so "version 7" means something to say out loud.
  version INT NOT NULL DEFAULT 1,
  file_url TEXT,
  file_name VARCHAR(255) DEFAULT '',
  uploaded_by VARCHAR(150) DEFAULT '',
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vector_order (order_id),
  UNIQUE KEY uq_vector_version (order_id, version)
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
  -- Answered beside a Final Approval For Production, and nowhere else: how
  -- urgently this run has to go, and how many days it has been given. The
  -- days are optional - the office often knows a job is a rush before it
  -- knows the date - so a blank here means not settled, not zero.
  order_type VARCHAR(20),
  dispatch_days INT,
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
  
  -- The order this one is a repeat of: a Re-print or a Re-order opens a new
  -- entry rather than writing over the run that has already been made.
  remake_of VARCHAR(20) NULL,

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
-- INVENTORY — company equipment and who is holding it
--
-- Two tables, not one. The item is a thing the company owns and keeps owning;
-- an assignment is one spell of somebody holding it. Keeping the spells as
-- their own rows is what lets the register answer "who had this laptop last
-- year" — a `holder` column on the item would only ever know about today.
-- =============================================
CREATE TABLE IF NOT EXISTS inventory_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- What it is called on the card. There is no free-text name field on the
  -- form: the type names the item, except for 'other', which is named by
  -- whatever type the person typed in.
  name VARCHAR(255) NOT NULL,
  type VARCHAR(30) NOT NULL,
  brand VARCHAR(255) DEFAULT '',
  model VARCHAR(255) DEFAULT '',
  serial_number VARCHAR(255) DEFAULT '',
  -- A data: URL, shrunk in the browser before it is sent. Kept on the row
  -- rather than on Drive: it is one small picture per item, and it has to
  -- survive without the Drive credentials being in play.
  photo LONGTEXT DEFAULT NULL,
  -- `condition` is a reserved word in MySQL 8, hence the prefix.
  item_condition VARCHAR(20) DEFAULT 'good',
  -- available / assigned / damaged / retired. Only 'available' can be handed
  -- out; where a returned item lands is decided by the return reason.
  status VARCHAR(20) DEFAULT 'available',
  notes TEXT,
  created_by INT DEFAULT NULL,
  is_deleted TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_inventory_status (status),
  INDEX idx_inventory_type (type)
);

-- One spell of somebody holding an item. Closed by a return rather than
-- deleted, so the register keeps the history of who held what.
CREATE TABLE IF NOT EXISTS inventory_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_id INT NOT NULL,
  user_id INT NOT NULL,
  assigned_by INT NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  returned_at DATETIME DEFAULT NULL,
  -- active -> pending_handover (someone has said it is coming back) ->
  -- returned (the custodian has it in hand again).
  handover_status VARCHAR(20) DEFAULT 'active',
  handover_notes TEXT,
  -- Why the spell ended. It decides where the item lands afterwards:
  -- damaged/retired take it out of circulation, offboarding sends it back to
  -- available stock.
  return_reason VARCHAR(20) DEFAULT NULL,
  INDEX idx_inv_assign_item (item_id),
  INDEX idx_inv_assign_user (user_id),
  INDEX idx_inv_assign_status (handover_status)
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
  -- Whose doing this correction is: 'designer', 'client', or 'change' for a
  -- change the client has asked for, which is nobody's mistake. Kept apart
  -- from client_note because that is what was asked for and this is why there
  -- was anything to ask - the office wants to count the first two and not the
  -- third, and reading that out of free text is guesswork.
  fault VARCHAR(20),
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

-- =============================================
-- APPROVAL HISTORY
-- Every time the client answers on an order, with the day they answered.
--
-- orders.actual_2 holds one date, so a second approval wrote over the first:
-- an order approved as a Sample in July and again for production in September
-- kept only September, and July was gone from the system entirely. That has
-- already happened on 66 orders.
--
-- One row per answer. actual_2 stays as it is - it is the latest, which is
-- what every board that asks "when did this reach production" wants - and this
-- is the record behind it.
-- =============================================
CREATE TABLE IF NOT EXISTS order_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL,
  status VARCHAR(100) NOT NULL,
  approved_at DATETIME NOT NULL,
  approved_by VARCHAR(150),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_appr_order (order_id),
  INDEX idx_appr_when (approved_at),
  -- Guards the exact repeat only. The same answer twice on the same day is one
  -- answer and not two, but the key sees the whole timestamp and two saves an
  -- hour apart are two different keys - logApproval() matches on the day.
  UNIQUE KEY uq_appr_day (order_id, status, approved_at)
);

-- =============================================
-- ADD ONS
-- The extra cards an order can carry beside the invitation itself - an RSVP
-- card, a menu card, a map. The list is the office's, not the code's: it is a
-- table so a new card can be added from Manage Data without a deploy.
-- =============================================
CREATE TABLE IF NOT EXISTS add_ons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  added_by VARCHAR(150),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_add_on_name (name)
);

-- =============================================
-- WHAT EACH ORDER ORDERED
-- One row per add-on on an order, with how many of it. A child table rather
-- than a column: an order takes as many add-ons as it takes, and a list packed
-- into one column cannot be counted, filtered or totalled later.
--
-- The name is stored, not a link to add_ons. Renaming a card in Manage Data
-- must not rewrite what was ordered last March, the same way an order keeps
-- the dealer name it was punched with.
-- =============================================
CREATE TABLE IF NOT EXISTS order_add_ons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  qty INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order_add_ons (order_id),
  -- The same card twice on one order is one line with a bigger number.
  UNIQUE KEY uq_order_add_on (order_id, name)
);

-- =============================================
-- PROSPECTS
-- The dealers and stationers the office is working on: who they are, how to
-- reach them, what has been sent and whether anything came back.
--
-- It arrived as one 928-row spreadsheet that several people had been adding
-- to for years, which is why the columns read the way they do - they are the
-- sheet's own, kept recognisable so whoever has been maintaining it can see
-- their own work in here. Nothing from it is dropped; a column nobody can
-- explain yet is still somebody's note about a customer.
--
-- Separate from `dealers`, which is the short list of people who actually
-- place orders and is wired into the order form. These 928 are mostly not
-- that yet, and merging the two would put every cold lead in the dealer
-- dropdown.
-- =============================================
CREATE TABLE IF NOT EXISTS prospects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(200) DEFAULT NULL,

  address VARCHAR(400) DEFAULT NULL,
  city VARCHAR(120) DEFAULT NULL,
  state VARCHAR(120) DEFAULT NULL,
  country VARCHAR(120) DEFAULT NULL,
  zipcode VARCHAR(40) DEFAULT NULL,

  phone VARCHAR(80) DEFAULT NULL,
  cell VARCHAR(80) DEFAULT NULL,
  second_phone VARCHAR(80) DEFAULT NULL,
  fax VARCHAR(80) DEFAULT NULL,
  email VARCHAR(255) DEFAULT NULL,
  second_email VARCHAR(255) DEFAULT NULL,

  website VARCHAR(400) DEFAULT NULL,
  facebook VARCHAR(400) DEFAULT NULL,
  instagram VARCHAR(400) DEFAULT NULL,

  -- Active, Inactive, Prospect, MailChimp Bounced, and the rest. Free text
  -- rather than an enum: the sheet holds seventeen spellings of five or six
  -- real answers, and deciding which are the same is the office's call, not
  -- a migration's.
  status VARCHAR(120) DEFAULT NULL,
  -- "ARB Pricing" or "KPC Pricing" - the same two brands the pricing
  -- calculator quotes against.
  pricing VARCHAR(60) DEFAULT NULL,
  -- Where the lead came from: Bella Figura Data, The Wed Data, a referral.
  lead_source VARCHAR(160) DEFAULT NULL,

  -- What was sent and what came back. Three sample columns because the sheet
  -- has three, each a different round with its own date written into it.
  sample_1 TEXT, sample_2 TEXT, sample_3 TEXT,
  text_message_sent VARCHAR(255) DEFAULT NULL,
  -- "mail not found", "no revert", "replied". 264 of these are dead
  -- addresses, which is worth knowing before anybody sends to them again.
  mail_outcome VARCHAR(255) DEFAULT NULL,
  outreach_note TEXT,
  comments TEXT,

  -- Set where the sheet gave no company name and the import used the
  -- contact person's instead, so those rows can be found and finished
  -- rather than quietly passing as complete.
  needs_name TINYINT(1) DEFAULT 0,

  -- The row this came from, so a question about one can be traced back to
  -- the spreadsheet it was imported from.
  source_row INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_prospect_name (company_name),
  INDEX idx_prospect_where (country, state, city),
  INDEX idx_prospect_status (status)
);

-- =============================================
-- PRICING QUOTES
-- What a job was quoted at, kept rather than retyped.
--
-- The calculator the client wrote works the price out in the browser. The
-- figures here are the ones the SERVER worked out from the same rules - the
-- browser's numbers are read, checked against a fresh calculation and
-- refused if they disagree. A quote that can be edited on its way to the
-- database is not a quote, and these are the numbers somebody will invoice
-- against later.
--
-- order_id is text, not a number: this office's orders are K-160108, and the
-- module's own table declared it INT because the system it came from
-- numbered them differently.
--
-- quote_json holds what was asked for - every component, quantity, layer and
-- ink - so a quote can be reopened and amended instead of rebuilt. The rates
-- change; rates_version records which list priced this one, so an old quote
-- can still be explained.
-- =============================================
CREATE TABLE IF NOT EXISTS pricing_quotes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(50) DEFAULT NULL,
  brand VARCHAR(10) NOT NULL,
  store_name VARCHAR(200) DEFAULT NULL,
  customer_name VARCHAR(200) DEFAULT NULL,
  total DECIMAL(18,2) NOT NULL,
  base_discount_amount DECIMAL(18,2) NOT NULL,
  additional_discount_amount DECIMAL(18,2) NOT NULL,
  -- Added after both discounts, not taken off. Kept as its own figure so an
  -- old quote can still be explained: the balance alone cannot say whether a
  -- job was priced in a hurry.
  rush_fee_percent DECIMAL(6,2) DEFAULT 0,
  rush_fee_amount DECIMAL(18,2) DEFAULT 0,
  balance DECIMAL(18,2) NOT NULL,
  summary_text MEDIUMTEXT,
  quote_json MEDIUMTEXT,
  rates_version VARCHAR(20) DEFAULT NULL,
  created_by VARCHAR(150) DEFAULT NULL,
  -- Where the quote was priced. "internal" is somebody on the Pricing tab;
  -- "public" is a customer on one of the two brand links, who gave a name
  -- and an address before the calculator would open.
  source VARCHAR(20) DEFAULT 'internal',
  customer_email VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pricing_order (order_id, created_at),
  INDEX idx_pricing_source (source, created_at),
  INDEX idx_pricing_when (created_at)
);

-- =============================================
-- SETTINGS
-- The few choices the office should be able to change without a deploy. Kept
-- as text against a name so adding the next one costs no migration.
-- =============================================
CREATE TABLE IF NOT EXISTS app_settings (
  name VARCHAR(60) NOT NULL PRIMARY KEY,
  value VARCHAR(255),
  updated_by VARCHAR(150),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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

-- =============================================
-- RECRUITMENT — the hiring pipeline, and the letters it sends
--
-- `employees` next door is people already on the payroll. This is the step
-- before: somebody being interviewed, what came of it, and — once they are
-- selected — the details they send back before their first day.
--
-- Four tables rather than one, because they answer four different questions
-- and only the first of them is ever edited by hand.
-- =============================================
CREATE TABLE IF NOT EXISTS recruit_candidates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) DEFAULT '',
  profile_position VARCHAR(255) DEFAULT '',
  -- Who is taking the interview, typed in when it is booked. They get their
  -- own letter, carrying the candidate's phone and email.
  interviewer_email VARCHAR(255) DEFAULT '',
  interview_date DATE DEFAULT NULL,
  interview_time VARCHAR(20) DEFAULT '',
  -- Where it is held. 'offline' at the office, 'online' over a meeting link,
  -- and the link itself when it is the second. Blank reads as offline: that is
  -- what every interview booked before this was, and guessing otherwise would
  -- send old candidates a letter with no address and no link.
  interview_mode VARCHAR(10) DEFAULT '',
  interview_link VARCHAR(500) DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'Scheduled',
  reschedule_date DATE DEFAULT NULL,
  reschedule_time VARCHAR(20) DEFAULT '',
  reschedule_reason TEXT,
  joining_date DATE DEFAULT NULL,
  salary VARCHAR(100) DEFAULT '',
  -- Where the candidate is now, which is not where the job is: work_location
  -- below is the office the offer letter names. Somebody in Delhi applying to
  -- Jaipur is the whole reason this column is worth having.
  current_location VARCHAR(255) DEFAULT '',
  -- Free text on purpose - "30 days", "Immediate", "serving, till 12 Nov".
  notice_period VARCHAR(60) DEFAULT '',
  -- What the offer letter needs and the interview never asked for. Typed when
  -- the offer is sent, and kept, so sending it a second time does not make
  -- somebody remember what they put the first time.
  department VARCHAR(255) DEFAULT '',
  work_location VARCHAR(255) DEFAULT '',
  offer_valid_till DATE DEFAULT NULL,
  offer_sent_at DATETIME DEFAULT NULL,
  notes TEXT,
  -- Where the name came from: a job board, an agency. On the office's own
  -- sheet before it was on this table, and worth keeping - it is the only
  -- thing that can later answer which source is worth paying for.
  sourcing VARCHAR(160) DEFAULT '',
  -- The caller's own words about the last call, and strictly internal.
  --
  -- Not `notes`, which looks like the obvious home for it and is the wrong
  -- one: that column is printed into the interview invitation, so filing
  -- "not responding" or "zero knowledge of excel" there would email it to
  -- the candidate. Nothing reads this one into a letter.
  internal_remark TEXT,
  -- The onboarding form is opened by a link, not a login, so this token is the
  -- credential. One per candidate, made the first time the form is sent and
  -- kept afterwards, so sending it twice sends the same form.
  joining_form_token VARCHAR(64) DEFAULT NULL,
  joining_form_sent_at DATETIME DEFAULT NULL,
  created_by INT DEFAULT NULL,
  is_deleted TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recruit_token (joining_form_token),
  INDEX idx_recruit_status (status),
  INDEX idx_recruit_interview (interview_date)
);

-- Every letter this section sent, and why it failed when it did.
--
-- Not optional. Email fails quietly — a mistyped address, SMTP refusing, an
-- app password that expired — and without this the first anybody hears of a
-- bounced invitation is a candidate who never turned up. A failed one can be
-- sent again from the page.
CREATE TABLE IF NOT EXISTS recruit_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  candidate_id INT DEFAULT NULL,
  candidate_name VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  action VARCHAR(255) DEFAULT '',
  subject VARCHAR(500) DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'Failed',
  error_detail TEXT,
  retry_count INT DEFAULT 0,
  last_retry_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_recruit_msg_cand (candidate_id),
  INDEX idx_recruit_msg_status (status)
);

-- What a selected candidate sends back through the onboarding form.
--
-- One row per candidate, so filling the form in a second time replaces the
-- first answer rather than leaving two records and no way to tell which is
-- believed. The documents themselves are in recruit_files below.
CREATE TABLE IF NOT EXISTS recruit_joining (
  id INT AUTO_INCREMENT PRIMARY KEY,
  candidate_id INT NOT NULL,
  full_name VARCHAR(255) DEFAULT '',
  emp_mobile VARCHAR(20) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  dob DATE DEFAULT NULL,
  -- Two people to reach. The relation is free text because the form's list
  -- ends in an "Other" the candidate types into — an uncle or a cousin is
  -- still the person to call.
  guardian1_name VARCHAR(255) DEFAULT '',
  guardian1_relation VARCHAR(100) DEFAULT '',
  guardian1_mobile VARCHAR(20) DEFAULT '',
  guardian2_name VARCHAR(255) DEFAULT '',
  guardian2_relation VARCHAR(100) DEFAULT '',
  guardian2_mobile VARCHAR(20) DEFAULT '',
  street VARCHAR(500) DEFAULT '',
  city VARCHAR(255) DEFAULT '',
  state VARCHAR(255) DEFAULT '',
  pincode VARCHAR(20) DEFAULT '',
  aadhaar_no VARCHAR(20) DEFAULT '',
  pan_no VARCHAR(20) DEFAULT '',
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recruit_joining_candidate (candidate_id)
);

-- The documents a new hire uploads: the CV, and the Aadhaar and PAN cards -
-- each of those being either one PDF or two photographs, front and back.
--
-- The bytes are kept here rather than on disk, because this app has no disk it
-- can rely on: it runs as a serverless function, where anything written to the
-- filesystem is gone by the next request. The same reasoning as the equipment
-- photo on inventory_items above, and for one reason more: a document can only
-- be reached by a query, so the login is the only way in. There is no folder
-- to share by mistake and no public URL to guess at, which for an Aadhaar
-- matters more than the convenience of a link. They are also inside the
-- nightly dump, which files sitting beside the app would not be.
--
-- Their own table, not five columns on recruit_joining. That row is read every
-- time the panel is opened and joined against on the candidate list; blobs
-- sitting in it would drag several megabytes through queries that only wanted
-- a name and a date. Here nothing reads the bytes until somebody opens the
-- document itself.
--
-- One row per candidate per document, so re-uploading replaces what was there
-- rather than leaving the old Aadhaar behind with nothing pointing at it.
CREATE TABLE IF NOT EXISTS recruit_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  candidate_id INT NOT NULL,
  -- Which of the five: resume_file, aadhaar_file, aadhaar_file_2, pan_file,
  -- pan_file_2. The route checks it against that list before it ever reaches
  -- a query.
  field VARCHAR(30) NOT NULL,
  file_name VARCHAR(255) DEFAULT '',
  mime_type VARCHAR(120) DEFAULT '',
  size_bytes INT DEFAULT 0,
  -- MEDIUMBLOB holds 16MB; the form refuses anything over 4MB, and shrinks
  -- photographs in the browser long before that.
  bytes MEDIUMBLOB NOT NULL,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recruit_file (candidate_id, field),
  INDEX idx_recruit_file_cand (candidate_id)
);

-- =============================================
-- PMS - THE STEP CATALOGUE
-- What the steps of an order are, in order. One row per step.
--
-- The orders table already carries this flow, but as eighty columns -
-- paper_cutting, paper_cutting_actual_time, dye_status, block_status and so
-- on. That shape is why nothing can be added without a migration, and why
-- every stage of an order gets stamped at the same second: there is one form
-- holding all of them, so the floor fills it once at the end. 92% of orders
-- with five production stages filled have all five within the same minute.
--
-- Rows instead of columns. A new step is an INSERT, and each one can be timed,
-- assigned and chased on its own.
--
-- This deliberately does not point at a Google Sheet the way fms_steps does.
-- Those rows store a column LETTER (plan_col 'I', actual_col 'J'), which goes
-- quietly wrong the moment somebody inserts a column in the sheet - the same
-- failure that broke the SCOT grid and the calling-date format twice over. The
-- order is already in this database; the steps belong beside it.
CREATE TABLE IF NOT EXISTS pms_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Position in the flow. Not the primary key: steps get reordered, and a
  -- row already written against a step must not follow it.
  step_order INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  -- NULL means the step runs on every order. Otherwise a key the engine
  -- knows (see utils/pms/engine.js CONDITIONS) deciding whether this order
  -- needs it - die cutting is on 3% of orders, laser on 1%, so most orders
  -- must skip most of production rather than sit pending forever.
  --
  -- A key, not SQL: a condition stored as SQL is a condition nobody can read
  -- on the admin screen, and one a typo turns into a query error at punch.
  condition_key VARCHAR(40) DEFAULT NULL,
  -- Who answers for it, by role. The person comes from pms_step_doers; this
  -- is the fallback that decides whose board it shows on when nobody is named.
  doer_role VARCHAR(60) DEFAULT '',
  -- Working days allowed. NULL means NOT YET KNOWN, and the engine leaves the
  -- planned date empty rather than inventing one.
  --
  -- Most of these are NULL on purpose. The time each production stage really
  -- takes cannot be recovered from the old data - every stage is stamped in
  -- one submit, so the gap between them reads as zero. Guessing here would put
  -- a confident wrong number on every board. They get filled from the floor.
  tat_days DECIMAL(5,2) DEFAULT NULL,
  -- Off, without deleting: a step switched off stops being created for new
  -- orders while the rows already written against it stay readable.
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(255) DEFAULT '',
  updated_by VARCHAR(150) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pms_step_order (step_order)
);

-- People named on a step. A step with nobody named falls to its doer_role.
CREATE TABLE IF NOT EXISTS pms_step_doers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT NOT NULL,
  user_id INT NOT NULL,
  UNIQUE KEY uq_pms_step_doer (step_id, user_id),
  INDEX idx_pms_doer_user (user_id)
);

-- =============================================
-- PMS - A STEP ON ONE ORDER
-- One row per order per step: when it was due, when it was done, by whom.
CREATE TABLE IF NOT EXISTS pms_order_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(20) NOT NULL,
  step_id INT NOT NULL,
  -- Copied from the step when the row is made. The catalogue gets reordered;
  -- an order already running must keep the order it started with, or its
  -- board reshuffles under the floor mid-job.
  step_order INT NOT NULL,
  step_name VARCHAR(120) NOT NULL,

  -- waiting  - earlier steps are not done, so this is not anybody's job yet
  -- pending  - open, waiting on its doer
  -- done     - finished, actual_at is set
  -- skipped  - the condition said no; the next step opened straight away
  status VARCHAR(12) NOT NULL DEFAULT 'waiting',

  -- When it became due. Step one counts from the order date; every later step
  -- counts from the previous step's actual. NULL where the step has no TAT
  -- yet - an empty date says "not known", where a made-up one would say
  -- "late" on a board the floor is meant to trust.
  planned_at DATETIME DEFAULT NULL,
  -- When it opened. Kept apart from planned_at so a step that opened late is
  -- not confused with one that was done late.
  opened_at DATETIME DEFAULT NULL,
  actual_at DATETIME DEFAULT NULL,

  -- Who finished it. Name as well as email because people leave and a board
  -- read a year later should still say who did the work.
  doer_email VARCHAR(150) DEFAULT '',
  doer_name VARCHAR(150) DEFAULT '',
  remark TEXT,
  -- Why it was late, asked for only once planned_at has passed.
  delay_reason TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One row per step per order. Makes creating an order's steps safe to
  -- repeat: a retry cannot give the floor the same step twice.
  UNIQUE KEY uq_pms_order_step (order_id, step_id),
  INDEX idx_pms_os_order (order_id),
  INDEX idx_pms_os_status (status),
  INDEX idx_pms_os_planned (planned_at),
  INDEX idx_pms_os_doer (doer_email)
);
