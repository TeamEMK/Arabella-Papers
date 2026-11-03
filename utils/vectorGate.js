// ══════════════════════════════════════════════════════
// "PROOFING DONE" NEEDS THE VECTOR FILE
//
// The office's rule: a design cannot be called proofed until the print-ready
// artwork is attached to the order.
//
// One rule, one file, because the first version of it was not. It was put on
// the Till Approval route and nowhere else, and FOUR routes can write that
// status - the Orders Dashboard's own Design Status box and its Bulk Update
// go through routes/api/orders.js and were never checked. Anybody using the
// dashboard, which is most people, could set Proofing Done on an order with
// no artwork anywhere near it.
//
// A guard that lives beside one of the doors is not a guard. Everything that
// can write the status calls in here.
//
// ── AND ONE SWITCH, NOT TWO ──
//
// This used to bar Proofing Done on every order, always, while the logout
// hold next door obeyed a start date in the settings. So there was no way to
// relax the rule: emptying the date freed the logout and left this one biting
// on every order in the system, including the thousands finished months
// before the upload box existed.
//
// Both now read the same setting. Empty means the rule is off and nothing
// here refuses anything; a date means it applies to orders punched on or
// after that day, which is exactly the set the logout hold counts. One lever,
// and the two halves cannot disagree about who it covers.
// ══════════════════════════════════════════════════════
const db = require('../config/db');
const { startDate } = require('./vectorDuty');

const MESSAGE = 'Upload the vector file first — Proofing Done cannot be set without it.';

/** Does this order already have artwork against it? */
async function hasVector(orderId) {
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS n FROM order_vector_files WHERE order_id = ?', [orderId]);
  return row.n > 0;
}

/**
 * Of these orders, the ones the rule actually covers.
 *
 * An order punched before the start date is not covered, however long it has
 * been sitting there - the same reading the nightly count uses. An order the
 * rule has never heard of is nobody's failure.
 *
 * @returns {Promise<Set<string>>} empty when the rule is switched off
 */
async function covered(orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return new Set();

  const from = await startDate();
  if (!from) return new Set();

  const [rows] = await db.query(
    `SELECT order_id FROM orders
      WHERE order_id IN (?) AND is_deleted = 0 AND DATE(timestamp) >= ?`,
    [ids, from]);
  return new Set(rows.map(r => r.order_id));
}

/**
 * Whether one order may be marked Proofing Done.
 *
 * `uploading` is true when a vector file is arriving in the same submission.
 * Nothing sends one that way any more - the screen files the artwork first
 * and saves the status after - but the argument is kept because a caller
 * passing true is asking a question this can still answer honestly.
 *
 * @returns {Promise<string|null>} the message to refuse with, or null to allow
 */
async function blockProofing(orderId, uploading) {
  if (uploading) return null;
  if (!(await covered([orderId])).size) return null;
  return (await hasVector(orderId)) ? null : MESSAGE;
}

/**
 * The same question for a batch.
 *
 * Refused by name rather than silently, because there is nowhere to attach a
 * file in a bulk update and the office needs to know which orders to go and
 * open.
 *
 * @returns {Promise<string|null>}
 */
async function blockProofingMany(orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (!ids.length) return null;

  const inScope = await covered(ids);
  if (!inScope.size) return null;

  const [withFiles] = await db.query(
    'SELECT DISTINCT order_id FROM order_vector_files WHERE order_id IN (?)', [[...inScope]]);
  const have = new Set(withFiles.map(r => r.order_id));
  const missing = [...inScope].filter(id => !have.has(id));
  if (!missing.length) return null;

  return 'These have no vector file yet, so Proofing Done cannot be set on them: '
    + missing.slice(0, 10).join(', ')
    + (missing.length > 10 ? ` and ${missing.length - 10} more` : '')
    + '. Open each one and attach the vector file.';
}

module.exports = { MESSAGE, hasVector, covered, blockProofing, blockProofingMany };
