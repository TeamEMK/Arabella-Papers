const db = require('../config/db');

const PREFIX = 'K-';
const START = 150000;

async function nextNumber() {
  const [rows] = await db.query(
    `SELECT order_id FROM orders ORDER BY id DESC LIMIT 1`
  );

  if (rows.length > 0) {
    const lastId = rows[0].order_id || '';
    if (lastId.startsWith(PREFIX)) {
      const numPart = parseInt(lastId.substring(PREFIX.length), 10);
      if (!isNaN(numPart)) {
        return numPart < START ? START : numPart + 1;
      }
    }
  }

  return START;
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

module.exports = { generateOrderId, generateOrderIds };
