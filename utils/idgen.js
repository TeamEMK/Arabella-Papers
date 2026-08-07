const db = require('../config/db');

/**
 * Generates next sequential order ID (K-150000, K-150001...)
 */
async function generateOrderId() {
  const [rows] = await db.query(
    `SELECT order_id FROM orders ORDER BY id DESC LIMIT 1`
  );

  const prefix = 'K-';
  let nextNum = 150000;

  if (rows.length > 0) {
    const lastId = rows[0].order_id || '';
    if (lastId.startsWith(prefix)) {
      const numPart = parseInt(lastId.substring(prefix.length), 10);
      if (!isNaN(numPart)) {
        nextNum = numPart < 150000 ? 150000 : numPart + 1;
      }
    }
  }

  return prefix + nextNum;
}

module.exports = { generateOrderId };
