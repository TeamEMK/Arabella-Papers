/**
 * Works out what every liner should answer to in the search box.
 *
 *   node scripts/tag-envelope-linears.js            # say what it would do
 *   node scripts/tag-envelope-linears.js --write
 *   node scripts/tag-envelope-linears.js --write --db arabella_envlin_browse
 *   node scripts/tag-envelope-linears.js --write --all   # redo ones already done
 *
 * The words are the colours in the picture plus the names of the section and
 * category it sits in, so "blue flower" finds a blue floral liner. See
 * utils/linerTags.js for what that does and does not mean.
 *
 * Two halves, deliberately split. PYTHON LOOKS AT THE PIXELS, because PyMuPDF
 * is already here and Node has nothing that can open a JPEG. It hands back
 * numbers and nothing else. NODE NAMES THEM, because the naming of a colour
 * has to be the same rule the upload path uses, and that rule lives in
 * utils/linerTags.js. Numbers travel between the two; opinions do not.
 *
 * Talks to whatever DB_NAME says unless --db is given, which is the dev copy.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');
const { spawnSync } = require('child_process');
const { colourName, tagsFor } = require('../utils/linerTags');
const { connectLive, liveSettings } = require('../utils/liveDb');

const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');
// Live only when it is asked for in so many words. There is no default that
// reaches it and no flag that reaches it by accident.
const LIVE = process.argv.includes('--live');
const dbArg = process.argv.indexOf('--db');
const DB = dbArg > -1 ? process.argv[dbArg + 1] : process.env.DB_NAME;
const NL = String.fromCharCode(10);
const ROOT = path.join(__dirname, '..');

// Reads the stored thumbnails straight out of MySQL and prints, per design,
// the few colours the picture is actually made of.
//
// The thumbnail rather than the full picture on purpose: it is 280px, it is
// the same image, and it is a tenth of the bytes to pull across.
const PIXELS = [
  'import sys, os, io, json, collections',
  'try:',
  '    import pymupdf',
  'except ImportError:',
  '    import fitz as pymupdf',
  'import pymysql',
  '',
  'conn = pymysql.connect(host=os.environ["H"], port=int(os.environ["P"]),',
  '                       user=os.environ["U"], password=os.environ["W"],',
  '                       database=os.environ["D"], charset="utf8mb4")',
  'ids = json.loads(os.environ["IDS"])',
  'out = {}',
  'with conn.cursor() as cur:',
  '    for i in ids:',
  '        cur.execute("SELECT thumb FROM envelope_linear_items WHERE id = %s", (i,))',
  '        row = cur.fetchone()',
  '        if not row or not row[0]:',
  '            continue',
  '        try:',
  '            pix = pymupdf.Pixmap(io.BytesIO(row[0]))',
  '        except Exception:',
  '            continue',
  '        if pix.n >= 4:',
  '            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)',
  '        w, h, n = pix.width, pix.height, pix.n',
  '        data = pix.samples',
  '        # A HISTOGRAM, AND NOTHING ELSE.',
  '        #',
  '        # This half does not decide anything. It counts how many pixels',
  '        # fall in each coarse box of colour and hands the numbers over,',
  '        # because the naming of a colour is one rule and it lives in',
  '        # utils/linerTags.js, which is JavaScript.',
  '        #',
  '        # Boxes of 16 rather than 32: the first floral in the book is',
  '        # blue hydrangeas, and in boxes of 32 its blues were a tenth of',
  '        # a percent each because they straddled two boxes. Node adds',
  '        # them back up by NAME, which is the only count that matters -',
  '        # a box is an accident of arithmetic, "blue" is the answer.',
  '        #',
  '        # Every third pixel each way: a liner is a repeating pattern, so',
  '        # nine times fewer pixels says the same thing.',
  '        hist = collections.Counter()',
  '        for y in range(0, h, 3):',
  '            base = y * w * n',
  '            for x in range(0, w, 3):',
  '                o = base + x * n',
  '                hist[(data[o] // 16, data[o+1] // 16, data[o+2] // 16)] += 1',
  '        out[str(i)] = [[r*16+8, g*16+8, b*16+8, c]',
  '                       for (r, g, b), c in hist.most_common(120)]',
  'print(json.dumps(out))',
].join(String.fromCharCode(10));

(async () => {
  const conn = LIVE ? await connectLive(mysql) : await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: DB,
  });
  console.log('Database: ' + (LIVE ? 'LIVE' : DB));

  const [rows] = await conn.query(
    `SELECT i.id, i.tags, c.section, c.category
       FROM envelope_linear_items i
       JOIN envelope_linears c ON c.id = i.category_id
      WHERE i.thumb IS NOT NULL
      ORDER BY c.section_order, c.sort_order, i.sort_order`);

  const todo = rows.filter(r => ALL || !String(r.tags || '').trim());
  console.log(rows.length + ' designs, ' + todo.length + ' to look at.');
  if (!todo.length) { await conn.end(); return; }

  // One Python run for the lot rather than one per design: starting the
  // interpreter costs more than reading all three hundred thumbnails.
  const py = spawnSync('python', ['-c', PIXELS], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    // The Python half opens its OWN connection, so it is handed the same
    // settings this half used. Letting it read .env for itself is how Node
    // ends up tagging live while Python reads the pictures off the dev copy.
    env: Object.assign({}, process.env, LIVE ? (function () {
      const L = liveSettings();
      return {
        H: L.host, P: String(L.port), U: L.user, W: L.password, D: L.database,
        IDS: JSON.stringify(todo.map(r => r.id)),
      };
    }()) : {
      H: process.env.DB_HOST, P: String(process.env.DB_PORT || 3306),
      U: process.env.DB_USER, W: process.env.DB_PASSWORD, D: DB,
      IDS: JSON.stringify(todo.map(r => r.id)),
    }),
  });
  if (py.status !== 0) {
    console.error('Could not read the pictures:');
    console.error((py.stderr || '').trim().slice(0, 600));
    process.exit(1);
  }

  let colours;
  try { colours = JSON.parse(py.stdout); } catch (e) {
    console.error('Python did not answer with colours:');
    console.error((py.stdout || '').slice(0, 300));
    process.exit(1);
  }

  // ── NAMING, AND WHICH NAMES ARE WORTH KEEPING ──
  //
  // Every box of colour is named first and the counts are added up BY
  // NAME. That order matters: a pale blue spread over four neighbouring
  // boxes looks like four unimportant colours and is one obvious one.
  //
  // Then the question is not "which colours are big" but "what is this
  // liner printed in". The ground only counts when it really is the
  // ground, and the pattern gets its best two whatever share they hold -
  // because the first floral in the book is blue hydrangeas covering a
  // twelfth of a cream sheet, and blue is the only word anybody would
  // ever search for it by.
  //
  // Two and not three, measured over all 316: three put a faint third
  // colour on nearly half of them, and a word that is true of half the
  // book is not a search term.
  const NEUTRAL = new Set(['white', 'cream', 'beige', 'grey', 'black', 'charcoal']);
  const GROUND_SHARE = 0.15;
  const INK_FLOOR = 0.02;
  const INKS_KEPT = 2;

  const plan = [];
  const tally = new Map();
  for (const r of todo) {
    const boxes = colours[String(r.id)] || [];
    const total = boxes.reduce((n, b) => n + b[3], 0) || 1;

    const share = new Map();
    for (const [cr, cg, cb, count] of boxes) {
      const name = colourName(cr, cg, cb);
      share.set(name, (share.get(name) || 0) + count / total);
    }

    const ranked = [...share.entries()].sort((a, b) => b[1] - a[1]);
    const named = [];
    for (const [name, part] of ranked) {
      if (NEUTRAL.has(name) && part >= GROUND_SHARE) named.push(name);
    }
    for (const [name, part] of ranked.filter(([n]) => !NEUTRAL.has(n)).slice(0, INKS_KEPT)) {
      if (part >= INK_FLOOR) named.push(name);
    }
    // Something, always. A liner that is one flat colour must still be
    // findable by that colour.
    if (!named.length && ranked.length) named.push(ranked[0][0]);

    for (const c of named) tally.set(c, (tally.get(c) || 0) + 1);
    plan.push([r.id, tagsFor({ section: r.section, category: r.category, colours: named })
      .join(' ').slice(0, 500)]);
  }
  console.log(NL + 'Colours found, and how many designs carry each:');
  [...tally.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log('  ' + c.padEnd(10) + n));

  const example = plan.find(p => p[1]);
  if (example) {
    const row = todo.find(r => r.id === example[0]);
    console.log(NL + 'For instance, ' + row.category + ': ' + example[1]);
  }

  if (!WRITE) {
    console.log(NL + 'Nothing was written. Run it again with --write.');
    await conn.end();
    return;
  }
  for (const [id, tags] of plan) {
    await conn.query('UPDATE envelope_linear_items SET tags = ? WHERE id = ?', [tags, id]);
  }
  const [[n]] = await conn.query(
    "SELECT COUNT(*) AS n FROM envelope_linear_items WHERE tags <> ''");
  console.log(NL + 'Written. ' + n.n + ' designs can now be searched for.');
  await conn.end();
})().catch(e => { console.error(e); process.exit(1); });
