/**
 * The address fields on the two prospect lists, and what may be written to
 * them.
 *
 * Both lists came out of a workbook and both were read-only to begin with:
 * the status and the remark were the office's own, the rest was the source
 * file and was left alone so a row could always be traced back to it. The
 * office then asked for the address to be shown broken up - street, flat,
 * state, ZIP - and to be able to correct it, because a list of seven
 * thousand shops read off somebody else's website has wrong addresses in it,
 * and because the Carlson Craft sheet never had a flat number column at all.
 *
 * So the rule is: these five may be corrected, nothing else, and the row
 * records who last did it. source_row still points at where it started,
 * which is what the old restriction was really protecting.
 *
 * ONLY WHAT WAS SENT IS WRITTEN. A box left out of the request is not the
 * same as a box emptied, and the edit screen sends every field it shows - so
 * a request carrying only a status cannot blank an address.
 */

// column -> how long the column is.
const FIELDS = {
  address: 400,   // the street line
  suite: 120,     // flat, suite, unit
  city: 120,
  state: 80,
  zip: 20,
};

/**
 * The address columns to write, from whatever the screen sent.
 *
 * Returns { set } - possibly empty - or { error }. An empty string is a real
 * answer here and clears the column: "no address published" is something 72
 * of these rows genuinely say, and a box that cannot be emptied again is a
 * box nobody can correct a mistake in.
 */
function fromBody(body) {
  const set = {};
  for (const [col, max] of Object.entries(FIELDS)) {
    if (!body || body[col] === undefined) continue;
    const v = body[col];
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') {
      return { error: 'The ' + col + ' could not be read.' };
    }
    const s = String(v === null ? '' : v).trim();
    if (s.length > max) {
      return { error: 'The ' + col + ' is too long - ' + max + ' characters at most.' };
    }
    set[col] = s || null;
  }
  return { set };
}

module.exports = { FIELDS, fromBody };
