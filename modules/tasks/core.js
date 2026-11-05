// ════════════════════════════════════════════════════════════════════
// Delegation + Checklist module — shared services and helpers.
//
// createCore(config) returns everything the route files use. Most of it is the
// ERP's own code, taken over as it was (see "from server.js" notes); the
// project can replace the services it already has through config:
//   config.db              mysql2/promise pool (required)
//   config.requireAuth     (req,res,next) that sets req.session = { userId, role, name }
//   config.requireAdmin    defaults to role === 'admin'
//   config.sendMail        (to, subject, html, opts) => Promise<boolean>
//   config.sendWhatsAppRaw (to, text) => Promise<{ok}>   group ids / numbers as-is
//   config.jwtSecret       for the built-in requireAuth (else env SESSION_SECRET)
//   config.mailFromName, config.roleDefaults
// ════════════════════════════════════════════════════════════════════
// Loaded only when used: a project that passes its own sendMail / requireAuth
// does not need nodemailer / jsonwebtoken installed for the module.
const lazy = name => { let m; return () => (m = m || require(name)); };
const nodemailer = lazy('nodemailer');
const jwtLib = lazy('jsonwebtoken');

module.exports = function createCore(config) {
  const db = config.db;
  if (!db || typeof db.query !== 'function') throw new Error('task module: config.db (a mysql2/promise pool) is required');
  const JWT_SECRET = config.jwtSecret || process.env.SESSION_SECRET || process.env.JWT_SECRET;

  // ── E-mail (from server.js) ──
  // server.js 921-974
  // No transporter of its own when the project hands over its sendMail.
  const mailTransporter = config.sendMail ? null : nodemailer().createTransport(process.env.SMTP_TEST_HOST
    ? {
        host: process.env.SMTP_TEST_HOST, port: Number(process.env.SMTP_TEST_PORT) || 2525,
        secure: false, ignoreTLS: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      }
    : {
        service: 'gmail',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

  if (mailTransporter) (async () => {
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await mailTransporter.verify();
        console.log('  ✅ Gmail SMTP Ready');
      } else {
        console.log('  ⚠️  SMTP credentials missing — emails disabled');
      }
    } catch (err) {
      console.error('  ❌ SMTP verification failed:', err.message);
    }
  })();

  // The display name on every email the app sends ("E-Marketing HR" in
  // production); Compose Email shows it under its editor.
  const MAIL_FROM_NAME = config.mailFromName || process.env.SMTP_FROM_NAME || 'Task Manager';

  // Reusable email sender — never throws (failures are logged only)
  // opts.attachments (optional) is passed straight to nodemailer, e.g.
  // [{ filename: 'x.pdf', content: <Buffer>, contentType: 'application/pdf' }].
  // Returns true on success so callers that care (e.g. the offer-email endpoint)
  // can report/throw; existing fire-and-forget callers can ignore it.
  // opts.replyTo sends replies elsewhere (Compose Email: to the admin who wrote it).
  async function sendMail(to, subject, html, opts = {}) {
    if (config.sendMail) return config.sendMail(to, subject, html, opts);
    if (!to || !process.env.SMTP_USER) return false;
    try {
      await mailTransporter.sendMail({
        from: `"${MAIL_FROM_NAME}" <${process.env.SMTP_USER}>`,
        to, subject, html,
        ...(opts.cc ? { cc: opts.cc } : {}),
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts.attachments ? { attachments: opts.attachments } : {})
      });
      console.log(`  📧 Email sent to ${to} — ${subject}`);
      return true;
    } catch (err) {
      console.error(`  ❌ Email failed (${to}):`, err.message);
      return false;
    }
  }

  // server.js 979-1011
  async function getNotifyTarget(userId) {
    try {
      const [rows] = await db.query(
        'SELECT name, email, notification_email FROM task_users WHERE id=? LIMIT 1',
        [userId]
      );
      const u = rows[0];
      const email = u && (u.notification_email || u.email);
      if (!email) return null;
      return { name: u.name, email };
    } catch { return null; }
  }

  // ── WhatsApp → Email migration helpers ───────────────────────────────
  // The team asked for every personal-number notification to arrive by email
  // instead of WhatsApp (only the HR onboarding email-ID notice and the client/
  // team GROUP messages stay on WhatsApp). Rather than hand-write an HTML
  // template per message, these turn the existing WhatsApp text into a simple
  // email so the wording stays identical.
  function waTextToEmailHtml(text) {
    const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
    const body = esc(text)
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')  // *bold* → <strong>
      .replace(/\n/g, '<br>');
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.6">${body}</div>`;
  }
  // Email a WhatsApp-style message to a user resolved by id. Best-effort; returns
  // true if it went out. Safe to call fire-and-forget.
  async function emailUserWaText(userId, subject, text) {
    const t = await getNotifyTarget(userId);
    if (!t?.email) return false;
    return sendMail(t.email, subject, waTextToEmailHtml(text));
  }


  // ── WhatsApp through Waumfy (from server.js) ──
  // server.js 5326-5417
  // ("120363…@g.us") in `phone`, so the raw sender below shares this URL rather
  // than needing a second one.
  //
  // No hardcoded key fallback on purpose — the previous key shipped in this file,
  // which is a good way to get a key deactivated. Set WAUMFY_API_KEY in the env.
  const WAUMFY_URL = process.env.WAUMFY_URL || 'https://www.waumfy.com/api/v1/send-message';
  const WAUMFY_API_KEY = process.env.WAUMFY_API_KEY || '';

  async function sendWhatsApp(phone, text) {
    if (process.env.WA_DISABLED === 'true') {
      console.log(`  🔇 WhatsApp send SKIPPED (WA_DISABLED) → ${phone}: ${text.slice(0, 60)}...`);
      return { ok: true, skipped: true };
    }
    if (!WAUMFY_API_KEY) {
      console.error('  ❌ WhatsApp NOT sent — WAUMFY_API_KEY is unset in this environment');
      return { ok: false, reason: 'WAUMFY_API_KEY not set' };
    }

    if (!phone) return { ok: false, reason: 'no phone' };
    // Strip non-digits, ensure 91 prefix (India)
    let to = String(phone).replace(/\D/g, '');
    if (to.length === 10) to = '91' + to;          // 10-digit → add 91
    else if (to.length === 12 && to.startsWith('91')) {} // already correct
    else if (to.length === 11 && to.startsWith('0')) to = '91' + to.slice(1);
    else return { ok: false, reason: 'invalid phone format' };

    // Cap the provider call at 30s. Without it a stalled Waumfy fetch hangs the
    // whole awaiting request — which is how a cron that sends WhatsApp (e.g. the
    // due-date nudge) would run past Vercel's 60s limit and never respond.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const fetch = global.fetch || (await import('node-fetch')).default;
      const r = await fetch(WAUMFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': WAUMFY_API_KEY },
        body: JSON.stringify({ phone: to, message: text }),
        signal: ctrl.signal
      });
      const data = await r.text();
      if (r.ok) {
        console.log(`  📱 WhatsApp sent → ${to}`);
        return { ok: true, response: data };
      } else {
        console.error(`  ❌ WhatsApp failed (${r.status}): ${data}`);
        return { ok: false, status: r.status, error: data };
      }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'provider timeout after 30s' : err.message;
      console.error('  ❌ WhatsApp error:', msg);
      return { ok: false, error: msg };
    } finally { clearTimeout(timer); }
  }

  // Raw send — used for WhatsApp group IDs (e.g. "120363400573269993@g.us")
  // No phone formatting, no 91-prefix logic — sends "to" as-is.
  async function sendWhatsAppRaw(to, text) {
    if (process.env.WA_DISABLED === 'true') {
      console.log(`  🔇 WhatsApp (raw) send SKIPPED (WA_DISABLED) → ${to}: ${text.slice(0, 60)}...`);
      return { ok: true, skipped: true };
    }
    if (!WAUMFY_API_KEY) {
      console.error('  ❌ WhatsApp (raw) NOT sent — WAUMFY_API_KEY is unset in this environment');
      return { ok: false, reason: 'WAUMFY_API_KEY not set' };
    }

    if (!to) return { ok: false, reason: 'no destination' };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const fetch = global.fetch || (await import('node-fetch')).default;
      const r = await fetch(WAUMFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': WAUMFY_API_KEY },
        body: JSON.stringify({ phone: String(to), message: text }),
        signal: ctrl.signal
      });
      const data = await r.text();
      if (r.ok) {
        console.log(`  📱 WhatsApp (raw) sent → ${to}`);
        return { ok: true, response: data };
      } else {
        console.error(`  ❌ WhatsApp (raw) failed (${r.status}): ${data}`);
        return { ok: false, status: r.status, error: data };
      }
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'provider timeout after 30s' : err.message;
      console.error('  ❌ WhatsApp (raw) error:', msg);
      return { ok: false, error: msg };
    } finally { clearTimeout(timer); }
  }


  // ── Login check (from server.js): JWT from the `token` cookie or a Bearer header,
  // role read live from task_users. Used only when config.requireAuth is not given. ──
  // server.js 1053-1116
  const ROLE_CACHE_TTL_MS = 30 * 1000;
  const roleCache = new Map(); // userId -> { role, exp }

  // Call after anything that writes users.role (or deletes the row) so the change
  // lands on the next request rather than up to TTL later.
  function invalidateRoleCache(userId) {
    roleCache.delete(Number(userId));
  }

  async function liveRole(userId, tokenRole) {
    const hit = roleCache.get(userId);
    if (hit && hit.exp > Date.now()) return hit.role;
    let row;
    try {
      [[row]] = await db.query('SELECT role FROM task_users WHERE id=? LIMIT 1', [userId]);
    } catch (e) {
      // DB blip. Fall back to the token's role — that is exactly what this
      // middleware did before, so a bad minute on the database degrades to the
      // old behaviour instead of logging the whole company out at once.
      return tokenRole;
    }
    // The query succeeded and there is no such user: the row was deleted. Only
    // reachable on a successful read, so it cannot be confused with the case above.
    if (!row) return null;
    roleCache.set(userId, { role: row.role, exp: Date.now() + ROLE_CACHE_TTL_MS });
    return row.role;
  }

  async function requireAuth(req, res, next) {
    const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ','');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    let decoded;
    try {
      decoded = jwtLib().verify(token, JWT_SECRET);
    } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
    // While an admin is viewing as an employee the token already carries the
    // TARGET's userId, so this resolves the employee's own current role — which
    // is what "view as" is supposed to show.
    const role = await liveRole(decoded.userId, decoded.role);
    if (role === null) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.session = {
      userId: decoded.userId, role, name: decoded.name,
      // Set only while an admin is viewing the app AS another user.
      impersonatedBy: decoded.impersonatedBy || null,
      impersonatorName: decoded.impersonatorName || null
    };
    // A client login is an outsider. It may use only what the client portal
    // (client.html) calls; every staff API — the staff directory, the client
    // list, meetings, HR, cards — is refused, including routes added later.
    if (role === 'client' && !CLIENT_ALLOWED_API.test(req.originalUrl.split('?')[0])) {
      return res.status(403).json({ error: 'Not available for client logins' });
    }
    next();
  }
  // Everything client.html calls: /api/me, /api/tasks and /api/tasks/:id/…,
  // /api/client-portal/…, /api/logout. Keep in step with client.html.
  const CLIENT_ALLOWED_API = /^\/api\/(me|logout|tasks(\/.*)?|client-portal(\/.*)?)$/;
  function requireAdmin(req, res, next) {
    if (req.session.role === 'admin') return next();
    res.status(403).json({ error: 'Admin only' });
  }


  // ── Permissions: which task actions a role may take ──
  // Same cascade as the ERP: an explicit users.user_permissions row wins, else
  // the role's defaults. Admin may do everything. Only the task actions are
  // listed here; config.roleDefaults replaces this table if the project's
  // roles differ.
  const SERVER_ROLE_DEFAULTS = config.roleDefaults || {
    hod:  { actions: ['edit_task','delete_task','create_task','create_checklist','transfer_task','reopen_task','approve_revision'] },
    pc:   { actions: ['approve_revision','bulk_approve','create_task','create_checklist','transfer_task','reopen_task','edit_task','delete_task'] },
    user: { actions: ['create_task','create_checklist','edit_task','delete_task','transfer_task'] },
  };
  async function getEffectivePerms(session) {
    if (session.role === 'admin') return 'all';
    let stored = null;
    try {
      const [[row]] = await db.query('SELECT user_permissions FROM task_users WHERE id=?', [session.userId]);
      if (row?.user_permissions) { try { stored = JSON.parse(row.user_permissions); } catch {} }
    } catch {}
    const def = SERVER_ROLE_DEFAULTS[session.role] || { actions: [] };
    return { actions: (stored && Array.isArray(stored.actions)) ? stored.actions : [...def.actions] };
  }
  async function userCanDo(session, action) {
    const p = await getEffectivePerms(session);
    return p === 'all' || p.actions.includes(action);
  }

  // ── Task helpers (from server.js) ──
  // server.js 1174-1176
  function getTable(type) {
    return type === 'delegation' ? 'delegation_tasks' : 'checklist_tasks';
  }

  // server.js 1178-1218
  // The same task, for the same doer, from the same assigner, for the same client
  // and the same date, created seconds ago is never a second delegation — it is a
  // double tap or a retried request. Production held groups of four identical
  // tasks written within one second, and the doer had to close every copy before
  // the task left their list. Returns the existing row's id so the caller can
  // answer with it instead of inserting another.
  //
  // Client and date are part of the match on purpose: the same wording for two
  // different clients, or two different dates, is real work. `<=>` rather than `=`
  // so a NULL client or a task still awaiting its due date matches as well.
  //
  // Lives here, outside POST /api/tasks, because that route branches on task type
  // and the guard was written inside the delegation arm — leaving checklist
  // creation unprotected against exactly the same double tap.
  async function findRecentDuplicateTask(table, { desc, assignedTo, assignedBy, clientId, dueDate }) {
    const [[row]] = await db.query(
      `SELECT id FROM ${table}
        WHERE description=? AND assigned_to=? AND assigned_by=?
          AND client_id <=> ? AND due_date <=> ?
          AND created_at >= DATE_SUB(NOW(), INTERVAL 2 MINUTE)
        ORDER BY id DESC LIMIT 1`,
      [desc, assignedTo, assignedBy, clientId, dueDate]);
    return row ? row.id : null;
  }

  // Append a row to task_activity. Never throws and never blocks the caller —
  // an audit write failing must not stop a user from marking their task done.
  function logTaskActivity({ taskId, taskType, field, oldStatus, newStatus, oldValue, newValue, changedBy, source, note }) {
    const f = field || 'status';
    // A status row fills old_value/new_value too, so one query can read the whole
    // history of a task without caring which kind of change each row is.
    const ov = oldValue !== undefined ? oldValue : (f === 'status' ? oldStatus : null);
    const nv = newValue !== undefined ? newValue : (f === 'status' ? newStatus : null);
    db.query(
      `INSERT INTO task_activity (task_id, task_type, old_status, new_status, field, old_value, new_value, changed_by, source, note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [taskId, taskType || 'delegation', oldStatus || null, newStatus || null,
       f, ov == null ? null : String(ov), nv == null ? null : String(nv),
       changedBy || null, source || null, note || null]
    ).catch(e => console.error('task_activity log err:', e.message));
  }

  // server.js 1220-1287
  // ══════════════════════════════════════════════════════
  // DELETE ARCHIVE
  // ══════════════════════════════════════════════════════
  // Snapshot rows into deleted_records before a hard DELETE removes them.
  //
  // Call this BEFORE the DELETE and let it throw: if the archive write fails we
  // must NOT go on to delete the rows, or the data is gone with no copy. A
  // silently-failing safety net is worse than none, so callers should leave this
  // un-caught and let their route's own catch turn it into a 500.
  //
  // `rows` = the full row object(s) about to be deleted (SELECT them first).
  // `opts.summary` = string, or fn(row) -> string, for a readable one-liner.
  // Rows whose user was deleted come back from a LEFT JOIN with no name. The
  // user's row is kept in deleted_records (archiveDeleted), so the name is read
  // from there and shown as "Name (removed)". pairs: [idKey, nameKey] per column.
  async function fillDeletedUserNames(rows, pairs) {
    const missing = new Set();
    const isGone = v => v == null || v === '' || v === '—' || String(v).includes('deleted user');
    for (const r of rows || []) for (const [idKey, nameKey] of pairs) {
      if (r[idKey] != null && isGone(r[nameKey])) missing.add(Number(r[idKey]));
    }
    if (!missing.size) return rows;
    let names = {};
    try {
      const [found] = await db.query(
        `SELECT record_id, record_data FROM deleted_records WHERE source_table='users' AND record_id IN (?) ORDER BY id`, [[...missing]]);
      for (const f of found) {
        try { const n = String(JSON.parse(f.record_data).name || '').trim(); if (n) names[f.record_id] = n; } catch {}
      }
    } catch (e) { return rows; }
    for (const r of rows) for (const [idKey, nameKey] of pairs) {
      const n = r[idKey] != null && isGone(r[nameKey]) && names[Number(r[idKey])];
      if (n) r[nameKey] = `${n} (removed)`;
    }
    return rows;
  }

  async function archiveDeleted(sourceTable, rows, req, opts = {}) {
    const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
    if (!list.length) return;

    const via = (opts.via || `${req?.method || ''} ${req?.originalUrl || ''}`).trim().slice(0, 120);
    const actorId   = req?.session?.userId ?? null;
    const actorName = String(req?.session?.name || '').slice(0, 255);
    const actorRole = String(req?.session?.role || '').slice(0, 20);

    const values = list.map(row => {
      let summary = '';
      try {
        summary = typeof opts.summary === 'function' ? opts.summary(row) : (opts.summary || '');
      } catch (e) { summary = ''; }
      return [
        sourceTable,
        row?.id ?? null,
        JSON.stringify(row),
        String(summary || '').slice(0, 255),
        actorId, actorName, actorRole, via,
        opts.reason || null,
      ];
    });

    await db.query(
      `INSERT INTO deleted_records
         (source_table, record_id, record_data, summary,
          deleted_by, deleted_by_name, deleted_by_role, deleted_via, delete_reason)
       VALUES ?`,
      [values]);
  }


  // ── Who may see a task / its sub-tasks; who sees all approvals (from server.js) ──
  // server.js 2414-2450
  // ── Sub-tasks: follow-up asks nested under a delegation task (e.g. client says
  // "make a dashboard" then later "change its color") instead of a brand-new task.
  async function canTouchSubtasks(req, task) {
    if (!task) return false;
    const role = req.session.role;
    if (role === 'client') {
      const [[me]] = await db.query('SELECT client_id FROM task_users WHERE id=? LIMIT 1', [req.session.userId]);
      return !!me?.client_id && Number(me.client_id) === Number(task.client_id);
    }
    return role === 'admin' || role === 'hod' || role === 'pc'
      || Number(task.assigned_to) === Number(req.session.userId)
      || Number(task.assigned_by) === Number(req.session.userId);
  }

  // May this session read one task's side data — its comments, its activity log?
  // Same rule sub-tasks already use: managers, the doer, the assigner, or the
  // client the task belongs to. Both routes below took an id off the URL and
  // answered, so changing the number in it read somebody else's task.
  async function canSeeTask(req, taskId, taskType) {
    const tt = taskType === 'checklist' ? 'checklist' : 'delegation';
    const id = parseInt(taskId, 10);
    if (!Number.isFinite(id)) return false;
    const [[task]] = await db.query(
      `SELECT id, assigned_to, assigned_by, client_id FROM ${getTable(tt)} WHERE id=?`, [id]);
    return canTouchSubtasks(req, task);
  }


  // ══════════════════════════════════════════════════════
  // APPROVALS
  // ══════════════════════════════════════════════════════
  // Admin or PC by role, or Approvals at the "Admin" level in Access Control
  // (admin_approvals). The role test stays: PC holds these powers today and does
  // not hold the key, so dropping it would take them away.
  async function seesAllApprovals(session) {
    return session.role === 'admin' || session.role === 'pc' || await userCanDo(session, 'admin_approvals');
  }


  // server.js 6930-6939

  // "14:30" → "02:30 PM". Input is always the server's TIME_FORMAT '%H:%i'.
  function fmtClock(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
  }


  // server.js 7565-7574

  // True when `userId` is a handler of the given client row (primary or secondary).
  async function isHandlerOf(userId, client) {
    if (!client) return false;
    if (Number(client.handler_id) === Number(userId)) return true;
    const [[row]] = await db.query(
      'SELECT 1 AS ok FROM client_handlers WHERE client_id=? AND user_id=? LIMIT 1', [client.id, userId]);
    return !!row;
  }


  // ── Dashboard: whose tasks a user sees (from server.js) ──
  async function dashboardUserFilter(req) {
      const uid = req.session.userId;
      const role = req.session.role;
      const isAdmin = role === 'admin' || role === 'pc';
      const isHod = role === 'hod';
      const filterEmployee = req.query.employee;
      let userFilter, params;

      if (isAdmin && filterEmployee && filterEmployee !== 'all') {
        userFilter = 'AND t.assigned_to = ?'; params = [filterEmployee];
      } else if (isAdmin) {
        userFilter = ''; params = [];
      } else if (isHod) {
        // HOD cannot drill into a single employee — they always see their whole
        // department's aggregate. Only admin (and PC) may switch the view, so the
        // `employee` query param is intentionally ignored here.
        // The department always comes from the HOD's own users row. The ?hodDept
        // param the dashboard sends is the same value, but trusting it let an HOD
        // read any department just by editing the URL.
        const [meRow] = await db.query('SELECT department FROM task_users WHERE id=?', [uid]);
        const resolvedDept = meRow[0]?.department || '';
        if (!resolvedDept) {
          // No department set — fall back to just their own tasks
          userFilter = 'AND t.assigned_to = ?'; params = [uid];
        } else {
          const [deptUsers] = await db.query('SELECT id FROM task_users WHERE department=? AND role NOT IN (?,?)', [resolvedDept, 'admin','hod']);
          if (!deptUsers.length) {
            // No users in this department — fall back to just their own tasks
            userFilter = 'AND t.assigned_to = ?'; params = [uid];
          } else {
            const ids = deptUsers.map(u=>u.id);
            // Include the HOD themselves too
            if (!ids.includes(uid)) ids.push(uid);
            userFilter = `AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
            params = ids;
          }
        }
      } else {
        userFilter = 'AND t.assigned_to = ?'; params = [uid];
      }
      return { userFilter, params };
  }


  // ── Dates, off days and holidays (from server.js) ──
  // server.js 10640-10794

  // ══════════════════════════════════════════════════════
  // HOLIDAYS — global; everyone reads, admin writes
  // Plus helpers used everywhere to decide if a user is "off" on a date.
  // ══════════════════════════════════════════════════════
  function _toDateStr(v) {
    if (v instanceof Date) return v.toISOString().slice(0,10);
    return String(v).slice(0,10);
  }

  // 'YYYY-MM-DD' + n days, same format back.
  function _addDays(dateStr, n) {
    const d = new Date(_toDateStr(dateStr) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // dateStr = 'YYYY-MM-DD'; holidaysSet = Set of YYYY-MM-DD strings
  // Single source of truth for off-days: Sunday, the last Saturday of the month,
  // and the Holiday tab (holidays table) — same rule applies to everyone.
  // Per-user week_off / extra_off are NOT considered.
  function isUserOffOn(_user, dateStr, holidaysSet) {
    const ds = _toDateStr(dateStr);
    const d = new Date(ds + 'T00:00:00Z');
    if (d.getUTCDay() === 0) return true; // Sunday
    if (isLastSaturdayOfMonth(ds)) return true;
    if (holidaysSet && holidaysSet.has(ds)) return true;
    return false;
  }

  async function loadHolidaysSet() {
    try {
      const [rows] = await db.query('SELECT DATE_FORMAT(holiday_date,"%Y-%m-%d") AS d FROM holidays');
      return new Set(rows.map(r => r.d));
    } catch (e) {
      console.error('loadHolidaysSet error:', e.message);
      return new Set();
    }
  }

  // Universal "no-message day" guard for all reminder/summary crons.
  // Returns { off: true, reason } if today is Sunday IST OR in the holidays table.
  // True if the given YYYY-MM-DD is the LAST Saturday of its month — a company
  // off day. (Saturday AND the next Saturday falls in a different month.)
  function isLastSaturdayOfMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (d.getUTCDay() !== 6) return false; // 6 = Saturday
    const next = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
    return next.getUTCMonth() !== d.getUTCMonth();
  }

  async function getTodayOffIST() {
    const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const today = istNow.toISOString().split('T')[0];
    const istDay = istNow.getUTCDay(); // 0 = Sunday IST
    if (istDay === 0) return { off: true, reason: 'Sunday — reminders skipped', today };
    // Last Saturday of every month is a company off day.
    if (isLastSaturdayOfMonth(today)) return { off: true, reason: 'Last Saturday of month — reminders skipped', today };
    const holidaysSet = await loadHolidaysSet();
    if (holidaysSet.has(today)) return { off: true, reason: 'Holiday — reminders skipped', today, holidaysSet };
    return { off: false, today, holidaysSet };
  }




  function nextWorkingDay(user, fromDateStr, holidaysSet) {
    const d = new Date(_toDateStr(fromDateStr) + 'T00:00:00');
    for (let i = 0; i < 60; i++) {
      d.setDate(d.getDate() + 1);
      const yy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      const ds = `${yy}-${mm}-${dd}`;
      if (!isUserOffOn(user, ds, holidaysSet)) return ds;
    }
    return _toDateStr(fromDateStr); // fallback
  }


  return {
    db,
    config,
    requireAuth: config.requireAuth || requireAuth,
    requireAdmin: config.requireAdmin || requireAdmin,
    liveRole,
    invalidateRoleCache,
    sendMail: config.sendMail || sendMail,
    getNotifyTarget,
    waTextToEmailHtml,
    emailUserWaText,
    sendWhatsApp,
    sendWhatsAppRaw: config.sendWhatsAppRaw || sendWhatsAppRaw,
    getTable,
    findRecentDuplicateTask,
    logTaskActivity,
    fillDeletedUserNames,
    archiveDeleted,
    canTouchSubtasks,
    canSeeTask,
    seesAllApprovals,
    getEffectivePerms,
    userCanDo,
    fmtClock,
    isHandlerOf,
    dashboardUserFilter,
    _toDateStr,
    _addDays,
    isUserOffOn,
    loadHolidaysSet,
    isLastSaturdayOfMonth,
    getTodayOffIST,
    nextWorkingDay,
  };
};
