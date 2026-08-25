const db = require('../config/db');

// Only the columns a person actually sets, with the name the office uses for
// them. Everything else the routes write - the *_actual_time stamps, the
// updated_by columns, actual_2 and actual_4 - is bookkeeping the system fills
// in for itself, and logging it would bury the one line that says what changed.
const FIELDS = {
  dealer_name: 'Dealer',
  client_name: 'Client',
  india_designer: 'Designer',
  overseas_designer: 'Designer (Overseas)',
  possible_design_time: 'Design Time',
  special_remarks: 'Special Remarks',
  remarks: 'Remarks',
  design_status: 'Design Status',
  design_approval_status_from_client: 'Client Approval',
  no_of_design_revision: 'Design Revision',
  upload_design: 'Design File',
  revision_design_upload: 'Revision Design File',
  upload_design_file: 'Order File',
  approved_design: 'Approved Design',
  guest_name: 'Guest Name',
  paper_cutting: 'Paper Cutting',
  dye_status: 'Dye Status',
  block_status: 'Block Status',
  printing: 'Printing',
  printing_type: 'Printing Type',
  edges: 'Edges',
  laser_cutting: 'Laser Cutting',
  output: 'Output',
  card_assembly: 'Card Assembly',
  remark: 'Production Remark',
  reason_for_delay: 'Reason For Delay',
  status_4: 'Dispatch Status',
  courier: 'Courier',
  ups_dhl_fedex_tracking_number: 'Tracking / Docket No',
  invoice_number: 'Invoice Number',
  invoice_amount: 'Invoice Amount',
  number_of_boxes: 'Boxes',
  weight: 'Weight',
  volumetric_weight: 'Vol. Weight',
  is_deleted: 'Deleted',
};

function text(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

// Who to write against the change. A session is the honest answer; the email
// the browser posted is the fallback for the routes that only get that.
function actor(user) {
  if (!user) return 'Unknown';
  if (typeof user === 'string') return user;
  return user.username || user.email || 'Unknown';
}

async function insert(rows) {
  if (!rows.length) return;
  await db.query(
    `INSERT INTO order_logs (order_id, action, field, old_value, new_value, changed_by) VALUES ?`,
    [rows.map(r => [r[0], r[1], r[2], r[3].slice(0, 500), r[4].slice(0, 500), r[5]])]
  );
}

/**
 * Record what an update is about to change. Call it BEFORE the UPDATE runs -
 * it reads the current row to work out the "from" side, and after the write
 * there is nothing left to compare against.
 *
 * Only fields that genuinely change are written, so opening a form and saving
 * it untouched leaves no trace, which is what makes the log worth reading.
 *
 * Never throws. A log that cannot be written must not fail the work it
 * describes.
 */
async function logOrderUpdate(orderId, updates, user, action) {
  try {
    const cols = Object.keys(updates || {}).filter(c => FIELDS[c]);
    if (!cols.length) return;

    const [rows] = await db.query(
      `SELECT ${cols.map(c => '`' + c + '`').join(', ')} FROM orders WHERE order_id = ? LIMIT 1`,
      [orderId]
    );
    const before = rows[0] || {};
    const who = actor(user);

    const changed = cols
      .map(col => [col, text(before[col]), text(updates[col])])
      .filter(([, from, to]) => from !== to)
      .map(([col, from, to]) => [orderId, action || 'Updated', FIELDS[col], from, to, who]);

    await insert(changed);
  } catch (err) {
    console.error(`[log] ${orderId}: could not record the update:`, err.message);
  }
}

/**
 * Record something that is not a field edit - an order being created, deleted,
 * or handed to Dispatch.
 */
async function logOrderEvent(orderId, action, detail, user) {
  try {
    await insert([[orderId, action, detail || '', '', '', actor(user)]]);
  } catch (err) {
    console.error(`[log] ${orderId}: could not record "${action}":`, err.message);
  }
}

module.exports = { logOrderUpdate, logOrderEvent, FIELDS };
