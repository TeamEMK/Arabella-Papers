/**
 * Gives every liner a name of its own.
 *
 *   node scripts/code-envelope-linears.js            # say what it would do
 *   node scripts/code-envelope-linears.js --write    # do it
 *   node scripts/code-envelope-linears.js --write --db arabella_envlin_browse
 *
 * CT-FB-01 is the first design in Floral & Botanical, which is in Classic &
 * Traditional. See utils/linerCode.js for where the letters come from.
 *
 * Only ever fills in a blank. A code that is already on a row is left exactly
 * as it is, because a code that has been read out to a customer has to go on
 * meaning the same design - this can be run again after an import or after a
 * category is added, and it will not shuffle anything that was already named.
 *
 * Never writes to live unless LIVE_DB_URL is given on purpose; by default it
 * talks to whatever DB_NAME says, which is the dev copy.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const { codeFor, clashes } = require('../utils/linerCode');
const { connectLive } = require('../utils/liveDb');

const WRITE = process.argv.includes('--write');
// Live only when it is asked for in so many words. There is no default
// that reaches it and no flag that reaches it by accident.
const LIVE = process.argv.includes('--live');
const dbArg = process.argv.indexOf('--db');
const DB = dbArg > -1 ? process.argv[dbArg + 1] : process.env.DB_NAME;
const NL = String.fromCharCode(10);

(async () => {
  const conn = LIVE ? await connectLive(mysql) : await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: DB,
  });

  console.log('Database: ' + (LIVE ? 'LIVE' : DB));

  const [cats] = await conn.query(
    `SELECT id, section, category FROM envelope_linears
      ORDER BY section_order, sort_order, id`);

  // Two categories sharing a prefix would mean two designs sharing a code,
  // and a code that means two things is worse than no code at all. Stopped
  // here rather than written and found later.
  const bad = clashes(cats.map(c => [c.section, c.category]));
  if (bad.length) {
    console.error(NL + 'Two categories would share a prefix, so nothing was written:');
    bad.forEach(b => console.error('  ' + b));
    process.exit(1);
  }

  let named = 0, already = 0;
  const plan = [];

  for (const cat of cats) {
    const [rows] = await conn.query(
      `SELECT id, code FROM envelope_linear_items
        WHERE category_id = ? ORDER BY sort_order, id`, [cat.id]);
    if (!rows.length) continue;

    // The highest number already handed out in this category, so a re-run
    // after somebody deleted the fifth of eighteen adds a nineteenth rather
    // than quietly reusing the gap.
    let highest = 0;
    for (const r of rows) {
      const m = /-(\d+)$/.exec(String(r.code || ''));
      if (m) highest = Math.max(highest, Number(m[1]));
    }

    for (const r of rows) {
      if (String(r.code || '').trim()) { already++; continue; }
      highest++;
      const code = codeFor(cat.section, cat.category, highest);
      plan.push([r.id, code]);
      named++;
    }
    const first = plan.length ? plan[plan.length - 1][1] : '';
    if (first) {
      console.log('  ' + String(cat.category).padEnd(36)
        + rows.length + ' designs, up to ' + first);
    }
  }

  console.log(NL + named + ' to name, ' + already + ' already named.');

  if (!WRITE) {
    console.log(named
      ? 'Nothing was written. Run it again with --write.'
      : 'Nothing to do.');
    await conn.end();
    return;
  }

  for (const [id, code] of plan) {
    await conn.query('UPDATE envelope_linear_items SET code = ? WHERE id = ?', [code, id]);
  }

  // Each category remembers how far it got, so the next design added through
  // the screen carries on from here rather than starting again.
  //
  // Run EVERY time, not only when something was named. A database whose
  // designs were all named before this counter existed would otherwise sit
  // on a counter of zero, and the first design added after the first
  // deletion would be handed a number that was already in use.
  await conn.query(
    `UPDATE envelope_linears c
        SET code_next = GREATEST(COALESCE(c.code_next, 0), COALESCE((
              SELECT MAX(CAST(SUBSTRING_INDEX(i.code, '-', -1) AS UNSIGNED))
                FROM envelope_linear_items i
               WHERE i.category_id = c.id AND i.code REGEXP '-[0-9]+$'), 0))`);

  // Said back from the table rather than from the plan: the point of the
  // check is that the rows really are all different, not that the list we
  // meant to write was.
  const [[count]] = await conn.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT code) AS d
       FROM envelope_linear_items WHERE code <> ''`);
  console.log('Written. ' + count.n + ' named designs, ' + count.d + ' different names.');
  if (count.n !== count.d) {
    console.error('TWO DESIGNS SHARE A NAME. Look before trusting any of them.');
    process.exit(1);
  }
  await conn.end();
})().catch(e => { console.error(e); process.exit(1); });
