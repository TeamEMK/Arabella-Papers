// ════════════════════════════════════════════════════════════════════
// Approvals: revise-date and completion requests waiting on the assigner
// Taken over from the ERP's server.js as it was; ctx comes from core.js.
// ════════════════════════════════════════════════════════════════════
module.exports = function register(app, ctx) {
  const {
    db, requireAuth, requireAdmin, liveRole, invalidateRoleCache, sendMail, getNotifyTarget, waTextToEmailHtml, emailUserWaText, sendWhatsApp, sendWhatsAppRaw, getTable, findRecentDuplicateTask, logTaskActivity, fillDeletedUserNames, archiveDeleted, canTouchSubtasks, canSeeTask, seesAllApprovals, getEffectivePerms, userCanDo, fmtClock, isHandlerOf, dashboardUserFilter, _toDateStr, _addDays, isUserOffOn, loadHolidaysSet, isLastSaturdayOfMonth, getTodayOffIST, nextWorkingDay,
  } = ctx;

  // server.js 2452-2591
  app.get('/api/approvals', requireAuth, async (req, res) => {
    try {
      const isAdminOrPC = await seesAllApprovals(req.session);
      // Everyone sees the approvals routed to THEM (the task's assigner). Admin/PC
      // see ALL pending approvals so nothing is ever stuck — e.g. requests routed to
      // a client (no approvals screen) or to a missing/invalid assigner.
      let whereClause, params;
      if (isAdminOrPC) { whereClause = `WHERE ta.status='pending'`; params = []; }
      else { whereClause = `WHERE ta.requested_to=? AND ta.status='pending'`; params = [req.session.userId]; }
      // requested_to on this row IS the task's own assigned_by — see the two
      // INSERT INTO task_approvals sites in backend/routes/tasks.js, both of
      // which set it to `task.assigned_by`. So requestedToName already answers
      // "who delegated this", it just was not being rendered on the page yet.
      // client_id lives on whichever of delegation_tasks/checklist_tasks this
      // row is for, same COALESCE pattern the rest of the query already uses.
      const [rows] = await db.query(`SELECT ta.*,DATE_FORMAT(ta.new_date,'%Y-%m-%d') AS reviseToDate,COALESCE(u1.name,'(deleted)') AS requestedByName,COALESCE(u2.name,'(deleted)') AS requestedToName,COALESCE(dt.description,ct.description) AS description,dt.approval AS taskApproval,DATE_FORMAT(COALESCE(dt.due_date,ct.due_date),'%Y-%m-%d') AS currentDue,COALESCE(NULLIF(TRIM(cl.brand_name),''), cl.name) AS clientName FROM task_approvals ta LEFT JOIN task_users u1 ON ta.requested_by=u1.id LEFT JOIN task_users u2 ON ta.requested_to=u2.id LEFT JOIN delegation_tasks dt ON ta.task_id=dt.id AND ta.task_type='delegation' LEFT JOIN checklist_tasks ct ON ta.task_id=ct.id AND ta.task_type='checklist' LEFT JOIN clients cl ON cl.id=COALESCE(dt.client_id,ct.client_id) ${whereClause} ORDER BY ta.created_at DESC`, params);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/approvals/count', requireAuth, async (req, res) => {
    try {
      // Count approvals waiting on THIS user; admin/PC count ALL pending so orphaned
      // ones (client-routed or missing assigner) surface instead of getting stuck.
      const isAdminOrPC = await seesAllApprovals(req.session);
      const sql = isAdminOrPC
        ? `SELECT COUNT(*) AS count FROM task_approvals WHERE status='pending'`
        : `SELECT COUNT(*) AS count FROM task_approvals WHERE requested_to=? AND status='pending'`;
      const [rows] = await db.query(sql, isAdminOrPC ? [] : [req.session.userId]);
      res.json({ count: rows[0].count });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/approvals/:id', requireAuth, async (req, res) => {
    try {
      const { action, note } = req.body;
      // Anything else used to be written into task_approvals.status as-is, and the
      // "rejected" branch below then cleared the task's waiting flag — so a bad
      // value made the request silently vanish.
      if (action !== 'approved' && action !== 'rejected') return res.status(400).json({ error: 'Invalid action' });
      const [rows] = await db.query(`SELECT *, DATE_FORMAT(new_date,'%Y-%m-%d') AS new_date_fmt FROM task_approvals WHERE id=?`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Approval not found' });
      const appr = rows[0];
      // PC and admin (or admin_approvals) can approve any; others only their own
      const canApprove = appr.requested_to === req.session.userId || await seesAllApprovals(req.session);
      if (!canApprove) return res.status(403).json({ error: 'Not allowed' });
      // Same sub-task rule as PUT /api/tasks/:id/status — re-checked here because
      // the client can add a sub-task after completion was requested, and
      // approving would otherwise close the task over it.
      if (action === 'approved' && appr.action_type === 'completed' && appr.task_type === 'delegation') {
        const [[open]] = await db.query(
          `SELECT COUNT(*) AS n FROM task_subtasks WHERE task_id=? AND status<>'completed'`, [appr.task_id]);
        if (open?.n > 0) {
          return res.status(409).json({
            error: `${open.n} sub-task${open.n === 1 ? '' : 's'} still pending on this task — it cannot be approved as done yet.`
          });
        }
      }
      // Claim the request first, and only while it is still pending: a double
      // click, a second approver, or a rejected revise approved later from a stale
      // screen must not touch the task (that last one would push the due date).
      const [claim] = await db.query(
        `UPDATE task_approvals SET status=?,note=? WHERE id=? AND status='pending'`, [action, note||'', req.params.id]);
      if (!claim.affectedRows) return res.status(409).json({ error: 'This request has already been decided' });
      const table = getTable(appr.task_type);
      try {
        if (action === 'approved') {
          // Revise approved → push the held new date now. Other actions just set status.
          if (appr.action_type === 'revised' && appr.new_date_fmt) {
            await db.query(`UPDATE ${table} SET status='pending',waiting_approval=0,due_date=? WHERE id=?`, [appr.new_date_fmt, appr.task_id]);
          } else if (appr.action_type === 'revised') {
            await db.query(`UPDATE ${table} SET status='pending',waiting_approval=0 WHERE id=?`, [appr.task_id]);
          } else if (appr.task_type === 'delegation') {
            // Stamp completed_at here too — approving a completion is the moment
            // the task actually closes.
            await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,completed_at=IF(?='completed',NOW(),NULL) WHERE id=?`,
              [appr.action_type, appr.action_type, appr.task_id]);
          } else {
            await db.query(`UPDATE ${table} SET status=?,waiting_approval=0 WHERE id=?`, [appr.action_type, appr.task_id]);
          }
        } else {
          // Rejected → drop the waiting flag; due_date and status stay unchanged.
          await db.query(`UPDATE ${table} SET waiting_approval=0 WHERE id=?`, [appr.task_id]);
        }
      } catch (taskErr) {
        // The task write failed after the claim — put the request back to pending
        // so it can be decided again, rather than leave it decided on paper only.
        await db.query(`UPDATE task_approvals SET status='pending',note=? WHERE id=?`, [appr.note || '', req.params.id]).catch(() => {});
        throw taskErr;
      }
      logTaskActivity({
        taskId: appr.task_id, taskType: appr.task_type,
        newStatus: action === 'approved' ? (appr.action_type === 'revised' ? 'pending' : appr.action_type) : null,
        changedBy: req.session.userId, source: `approval-${action}`,
        note: `${appr.action_type} request${appr.new_date_fmt ? ` (due -> ${appr.new_date_fmt})` : ''}`
      });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Bulk-approve ALL pending revise requests (admin/PC). Applies each held new date
  // to its task and clears the waiting flag — clears orphaned/stuck revises in one go.
  app.post('/api/approvals/approve-all-revises', requireAuth, async (req, res) => {
    if (!(await seesAllApprovals(req.session))) return res.status(403).json({ error: 'Admin or PC only' });
    try {
      const [pending] = await db.query(
        `SELECT id, task_id, task_type, DATE_FORMAT(new_date,'%Y-%m-%d') AS nd
           FROM task_approvals WHERE status='pending' AND action_type='revised'`);
      let approved = 0;
      for (const a of pending) {
        const table = getTable(a.task_type);
        // A task that was completed after its revise was filed must not be dragged
        // back to pending by this bulk sweep — that would look exactly like "my
        // finished task came back". Clear the stale request and leave the task alone.
        const [[cur]] = await db.query(`SELECT status FROM ${table} WHERE id=?`, [a.task_id]);
        // Every write below is conditional on the request still being pending, so
        // a single approve/reject landing during the sweep is never overridden.
        if (!cur) { await db.query(`UPDATE task_approvals SET status='approved' WHERE id=? AND status='pending'`, [a.id]); continue; }
        if (cur.status === 'completed') {
          const [skip] = await db.query(`UPDATE task_approvals SET status='approved', note=CONCAT(COALESCE(note,''),' [skipped — task already completed]') WHERE id=? AND status='pending'`, [a.id]);
          if (skip.affectedRows) logTaskActivity({ taskId: a.task_id, taskType: a.task_type, oldStatus: 'completed', newStatus: 'completed',
            changedBy: req.session.userId, source: 'bulk-revise-skipped', note: 'stale revise cleared, task left completed' });
          continue;
        }
        const [claim] = await db.query(`UPDATE task_approvals SET status='approved' WHERE id=? AND status='pending'`, [a.id]);
        if (!claim.affectedRows) continue;
        try {
          if (a.nd) await db.query(`UPDATE ${table} SET status='pending', waiting_approval=0, due_date=? WHERE id=?`, [a.nd, a.task_id]);
          else      await db.query(`UPDATE ${table} SET status='pending', waiting_approval=0 WHERE id=?`, [a.task_id]);
        } catch (taskErr) {
          await db.query(`UPDATE task_approvals SET status='pending' WHERE id=?`, [a.id]).catch(() => {});
          throw taskErr;
        }
        logTaskActivity({ taskId: a.task_id, taskType: a.task_type, oldStatus: cur.status, newStatus: 'pending',
          changedBy: req.session.userId, source: 'bulk-revise-approve', note: a.nd ? `due -> ${a.nd}` : null });
        approved++;
      }
      res.json({ ok: true, approved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
