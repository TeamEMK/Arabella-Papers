// ══════════════════════════════════════════════════════
// SCOT SHEET — ONE-TIME FILL
//
// Puts every order punched since a given date onto the calling sheet, one row
// per dealer. Written as one pass rather than a loop over utils/scot.js so
// sixty dealers cost two requests instead of a hundred and twenty.
//
//   node scripts/scot-backfill.js 2026-08-01 --dry     local database, nothing written
//   node scripts/scot-backfill.js 2026-08-01 --live    the real one
//
// --dry prints exactly what would be written and touches nothing. Run it first.
// --live reads the office database over the connection string in .env.backup,
// the same gitignored file scripts/backup-live.js uses, so no password is ever
// typed on a command line. It only ever READS from there; the writing is all
// into the sheet.
//
// The sheet must be shared with the service account; the script prints which
// address that is if it cannot get in.
// ══════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Before config/db is required, or the pool is already built by then.
if (process.argv.includes('--live')) {
  const file = path.join(__dirname, '..', '.env.backup');
  const line = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(l => l.trim()).find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) {
    console.error('.env.backup me LIVE_DB_URL nahi mila.');
    console.error('ek baar chalao: node scripts/backup-live.js "mysql://..."');
    process.exit(1);
  }
  const u = new URL(line.slice('LIVE_DB_URL='.length));
  process.env.DB_HOST = u.hostname;
  process.env.DB_PORT = u.port || '3306';
  process.env.DB_USER = decodeURIComponent(u.username);
  process.env.DB_PASSWORD = decodeURIComponent(u.password);
  process.env.DB_NAME = u.pathname.replace(/^\//, '');
  console.log(`database   : ${u.hostname} (live, sirf padha jayega)`);
}

const db = require('../config/db');
const sheets = require('../utils/sheets');
const scot = require('../utils/scot');

