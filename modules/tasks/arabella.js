// ════════════════════════════════════════════════════════════════════
// Delegation + Checklist, wired into Arabella.
//
// The module (this folder) came from the E-Marketing ERP and reads the person
// from req.session.userId / role / name. Arabella's login keeps them in
// req.session.user = { id, username, role, domain }, so requireAuth below
// copies them across on every task request:
//   userId ← user.id     name ← user.username
//   role   ← 'admin' for a SuperAdmin, 'user' for everyone else
// (the same rule as the task_users view in schema.sql). Mail goes through
// Arabella's own utils/mailer; there is no WhatsApp here, so the module's
// client-group messages are skipped, and clients are switched off.
// ════════════════════════════════════════════════════════════════════
const db = require('../../config/db');
const mailer = require('../../utils/mailer');
const mountTaskModule = require('./index');

const taskRole = user => (user.role === 'SuperAdmin' ? 'admin' : 'user');

function requireAuth(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  req.session.userId = user.id;
  req.session.role = taskRole(user);
  req.session.name = user.username;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}

// The module calls sendMail(to, subject, html, opts) and wants true / false back.
async function sendMail(to, subject, html, opts = {}) {
  const r = await mailer.sendMail({ to, subject, html, replyTo: opts.replyTo, attachments: opts.attachments });
  return !!(r && r.sent);
}

module.exports = function mountTasks(app) {
  return mountTaskModule(app, {
    db,
    clients: false,
    requireAuth,
    requireAdmin,
    sendMail,
    sendWhatsAppRaw: async () => ({ ok: false, skipped: true, reason: 'no WhatsApp in Arabella' }),
    mailFromName: 'Arabella Papers',
  });
};
