// ══════════════════════════════════════════════════════
// THE EVENING VECTOR REPORT
//
// Seven o'clock, to the owners: who is behind on vector files and by how
// much. The logout gate stops somebody leaving cleanly; this is what catches
// the one who shut the laptop instead.
//
// It is deliberately a list of names and counts rather than a scolding. The
// office reads it to know where the work is, and a mail that reads as an
// accusation is one people start arguing with instead of acting on.
// ══════════════════════════════════════════════════════
const { sendMail } = require('./mailer');
const vectorDuty = require('./vectorDuty');

const TO = (process.env.VECTOR_REPORT_TO
  || 'amita@arabellapapers.com, sagar@arabellapapers.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const APP_URL = () => (process.env.APP_URL || 'https://mis.arabellapapers.com').replace(/\/+$/, '');

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function html(report, when) {
  const rows = report.rows.map(r => {
    // One line per day, because "seven orders" and "seven orders spread over
    // four days" are not the same message. A designer who is a day behind
    // catches up; one carrying four days has stopped.
    const days = r.days.map(d => `
      <div style="margin:0 0 4px;">
        <span style="display:inline-block;min-width:96px;color:#444;font-weight:600;">${esc(d.date)}</span>
        <span style="color:#b02a37;font-weight:700;">${d.count}</span>
        <span style="color:#777;font-size:12px;"> &nbsp;${esc(d.orders.join(', '))}${d.more ? ` <i>+${d.more}</i>` : ''}</span>
      </div>`).join('');
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;vertical-align:top;white-space:nowrap;">
          ${esc(r.designer)}
          <div style="font-weight:400;color:#888;font-size:12px;margin-top:2px;">
            ${r.dayCount} day${r.dayCount === 1 ? '' : 's'}
          </div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;vertical-align:top;font-size:20px;font-weight:700;color:#b02a37;">${r.count}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;">${days}</td>
      </tr>`;
  }).join('');

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;color:#222;">
    <h2 style="margin:0 0 4px;">Vector files still to come</h2>
    <p style="margin:0 0 16px;color:#666;">${esc(when)}</p>
    <p style="margin:0 0 16px;">
      <b>${report.total}</b> order${report.total === 1 ? '' : 's'} across
      <b>${report.rows.length}</b> designer${report.rows.length === 1 ? '' : 's'}.
    </p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="background:#f4f4f4;">
          <th style="padding:8px 12px;text-align:left;">Designer</th>
          <th style="padding:8px 12px;">Pending</th>
          <th style="padding:8px 12px;text-align:left;">Which day they are from</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:18px 0 0;color:#666;font-size:12px;">
      Orders punched after ${vectorDuty.EVENING_CUTOFF_HOUR}:00 are left for tomorrow's count.
      Orders with no designer named are not counted against anybody.
      <br><a href="${APP_URL()}">Open the system</a>
    </p>
  </div>`;
}

function text(report, when) {
  const NL = '\n';
  return 'Vector files still to come — ' + when + NL + NL
    + report.total + ' orders across ' + report.rows.length + ' designers.' + NL + NL
    + report.rows.map(r => r.designer + ': ' + r.count
        + ' over ' + r.dayCount + ' day' + (r.dayCount === 1 ? '' : 's') + NL
        + r.days.map(d => '    ' + d.date + '  ' + d.count + '  '
            + d.orders.join(', ') + (d.more ? ' +' + d.more : '')).join(NL)
      ).join(NL + NL);
}

/**
 * Build and send tonight's report.
 *
 * Sends nothing when nobody is behind. A daily mail that mostly says "all
 * clear" is one that stops being opened, and then the night it matters it is
 * not opened either.
 *
 * @returns {Promise<{sent: boolean, reason?: string, total?: number}>}
 */
async function sendVectorReport() {
  const report = await vectorDuty.pendingByDesigner();
  if (!report.on) return { sent: false, reason: 'rule-off' };
  if (!report.total) return { sent: false, reason: 'nothing-pending', total: 0 };

  const when = new Date().toLocaleString('en-GB',
    { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  const res = await sendMail({
    to: TO.join(', '),
    subject: `${report.total} vector file${report.total === 1 ? '' : 's'} still to come — Arabella Papers`,
    html: html(report, when),
    text: text(report, when),
  });

  return { ...res, total: report.total, designers: report.rows.length };
}

module.exports = { sendVectorReport, TO };
