/**
 * URGENT ORDERS, FROM THE PUNCH TO EVERY BOARD.
 *
 *   node scripts/smoke-urgent-order.js
 *
 * The office hears that a job is urgent on the telephone - which is the
 * punch, not the approval box days later. So the punch asks, as a plain yes
 * or no, and a yes has to carry the day the CLIENT has been promised it.
 *
 * Three things are worth proving and all three are here:
 *
 *   THE QUESTION CANNOT BE SKIPPED, and a yes cannot arrive without a date.
 *   Checked against the route and not only against the form: the browser is
 *   one way into this and a request is another.
 *
 *   IT IS THE SAME FLAG THE REST OF THE APP ALREADY READS. A punch that said
 *   urgent writes the column the production badge, the PMS filter and the
 *   morning mail have always read - otherwise there would be two ideas of
 *   urgent and no way to tell which one a screen is showing.
 *
 *   EVERY SURFACE COUNTS THE DAYS THE SAME WAY. One rule, utils/urgency.js,
 *   loaded by all of them. An order that reads "due tomorrow" on a board and
 *   "overdue" in a mail sent the same minute is the failure this prevents.
 *
 * Builds its own throwaway database. Never live.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_urgent_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.PORT = '0';

// Nothing is posted anywhere.
for (const mod of ['utils/mailer.js']) {
  const p = require.resolve(path.join(ROOT, mod));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      sendMail: async () => ({ sent: true }),
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
const NL = String.fromCharCode(10);

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) throw new Error('refusing to run against DB_NAME');

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));
  const urgency = require(path.join(ROOT, 'utils/urgency.js'));
  const report = require(path.join(ROOT, 'utils/stageReport.js'));

  const today = urgency.today();
  const dayOff = (n) => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  // Signed in, and proved signed in: the session table is made on startup and
  // a fresh database can hand back a cookie that was never stored.
  const signIn = async (email, password) => {
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const r = await go('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password }),
      });
      const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      if (cookie) {
        const who = await go('/api/orders', { headers: { cookie } });
        last = who.status;
        if (who.status === 200) return cookie;
      }
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error('could not sign in (last answer ' + last + ')');
  };
  const jar = await signIn(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  // A punch, exactly as the form sends one: multipart, no files.
  const punch = async (over) => {
    const form = new FormData();
    const body = Object.assign({
      email: 'probe@test.local', punchedBy: 'India Team',
      dealer: 'Dealer One', client: 'Client One',
      remarks: 'Probe order', designer: 'Rakesh', designTime: '1 Hour',
    }, over || {});
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.append(k, v);
    const r = await go('/api/orders', { method: 'POST', headers: { cookie: jar }, body: form });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const rowOf = async (orderId) => {
    const [[row]] = await db.query(
      'SELECT order_type, delivery_due_date FROM orders WHERE order_id = ?', [orderId]);
    return row;
  };

  const tidy = async () => {
    try { server.close(); } catch (e) {}
    try { await db.end(); } catch (e) {}
    try {
      await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
      await admin.end();
    } catch (e) {}
  };

  try {
    // ──────────────────────────────────────────────
    console.log(NL + 'The question has to be answered');
    const noAnswer = await punch({});
    check('a punch with no answer is refused', noAnswer.status === 400, noAnswer);
    const nonsense = await punch({ urgent: 'maybe' });
    check('and so is an answer that is neither yes nor no', nonsense.status === 400, nonsense);

    console.log(NL + 'A yes has to carry a date');
    const bare = await punch({ urgent: 'Yes' });
    check('urgent with no date is refused', bare.status === 400, bare);
    const junk = await punch({ urgent: 'Yes', deliveryDueDate: 'next week' });
    check('and a date that is not a date is refused', junk.status === 400, junk);
    check('the refusal says what is missing',
      /date/i.test((bare.json && bare.json.error) || ''), bare.json);

    console.log(NL + 'What a yes writes');
    const due = dayOff(3);
    const yes = await punch({ urgent: 'Yes', deliveryDueDate: due });
    check('the order is taken', yes.status === 200 && yes.json.success, yes);
    const rushRow = await rowOf(yes.json.orderId);
    // THE WHOLE POINT. Not a second column of its own: the one the badge, the
    // filter and the mail have always read.
    check('it is RUSH in the column every board already reads',
      rushRow.order_type === 'RUSH Order', rushRow);
    check('and it keeps the day the client was promised',
      urgency.day(rushRow.delivery_due_date) === due, rushRow);

    console.log(NL + 'What a no writes');
    const no = await punch({ urgent: 'No', deliveryDueDate: due });
    const normalRow = await rowOf(no.json.orderId);
    check('a normal order is Normal', normalRow.order_type === 'Normal Order', normalRow);
    // A date sent beside a No is thrown away rather than stored: a board
    // counting down to a day nobody promised is worse than one that does not
    // count at all.
    check('and carries no date, even when one was sent',
      normalRow.delivery_due_date === null, normalRow);

    console.log(NL + 'It is on the dashboard the moment it is taken');
    const list = await (await go('/api/orders', { headers: { cookie: jar } })).json();
    const mine = list.data.find(o => o.ID === yes.json.orderId);
    check('the order list carries the type', mine && mine.Order_Type === 'RUSH Order', mine);
    check('and the date, as a plain YYYY-MM-DD the browser can count from',
      mine && mine.Delivery_Due === due, mine && mine.Delivery_Due);
    const plain = list.data.find(o => o.ID === no.json.orderId);
    check('a normal order carries nothing to count',
      plain && plain.Order_Type === 'Normal Order' && plain.Delivery_Due === '', plain);

    console.log(NL + 'Who marked it urgent is written down');
    // logOrderEvent puts its one line of detail in `field` - the table is
    // shaped for column changes and an event borrows it.
    const [log] = await db.query(
      "SELECT action, field FROM order_logs WHERE order_id = ? AND action LIKE '%RUSH%'",
      [yes.json.orderId]);
    check('the log says so', log.length === 1, log);
    check('and says which day was promised',
      log.length === 1 && String(log[0].field).includes(due), log[0]);
    const [quiet] = await db.query(
      "SELECT id FROM order_logs WHERE order_id = ? AND action LIKE '%RUSH%'",
      [no.json.orderId]);
    check('a normal order says nothing about urgency', quiet.length === 0, quiet);

    // ──────────────────────────────────────────────
    console.log(NL + 'The days are counted in the office\'s day');
    check('today is "Due today"', urgency.describe(dayOff(0)).label === 'Due today');
    check('tomorrow is "Due tomorrow"', urgency.describe(dayOff(1)).label === 'Due tomorrow');
    check('three days is "Due in 3 days"', urgency.describe(dayOff(3)).label === 'Due in 3 days');
    check('yesterday is "Due yesterday"', urgency.describe(dayOff(-1)).label === 'Due yesterday');
    check('four days back is overdue, and says how far',
      urgency.describe(dayOff(-4)).label === '4 days overdue'
      && urgency.describe(dayOff(-4)).overdue === true);
    // A blank column must read as "no date", never as "overdue". A board that
    // shouts at every order with an empty column is a board people stop
    // looking at.
    for (const empty of [null, '', undefined, 'rubbish']) {
      check('nothing at all (' + JSON.stringify(empty) + ') is no date, not overdue',
        urgency.describe(empty) === null);
    }

    console.log(NL + 'Everything reads the one rule');
    const onePlace = (file, what) => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      check(what + ' reads utils/urgency.js',
        /ArabellaUrgency|require\(.*urgency/.test(src), file);
    };
    onePlace('views/views/productionBD.ejs', 'the production board');
    onePlace('views/views/pmsOrders.ejs', 'PMS Orders');
    onePlace('views/views/dashboard.ejs', 'the order dashboard');
    onePlace('views/views/tillApproval.ejs', 'the approval board');
    onePlace('utils/stageReport.js', 'the morning mail');
    check('and the shell serves it to all of them',
      fs.readFileSync(path.join(ROOT, 'views/app.ejs'), 'utf8').includes('/js/urgency.js'));
    check('the browser can actually fetch it',
      (await go('/js/urgency.js')).status === 200);

    // ── THE FILTER THAT FOUND NOTHING ──
    //
    // PMS Orders offered RUSH and Normal and compared them to a column
    // holding "RUSH Order" and "Normal Order", so picking RUSH emptied the
    // table. This is the rule it asks now, and the line below is what the old
    // one did.
    console.log(NL + 'RUSH is recognised however it was typed');
    check('"RUSH Order" is urgent', urgency.isRush('RUSH Order'));
    check('"rush order" is urgent too', urgency.isRush('rush order'));
    check('"Normal Order" is not', !urgency.isRush('Normal Order'));
    check('an unanswered order is not', !urgency.isRush('') && !urgency.isRush(null));
    check('the old exact match would have found nothing',
      ('RUSH Order' === 'RUSH') === false);

    // ──────────────────────────────────────────────
    console.log(NL + 'The morning mail counts the same days');
    const yesterday = (() => {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    await db.query(
      `INSERT INTO orders (order_id, dealer_name, client_name, actual_2,
         design_approval_status_from_client, india_designer, order_type,
         delivery_due_date, printing, guest_name, paper_cutting, dye_status,
         block_status, edges, laser_cutting, output, card_assembly)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['U-RUSH', 'Dealer', 'Client', yesterday + ' 15:00:00',
        'Final Approval For Production', 'Rakesh', 'RUSH Order', dayOff(2),
        'Pending', 'GNA Printed', 'Done', 'No Die', 'No Block', 'No', 'No',
        'Done', 'Done']);
    const mail = await report.pending();
    const line = mail.orders.find(o => o.orderId === 'U-RUSH');
    check('the urgent order is in it', !!line, mail.orders.map(o => o.orderId));
    check('marked as a rush', line && line.rush === true, line);
    check('with the same words the boards use',
      line && line.due && line.due.label === 'Due in 2 days', line && line.due);
    const html = report.html ? report.html(mail) : '';
    if (html) check('and the mail itself prints it', html.includes('Due in 2 days'));

    console.log(NL + pass + ' passed, ' + fail + ' failed');
  } finally {
    await tidy();
    console.log('Throwaway database dropped.');
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
