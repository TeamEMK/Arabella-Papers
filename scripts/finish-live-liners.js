/**
 * Names and tags the liners on LIVE, when Node cannot reach it.
 *
 *   node scripts/finish-live-liners.js            # say what it would do
 *   node scripts/finish-live-liners.js --write
 *
 * WHY THIS EXISTS AT ALL.
 *
 * On 15 November, with 316 designs freshly imported, mysql2 could not get
 * through to Railway from this office: TCP connected in 620ms and then every
 * handshake died, 21 seconds each, ETIMEDOUT or ER_NET_READ_INTERRUPTED,
 * with ssl on, ssl off, insecureAuth and keepalive off all behaving the
 * same. Python's pymysql connected over the identical path in 3.9 seconds
 * and ran the whole import. So it is the driver, not the line.
 *
 * Rather than write the naming rule a second time in Python - two rules that
 * agree until the day one of them is edited - this keeps the rules where
 * they live and swaps only the TRANSPORT:
 *
 *   Python reads  ->  JSON  ->  Node decides  ->  JSON  ->  Python writes
 *
 * utils/linerCode.js still decides what a liner is called and
 * utils/linerTags.js still decides what colour a colour is. Python carries
 * bytes and nothing else.
 *
 * Only ever fills a blank. A code or a tag already on a row is left exactly
 * as it is, so this can be run again after any import.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { codeFor, clashes } = require('../utils/linerCode');
const { colourName, tagsFor } = require('../utils/linerTags');
const { liveSettings } = require('../utils/liveDb');

const WRITE = process.argv.includes('--write');
const ROOT = path.join(__dirname, '..');
const NL = String.fromCharCode(10);

// ── The Python half: reads ────────────────────────────────────
// Hands back every category, every design, and a histogram of each
// thumbnail. It decides nothing: the boxes of colour are counted, named
// nowhere, and shipped as numbers.
const DUMP = [
  'import os, io, json, collections',
  'try:',
  '    import pymupdf',
  'except ImportError:',
  '    import fitz as pymupdf',
  'import pymysql',
  '',
  'c = pymysql.connect(host=os.environ["H"], port=int(os.environ["P"]),',
  '                    user=os.environ["U"], password=os.environ["W"],',
  '                    database=os.environ["D"], charset="utf8mb4",',
  '                    connect_timeout=25)',
  'out = {"categories": [], "items": []}',
  'with c.cursor() as cur:',
  '    cur.execute("SELECT id, section, category, COALESCE(code_next,0)"',
  '                " FROM envelope_linears ORDER BY section_order, sort_order, id")',
  '    for i, sec, cat, nxt in cur.fetchall():',
  '        out["categories"].append({"id": i, "section": sec,',
  '                                  "category": cat, "codeNext": nxt})',
  '    cur.execute("SELECT id, category_id, code, tags, sort_order, thumb"',
  '                " FROM envelope_linear_items WHERE is_active = 1"',
  '                " ORDER BY category_id, sort_order, id")',
  '    for i, cid, code, tags, sort, thumb in cur.fetchall():',
  '        code = code or ""',
  '        tags = tags or ""',
  '        boxes = []',
  '        if thumb and not tags:',
  '            try:',
  '                pix = pymupdf.Pixmap(io.BytesIO(thumb))',
  '                if pix.n >= 4:',
  '                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)',
  '                w, h, n = pix.width, pix.height, pix.n',
  '                data = pix.samples',
  '                hist = collections.Counter()',
  '                for y in range(0, h, 3):',
  '                    base = y * w * n',
  '                    for x in range(0, w, 3):',
  '                        o = base + x * n',
  '                        hist[(data[o] // 16, data[o+1] // 16, data[o+2] // 16)] += 1',
  '                boxes = [[r*16+8, g*16+8, b*16+8, k]',
  '                         for (r, g, b), k in hist.most_common(120)]',
  '            except Exception:',
  '                boxes = []',
  '        out["items"].append({"id": i, "categoryId": cid, "code": code,',
  '                             "tags": tags, "sort": sort, "boxes": boxes})',
  'print(json.dumps(out))',
].join(NL);

// ── The Python half: writes ───────────────────────────────────
const APPLY = [
  'import os, json',
  'import pymysql',
  '',
  'plan = json.load(open(os.environ["PLAN"], encoding="utf-8"))',
  'c = pymysql.connect(host=os.environ["H"], port=int(os.environ["P"]),',
  '                    user=os.environ["U"], password=os.environ["W"],',
  '                    database=os.environ["D"], charset="utf8mb4",',
  '                    connect_timeout=25)',
  '# A few hundred small updates, committed in batches. The link to this',
  '# server drops often enough to plan for: a batch that dies costs the',
  '# batch, and running again picks up whatever is still blank.',
  'done = 0',
  'with c.cursor() as cur:',
  '    for row in plan["items"]:',
  '        sets, vals = [], []',
  '        if row.get("code"):',
  '            sets.append("code = %s"); vals.append(row["code"])',
  '        if row.get("tags"):',
  '            sets.append("tags = %s"); vals.append(row["tags"])',
  '        if not sets:',
  '            continue',
  '        vals.append(row["id"])',
  '        cur.execute("UPDATE envelope_linear_items SET " + ", ".join(sets)',
  '                    + " WHERE id = %s", vals)',
  '        done += 1',
  '        if done % 40 == 0:',
  '            c.commit()',
  '            print("  %d of %d" % (done, len(plan["items"])), flush=True)',
  '    for cat in plan["categories"]:',
  '        cur.execute("UPDATE envelope_linears SET code_next = GREATEST("',
  '                    "COALESCE(code_next,0), %s) WHERE id = %s",',
  '                    (cat["codeNext"], cat["id"]))',
  'c.commit()',
  'print("  %d of %d" % (done, len(plan["items"])), flush=True)',
  'with c.cursor() as cur:',
  '    cur.execute("SELECT code FROM envelope_linear_items WHERE is_active = 1")',
  '    codes = [r[0] or "" for r in cur.fetchall()]',
  '    cur.execute("SELECT tags FROM envelope_linear_items WHERE is_active = 1")',
  '    tagged = len([r for r in cur.fetchall() if (r[0] or "").strip()])',
  'named = [c for c in codes if c.strip()]',
  'print(json.dumps({"designs": len(codes), "named": len(named),',
  '                  "tagged": tagged, "different": len(set(named))}))',
].join(NL);

function python(code, env, label) {
  const L = liveSettings();
  const r = spawnSync('python', ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: Object.assign({}, process.env, {
      H: L.host, P: String(L.port), U: L.user, W: L.password, D: L.database,
    }, env || {}),
  });
  if (r.status !== 0) {
    console.error('The ' + label + ' step failed:');
    console.error((r.stderr || '').trim().slice(0, 800));
    process.exit(1);
  }
  return r;
}

(async () => {
  console.log('Reading live...');
  const dump = JSON.parse(python(DUMP, {}, 'read').stdout);
  console.log('  ' + dump.categories.length + ' categories, '
    + dump.items.length + ' designs');

  // Two categories sharing a prefix would mean two designs sharing a name,
  // and a name that means two things is worse than no name.
  const bad = clashes(dump.categories.map(c => [c.section, c.category]));
  if (bad.length) {
    console.error(NL + 'Two categories would share a prefix, so nothing was written:');
    bad.forEach(b => console.error('  ' + b));
    process.exit(1);
  }

  const catById = new Map(dump.categories.map(c => [c.id, c]));

  // ── Naming, by the one rule ─────────────────────────────────
  // Counted off the highest number the category has ever handed out, not
  // off how many are in it: delete the second of three and the next design
  // added has to be a fourth, or a code read down a telephone last month
  // comes back meaning something else.
  const highest = new Map();
  for (const it of dump.items) {
    const m = /-(\d+)$/.exec(it.code || '');
    if (m) {
      highest.set(it.categoryId,
        Math.max(highest.get(it.categoryId) || 0, Number(m[1])));
    }
  }
  for (const c of dump.categories) {
    highest.set(c.id, Math.max(highest.get(c.id) || 0, Number(c.codeNext) || 0));
  }

  const NEUTRAL = new Set(['white', 'cream', 'beige', 'grey', 'black', 'charcoal']);
  const GROUND_SHARE = 0.15;
  const INK_FLOOR = 0.02;
  const INKS_KEPT = 2;

  const plan = { items: [], categories: [] };
  let toName = 0, toTag = 0;

  for (const it of dump.items) {
    const row = { id: it.id };
    const cat = catById.get(it.categoryId);
    if (!cat) continue;

    if (!String(it.code || '').trim()) {
      const n = (highest.get(cat.id) || 0) + 1;
      highest.set(cat.id, n);
      row.code = codeFor(cat.section, cat.category, n);
      toName++;
    }

    if (!String(it.tags || '').trim() && it.boxes && it.boxes.length) {
      const total = it.boxes.reduce((s, b) => s + b[3], 0) || 1;
      const share = new Map();
      for (const [r, g, b, k] of it.boxes) {
        const name = colourName(r, g, b);
        share.set(name, (share.get(name) || 0) + k / total);
      }
      const ranked = [...share.entries()].sort((a, b) => b[1] - a[1]);
      const named = [];
      for (const [name, part] of ranked) {
        if (NEUTRAL.has(name) && part >= GROUND_SHARE) named.push(name);
      }
      for (const [name, part] of ranked.filter(([n]) => !NEUTRAL.has(n)).slice(0, INKS_KEPT)) {
        if (part >= INK_FLOOR) named.push(name);
      }
      if (!named.length && ranked.length) named.push(ranked[0][0]);
      row.tags = tagsFor({ section: cat.section, category: cat.category, colours: named })
        .join(' ').slice(0, 500);
      toTag++;
    }

    if (row.code || row.tags) plan.items.push(row);
  }

  for (const c of dump.categories) {
    plan.categories.push({ id: c.id, codeNext: highest.get(c.id) || 0 });
  }

  console.log(NL + toName + ' to name, ' + toTag + ' to tag.');
  const example = plan.items.find(r => r.code && r.tags);
  if (example) console.log('For instance: ' + example.code + '  ->  ' + example.tags);

  if (!plan.items.length) { console.log('Nothing to do.'); return; }
  if (!WRITE) {
    console.log('Nothing was written. Run it again with --write.');
    return;
  }

  const file = path.join(os.tmpdir(), 'liner-plan-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(plan), 'utf8');
  try {
    console.log(NL + 'Writing to live...');
    const out = python(APPLY, { PLAN: file }, 'write');
    const lines = (out.stdout || '').trim().split(/\r?\n/);
    lines.slice(0, -1).forEach(l => console.log(l));
    // Said back from the table rather than from the plan: the point is that
    // the rows really are all different, not that the list we meant to
    // write was.
    const after = JSON.parse(lines[lines.length - 1]);
    console.log(NL + 'Live now: ' + after.designs + ' designs, ' + after.named
      + ' named, ' + after.tagged + ' tagged, ' + after.different + ' different names.');
    if (after.named !== after.different) {
      console.error('TWO DESIGNS SHARE A NAME. Look before trusting any of them.');
      process.exit(1);
    }
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* it was a temp file */ }
  }
})().catch(e => { console.error(e); process.exit(1); });
