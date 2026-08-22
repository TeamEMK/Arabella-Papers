const nodemailer = require('nodemailer');

// Mail is optional. Until SMTP_USER and SMTP_PASS are set the whole module is
// a no-op, so a missing password can never stop an order from being punched.
function isMailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
let warned = false;

function getTransporter() {
  if (transporter) return transporter;

  // Port 465 is implicit TLS; 587 upgrades with STARTTLS. Google Workspace
  // takes either, but the flag has to match the port or the handshake hangs.
  const port = Number(process.env.SMTP_PORT || 465);

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Vercel freezes the container between requests, so a pooled connection is
    // dead by the time the next one arrives. One connection per send it is.
    pool: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return transporter;
}

/**
 * Send one mail. Never throws — a mail that fails is logged and reported back,
 * because none of the callers should fail their own job over it.
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!isMailConfigured()) {
    if (!warned) {
      console.warn('[mail] SMTP_USER/SMTP_PASS not set — emails are disabled.');
      warned = true;
    }
    return { sent: false, skipped: 'not-configured' };
  }

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { sent: false, skipped: 'no-recipient' };

  try {
    const info = await getTransporter().sendMail({
      from: process.env.MAIL_FROM || `Arabella Papers <${process.env.SMTP_USER}>`,
      to: recipients.join(', '),
      subject,
      text,
      html,
      replyTo: replyTo || undefined,
    });
    console.log(`[mail] sent "${subject}" to ${recipients.join(', ')} (${info.messageId})`);
    return { sent: true };
  } catch (err) {
    console.error(`[mail] failed "${subject}" to ${recipients.join(', ')}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Prove the SMTP credentials work without sending anything. Used by the
 * settings check so a wrong app password shows up before an order does.
 */
async function verifyMail() {
  if (!isMailConfigured()) return { ok: false, error: 'SMTP_USER / SMTP_PASS not set.' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendMail, verifyMail, isMailConfigured };
