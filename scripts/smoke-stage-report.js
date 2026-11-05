/**
 * THE MORNING STAGE REPORT.
 *
 * Nine o'clock: the orders that went into production on an earlier day and
 * still have stages open, and which stages those are.
 *
 * Two things decide whether this mail is worth opening, and both are here:
 *
 *   WHO IS IN IT. The office's words were "as soon as the day changes", so
 *   an order approved yesterday evening is in this morning's mail and one
 *   approved at nine this morning is not. Cancelled work, local orders and
 *   anything already with Dispatch are not on the production board and are
 *   not chased - a mail with noise in it is a mail people stop opening.
 *
 *   WHAT COUNTS AS DONE. The same list the board draws its badges from,
 *   utils/productionStages.js. The last time a rule like this was written
 *   twice, the two copies drifted and a status was refused on one screen and
 *   allowed on another; a mail that calls an order late while the board in
 *   front of somebody shows it green is the same failure, by post.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_stagerep_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

// The mail is caught rather than sent.
const sent = [];
{
  const p = require.resolve(path.join(ROOT, 'utils/mailer.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      sendMail: async (m) => { sent.push(m); return { sent: true }; },
      verifyMail: async () => ({ ok: true }),
      isMailConfigured: () => true,
    },
  };
}

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

// Everything finished, as a starting point to spoil one stage at a time.
const DONE = {
  guest_name: 'GNA Printed', paper_cutting: 'Done', dye_status: 'No Die',
  block_status: 'No Block', printing: 'Done', edges: 'No',
  laser_cutting: 'No', output: 'Done', card_assembly: 'Done',
};

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) throw new Error('refusing to run against DB_NAME');

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));
  const report = require(path.join(ROOT, 'utils/stageReport.js'));
  const stages = require(path.join(ROOT, 'utils/productionStages.js'));

  const today = report.todayIST();
  const dayOff = (n) => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const mk = async (id, over) => {
    const row = Object.assign({
      order_id: id, dealer_name: 'Dealer', client_name: 'Client ' + id,
      actual_2: dayOff(1) + ' 15:00:00',
      design_approval_status_from_client: 'Final Approval For Production',
      india_designer: 'Rakesh',
    }, DONE, over || {});
    const cols = Object.keys(row);
    await db.query(
      `INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map(c => row[c]));
  };

  console.log('\nThe list of nine');
  check('nine stages, in the order the floor works them', stages.STAGES.length === 9);
  check('and the board loads the same file, not a copy',
    require('fs').readFileSync(path.join(ROOT, 'views/views/productionBD.ejs'), 'utf8')
      .includes('/js/productionStages.js'));
  // These two are the ones somebody would get wrong rewriting the list.
  check('GNA Approved is NOT finished - printed is',
    !stages.isDone(stages.STAGES[0], 'GNA Approved') && stages.isDone(stages.STAGES[0], 'GNA Printed'));
  check('"No Die" is finished, not pending - the job has no die cutting',
    stages.isDone(stages.STAGES[2], 'No Die'));

  console.log('\nWho the mail is about');
  await mk('S-DONE');                                        // yesterday, all finished
  await mk('S-OPEN', { printing: 'Pending', edges: 'Pending' });
  await mk('S-TODAY', { actual_2: today + ' 09:05:00', printing: 'Pending' });
  await mk('S-OLD', { actual_2: dayOff(11) + ' 10:00:00', card_assembly: 'Pending' });

  let r = await report.pending();
  let ids = r.orders.map(o => o.orderId);
  check('an order with everything finished is not in it', !ids.includes('S-DONE'), ids);
  check('one with stages open is', ids.includes('S-OPEN'), ids);
  // "As soon as the day changes" - so this morning's approvals are tomorrow's
  // business, however little has been done to them.
  check('one that reached the floor TODAY is not', !ids.includes('S-TODAY'), ids);
  check('longest wait first', ids[0] === 'S-OLD', ids);
  check('and it says how many days', r.orders[0].waiting === 11, r.orders[0].waiting);

  console.log('\nWhat is left off on purpose');
  await mk('S-CANCEL', { printing: 'Pending', design_approval_status_from_client: 'Cancelled' });
  await mk('S-CANCEL2', { printing: 'Pending', design_status: 'Cancelled' });
  await mk('S-LOCAL', { printing: 'Pending', dealer_name: 'Local Order' });
  await mk('S-GONE', { printing: 'Pending', status_4: 'Dispatched' });
  await mk('S-GONE2', { printing: 'Pending', actual_4: dayOff(1) + ' 12:00:00' });
  await mk('S-DEL', { printing: 'Pending', is_deleted: 1 });

  r = await report.pending();
  ids = r.orders.map(o => o.orderId);
  for (const [id, why] of [
    ['S-CANCEL', 'a cancelled approval'], ['S-CANCEL2', 'a cancelled design'],
    ['S-LOCAL', 'a local order'], ['S-GONE', 'one already sent to dispatch'],
    ['S-GONE2', 'one with a dispatch date'], ['S-DEL', 'a deleted row'],
  ]) check(why + ' is left out', !ids.includes(id), ids);

  // ── THE BACKUP BOARD IS NOT CHASED ──
  //
  // This is what made the feature usable. Written without the board's own
  // rules, the report came out at 3,308 orders on live data - the oldest
  // sitting 929 days with every stage untouched, because the history
  // imported from the sheet was never worked through the app. Those live on
  // Backup Production, where nobody is chasing them. With the rules: 64.
  console.log('\nOnly the board somebody actually opens');
  await mk('S-ARCHIVE', { actual_2: '2026-07-15 10:00:00', printing: 'Pending' });
  await mk('S-PINNED-OLD', { printing: 'Pending', production_board: 'old' });
  await mk('S-PINNED-NEW', { actual_2: '2026-07-15 10:00:00', printing: 'Pending', production_board: 'current' });
  r = await report.pending();
  ids = r.orders.map(o => o.orderId);
  check('an order from before the August cutoff is left to Backup Production',
    !ids.includes('S-ARCHIVE'), ids);
  check('and one pinned to the old board is too', !ids.includes('S-PINNED-OLD'), ids);
  // The pin has to work both ways, or an old order somebody HAS picked up
  // again is worked on and never chased.
  check('but an old one pinned back to the live queue is chased',
    ids.includes('S-PINNED-NEW'), ids);

  const reportSrc = require('fs').readFileSync(path.join(ROOT, 'utils/stageReport.js'), 'utf8');
  const dashSrc = require('fs').readFileSync(path.join(ROOT, 'routes/api/dashboards.js'), 'utf8');
  check('the mail imports the board rules rather than restating them',
    reportSrc.includes("require('./productionBoard')")
    && !reportSrc.includes('PRODUCTION_QUEUE_WHERE ='));
  check('and the board itself imports them from that same file',
    dashSrc.includes("require('../../utils/productionBoard')")
    && !dashSrc.includes('const PRODUCTION_QUEUE_WHERE ='));

  console.log('\nWhat it says');
  const open = r.orders.find(o => o.orderId === 'S-OPEN');
  check('it names the stages still to do',
    open.pending.map(s => s.label).join(',') === 'Print,Edges', open.pending);
  check('and what the column actually said, because blank and "Pending" differ',
    open.pending.every(s => s.said === 'pending'), open.pending);
  // Tied to the orders rather than to a number somebody has to keep updating
  // when a fixture is added: the count beside a stage has to be how many
  // orders are waiting on it.
  check('the shape across the top counts each stage',
    r.stageTotals.every(t =>
      t.count === r.orders.filter(o => o.pending.some(p => p.label === t.label)).length),
    r.stageTotals);

  console.log('\nSending it');
  let out = await report.sendStageReport();
  check('it goes', out.sent === true, out);
  check('to the two the office named',
    report.TO.join(',') === 'ramchandra@arabellajaipur.com,kailash@arabellajaipur.com', report.TO);
  const mail = sent[sent.length - 1];
  check('the subject counts them',
    mail.subject === 'Production: ' + r.orders.length + ' orders with stages still open', mail.subject);
  check('the body names the orders', /S-OPEN/.test(mail.html) && /S-OLD/.test(mail.html));
  check('and the stages under each', /Print/.test(mail.html) && /Assembly/.test(mail.html));
  check('it leaves out the ones it should', !/S-TODAY|S-CANCEL|S-LOCAL|S-GONE/.test(mail.html));
  check('a plain-text copy goes too, for whoever reads mail that way',
    /still to do: Print, Edges/.test(mail.text || ''), (mail.text || '').slice(0, 200));

  // A daily "all clear" trains people to delete it unread, and then the
  // morning it matters it goes the same way.
  console.log('\nWhen there is nothing to say');
  await db.query("UPDATE orders SET printing='Done', edges='Done', card_assembly='Done'");
  const before = sent.length;
  out = await report.sendStageReport();
  check('no mail at all', out.sent === false && sent.length === before, out);

  console.log('\nThe schedule');
  const vercel = require(path.join(ROOT, 'vercel.json'));
  const cron = (vercel.crons || []).find(c => /stage-report/.test(c.path));
  // Vercel's scheduler runs on UTC. 03:30 UTC is 09:00 IST, which is what
  // the office asked for.
  check('nine in the morning, written in UTC', cron && cron.schedule === '30 3 * * *', cron);
  // Every route in here, not just this one. These are public URLs on a
  // public domain, and a nightly mail anybody can trigger is a nightly mail
  // anybody can trigger a hundred times - so the check is written as a sweep,
  // which is what catches the NEXT cron somebody adds without a guard.
  const cronSrc = require('fs').readFileSync(path.join(ROOT, 'routes/api/cron.js'), 'utf8');
  const handlers = cronSrc.split(/router\.(?:get|post)\(/).slice(1);
  check('there are cron routes to check', handlers.length >= 2, handlers.length);
  check('and not one of them runs without the secret',
    handlers.every(h => /if \(!authorised\(req\)\) return res\.status\(401\)/.test(h.slice(0, 400))),
    handlers.map(h => h.slice(0, 40)));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await db.end().catch(() => {});
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
