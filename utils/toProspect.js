/**
 * MARKING A SHOP ACTIVE PUTS IT ON THE PROSPECTS LIST.
 *
 * The two competitor lists are piles to work through: 7,041 Carlson Craft
 * retailers and 395 Bella Figura dealers, nearly all of them untouched.
 * Marking one Active is the office saying "this one is worth going after",
 * and going after it means samples, outreach, bounced mail and notes - all
 * of which live on the Prospects list and none of which those two tables
 * have anywhere to put.
 *
 * So the row is OPENED ON THE PROSPECTS LIST, and the shop stays on the list
 * it came from. Not moved: the Carlson Craft list is a record of a page read
 * on a particular day, traced back to it row by row, and 7,041 that quietly
 * becomes 6,800 is a list that can no longer be checked against its source.
 * The row keeps a prospect_id instead, which is how both screens say "this
 * one is already on Prospects" and link across to it.
 *
 * NOTHING IS OPENED TWICE. Marking Active again, or in a batch of two
 * hundred, finds the prospect already linked and leaves it alone. A company
 * of the same name in the same town that is ALREADY on the Prospects list is
 * linked rather than duplicated - the office has been working that list for
 * years and some of these shops will already be on it.
 *
 * Nothing on an existing prospect is overwritten. What is on that row is the
 * office's own work; this only ever adds rows that were not there.
 */

/** Trimmed, cut to the column, or null. */
function text(v, n) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s ? s.slice(0, n) : null;
}

/** The street and the flat as one line, which is all `prospects` has. */
function oneLine(address, suite) {
  return text([address, suite].map(v => String(v || '').trim()).filter(Boolean).join(', '), 400);
}

/**
 * A Carlson Craft retailer as a prospect.
 *
 * Every one of the fifty-two sheets is a US state, so the country is not a
 * guess. The office's own remark goes to outreach_note and the source's
 * notes to comments: they are two different people's writing and merging
 * them would lose which was which.
 */
function fromCc(r) {
  return {
    company_name: text(r.retailer, 255),
    address: oneLine(r.address, r.suite),
    city: text(r.city, 120),
    state: text(r.state, 120),
    country: 'USA',
    zipcode: text(r.zip, 40),
    phone: text(r.phone, 80),
    email: text(r.email, 255),
    website: text(r.website, 400),
    status: 'Prospect',
    lead_source: 'Carlson Craft List',
    outreach_note: text(r.remark, 2000),
    comments: text(r.notes, 2000),
  };
}

/** A Bella Figura dealer as a prospect. */
function fromBf(r) {
  // Worth carrying over: it decides whether somebody can be walked in on or
  // has to be written to first, and the Prospects list has no column of its
  // own for it.
  const policy = text(r.visitor_policy, 160);
  return {
    company_name: text(r.store_name, 255),
    address: oneLine(r.address, r.suite),
    city: text(r.city, 120),
    state: text(r.state, 120),
    country: text(r.country, 120),
    zipcode: text(r.zip, 40),
    phone: text(r.phone, 80),
    email: text(r.email, 255),
    website: text(r.website, 400),
    instagram: text(r.instagram, 400),
    facebook: text(r.facebook, 400),
    status: 'Prospect',
    lead_source: 'Bella Figura Data',
    outreach_note: text(r.remark, 2000),
    comments: policy,
  };
}

const SHAPE = { cc: fromCc, bf: fromBf };

/**
 * Open these rows on the Prospects list, and say which prospect each became.
 *
 * Takes rows already read from cc_prospects or bf_prospects - whole rows,
 * because the mapping above needs most of the columns - and returns a Map of
 * source row id to prospect id. A row that is already linked, or has no name
 * to open under, is skipped.
 *
 * One row at a time rather than one big INSERT: a batch of two hundred needs
 * each new id to write back against its own source row, and MySQL hands back
 * only the first of a multi-row insert.
 */
async function open(db, kind, rows, user) {
  const shape = SHAPE[kind];
  if (!shape) throw new Error('No such list: ' + kind);
  const table = kind === 'cc' ? 'cc_prospects' : 'bf_prospects';
  const made = new Map();

  for (const r of rows) {
    if (r.prospect_id) continue;
    const row = shape(r);
    if (!row.company_name) continue;

    // Already on the list under the same name in the same town. Linked, not
    // copied: two rows for one shop is how two people end up sending the
    // same samples a week apart.
    const [[seen]] = await db.query(
      `SELECT id FROM prospects
        WHERE LOWER(company_name) = LOWER(?)
          AND LOWER(IFNULL(city, '')) = LOWER(IFNULL(?, ''))
        LIMIT 1`,
      [row.company_name, row.city]);

    let id = seen && seen.id;
    if (!id) {
      const cols = Object.keys(row).filter(c => row[c] !== null && row[c] !== undefined);
      const [ins] = await db.query(
        `INSERT INTO prospects (${cols.map(c => `\`${c}\``).join(', ')})
         VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map(c => row[c]));
      id = ins.insertId;
    }

    await db.query(`UPDATE ${table} SET prospect_id = ? WHERE id = ?`, [id, r.id]);
    made.set(r.id, id);
  }
  return made;
}

module.exports = { open, fromCc, fromBf };
