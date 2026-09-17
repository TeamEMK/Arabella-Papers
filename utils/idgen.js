const db = require('../config/db');

const PREFIX = 'K-';
const START = 150000;

/**
 * The highest plain order number taken so far.
 *
 * Only ids that are the prefix and digits and nothing else are counted. A
 * repeat of an order carries a suffix - K-159295-R1 - and reading one of those
 * as the top of the range would hand the next punch a number that is already
 * on the table.
 *
 * MAX over the numbers rather than whichever row was inserted last, which is
 * the same answer on an ordinary day and the right one on the days it is not:
 * a repeat saved after this morning's punch, or a row imported out of order,
 * both make "the last row" the wrong place to look.
 */
async function nextNumber() {
  const [[row]] = await db.query(
    `SELECT MAX(CAST(SUBSTRING(order_id, ${PREFIX.length + 1}) AS UNSIGNED)) AS top
       FROM orders
      WHERE order_id REGEXP '^${PREFIX}[0-9]+$'`
  );

  const top = Number(row && row.top);
  return !top || top < START ? START : top + 1;
}

/**
 * Generates next sequential order ID (K-150000, K-150001...)
 */
async function generateOrderId() {
  return PREFIX + await nextNumber();
}

/**
 * Generates `count` consecutive IDs from a single lookup. Calling
 * generateOrderId() in a loop would re-read the table for every row, and each
 * read only sees rows already committed — fine one at a time, needlessly slow
 * for an import of a few hundred.
 */
async function generateOrderIds(count) {
  const start = await nextNumber();
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(PREFIX + (start + i));
  return ids;
}

/**
 * The order this one is a repeat of, stripped back to the number the office
 * uses. A reprint of a reprint still hangs off the original: the client and
 * the invoice both say 159295, and K-159295-R1-R1 says nothing to anybody.
 */
function rootOrderId(orderId) {
  return String(orderId || '').trim().replace(/-R\d+$/i, '');
}

/**
 * The id for a repeat of an existing order: K-159295-R1, then -R2.
 *
 * The number is kept so the new entry can be read at a glance as the same job
 * again - that is how the floor, the dealer and the invoice all refer to it -
 * and the suffix says which run. Counting the repeats already on the table
 * rather than keeping a column of it, so a deleted one cannot leave a gap that
 * hands out an id twice.
 */
async function remakeOrderId(parentId) {
  const root = rootOrderId(parentId);
  const [rows] = await db.query(
    'SELECT order_id FROM orders WHERE order_id LIKE ?',
    [root + '-R%'],
  );

  let highest = 0;
  for (const r of rows) {
    const m = /-R(\d+)$/i.exec(r.order_id || '');
    if (m) highest = Math.max(highest, parseInt(m[1], 10));
  }
  return `${root}-R${highest + 1}`;
}

module.exports = { generateOrderId, generateOrderIds, remakeOrderId, rootOrderId };
