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
//
// ── ONE ARCHIVE TABLE, NOT TWO ──
//
// `deleted_records` is NOT this file's table. It belongs to the Tasks
// module (modules/tasks/schema.sql), which has been copying deleted tasks,
// comments and users into it since the 5th of November. This file writes
// into the same one, in the same columns.
//
// Said plainly because getting it wrong cost the office a day: this file
// first shipped with columns of its own invention (table_name, payload,
// route...) and a CREATE TABLE in config/schema.sql to match. On a fresh
// test database that CREATE won, so every test passed; on live the Tasks
// module's table already existed, CREATE IF NOT EXISTS did nothing, and
// every INSERT died on "Unknown column 'table_name'". Deletes failed
// closed - correctly - and the office saw "the server is busy" four times
// in a row with the order still sitting there.
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
/** What a person would call this row: an order number, an email, a name. */
function summaryOf(row) {
  const bits = [row.order_id, row.code, row.name, row.email, row.username,
    row.client_name, row.dealer_name].filter(Boolean);
  return String(bits.join(' · ') || ('#' + (row.id || '?'))).slice(0, 255);
}

async function keepCopy(table, where, params, req, reason) {
  const [rows] = await db.query(
    'SELECT * FROM `' + table + '` WHERE ' + where, params);
  if (!rows.length) return 0;

  const user = (req && req.session && req.session.user) || {};
  // The office's own id space, not the Tasks module's - they share this
  // column and nothing joins on it, which is why the name and the role are
  // written beside it rather than left to be looked up later.
  const actorId = Number.isInteger(user.id) ? user.id : null;
  const via = String((req && (req.method + ' ' + req.originalUrl)) || '').slice(0, 120);

  for (const row of rows) {
    await db.query(
      `INSERT INTO deleted_records
         (source_table, record_id, record_data, summary,
          deleted_by, deleted_by_name, deleted_by_role, deleted_via, delete_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        table,
        // Only a numeric key goes in this column; an order is K-160697, and
        // the number it would be mangled into is worse than nothing. The id
        // it is known by is in `summary`, which the Tasks module uses the
        // same way.
        Number.isInteger(row.id) ? row.id : null,
        JSON.stringify(tidy(row)),
        summaryOf(row),
        actorId,
        String(user.username || 'unknown').slice(0, 255),
        String(user.role || '').slice(0, 20),
        via,
        String(reason || '') || null,
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
