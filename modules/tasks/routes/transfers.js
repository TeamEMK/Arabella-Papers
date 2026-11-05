// ════════════════════════════════════════════════════════════════════
// Transfers: moving tasks from one person to another
// Taken over from the ERP's server.js as it was; ctx comes from core.js.
// ════════════════════════════════════════════════════════════════════
module.exports = function register(app, ctx) {
  const {
    db, requireAuth, requireAdmin, liveRole, invalidateRoleCache, sendMail, getNotifyTarget, waTextToEmailHtml, emailUserWaText, sendWhatsApp, sendWhatsAppRaw, getTable, findRecentDuplicateTask, logTaskActivity, fillDeletedUserNames, archiveDeleted, canTouchSubtasks, canSeeTask, seesAllApprovals, getEffectivePerms, userCanDo, fmtClock, isHandlerOf, dashboardUserFilter, _toDateStr, _addDays, isUserOffOn, loadHolidaysSet, isLastSaturdayOfMonth, getTodayOffIST, nextWorkingDay,
  } = ctx;

  // ══════════════════════════════════════════════════════
  // TASK TRANSFERS
  // ══════════════════════════════════════════════════════

  // POST — Create transfer request (user/hod/admin)
  app.post('/api/transfers', requireAuth, async (req, res) => {
    try {
      const { tasks, toUserId } = req.body;
      // tasks = [{taskId, taskType}]
      if (!tasks || !tasks.length || !toUserId)
        return res.status(400).json({ error: 'Tasks and target user required' });
      // The "🔀 Transfer" button already hides behind this key; the route did not
      // ask for it, so the ownership rules below were the only limit.
      if (!(await userCanDo(req.session, 'transfer_task'))) {
        return res.status(403).json({ error: 'You do not have access to transfer tasks' });
      }

      const uid = req.session.userId;
      const role = req.session.role;

      // Validate each task — user can only transfer their own, HOD dept, admin any
      for (const t of tasks) {
        const table = getTable(t.taskType);
        const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [t.taskId]);
        if (!rows[0]) return res.status(404).json({ error: `Task ${t.taskId} not found` });
        const task = rows[0];

        if (role === 'user' && Number(task.assigned_to) !== Number(uid))
          return res.status(403).json({ error: 'You can only transfer your own tasks' });

        if (role === 'hod') {
          const [taskUser] = await db.query('SELECT department FROM task_users WHERE id=?', [task.assigned_to]);
          const [hodUser] = await db.query('SELECT department FROM task_users WHERE id=?', [uid]);
          if (taskUser[0]?.department !== hodUser[0]?.department)
            return res.status(403).json({ error: 'HOD can only transfer tasks of their department' });
        }
      }

      // Insert transfer requests — skip if already pending
      let inserted = 0, skipped = 0;
      for (const t of tasks) {
        const table = getTable(t.taskType);
        const [rows] = await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [t.taskId]);
        const fromUser = rows[0].assigned_to;
        const [existing] = await db.query(
          `SELECT id FROM task_transfers WHERE task_id=? AND task_type=? AND status='pending'`,
          [t.taskId, t.taskType]
        );
        if (existing[0]) { skipped++; continue; }
        await db.query(
          `INSERT INTO task_transfers (task_id, task_type, from_user, to_user, requested_by, status) VALUES (?,?,?,?,?,'pending')`,
          [t.taskId, t.taskType, fromUser, toUserId, uid]
        );
        inserted++;
      }

      res.json({ success: true, count: inserted, skipped });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET — Task IDs that already have a pending transfer (for current user's tasks)
  app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT task_id, task_type FROM task_transfers WHERE status='pending' AND requested_by=?`,
        [req.session.userId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET — Pending transfers for approval (admin sees all, HOD sees dept)
  // Transfers keep their role gate (admin, hod, pc — what requireAdminOrHod
  // admitted) and add Approvals at the "Admin" level. That level also lifts an
  // HOD's own-department limit, as it does everywhere else on this page.
  async function transferAccess(session) {
    const full = await userCanDo(session, 'admin_approvals');
    // `own`: anyone else may still decide the transfers coming to them.
    const allowed = full || ['admin', 'hod', 'pc'].includes(session.role);
    return { allowed: true, full, own: !allowed };
  }

  app.get('/api/transfers', requireAuth, async (req, res) => {
    const acc = await transferAccess(req.session);
    if (!acc.allowed) return res.status(403).json({ error: 'Admin or HOD only' });
    try {
      const uid = req.session.userId;
      const role = req.session.role;
      let deptFilter = '';
      let params = [];

      if (acc.own) {
        // Everyone else sees only the transfers coming to them.
        deptFilter = 'AND tt.to_user=?';
        params = [uid];
      } else if (role === 'hod' && !acc.full) {
        const [me] = await db.query('SELECT department FROM task_users WHERE id=?', [uid]);
        const dept = me[0]?.department || '';
        // HOD sees transfers of users in their department, and any coming to them
        const [deptUsers] = await db.query('SELECT id FROM task_users WHERE department=?', [dept]);
        const ids = deptUsers.map(u=>u.id);
        deptFilter = ids.length
          ? `AND (tt.from_user IN (${ids.map(()=>'?').join(',')}) OR tt.to_user IN (${ids.map(()=>'?').join(',')}) OR tt.to_user=?)`
          : 'AND tt.to_user=?';
        params = [...ids, ...ids, uid];
      }

      const [rows] = await db.query(`
        SELECT tt.*,
          uf.name AS fromUserName, ut.name AS toUserName,
          ur.name AS requestedByName,
          u_from.department AS fromDept
        FROM task_transfers tt
        JOIN task_users uf ON tt.from_user = uf.id
        JOIN task_users ut ON tt.to_user = ut.id
        JOIN task_users ur ON tt.requested_by = ur.id
        JOIN task_users u_from ON tt.from_user = u_from.id
        WHERE tt.status = 'pending' ${deptFilter}
        ORDER BY tt.created_at DESC`, params);

      // Attach task description
      await attachTransferTasks(rows, true);

      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET — Transfer count for badge
  app.get('/api/transfers/count', requireAuth, async (req, res) => {
    const acc = await transferAccess(req.session);
    if (!acc.allowed) return res.status(403).json({ error: 'Admin or HOD only' });
    try {
      const uid = req.session.userId;
      let count = 0;
      if (acc.full) {
        const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending'`);
        count = r[0].c;
      } else if (acc.own) {
        const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending' AND to_user=?`, [uid]);
        count = r[0].c;
      } else {
        const [me] = await db.query('SELECT department FROM task_users WHERE id=?', [uid]);
        const dept = me[0]?.department || '';
        const [deptUsers] = await db.query('SELECT id FROM task_users WHERE department=?', [dept]);
        if (deptUsers.length) {
          const ids = deptUsers.map(u=>u.id);
          const [r] = await db.query(`SELECT COUNT(*) AS c FROM task_transfers WHERE status='pending' AND (from_user IN (${ids.map(()=>'?').join(',')}) OR to_user IN (${ids.map(()=>'?').join(',')}))`, [...ids,...ids]);
          count = r[0].c;
        }
      }
      res.json({ count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PUT — Approve or reject transfer
  app.put('/api/transfers/:id', requireAuth, async (req, res) => {
    const acc = await transferAccess(req.session);
    if (!acc.allowed) return res.status(403).json({ error: 'Admin or HOD only' });
    try {
      const { action, note } = req.body;
      const [code, body] = await decideTransfer(req.session, acc, req.params.id, action, note);
      res.status(code).json(body);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST — decide many transfers at once (a grouped row, or the ticked rows).
  // Each goes through the same rules as a single decision; the ones that fail
  // are reported back with their reason and the rest still go through.
  app.post('/api/transfers/bulk', requireAuth, async (req, res) => {
    const acc = await transferAccess(req.session);
    try {
      const { ids, action, note } = req.body || {};
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(n => parseInt(n, 10)).filter(Number.isFinite))];
      if (!list.length) return res.status(400).json({ error: 'No transfers selected' });
      if (list.length > 1000) return res.status(400).json({ error: 'Select at most 1000 at a time' });
      let done = 0; const failed = [];
      for (const id of list) {
        const [code, body] = await decideTransfer(req.session, acc, id, action, note);
        if (code === 200) done++; else failed.push({ id, error: body.error });
        // A bad action or a missing reason fails every row the same way.
        if (code === 400) return res.status(400).json(body);
      }
      res.json({ success: true, done, failed });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // One transfer decision. Returns [httpStatus, body].
  async function decideTransfer(session, acc, id, action, note) {
    {
      // The comment here used to say 'approved' | 'rejected' and nothing enforced
      // it. status is an ENUM, and non-strict MySQL turns an unexpected value into
      // the empty string rather than erroring — leaving a transfer that is neither
      // pending nor decided: gone from the pending list, task never moved, and the
      // request still answered success.
      if (!['approved', 'rejected'].includes(action)) {
        return [400, { error: 'action must be approved or rejected' }];
      }
      if (action === 'rejected' && !String(note || '').trim()) {
        return [400, { error: 'Please give a reason for rejecting' }];
      }
      const [rows] = await db.query('SELECT * FROM task_transfers WHERE id=?', [id]);
      if (!rows[0]) return [404, { error: 'Transfer not found' }];
      const tr = rows[0];

      // The person receiving the task may decide it; other users may not.
      const isReceiver = Number(tr.to_user) === Number(session.userId);
      if (acc.own && !isReceiver) {
        return [403, { error: 'You can only act on transfers coming to you' }];
      }

      // An HOD may only act on transfers touching their own department. Creating
      // one already checks this and so does the pending count, but approving did
      // not — requireAdminOrHod asks "an HOD?", never "which HOD?" — so any HOD
      // could reassign a task between two people in another department. Not
      // reachable by accident, since the list and count are both scoped, but
      // nothing stopped it either, and transfers leave no audit row.
      //
      // Ordered before the pending check on purpose: an HOD with no business here
      // should be turned away without being told whether the transfer is still
      // open or how it was decided.
      if (session.role === 'hod' && !acc.full && !isReceiver) {
        const [[me]] = await db.query('SELECT department FROM task_users WHERE id=?', [session.userId]);
        const dept = me?.department || '';
        const [parties] = await db.query(
          'SELECT department FROM task_users WHERE id IN (?,?)', [tr.from_user, tr.to_user]);
        // A blank department must not match another blank one into access.
        if (!dept || !parties.some(p => p.department === dept)) {
          return [403, { error: 'You can only act on transfers in your own department' }];
        }
      }

      // Deciding a transfer is a one-time act. Without this a rejected transfer
      // could be approved later and would move the task, so two people looking at
      // the same stale list could overwrite each other's decision silently.
      if (tr.status !== 'pending') {
        return [409, { error: `This transfer was already ${tr.status}` }];
      }

      // The check above is a read; the conditional write is what makes the decision
      // one-time when two people act at the same moment.
      const [claim] = await db.query(
        `UPDATE task_transfers SET status=?, note=? WHERE id=? AND status='pending'`, [action, note||'', id]);
      if (!claim.affectedRows) return [409, { error: 'This transfer was already decided' }];

      if (action === 'approved') {
        const table = getTable(tr.task_type);
        // Move the task only if it is still with the person who asked to hand it
        // over. If it was reassigned (or deleted) since, approving this old request
        // would silently take it away from whoever holds it now — so the transfer
        // goes back to pending and the approver is told to reject it instead.
        const [moved] = await db.query(
          `UPDATE ${table} SET assigned_to=? WHERE id=? AND assigned_to=?`, [tr.to_user, tr.task_id, tr.from_user]);
        // Already with the person it was going to (moved by an earlier try, or by
        // hand): there is nothing left to move, so the approval simply stands.
        const [[now]] = moved.affectedRows ? [[null]] : await db.query(`SELECT assigned_to FROM ${table} WHERE id=?`, [tr.task_id]);
        if (!moved.affectedRows && now && Number(now.assigned_to) === Number(tr.to_user)) {
          return [200, { success: true, already: true }];
        }
        if (!moved.affectedRows) {
          await db.query(`UPDATE task_transfers SET status='pending', note=? WHERE id=?`, [tr.note || '', id]);
          return [409, {
            error: 'This task is no longer with the person who asked to transfer it — the request is out of date. Reject it instead.'
          }];
        }
        // The one change that moves a task to a different person, and until now
        // it left nothing behind: "my task went to someone else" was unanswerable.
        const [names] = await db.query('SELECT id, name FROM task_users WHERE id IN (?,?)', [tr.from_user, tr.to_user]);
        const nameOf = id => names.find(n => Number(n.id) === Number(id))?.name || `#${id}`;
        logTaskActivity({
          taskId: tr.task_id, taskType: tr.task_type, field: 'assigned_to',
          oldValue: tr.from_user, newValue: tr.to_user,
          changedBy: session.userId, source: 'transfer-approved',
          note: `${nameOf(tr.from_user)} -> ${nameOf(tr.to_user)}`
        });
      }
      return [200, { success: true }];
    }
  }

  // GET — My sent transfer requests (for users to track)
  // Fills description (and due_date) on transfer rows with one query per task
  // table instead of one per row — the lists ran a query for every transfer.
  async function attachTransferTasks(rows, withDue) {
    for (const type of ['delegation', 'checklist']) {
      const ids = [...new Set(rows.filter(r => getTable(r.task_type) === getTable(type)).map(r => r.task_id))];
      const byId = {};
      if (ids.length) {
        const [tasks] = await db.query(
          `SELECT id, description, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${getTable(type)} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        tasks.forEach(t => { byId[t.id] = t; });
      }
      for (const r of rows) {
        if (getTable(r.task_type) !== getTable(type)) continue;
        const t = byId[r.task_id];
        r.description = t?.description || '—';
        if (withDue) r.due_date = t?.due_date || '—';
      }
    }
  }

  app.get('/api/transfers/my', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT tt.*, uf.name AS fromUserName, ut.name AS toUserName
        FROM task_transfers tt
        JOIN task_users uf ON tt.from_user = uf.id
        JOIN task_users ut ON tt.to_user = ut.id
        WHERE tt.requested_by=?
        ORDER BY tt.created_at DESC LIMIT 20`, [req.session.userId]);
      await attachTransferTasks(rows, false);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
