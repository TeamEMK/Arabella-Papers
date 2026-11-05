// ══════════════════════════════════════════════════════
// THE MORNING STAGE REPORT
//
// Nine o'clock, before the floor gets going: the orders that went into
// production on an earlier day and still have stages outstanding, and which
// stages those are.
//
// WHAT "LATE" MEANS HERE. An order is late once the DAY HAS CHANGED since it
// reached production - the office's words. So something approved yesterday
// afternoon is in this morning's mail; something approved at nine this
// morning is not, however little has been done to it. The day is the office's
// day, IST, not the server's: Vercel runs in UTC and "today" there is five
// and a half hours out.
//
// WHICH ORDERS COUNT. The same ones the production board shows - cancelled
// work, local orders and anything already gone to dispatch are not on the
// board and are not chased here. An order nobody can act on is noise, and a
// morning mail with noise in it is a mail people stop opening.
//
// WHICH STAGES COUNT. utils/productionStages.js, which is also what draws
// the badges on the board. One list, one reading of it - a mail that says an
// order is late while the screen shows it green is worse than no mail.
// ══════════════════════════════════════════════════════
const db = require('../config/db');
const { sendMail } = require('./mailer');
const stages = require('./productionStages');

const TO = (process.env.STAGE_REPORT_TO
  || 'ramchandra@arabellajaipur.com, kailash@arabellajaipur.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const APP_URL = () => (process.env.APP_URL || 'https://mis.arabellapapers.com').replace(/\/+$/, '');

/** Today in IST as YYYY-MM-DD. The office's day, not the server's. */
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB',
  { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '');

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The day an order reached the floor is the approval date, not the punch
// date: an order approved this morning may have been taken a month ago. The
// production board orders itself the same way, for the same reason.
const REACHED_ON = 'COALESCE(actual_2, timestamp)';

// WHICH ORDERS ARE PRODUCTION'S WORK - the board's own rules, imported, not
// rewritten. Written from memory instead, this report came out at 3,308
// orders: the oldest sitting 929 days with every stage untouched, because
// the history imported from the sheet was never worked through the app and
// sits on the Backup Production board where nobody is chasing it.
//
// A mail that long is deleted unread on the first morning. So the rule is:
// if it is not on the board somebody opens, it is not in the mail.
const board = require('./productionBoard');

/**
 * The orders still owing stages this morning.
 *
 * @returns {Promise<{asOf: string, orders: Array, stageTotals: Array}>}
 */
async function pending() {
  const today = todayIST();

  const [rows] = await db.query(
    `SELECT order_id, dealer_name, client_name, order_type,
            india_designer, overseas_designer,
            ${REACHED_ON} AS reached,
            guest_name, paper_cutting, dye_status, block_status,
            printing, edges, laser_cutting, output, card_assembly
       FROM orders
      WHERE ${board.PRODUCTION_QUEUE_WHERE}
        AND NOT ${board.LEFT_FOR_DISPATCH}
        AND ${board.ON_PRODUCTION_BOARD(false)}
        AND ${REACHED_ON} IS NOT NULL
        -- The day has changed since it reached the floor. Strictly earlier,
        -- so this morning's approvals are tomorrow's business.
        --
        -- No CONVERT_TZ here, and that is deliberate: config/db.js pins every
        -- connection to +05:30, so these columns already hold IST wall-clock
        -- and DATE() gives the office's day straight off. Converting would
        -- shift it five and a half hours and put a whole evening's orders in
        -- the wrong day's mail.
        AND DATE(${REACHED_ON}) < ?
      ORDER BY ${REACHED_ON} ASC, id ASC`,
    [board.PRODUCTION_ARCHIVE_FROM, today],
  );

  const orders = [];
  for (const r of rows) {
    const left = stages.pending(r, 'column');
    if (!left.length) continue;
    const reachedDay = new Date(r.reached).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    orders.push({
      orderId: r.order_id,
      dealer: r.dealer_name || '',
      client: r.client_name || '',
      rush: /rush/i.test(String(r.order_type || '')),
      designer: (r.india_designer || r.overseas_designer || '').trim(),
      reached: day(r.reached),
      // How many days it has been sitting, in the office's days. One is
      // "since yesterday"; eleven is a different conversation.
      waiting: Math.round(
        (new Date(today + 'T00:00:00Z') - new Date(reachedDay + 'T00:00:00Z')) / 86400000),
      pending: left,
    });
  }

  // Longest wait first. The morning's first question is what has been stuck
  // the longest, not what came in last.
  orders.sort((a, b) => b.waiting - a.waiting);

  // Which stage is holding up the most work, so the mail opens with a shape
  // rather than a list to count by hand.
  const totals = new Map();
  for (const o of orders) for (const s of o.pending) totals.set(s.label, (totals.get(s.label) || 0) + 1);
  const stageTotals = stages.STAGES
    .map(s => ({ label: s.label, count: totals.get(s.label) || 0 }))
    .filter(s => s.count > 0)
    .sort((a, b) => b.count - a.count);

  return { asOf: today, orders, stageTotals };
}

function html(report) {
  const url = APP_URL();
  const shape = report.stageTotals.map(s =>
    `<span style="display:inline-block;background:#fdecea;color:#b02a37;border-radius:4px;
      padding:3px 8px;margin:0 6px 6px 0;font-size:13px;">
      ${esc(s.label)} <b>${s.count}</b></span>`).join('');

  const rows = report.orders.map(o => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;">
        <b>${esc(o.orderId)}</b>${o.rush ? ' <span style="color:#b02a37;font-size:11px;font-weight:700;">RUSH</span>' : ''}
        <div style="color:#888;font-size:12px;margin-top:2px;">
          ${esc(o.reached)} &nbsp;·&nbsp; ${o.waiting} day${o.waiting === 1 ? '' : 's'}
        </div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;">
        ${esc(o.client || o.dealer || '-')}
        ${o.designer ? `<div style="color:#888;font-size:12px;margin-top:2px;">${esc(o.designer)}</div>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;vertical-align:top;">
        ${o.pending.map(s => `
          <span style="display:inline-block;border:1px solid #f1c6c2;color:#b02a37;border-radius:4px;
            padding:2px 7px;margin:0 5px 5px 0;font-size:12px;" title="${esc(s.said)}">
            ${esc(s.label)}</span>`).join('')}
      </td>
    </tr>`).join('');

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:860px;color:#222;">
    <div style="letter-spacing:.2em;font-size:12px;color:#b08a3e;font-weight:700;">ARABELLA PAPERS</div>
    <h2 style="margin:6px 0 2px;">Production stages still open</h2>
    <p style="margin:0 0 16px;color:#666;">
      ${report.orders.length} order${report.orders.length === 1 ? '' : 's'} went into production
      on an earlier day and ${report.orders.length === 1 ? 'is' : 'are'} not finished.
    </p>
    <div style="margin:0 0 14px;">${shape}</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead>
        <tr style="background:#f6f6f6;">
          <th align="left" style="padding:8px 12px;">Order</th>
          <th align="left" style="padding:8px 12px;">Client</th>
          <th align="left" style="padding:8px 12px;">Still to do</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:18px 0 0;">
      <a href="${url}/?tab=productionBD" style="color:#0d6efd;">Open the production board</a>
    </p>
    <p style="margin:10px 0 0;color:#888;font-size:12px;">
      Sent at nine each morning. Cancelled orders, local orders and anything
      already with Dispatch are left out.
    </p>
  </div>`;
}

function text(report) {
  const lines = report.orders.map(o =>
    `${o.orderId}${o.rush ? ' (RUSH)' : ''} — ${o.client || o.dealer || '-'}`
    + ` — ${o.waiting} day${o.waiting === 1 ? '' : 's'}`
    + ` — still to do: ${o.pending.map(s => s.label).join(', ')}`);
  return `Production stages still open\n\n`
    + `${report.orders.length} order(s) went into production on an earlier day `
    + `and are not finished.\n\n${lines.join('\n')}\n`;
}

/**
 * Work it out and send it.
 *
 * Nothing outstanding means no mail. A daily "all clear" trains people to
 * delete it unread, and then the morning it matters it goes the same way.
 */
async function sendStageReport() {
  const report = await pending();
  if (!report.orders.length) return { sent: false, reason: 'nothing outstanding', orders: 0 };

  await sendMail({
    to: TO.join(', '),
    subject: `Production: ${report.orders.length} order${report.orders.length === 1 ? '' : 's'} with stages still open`,
    html: html(report),
    text: text(report),
  });
  return { sent: true, to: TO, orders: report.orders.length, asOf: report.asOf };
}

module.exports = { TO, pending, html, text, sendStageReport, todayIST };
