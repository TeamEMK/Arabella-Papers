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
// ══════════════════════════════════════════════════════
const db = require('../config/db');

const MESSAGE = 'Upload the vector file first — Proofing Done cannot be set without it.';

/** Does this order already have artwork against it? */
async function hasVector(orderId) {
  const [[row]] = await db.query(
    'SELECT COUNT(*) AS n FROM order_vector_files WHERE order_id = ?', [orderId]);
  return row.n > 0;
}

/**
 * Whether one order may be marked Proofing Done.
 *
 * `uploading` is true when a vector file is arriving in the same submission -
 * the ordinary way it happens, somebody attaching the artwork and marking it
 * done in one go.
 *
 * @returns {Promise<string|null>} the message to refuse with, or null to allow
 */
async function blockProofing(orderId, uploading) {
  if (uploading) return null;
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

  const [withFiles] = await db.query(
    'SELECT DISTINCT order_id FROM order_vector_files WHERE order_id IN (?)', [ids]);
  const have = new Set(withFiles.map(r => r.order_id));
  const missing = ids.filter(id => !have.has(id));
  if (!missing.length) return null;

  return 'These have no vector file yet, so Proofing Done cannot be set on them: '
    + missing.slice(0, 10).join(', ')
    + (missing.length > 10 ? ` and ${missing.length - 10} more` : '')
    + '. Open each one and attach the vector file.';
}

module.exports = { MESSAGE, hasVector, blockProofing, blockProofingMany };
