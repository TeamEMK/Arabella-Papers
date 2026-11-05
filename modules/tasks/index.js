// ════════════════════════════════════════════════════════════════════
// Delegation + Checklist module — server entry.
//
//   const mountTaskModule = require('./delegation-checklist-module/server');
//   mountTaskModule(app, { db, requireAuth, requireAdmin, sendMail, ... });
//
// Call it after express.json() and cookie-parser are set up. It registers the
// task, dashboard, approval, comment, transfer and holiday routes under /api
// (the same paths the ERP uses, so its frontend works unchanged), plus three
// small lookups under /api/task-module for the module's own pages.
// See README.md for every config option.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const createCore = require('./core');

// The module's tables and the task_users view (schema.sql), built on the first
// task request the way config/initDb.js builds the app's own: every statement
// is IF NOT EXISTS / OR REPLACE, so a database that has them is left alone.
let _schemaReady = null;
function ensureTaskSchema(db) {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const statements = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
        .split(';').map(s => s.trim()).filter(Boolean);
      for (const s of statements) await db.query(s);
    })().catch(err => { _schemaReady = null; throw err; });
  }
  return _schemaReady;
}
const TASK_PATHS = ['/api/tasks', '/api/subtasks', '/api/dashboard', '/api/approvals', '/api/comments',
  '/api/transfers', '/api/holidays', '/api/task-module'];

module.exports = function mountTaskModule(app, config = {}) {
  const ctx = createCore(config);
  const { db, requireAuth, getEffectivePerms } = ctx;
  app.use(TASK_PATHS, (req, res, next) => ensureTaskSchema(db).then(() => next(), next));

  // In the ERP's order (dashboard came before the task routes there).
  require('./routes/dashboard')(app, ctx);
  require('./routes/tasks')(app, ctx);
  require('./routes/approvals')(app, ctx);
  require('./routes/comments')(app, ctx);
  require('./routes/transfers')(app, ctx);
  require('./routes/holidays')(app, ctx);

  // ── Lookups for the module's pages ──
  // Who is logged in and which task actions they may take (the pages hide
  // buttons from this; every route checks again on its own).
  app.get('/api/task-module/me', requireAuth, async (req, res) => {
    try {
      const [[u]] = await db.query('SELECT id, name, email, role, department FROM task_users WHERE id=?', [req.session.userId]);
      if (!u) return res.status(404).json({ error: 'User not found' });
      const p = await getEffectivePerms(req.session);
      res.json({ ...u, role: req.session.role, can: p === 'all' ? { all: true, actions: [] } : { all: false, actions: p.actions } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Everyone who can be given a task. Client logins are left out.
  app.get('/api/task-module/users', requireAuth, async (req, res) => {
    try {
      const [cols] = await db.query('SHOW COLUMNS FROM task_users');
      const has = new Set(cols.map(c => c.Field));
      const pick = ['id', 'name', 'email', 'role', 'department', 'week_off', 'extra_off'].filter(c => has.has(c));
      const [rows] = await db.query(`SELECT ${pick.join(', ')} FROM task_users WHERE COALESCE(role,'') <> 'client' ORDER BY name`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // The clients a task can be tagged with (empty when config.clients is false).
  app.get('/api/task-module/clients', requireAuth, async (req, res) => {
    try {
      if (config.clients === false) return res.json([]);
      const [rows] = await db.query(
        `SELECT c.id, c.name, c.brand_name, c.is_active,
                (c.handler_id = ? OR EXISTS (SELECT 1 FROM client_handlers h WHERE h.client_id = c.id AND h.user_id = ?)) AS is_my_client
           FROM clients c ORDER BY c.name`, [req.session.userId, req.session.userId]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return ctx;
};
