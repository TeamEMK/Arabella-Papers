// ══════════════════════════════════════════════════════
// A DELETE BUTTON THAT KEEPS THE COPY
//
// Fourteen endpoints in this app end in `DELETE FROM`: an order, a user, a
// catalogue design, a correction, an FMS sheet, a dealer, a leave request.
// The row is gone the moment the button is pressed, and there is nothing
// left to read - not the row, not who pressed it, not when. Three different
// things all look the same afterwards:
//
//   someone deleted the wrong order and said nothing;
//   someone deleted an order on purpose to hide it;
//   the order was never there.
//
// So the row is copied first, into one table, and only then deleted. What
// that buys: a wrong delete can be read back and typed in again, and a
// deliberate one has the deleter's name on it. Both are the point.
//
// THIS FAILS CLOSED, and that is deliberate: if the copy cannot be written,
// the delete does not happen. An archive that quietly skips itself when the
// table is missing is an archive nobody can rely on, which is worse than
// none - the office would believe the copy exists. The route answers with
// its ordinary 500 and the record is still there to try again.
// ══════════════════════════════════════════════════════
const db = require('../config/db');

// Image bytes are not kept. A single catalogue design is up to 16MB of blob,
// and the archive is here so a person can READ what was deleted - the name,
// the dealer, the dates. The picture itself can be uploaded again; a copy of
// every deleted one would be gigabytes of JSON nobody opens.
const MAX_TEXT = 60000;

function tidy(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) out[k] = '[' + v.length + ' bytes of binary, not kept]';
    else if (typeof v === 'string' && v.length > MAX_TEXT) {
      out[k] = v.slice(0, MAX_TEXT) + '… [' + v.length + ' characters, cut]';
    } else out[k] = v;
  }
  return out;
}

/**
 * Copies every row the WHERE matches into deleted_records.
 *
 * Called BEFORE the DELETE, with the same WHERE and the same parameters, so
 * what is kept is exactly what goes. Throws if it cannot write - see the
 * note at the top.
 *
 * @param table  the table being deleted from
 * @param where  the WHERE clause, without the word WHERE
 * @param params its parameters
 * @param req    the request, for who pressed the button
 * @param reason a short note, e.g. 'order deleted by SuperAdmin'
 */
async function keepCopy(table, where, params, req, reason) {
  const [rows] = await db.query(
    'SELECT * FROM `' + table + '` WHERE ' + where, params);
  if (!rows.length) return 0;

  const user = (req && req.session && req.session.user) || {};
  for (const row of rows) {
    await db.query(
      `INSERT INTO deleted_records
         (table_name, record_key, payload, deleted_by, deleted_by_email, route, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        table,
        String(row.order_id || row.id || row.email || '') .slice(0, 191),
        JSON.stringify(tidy(row)),
        String(user.username || 'unknown').slice(0, 191),
        String(user.email || '').slice(0, 191),
        String((req && (req.method + ' ' + req.originalUrl)) || '').slice(0, 255),
        String(reason || '').slice(0, 255),
      ]);
  }
  return rows.length;
}

/** Copy, then delete. The two halves are never written apart by accident. */
async function archiveThenDelete(table, where, params, req, reason) {
  const kept = await keepCopy(table, where, params, req, reason);
  const [res] = await db.query(
    'DELETE FROM `' + table + '` WHERE ' + where, params);
  return { kept, removed: res.affectedRows };
}

module.exports = { keepCopy, archiveThenDelete };