const from = process.argv[2] || '2026-08-01';
const dry = process.argv.includes('--dry');

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error(`date aise do: YYYY-MM-DD (mila "${from}")`);
  }
  console.log(`SCOT sheet  : ${scot.SHEET_ID}`);
  console.log(`signed in as: ${sheets.serviceAccountEmail()}`);
  console.log(`orders from : ${from}${dry ? '   [DRY RUN - kuch nahi likha jayega]' : ''}\n`);

  const cal = await scot.calendar();
  const days = [...cal.keys()].sort();
  console.log(`sheet ka calendar: ${days[0]} se ${days[days.length - 1]} tak, ${days.length} din\n`);

  // ── every dealer with work in the window, and every day they ordered ──
  const [rows] = await db.query(
    `SELECT TRIM(dealer_name) AS dealer, DATE(timestamp) AS day, COUNT(*) AS n
       FROM orders
      WHERE is_deleted = 0
        AND DATE(timestamp) >= ?
        AND TRIM(IFNULL(dealer_name, '')) <> ''
      GROUP BY TRIM(dealer_name), DATE(timestamp)
      ORDER BY dealer, day`,
    [from],
  );

  const byDealer = new Map();
  for (const r of rows) {
    const name = r.dealer;
    if (scot.NOT_A_CLIENT.has(name.toLowerCase())) continue;
    if (!byDealer.has(name)) byDealer.set(name, []);
    byDealer.get(name).push({ day: scot.dayKey(r.day), n: Number(r.n) });
  }

  // ── the rhythm, measured over the whole history not just this window ──
  const [hist] = await db.query(
    `SELECT TRIM(dealer_name) AS dealer, DATE(timestamp) AS day
       FROM orders
      WHERE is_deleted = 0 AND TRIM(IFNULL(dealer_name, '')) <> ''
      GROUP BY TRIM(dealer_name), DATE(timestamp)`);
  const allDays = new Map();
  for (const r of hist) {
    if (!allDays.has(r.dealer)) allDays.set(r.dealer, []);
    allDays.get(r.dealer).push(scot.dayKey(r.day));
  }

  // Busiest first, so the people worth calling are at the top of the sheet
  // rather than wherever the alphabet put them.
  const dealers = [...byDealer.entries()]
    .map(([name, list]) => ({
      name,
      list,
      orders: list.reduce((a, d) => a + d.n, 0),
      freq: scot.frequencyFrom(allDays.get(name) || []),
    }))
    .sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));

  console.log(`dealers: ${dealers.length}   orders: ${dealers.reduce((a, d) => a + d.orders, 0)}`);
  const skipped = rows.filter(r => scot.NOT_A_CLIENT.has(r.dealer.toLowerCase()));
  if (skipped.length) {
    console.log(`chhode gaye: ${skipped.reduce((a, r) => a + Number(r.n), 0)} orders `
      + `(${[...new Set(skipped.map(r => r.dealer))].join(', ')})`);
  }

  // ── build the two blocks ──
  const lastCol = Math.max(...[...cal.values()]);
  const width = lastCol - scot.FIRST_GRID_COL + 1;

  // Column by column rather than one B:M block. C, D, F, G and I belong to the
  // office - a phone number or an order size typed in there has to survive
  // this script, and a single wide block would wipe every one of them.
  const names = [];
  const freqs = [];
  const grid = [];
  let outside = 0;

  dealers.forEach((d, i) => {
    const row = scot.FIRST_ROW + i;
    const dash = row - 3;
    names.push([d.name]);
    freqs.push([
      d.freq ? d.freq.label : '',
      d.freq ? d.freq.days : '',
      `=IFERROR(Dashboard!L${dash},"")`,
      `=IFERROR(Dashboard!H${dash},"")`,
    ]);

    const line = new Array(width).fill('');
    for (const { day, n } of d.list) {
      const col = cal.get(day);
      if (!col) { outside++; continue; }
      line[col - scot.FIRST_GRID_COL] = n;
    }
    grid.push(line);
  });

  if (outside) console.log(`${outside} din sheet ke calendar se bahar the, chhod diye`);

  const lastRow = scot.FIRST_ROW + dealers.length - 1;
  const span = (col) => `'${scot.TAB}'!${col}${scot.FIRST_ROW}:${col}${lastRow}`;
  const gridRange = `'${scot.TAB}'!${scot.colLetters(scot.FIRST_GRID_COL)}${scot.FIRST_ROW}`
    + `:${scot.colLetters(lastCol)}${lastRow}`;

  const data = [
    { range: span('B'), values: names },
    { range: span('E'), values: names },
    { range: span('H'), values: names },
    { range: `'${scot.TAB}'!J${scot.FIRST_ROW}:M${lastRow}`, values: freqs },
    { range: gridRange, values: grid },
  ];

  console.log(`\nlikhna hai:\n${data.map(d => '  ' + d.range).join('\n')}\n`);
  // If this comes out all one bucket the Status column is worthless - every
  // dealer would be judged against the same seven days.
  const tally = {};
  for (const d of dealers) {
    const k = d.freq ? d.freq.label : '(ek hi order din - khali)';
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log('\nOrder Frequency:');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }

  console.log('\npehle 10 rows:');
  dealers.slice(0, 10).forEach((d, i) => {
    console.log(`  ${String(scot.FIRST_ROW + i).padStart(3)}  ${d.name.padEnd(30)}`
      + ` ${String(d.orders).padStart(3)} orders on ${String(d.list.length).padStart(2)} days`
      + `   ${d.freq ? d.freq.label : '(gap nikalne ko ek hi din)'}`);
  });

  if (dry) { console.log('\n--dry tha, kuch nahi likha.'); return; }

  const api = await sheets.getWriteClient();
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: scot.SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  // "Date for calling" is a formula returning a date, and a date with no date
  // format on the cell shows as the five-digit number underneath it.
  await scot.ensureCallDateFormat();
  sheets.invalidateSheet(scot.SHEET_ID);
  console.log(`\nho gaya - ${dealers.length} dealers sheet par.`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\nFAILED:', err.message);
    if (/permission|not found|403|404/i.test(err.message)) {
      console.error(`sheet ko ${sheets.serviceAccountEmail()} ke saath share karna padega (Editor).`);
    }
    process.exit(1);
  });
