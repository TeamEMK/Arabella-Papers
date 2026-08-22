const db = require('../config/db');
const { sendMail } = require('./mailer');

const APP_URL = () => (process.env.APP_URL || 'https://mis.arabellapapers.com').replace(/\/+$/, '');

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Find a designer's mailbox by the name stored on the order. Orders link to
 * designers by name text, not by id, so the name is all we ever have.
 * The designers table is the source of truth; a designer who was given a login
 * but never added to that list still gets found through users.
 * @returns {Promise<string>} the address, or '' if the designer has none
 */
async function designerEmail(name) {
  const designer = String(name || '').trim();
  if (!designer) return '';

  const [rows] = await db.query(
    `SELECT NULLIF(TRIM(IFNULL(india_email, '')), '')    AS india,
            NULLIF(TRIM(IFNULL(overseas_email, '')), '') AS overseas
       FROM designers
      WHERE LOWER(TRIM(IFNULL(india_name, ''))) = LOWER(?)
         OR LOWER(TRIM(IFNULL(overseas_name, ''))) = LOWER(?)
      LIMIT 1`,
    [designer, designer]
  );
  if (rows.length && (rows[0].india || rows[0].overseas)) {
    return rows[0].india || rows[0].overseas;
  }

  const [users] = await db.query(
    `SELECT email FROM users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1`,
    [designer]
  );
  return users.length ? (users[0].email || '') : '';
}

function assignmentHtml(order) {
  const rows = [
    ['Order ID', order.orderId],
    ['Client', order.client],
    ['Design time', order.designTime],
    ['Remarks', order.remarks],
  ]
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 16px 8px 0;color:#6c757d;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(k)}</td>
        <td style="padding:8px 0;color:#212529;font-size:14px;font-weight:600;">${esc(v)}</td>
      </tr>`)
    .join('');

  return `
  <div style="background:#f4f5f7;padding:24px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8eb;">
      <div style="background:#212529;padding:22px 24px;">
        <div style="color:#ffa500;font-size:17px;font-weight:700;letter-spacing:.5px;">ARABELLA PAPERS</div>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 4px;font-size:16px;color:#212529;">Hello ${esc(order.designerName)},</p>
        <p style="margin:0 0 20px;font-size:14px;color:#495057;line-height:1.5;">
          ${order.isReassignment
            ? 'An order has been reassigned to you for design.'
            : 'A new design task has been assigned to you.'}
        </p>
        <table style="width:100%;border-collapse:collapse;border-top:1px solid #e9ecef;border-bottom:1px solid #e9ecef;">
          ${rows}
        </table>
        <a href="${esc(APP_URL())}" style="display:inline-block;margin-top:22px;background:#ffa500;color:#212529;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:6px;">
          Open the dashboard
        </a>
        ${order.assignedBy
          ? `<p style="margin:20px 0 0;font-size:12px;color:#868e96;">Assigned by ${esc(order.assignedBy)}.</p>`
          : ''}
      </div>
      <div style="background:#f8f9fa;padding:14px 24px;border-top:1px solid #e9ecef;">
        <p style="margin:0;font-size:11px;color:#adb5bd;line-height:1.5;">
          This is an automated message from the Arabella Papers FMS. Please do not reply to it.
        </p>
      </div>
    </div>
  </div>`;
}

function assignmentText(order) {
  return [
    `Hello ${order.designerName},`,
    '',
    order.isReassignment
      ? 'An order has been reassigned to you for design.'
      : 'A new design task has been assigned to you.',
    '',
    `Order ID   : ${order.orderId}`,
    order.client ? `Client     : ${order.client}` : '',
    order.designTime ? `Design time: ${order.designTime}` : '',
    order.remarks ? `Remarks    : ${order.remarks}` : '',
    '',
    `Open the dashboard: ${APP_URL()}`,
    order.assignedBy ? `Assigned by ${order.assignedBy}.` : '',
    '',
    'This is an automated message from the Arabella Papers FMS.',
  ].filter(l => l !== '').join('\n');
}

/**
 * Tell a designer an order has landed on their plate. Resolves the mailbox
 * itself so callers only have to pass the name that is on the order.
 * Never throws: a designer with no email on file, or an SMTP that is down,
 * must not fail the order that triggered this.
 */
async function notifyDesignerAssigned(order) {
  try {
    const to = await designerEmail(order.designerName);
    if (!to) {
      console.warn(`[mail] ${order.orderId}: no email on file for designer "${order.designerName}"`);
      return { sent: false, skipped: 'no-designer-email' };
    }

    return await sendMail({
      to,
      subject: order.isReassignment
        ? `Order ${order.orderId} reassigned to you — Arabella Papers`
        : `New design task: ${order.orderId} — Arabella Papers`,
      html: assignmentHtml(order),
      text: assignmentText(order),
    });
  } catch (err) {
    console.error(`[mail] ${order.orderId}: assignment notice failed:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { notifyDesignerAssigned, designerEmail };
