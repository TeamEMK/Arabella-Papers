// ══════════════════════════════════════════════════════
// TASKS — delegation and checklist tasks, sub-tasks, status and history
// ══════════════════════════════════════════════════════
// Lifted out of server.js unchanged — both slices below are byte-for-byte
// what lived there.
//
// The group was split around two helpers that STAYED in server.js:
// canSeeTask is called by the task-comments routes far below this block, and
// canSeeTask calls canTouchSubtasks — so both stay there and are injected
// back in here. The kept region declares functions only, so removing the two
// slices around it leaves every route registered in its original order.
//
// Dependencies are passed in rather than re-required: these must be the SAME
// instances server.js uses. db in particular carries the max_user_connections
// retry wrapper.
module.exports = function registerTaskRoutes(app, deps) {
  const {
    db,
    fillDeletedUserNames,
    requireAuth,
    requireAdmin,
    archiveDeleted,
    userCanDo,
    isHandlerOf,
    getTable,
    logTaskActivity,
    findRecentDuplicateTask,
    getNotifyTarget,
    isUserOffOn,
    loadHolidaysSet,
    nextWorkingDay,
    fmtClock,
    sendMail,
    sendWhatsAppRaw,
    emailUserWaText,
    waTextToEmailHtml,
    canTouchSubtasks,
    canSeeTask,
  } = deps;

// Why a delegation task was finished after its due date. Required when it is
// marked done late (PUT /api/tasks/:id/status); tasks already done late since
// DELAY_REASON_FROM can be given one afterwards (PUT /api/tasks/:id/delay-reason).
// Added here, once per instance, so a cold start never reads a missing column.
let _delayReasonCol = null;
function ensureDelayReasonColumn() {
  if (!_delayReasonCol) _delayReasonCol = db.query('ALTER TABLE delegation_tasks ADD COLUMN delay_reason TEXT NULL')
    .catch(e => { if (e.code !== 'ER_DUP_FIELDNAME') { _delayReasonCol = null; throw e; } });
  return _delayReasonCol;
}
// Late tasks finished before this date are not asked for a reason afterwards.
const DELAY_REASON_FROM = '2026-08-01';
// Days past the due date, counted on the IST calendar by the database, so the
// server's own time zone (UTC on Vercel) does not move the boundary.
const LATE_DAYS_SQL = `DATEDIFF(DATE(UTC_TIMESTAMP() + INTERVAL 330 MINUTE), due_date)`;

// ══════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    // All Tasks at the "Admin" level in Access Control: the admin view of every
    // task. Role tests stay beside it everywhere in this file — PC and HOD hold
    // their powers by role and do not hold the key.
    const taskAdmin = await userCanDo(req.session, 'admin_tasks');
    const { mine } = req.query;
    // `type` is written into the SELECT below as a string literal, so it must be
    // one of the two known values — anything else would be pasted into the SQL.
    const type = req.query.type || 'delegation';
    if (type !== 'delegation' && type !== 'checklist') {
      return res.status(400).json({ error: 'Invalid task type' });
    }
    const isMine = (mine === '1' || mine === 'true');
    const isClientTasks = (req.query.clients === '1');
    const table = getTable(type || 'delegation');
    const isDeleg = (type || 'delegation') === 'delegation';
    if (isDeleg) await ensureDelayReasonColumn();
    let where = 'WHERE 1=1';
    const params = [];

    if (isMine) {
      // "Delegate by Me" mode — only tasks I've assigned to someone ELSE.
      // Self-delegated tasks (assigned_to === me) already show in the regular Delegation tab — don't duplicate here.
      where += ' AND t.assigned_by = ? AND t.assigned_to <> t.assigned_by';
      params.push(uid);
    } else if (isClientTasks) {
      // "Client Tasks" tab — delegation tasks whose DOER is a client login.
      // Managers see them all; a regular handler sees only what they delegated.
      if (!(isAdmin || isHod || role === 'pc' || taskAdmin)) {
        where += ' AND t.assigned_by = ?';
        params.push(uid);
      }
    } else if (isAdmin || role === 'pc' || taskAdmin) {
      // Admin/PC — see everything
    } else if (isHod) {
      // HOD — tasks belonging to users in their department
      const [me] = await db.query('SELECT department FROM task_users WHERE id=?', [uid]);
      const dept = me[0]?.department || '';
      const [deptUsers] = await db.query('SELECT id FROM task_users WHERE department=?', [dept]);
      if (!deptUsers.length) {
        return res.json({ grouped: [] });
      }
      const ids = deptUsers.map(u=>u.id);
      where += ` AND t.assigned_to IN (${ids.map(()=>'?').join(',')})`;
      params.push(...ids);
    } else {
      // Regular user — only their own tasks
      where += ' AND t.assigned_to = ?';
      params.push(uid);
    }

    // A client login as the DOER is what separates the two worlds: those tasks
    // belong ONLY to the "Client Tasks" tab and are kept out of the normal
    // grouped Delegation / Checklist views (they used to show up as fake "doers").
    if (!isMine) {
      where += isClientTasks
        ? " AND (u1.role = 'client' OR u1.client_id IS NOT NULL)"
        // u1.id IS NULL keeps a task whose doer was deleted: without it
        // `u1.role <> 'client'` evaluates to NULL for the orphan and drops the
        // very row this LEFT JOIN was added to rescue. Orphans land in the
        // normal tab, not Client Tasks, which is where they can be reassigned.
        : " AND (u1.id IS NULL OR (u1.role <> 'client' AND u1.client_id IS NULL))";
    }

    // Explicit from/to range (sent by admin filter) overrides defaults for BOTH types.
    // Otherwise: delegation shows all future (for transfers), checklist caps at
    // today + 30 days so recurring checklists don't flood the table.
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (req.query.from && isDate(req.query.from)) { where += ' AND t.due_date >= ?'; params.push(req.query.from); }
    if (req.query.to   && isDate(req.query.to))   { where += ' AND t.due_date <= ?'; params.push(req.query.to);   }
    if (!isDeleg && !(req.query.from || req.query.to)) {
      where += ' AND t.due_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)';
    }

    const subtaskCols = isDeleg
      ? "COALESCE((SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id=t.id AND s.status='completed'),0) AS subtasks_done,COALESCE((SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id=t.id AND s.status='pending'),0) AS subtasks_pending,"
      : "0 AS subtasks_done,0 AS subtasks_pending,";
    const [tasks] = await db.query(`SELECT t.id,'${type||'delegation'}' AS type,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,${isDeleg?"COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,COALESCE(t.awaiting_due_date,0) AS awaiting_due_date,t.no_due_date_reason,t.remarks,t.url,t.client_ask,DATE_FORMAT(t.client_ask_by,'%Y-%m-%d') AS client_ask_date,TIME_FORMAT(t.client_ask_by,'%H:%i') AS client_ask_time,DATE_FORMAT(t.completed_at,'%Y-%m-%d') AS completed_on,t.delay_reason,":"'no' AS approval,0 AS waiting_approval,0 AS awaiting_due_date,t.remarks,NULL AS url,NULL AS client_ask,NULL AS client_ask_date,NULL AS client_ask_time,NULL AS completed_on,NULL AS delay_reason,"}${subtaskCols}t.client_id,COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS delegated_on,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,COALESCE(u1.name,'— deleted user —') AS assignedToName,COALESCE(u2.name,'— deleted user —') AS assignedByName FROM ${table} t LEFT JOIN task_users u1 ON t.assigned_to=u1.id LEFT JOIN task_users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id ${where} ORDER BY t.due_date ASC`, params);

    await fillDeletedUserNames(tasks, [['assigned_to', 'assignedToName'], ['assigned_by', 'assignedByName']]);

    // mine=1 mode always returns flat tasks (never grouped)
    if (isMine) {
      return res.json({ tasks });
    }
    if (isAdmin || isHod || role === 'pc' || taskAdmin) {
      const grouped = {};
      tasks.forEach(t => {
        if (!grouped[t.assigned_to]) grouped[t.assigned_to] = { userId: t.assigned_to, name: t.assignedToName, tasks: [] };
        grouped[t.assigned_to].tasks.push(t);
      });
      return res.json({ grouped: Object.values(grouped) });
    }
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, approver, date, priority, approval, remarks, client_id, clientId, url } = req.body;
    // Returned so a caller (the CSV upload) can act on the row it just made.
    let newTaskId = null;
    // Delegation only: assigner leaves the due date to the doer (their occupancy).
    const doerWillSet = (req.body.doerSetsDueDate === true || req.body.doerSetsDueDate === 'true')
      && (type || 'checklist') === 'delegation';
    // Accept either client_id or clientId from request body
    const clientIdInt = (() => {
      const raw = client_id != null ? client_id : clientId;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const isAdmin = req.session.role === 'admin';
    const isHod   = req.session.role === 'hod';
    const isUser  = req.session.role === 'user';
    const isClient = req.session.role === 'client';
    // The panel's Editor toggle for Daily Task decides who may create work. The
    // frontend already hides "+ Delegate" / "+ Checklist" behind these same two
    // keys; the route accepted the call from anyone regardless, so the buttons
    // were the only thing stopping it. Clients are exempt — delegating to their
    // own handler is the point of the client portal, and that path carries its
    // own checks below.
    if (!isClient) {
      const key = (type || 'checklist') === 'checklist' ? 'create_checklist' : 'create_task';
      if (!(await userCanDo(req.session, key))) {
        return res.status(403).json({ error: key === 'create_checklist'
          ? 'You do not have access to create checklist tasks'
          : 'You do not have access to delegate tasks' });
      }
    }
    // Clients can only assign to their handler. Resolve from clients table.
    let targetUser;
    let enforcedClientId = clientIdInt;
    if (isClient) {
      const [[me]] = await db.query('SELECT client_id FROM task_users WHERE id=? LIMIT 1', [req.session.userId]);
      if (!me?.client_id) return res.status(403).json({ error: 'Client portal: no linked client' });
      const [[c]] = await db.query('SELECT handler_id FROM clients WHERE id=? LIMIT 1', [me.client_id]);
      // A client may have MULTIPLE handlers (client_handlers) — let them pick one.
      // Only their own handlers are valid targets; anything else falls back to
      // the primary handler_id. The legacy single handler_id is always valid.
      const [handlerRows] = await db.query('SELECT user_id FROM client_handlers WHERE client_id=?', [me.client_id]);
      const validHandlers = new Set(handlerRows.map(r => r.user_id));
      if (c?.handler_id) validHandlers.add(c.handler_id);
      const chosen = assignedTo ? parseInt(assignedTo) : null;
      targetUser = (chosen && validHandlers.has(chosen)) ? chosen : (c?.handler_id || [...validHandlers][0]);
      if (!targetUser) return res.status(400).json({ error: 'Your client does not have a handler assigned yet — contact admin' });
      enforcedClientId = me.client_id; // force tag the task to client's own id
      // Clients don't set a due date — the handler fills it in after assignment.
      if (!doerWillSet) {
        const ist = new Date(Date.now() + (5.5*60*60*1000));
        const minDate = new Date(ist.getTime() + 2*24*60*60*1000).toISOString().split('T')[0];
        if (!date || date < minDate) {
          return res.status(400).json({ error: `Due date must be at least 2 days from now (${minDate})` });
        }
      }
    } else {
      // Admin, HOD and regular users can all assign to others; fallback to self if not specified
      targetUser = (isAdmin || isHod || isUser) && assignedTo ? parseInt(assignedTo) : req.session.userId;
    }
    if (!desc) return res.status(400).json({ error: 'Description required' });
    if (!doerWillSet && !date) return res.status(400).json({ error: 'Description and date required' });

    // Staff delegating TO a client (the handler→client direction). The doer is
    // the client's own portal login, so it is only allowed when that login
    // really belongs to the client the task is tagged with — otherwise one
    // client's login could be handed another client's work.
    let doerIsClient = false;
    if (!isClient && targetUser !== req.session.userId) {
      const [[doer]] = await db.query('SELECT id, role, client_id FROM task_users WHERE id=? LIMIT 1', [targetUser]);
      if (!doer) return res.status(400).json({ error: 'Doer not found' });
      if (doer.role === 'client') {
        if (!enforcedClientId || Number(doer.client_id) !== Number(enforcedClientId)) {
          return res.status(403).json({ error: 'That portal login does not belong to this client' });
        }
        const [[cli]] = await db.query('SELECT id, handler_id FROM clients WHERE id=? LIMIT 1', [enforcedClientId]);
        const mayDelegate = isAdmin || isHod || await isHandlerOf(req.session.userId, cli);
        if (!mayDelegate) return res.status(403).json({ error: 'Only this client\'s handler can delegate to them' });
        if (doerWillSet) return res.status(400).json({ error: 'A client task needs a due date set by you' });
        doerIsClient = true;
      }
    }
    // Optional clock time on the deadline — only meaningful alongside a date.
    const dueTime = doerWillSet ? null : parseDueTime(req.body.dueTime);
    if (dueTime === undefined) return res.status(400).json({ error: 'Due time must be HH:MM (24-hour)' });

    // Holiday / week-off check — auto-adjust due_date if needed.
    // Skipped when the doer will set their own date (none yet to adjust), and
    // when the doer is a client: our holiday calendar and week-offs describe
    // staff, so silently moving a date the handler agreed with the client
    // would be wrong.
    let effectiveDate = doerWillSet ? null : date;
    let adjusted = false, adjustedReason = '';
    if (!doerWillSet && !doerIsClient) try {
      const holidaysSet = await loadHolidaysSet();
      const [[doerUser]] = await db.query('SELECT week_off, extra_off FROM task_users WHERE id=? LIMIT 1', [targetUser]);
      if (doerUser && isUserOffOn(doerUser, date, holidaysSet)) {
        const tt = (type||'checklist') === 'delegation' ? 'delegation' : 'checklist';
        if (tt === 'delegation') {
          // Push to next working day
          effectiveDate = nextWorkingDay(doerUser, date, holidaysSet);
          adjusted = true;
          adjustedReason = `Original date was a holiday/week-off — moved to ${effectiveDate}`;
        } else {
          // Checklist: skip creation on off day
          return res.json({ success: true, skipped: true, reason: 'Skipped — selected date is a holiday or doer\'s week-off' });
        }
      }
    } catch (e) { console.error('holiday check error:', e.message); }

    if ((type||'checklist') === 'delegation') {
      // Approver: prefer approverEmail; otherwise approver ID from form; otherwise logged-in user
      let assignedBy = req.session.userId;
      if (approverEmail) {
        const [aprRows] = await db.query('SELECT id FROM task_users WHERE email=? LIMIT 1', [approverEmail]);
        if (aprRows.length) assignedBy = aprRows[0].id;
      } else if (approver && approval === 'yes') {
        const apId = parseInt(approver);
        if (apId) {
          const [aprRows] = await db.query('SELECT id FROM task_users WHERE id=? LIMIT 1', [apId]);
          if (aprRows.length) assignedBy = aprRows[0].id;
        }
      }
      // Same task, same doer, same assigner, seconds apart is never a real second
      // See findRecentDuplicateTask. The button guard in the UI is the first line
      // of defence; this one also covers refresh, back button and network retry.
      const dupId = await findRecentDuplicateTask('delegation_tasks', {
        desc, assignedTo: targetUser, assignedBy, clientId: enforcedClientId, dueDate: effectiveDate });
      if (dupId) return res.json({ success: true, duplicate: true, id: dupId });
      // A task you hand to yourself is not news. Stamping seen_at at creation
      // keeps it out of the new-task popup AND off the bell's unread count in
      // one move, while still leaving the row in the bell's history where it
      // belongs. ⚠️ Deliberately NOT applied to the three WhatsApp-bot
      // approval inserts in server.js: those arrive from outside and the doer
      // really has not seen them, whoever the row names as assigner.
      const selfAssigned = String(assignedBy) === String(targetUser);
      const [insD] = await db.query(`INSERT INTO delegation_tasks (description,assigned_to,assigned_by,due_date,due_time,status,priority,approval,remarks,client_id,url,awaiting_due_date,seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [desc, targetUser, assignedBy, effectiveDate, dueTime, 'pending', priority||'low', approval||'no', remarks||'', enforcedClientId, url||null, doerWillSet ? 1 : 0, selfAssigned ? new Date() : null]);
      newTaskId = insD.insertId;
      // 📧 Send delegation email + 📱 WhatsApp (non-blocking — fire and forget)
      (async () => {
        const target = await getNotifyTarget(targetUser);
        const [aprRows] = await db.query('SELECT name FROM task_users WHERE id=? LIMIT 1', [assignedBy]);
        const assignerName = aprRows[0]?.name || 'Admin';
        let clientName = '';
        if (enforcedClientId) {
          const [[cli]] = await db.query("SELECT COALESCE(NULLIF(TRIM(brand_name),''), name) AS name FROM clients WHERE id=? LIMIT 1", [enforcedClientId]);
          clientName = cli?.name || '';
        }
        // A bulk create (CSV upload, several tasks in one Delegate form) passes
        // quietEmail and sends one summary per doer afterwards through
        // POST /api/tasks/notify-batch, instead of an email per task.
        if (target && req.body.quietEmail !== true) {
          // Same wording as the old WhatsApp delegation message — no HTML card,
          // no "Open Task Manager" button — just the plain text as an email.
          const dueFmt = doerWillSet ? 'Please add the due date in the task' : effectiveDate;
          const msg = `Hello ${target.name || ''},\n\n📋 *New Task Delegated*\n\n` +
            `*By:* ${assignerName}\n` +
            (clientName ? `*Client:* ${clientName}\n` : '') +
            `*Due Date:* ${dueFmt}\n` +
            `*Priority:* ${(priority||'low').toUpperCase()}\n` +
            (approval === 'yes' ? `*Approval Required:* Yes\n` : '') +
            `\n*Task:* ${desc}` +
            (url ? `\n\n*URL:* ${url}` : '') +
            (remarks ? `\n\n*Remarks:* ${remarks}` : '') +
            `\n\n— E-Marketing Task Manager`;
          await sendMail(target.email, `📋 New Task Assigned: ${Array.from(desc||'').slice(0,60).join('')}`, waTextToEmailHtml(msg));
        }
        // Doer notification now goes by EMAIL only (sent just above via
        // getNotifyTarget) — the personal WhatsApp DM has been retired.

        // Handler → client task: announce it in the client's own WhatsApp group
        // right away (the doer is a client login with no phone, so the message
        // above never reaches them). Skipped when the client has no group set.
        if (doerIsClient && enforcedClientId) try {
          const [[cli]] = await db.query('SELECT whatsapp_group_id AS g FROM clients WHERE id=? LIMIT 1', [enforcedClientId]);
          if (cli?.g) {
            const due = (effectiveDate || '').split('-').reverse().join('-') +
                        (dueTime ? ` · ${fmtClock(dueTime.slice(0,5))} IST` : '');
            const gmsg = `📝 *New Task for You*\n\n` +
              `*Task:* ${desc}\n` +
              (due ? `*Due:* ${due}\n` : '') +
              `*Priority:* ${(priority||'low').toUpperCase()}\n` +
              `*Assigned by:* ${assignerName}` +
              (remarks ? `\n\n*Remarks:* ${remarks}` : '') +
              `\n\n— E-Marketing Task Manager`;
            await sendWhatsAppRaw(cli.g, gmsg).catch(e => console.error('WA client-task group err:', e.message));
          }
        } catch (e) { console.error('WA client-task group lookup err:', e.message); }
      })();
    } else {
      // Same guard as the delegation arm above — a double tap here used to write
      // two checklist rows, and the doer had to close both.
      const dupId = await findRecentDuplicateTask('checklist_tasks', {
        desc, assignedTo: targetUser, assignedBy: req.session.userId,
        clientId: enforcedClientId, dueDate: effectiveDate });
      if (dupId) return res.json({ success: true, duplicate: true, id: dupId });
      const [insC] = await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks,client_id) VALUES (?,?,?,?,?,?,?,?)`, [desc, targetUser, req.session.userId, effectiveDate, 'pending', priority||'low', remarks||'', enforcedClientId]);
      newTaskId = insC.insertId;
    }
    res.json({ success: true, id: newTaskId, adjusted, effectiveDate, adjustedReason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Doer sets the due date on a "doer-defines-date" delegation (applies directly,
// no approval). Assigner/admin can also set it as a fallback if the doer delays.
app.put('/api/tasks/:id/due-date', requireAuth, async (req, res) => {
  try {
    // Two ways to answer this route: give the date, or say why you cannot yet.
    // The doer is the one who knows, and a task sitting date-less with no
    // explanation is invisible to every deadline mechanism in the app, so one
    // of the two is required. A reason is NOT a substitute for a date — the
    // task still cannot be completed until a real date exists (see the guard in
    // PUT /api/tasks/:id/status); it only records why the gap is there and
    // shows it on the row, so it stops being silent.
    const { date, reason } = req.body;
    const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '');
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (!hasDate && !cleanReason) {
      return res.status(400).json({ error: 'Pick a due date, or say why one cannot be set yet.' });
    }
    const uid = req.session.userId;
    const isPrivileged = req.session.role === 'admin' || req.session.role === 'pc' || await userCanDo(req.session, 'admin_tasks');
    const [rows] = await db.query('SELECT * FROM delegation_tasks WHERE id=?', [parseInt(req.params.id, 10)]);
    const task = rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.awaiting_due_date) return res.status(409).json({ error: 'Due date is already set on this task' });
    // Doer, assigner, or admin/PC only.
    if (!isPrivileged && Number(task.assigned_to) !== Number(uid) && Number(task.assigned_by) !== Number(uid)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    // Reason only: the task stays awaiting_due_date, so the "Set due date"
    // button and this route both remain available for the real answer later.
    if (!hasDate) {
      await db.query(
        'UPDATE delegation_tasks SET no_due_date_reason=?, no_due_date_reason_at=NOW() WHERE id=?',
        [cleanReason, task.id]);
      logTaskActivity({
        taskId: task.id, field: 'no_due_date_reason', oldValue: task.no_due_date_reason || null,
        newValue: cleanReason, changedBy: uid, source: 'due-date-deferred'
      });
      return res.json({ success: true, reasonSaved: true });
    }
    // Nudge past a holiday / week-off, same as a normal delegation date.
    let effectiveDate = date;
    try {
      const holidaysSet = await loadHolidaysSet();
      const [[doerUser]] = await db.query('SELECT week_off, extra_off FROM task_users WHERE id=? LIMIT 1', [task.assigned_to]);
      if (doerUser && isUserOffOn(doerUser, date, holidaysSet)) effectiveDate = nextWorkingDay(doerUser, date, holidaysSet);
    } catch (e) { console.error('due-date holiday check err:', e.message); }
    // A real date arrived, so any earlier "cannot set one yet" note is stale —
    // clear it rather than leave the row explaining a gap that no longer exists.
    await db.query(
      'UPDATE delegation_tasks SET due_date=?, awaiting_due_date=0, no_due_date_reason=NULL, no_due_date_reason_at=NULL WHERE id=?',
      [effectiveDate, task.id]);
    logTaskActivity({
      taskId: task.id, field: 'due_date', oldValue: null, newValue: effectiveDate,
      changedBy: uid, source: 'due-date-set',
      note: effectiveDate !== date ? `asked for ${date}, moved past a holiday or week-off` : null
    });
    res.json({ success: true, effectiveDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/tasks/:id/subtasks', requireAuth, async (req, res) => {
  try {
    const taskId = parseInt(req.params.id, 10);
    const [[task]] = await db.query('SELECT id, assigned_to, assigned_by, client_id FROM delegation_tasks WHERE id=?', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canTouchSubtasks(req, task))) return res.status(403).json({ error: 'Not allowed' });
    const [subtasks] = await db.query(
      `SELECT s.id, s.description, s.remarks, s.status, COALESCE(s.priority,'low') AS priority,
              DATE_FORMAT(s.created_at,'%Y-%m-%d') AS created_at,
              DATE_FORMAT(s.completed_at,'%Y-%m-%d') AS completed_at, u.name AS createdByName
       FROM task_subtasks s JOIN task_users u ON s.created_by = u.id
       WHERE s.task_id=? ORDER BY s.created_at ASC`, [taskId]);
    res.json({ subtasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/subtasks', requireAuth, async (req, res) => {
  try {
    // Only the client can add sub-tasks — staff (handler/admin/hod/pc) can view,
    // complete, and delete them, but adding is the client's follow-up channel only.
    if (req.session.role !== 'client') return res.status(403).json({ error: 'Not allowed' });
    const taskId = parseInt(req.params.id, 10);
    const desc = (req.body.description || '').trim();
    if (!desc) return res.status(400).json({ error: 'Description required' });
    const priority = ['low','medium','high','urgent'].includes(req.body.priority) ? req.body.priority : 'low';
    const [[task]] = await db.query('SELECT id, assigned_to, assigned_by, client_id, description FROM delegation_tasks WHERE id=?', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canTouchSubtasks(req, task))) return res.status(403).json({ error: 'Not allowed' });
    await db.query('INSERT INTO task_subtasks (task_id, description, priority, created_by) VALUES (?,?,?,?)', [taskId, desc, priority, req.session.userId]);

    // 📧 Email the handler — non-blocking (fire and forget). Was WhatsApp.
    (async () => {
      const [[client]] = await db.query('SELECT name FROM task_users WHERE id=? LIMIT 1', [req.session.userId]);
      const [[handler]] = await db.query('SELECT name FROM task_users WHERE id=? LIMIT 1', [task.assigned_to]);
      const msg = `Hello ${handler?.name || ''},\n\n🧩 *New Sub-task Added*\n\n` +
        `*By:* ${client?.name || 'Client'} (Client)\n` +
        `*Under Task:* ${task.description}\n\n` +
        `*Sub-task:* ${desc}\n\n` +
        `— E-Marketing Task Manager`;
      await emailUserWaText(task.assigned_to, `New Sub-task: ${desc.slice(0,60)}`, msg);
    })().catch(e => console.error('subtask email err:', e.message));

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/subtasks/:id', requireAuth, async (req, res) => {
  try {
    // Client can add sub-tasks but only the doer/assigner/admin/hod/pc mark them done.
    if (req.session.role === 'client') return res.status(403).json({ error: 'Not allowed' });
    const id = parseInt(req.params.id, 10);
    const status = req.body.status === 'completed' ? 'completed' : 'pending';
    const [[sub]] = await db.query('SELECT task_id FROM task_subtasks WHERE id=?', [id]);
    if (!sub) return res.status(404).json({ error: 'Sub-task not found' });
    const [[task]] = await db.query('SELECT id, assigned_to, assigned_by, client_id FROM delegation_tasks WHERE id=?', [sub.task_id]);
    if (!(await canTouchSubtasks(req, task))) return res.status(403).json({ error: 'Not allowed' });
    // Remarks alone: leave the status untouched, so saving a note never flips a
    // sub-task's state as a side effect.
    if (req.body.remarks !== undefined && req.body.status === undefined) {
      await db.query('UPDATE task_subtasks SET remarks=? WHERE id=?', [String(req.body.remarks || '').trim() || null, id]);
      return res.json({ success: true });
    }
    await db.query(`UPDATE task_subtasks SET status=?, completed_at=IF(?='completed', NOW(), NULL) WHERE id=?`, [status, status, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The handler records what they still need FROM the client on their own task,
// with a deadline. Two rules the user set:
//   · the task must already have a due date — otherwise there is nothing to
//     measure "not later than" against, and it gives a reason to fill it in;
//   · the ask cannot be due after the task itself, since needing an input after
//     your own deadline is meaningless.
// Blank text clears both fields.
app.put('/api/tasks/:id/client-ask', requireAuth, async (req, res) => {
  try {
    if (req.session.role === 'client') return res.status(403).json({ error: 'Not allowed' });
    const id = parseInt(req.params.id, 10);
    const [[task]] = await db.query(
      `SELECT id, assigned_to, assigned_by, due_date, due_time,
              DATE_FORMAT(due_date,'%Y-%m-%d') AS due_ymd
         FROM delegation_tasks WHERE id=?`, [id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const role = req.session.role;
    const privileged = role === 'admin' || role === 'hod' || role === 'pc' || await userCanDo(req.session, 'admin_tasks');
    // The doer is the one who knows what is missing; the assigner may also note it.
    if (!privileged && Number(task.assigned_to) !== Number(req.session.userId)
                    && Number(task.assigned_by) !== Number(req.session.userId)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const note = String(req.body.note || '').trim();
    if (!note) {
      await db.query('UPDATE delegation_tasks SET client_ask=NULL, client_ask_by=NULL WHERE id=?', [id]);
      return res.json({ success: true, cleared: true });
    }
    if (!task.due_ymd) {
      return res.status(409).json({ error: 'Set this task\'s due date first, then record what you need from the client.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.byDate || '')) {
      return res.status(400).json({ error: 'Needed-by date is required (YYYY-MM-DD)' });
    }
    const byTime = parseDueTime(req.body.byTime);
    if (byTime === undefined) return res.status(400).json({ error: 'Needed-by time must be HH:MM (24-hour)' });

    // Compare as full moments. A task with no clock time is treated as due at
    // end of day, so an ask at any time on that date is still allowed.
    const askAt = `${req.body.byDate} ${byTime || '23:59:00'}`;
    const dueAt = `${task.due_ymd} ${task.due_time || '23:59:59'}`;
    if (askAt > dueAt) {
      return res.status(400).json({ error: `Cannot be later than the task's own due date (${task.due_ymd.split('-').reverse().join('-')})` });
    }
    await db.query('UPDATE delegation_tasks SET client_ask=?, client_ask_by=? WHERE id=?', [note, askAt, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/subtasks/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[sub]] = await db.query('SELECT * FROM task_subtasks WHERE id=?', [id]);
    if (!sub) return res.status(404).json({ error: 'Sub-task not found' });
    const isPrivileged = req.session.role === 'admin' || req.session.role === 'pc' || await userCanDo(req.session, 'admin_tasks');
    if (sub.created_by !== req.session.userId && !isPrivileged) return res.status(403).json({ error: 'Not allowed' });
    await archiveDeleted('task_subtasks', sub, req, { summary: r => `Sub-task: ${r.description || ''}` });
    await db.query('DELETE FROM task_subtasks WHERE id=?', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The Checklist form's "Generate Tasks" posts here. It was admin-only while the
// form itself was offered to anyone with create_checklist, so everyone else got
// "Admin only". Same permission as a single checklist task now, and the same
// doer rule as POST /api/tasks: a pc's checklist is always their own.
// One email per doer for a batch of delegations created with quietEmail
// (bulk CSV upload, several tasks in one Delegate form). Only the caller's own
// tasks from the last hour, and only those still open — rows the upload marked
// done straight away are not news.
app.post('/api/tasks/notify-batch', requireAuth, async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(n => parseInt(n, 10)).filter(n => n > 0))].slice(0, 500);
    if (!ids.length) return res.json({ success: true, sent: 0 });
    const [rows] = await db.query(
      `SELECT t.id, t.description, t.assigned_to, t.priority, t.approval, t.awaiting_due_date,
              DATE_FORMAT(t.due_date,'%d-%m-%Y') AS due,
              COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name
         FROM delegation_tasks t LEFT JOIN clients c ON c.id = t.client_id
        WHERE t.id IN (?) AND t.assigned_by = ? AND t.status <> 'completed'
          AND t.created_at >= NOW() - INTERVAL 1 HOUR
        ORDER BY t.assigned_to, t.due_date, t.id`, [ids, req.session.userId]);
    const byDoer = new Map();
    for (const r of rows) { if (!byDoer.has(r.assigned_to)) byDoer.set(r.assigned_to, []); byDoer.get(r.assigned_to).push(r); }
    const [[me]] = await db.query('SELECT name FROM task_users WHERE id=? LIMIT 1', [req.session.userId]);
    let sent = 0;
    for (const [doer, list] of byDoer) {
      const target = await getNotifyTarget(doer);
      if (!target) continue;
      const lines = list.map((t, i) =>
        `${i + 1}. ${t.description}\n` +
        `   *Due:* ${t.awaiting_due_date ? 'Please add the due date in the task' : (t.due || '—')}` +
        ` · *Priority:* ${(t.priority || 'low').toUpperCase()}` +
        (t.client_name ? ` · *Client:* ${t.client_name}` : '') +
        (t.approval === 'yes' ? ' · *Approval Required*' : '')).join('\n\n');
      const msg = `Hello ${target.name || ''},\n\n📋 *${list.length} New Task${list.length === 1 ? '' : 's'} Delegated*\n\n` +
        `*By:* ${me?.name || 'Admin'}\n\n${lines}\n\n— E-Marketing Task Manager`;
      await sendMail(target.email, `📋 ${list.length} new task${list.length === 1 ? '' : 's'} assigned to you`, waTextToEmailHtml(msg)).catch(() => {});
      sent++;
    }
    res.json({ success: true, sent, tasks: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/bulk-checklist', requireAuth, async (req, res) => {
  try {
    if (!(await userCanDo(req.session, 'create_checklist'))) {
      return res.status(403).json({ error: 'You do not have access to create checklist tasks' });
    }
    const { desc, priority, remarks, dates, client_id, clientId } = req.body;
    const assignedTo = req.session.role === 'pc' ? req.session.userId : req.body.assignedTo;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    // A daily checklist for a year is ~365 dates; anything far past that is a mistake.
    if (!Array.isArray(dates) || dates.length > 800) return res.status(400).json({ error: 'Too many dates in one go' });
    const cidRaw = client_id != null ? client_id : clientId;
    const cid = (() => { const n = parseInt(cidRaw, 10); return Number.isFinite(n) && n > 0 ? n : null; })();

    // Filter out holiday + week-off dates for this user
    let skippedCount = 0;
    try {
      const holidaysSet = await loadHolidaysSet();
      const [[doerUser]] = await db.query('SELECT week_off, extra_off FROM task_users WHERE id=? LIMIT 1', [parseInt(assignedTo)]);
      if (doerUser) {
        const filtered = dates.filter(d => !isUserOffOn(doerUser, d, holidaysSet));
        skippedCount = dates.length - filtered.length;
        if (!filtered.length) return res.json({ success: true, count: 0, skipped: skippedCount, message: 'All dates were holidays / week-offs — nothing inserted' });
        dates.length = 0;
        dates.push(...filtered);
      }
    } catch (e) { console.error('bulk-checklist holiday filter err:', e.message); }

    const values = dates.map(date => [desc, parseInt(assignedTo), req.session.userId, date, 'pending', priority||'low', remarks||'', cid]);
    await db.query(`INSERT INTO checklist_tasks (description,assigned_to,assigned_by,due_date,status,priority,remarks,client_id) VALUES ?`, [values]);
    res.json({ success: true, count: dates.length, skipped: skippedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const tt = type || 'delegation';
    // getTable() answers "not delegation" with checklist_tasks instead of an
    // error, so 'Delegation' with a capital D, or a stray space, would quietly
    // update the checklist row that happens to share the id — and switch off
    // every `tt === 'delegation'` rule below on the way past, approval and
    // sub-task checks included — while still returning 200.
    if (!['delegation', 'checklist'].includes(tt)) {
      return res.status(400).json({ error: 'type must be delegation or checklist' });
    }
    // Per table, because the two columns do not hold the same set:
    // delegation_tasks is ENUM('pending','completed','revised') and
    // checklist_tasks only ENUM('pending','completed'). Anything outside the
    // ENUM becomes the empty string in non-strict MySQL, which SQL then matches
    // as neither pending nor completed while the frontend's !t.status test
    // still reads it as pending. Revise is not offered on checklist rows in the
    // UI, so this refuses a route that was reachable but never travelled.
    const ALLOWED_STATUS = { delegation: ['pending', 'completed', 'revised'], checklist: ['pending', 'completed'] };
    if (!ALLOWED_STATUS[tt].includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUS[tt].join(', ')}` });
    }
    // The assigner approves or rejects a revision on its reason, so one is required.
    if (status === 'revised' && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'Please enter a reason for the revision.' });
    }
    const table = getTable(tt);
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    const isPrivileged = isAdmin || isPC || await userCanDo(req.session, 'admin_tasks');
    const [rows] = await db.query(`SELECT * FROM ${table} WHERE id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    const task = rows[0];
    // Number() on both sides, matching reviserIsAssigner five lines down: !==
    // compares type as well, so the day a driver setting or a column type hands
    // back '41' instead of 41 this starts refusing people their own tasks, and
    // it would read as a permissions bug rather than a type one.
    if (!isPrivileged && Number(task.assigned_to) !== Number(uid)) return res.status(403).json({ error: 'Not allowed' });

    // Approval workflow only exists for delegation tasks (checklist has no approval column).
    const supportsApproval = tt === 'delegation';
    // The reviser is also the one who assigned the task → no separate approval needed.
    const reviserIsAssigner = Number(task.assigned_by) === Number(uid);
    // Client-delegated task: the assigner is a client login (no approvals screen),
    // so a doer's revise applies directly — no approval step.
    let assignerIsClient = false;
    try {
      const [[asg]] = await db.query('SELECT role, client_id FROM task_users WHERE id=? LIMIT 1', [task.assigned_by]);
      assignerIsClient = !!asg && (asg.role === 'client' || asg.client_id != null);
    } catch (e) {}

    // While a revise/approval is pending, the doer can neither revise again nor mark done.
    // Privileged users (admin/PC) act directly; the assigner decides via the Approvals screen.
    if (supportsApproval && task.waiting_approval && !isPrivileged) {
      return res.status(409).json({ error: 'Approval is pending — you cannot revise or mark done until it is approved.' });
    }

    // A delegation task can legitimately start with no due date — the assigner
    // hands that choice to the doer (doerSetsDueDate on POST /api/tasks), who
    // sets it from their own occupancy. Until they do, the row has no date to be
    // measured against: it can never go overdue, never reaches Upcoming, and sits
    // in Pending indefinitely without ever chasing anyone. Closing it in that
    // state would mean the task lived and died without a date, so completion
    // waits for one. Revise is deliberately still allowed — that path carries
    // newDate and is one of the ways a date arrives. Applies to every role,
    // including admin and PC: the point is the record, not the permission.
    // needsDueDate tells the caller this refusal has a cure it can offer on the
    // spot — open the Set Due Date modal — instead of a dead-end alert. It is
    // only true where PUT /api/tasks/:id/due-date would actually accept the
    // answer: that route is delegation-only and 409s unless awaiting_due_date
    // is still set, so a checklist row or a legacy date-less delegation row
    // keeps the plain message rather than opening a modal that cannot save.
    if (status === 'completed' && !task.due_date) {
      return res.status(400).json({
        error: 'Set a due date before marking this task done.',
        needsDueDate: tt === 'delegation' && !!task.awaiting_due_date
      });
    }

    // Reopening is a different permission from finishing, and only the reopen
    // half is gated. Marking your own work done has to stay open to everyone —
    // this is the route every employee uses all day, and a page-level gate here
    // would stop the company. Putting a finished task BACK to pending is the
    // separate act the frontend already hides behind canDo('reopen_task'); the
    // route never asked, so the button was the only thing enforcing it.
    if (status === 'pending' && task.status === 'completed'
        && !(await userCanDo(req.session, 'reopen_task'))) {
      return res.status(403).json({ error: 'You do not have access to reopen tasks' });
    }

    // REVISE (date push) ALWAYS needs the assigner's approval — for every role,
    // including admin and self-assigned tasks (the request just routes back to the
    // assigner, who approves it on the Approvals screen). The requested new date is
    // held in the approval row and applied to the task only once approved. Anyone
    // who can directly change a date should use Edit, not Revise.
    if (status === 'revised' && supportsApproval) {
      // Client-delegated → apply the revise directly (push the new date), no approval.
      if (assignerIsClient) {
        if (newDate) await db.query(`UPDATE ${table} SET status='revised', waiting_approval=0, due_date=? WHERE id=?`, [newDate, req.params.id]);
        else         await db.query(`UPDATE ${table} SET status='revised', waiting_approval=0 WHERE id=?`, [req.params.id]);
        logTaskActivity({ taskId: req.params.id, taskType: tt, oldStatus: task.status, newStatus: 'revised',
          changedBy: uid, source: 'revise-client-direct', note: newDate ? `due -> ${newDate}` : (reason || null) });
        return res.json({ success: true, applied: true });
      }
      await db.query(
        `INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,new_date,status,note)
         VALUES (?,?,?,?,?,?,'pending',?)`,
        [req.params.id, tt, uid, task.assigned_by, 'revised', newDate || null, reason || '']
      );
      await db.query(`UPDATE ${table} SET waiting_approval=1 WHERE id=?`, [req.params.id]);
      return res.json({ success: true, needsApproval: true });
    }

    // A task cannot be finished while the client's follow-up asks are still
    // open — those sub-tasks ARE part of the job. Checked before the approval
    // branch below so completion cannot even be requested, and applied to every
    // role including admin/PC: the way out is to tick the sub-tasks off or
    // delete them, not to close over them.
    if (status === 'completed' && tt === 'delegation') {
      const [[open]] = await db.query(
        `SELECT COUNT(*) AS n FROM task_subtasks WHERE task_id=? AND status<>'completed'`, [req.params.id]);
      if (open?.n > 0) {
        return res.status(409).json({
          error: `${open.n} sub-task${open.n === 1 ? '' : 's'} still pending — finish those before marking this task done.`
        });
      }
    }

    // Finished after its due date: the doer says why, before it closes. Every
    // role, like the due-date rule above; needsDelayReason lets the page ask on
    // the spot and send the same request again with delay_reason.
    if (status === 'completed' && tt === 'delegation') {
      const [[d]] = await db.query(`SELECT ${LATE_DAYS_SQL} AS late FROM delegation_tasks WHERE id=?`, [req.params.id]);
      if (d && Number(d.late) > 0) {
        const delayReason = String(req.body.delay_reason || '').trim();
        if (!delayReason) {
          return res.status(400).json({
            error: 'This task is past its due date. Please give the reason for the delay.',
            needsDelayReason: true, lateDays: Number(d.late)
          });
        }
        await ensureDelayReasonColumn();
        await db.query('UPDATE delegation_tasks SET delay_reason=? WHERE id=?', [delayReason.slice(0, 2000), req.params.id]);
      }
    }

    // COMPLETION approval — only when the task was created with approval='yes'.
    if (status === 'completed' && supportsApproval && task.approval === 'yes' && !isPrivileged && !reviserIsAssigner) {
      await db.query(
        `INSERT INTO task_approvals (task_id,task_type,requested_by,requested_to,action_type,status,note)
         VALUES (?,?,?,?,?,'pending',?)`,
        [req.params.id, tt, uid, task.assigned_by, 'completed', reason || '']
      );
      await db.query(`UPDATE ${table} SET waiting_approval=1 WHERE id=?`, [req.params.id]);
      return res.json({ success: true, needsApproval: true });
    }

    // Direct apply: privileged user, self-assigner, plain completion, or checklist.
    // If a privileged user overrides while a request was pending, cancel the stale one.
    if (supportsApproval && task.waiting_approval && isPrivileged) {
      await db.query(`DELETE FROM task_approvals WHERE task_id=? AND task_type=? AND status='pending'`, [req.params.id, tt]);
    }
    // completed_at only exists on delegation_tasks, and is stamped or cleared to
    // match the new status so a reopened task drops out of the daily digest.
    if (newDate && status === 'revised') {
      if (tt === 'checklist') await db.query(`UPDATE ${table} SET status=?,due_date=? WHERE id=?`, [status, newDate, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,due_date=?,completed_at=NULL WHERE id=?`, [status, newDate, req.params.id]);
    } else {
      // checklist_tasks has no waiting_approval column
      if (tt === 'checklist') await db.query(`UPDATE ${table} SET status=? WHERE id=?`, [status, req.params.id]);
      else await db.query(`UPDATE ${table} SET status=?,waiting_approval=0,completed_at=IF(?='completed',NOW(),NULL) WHERE id=?`, [status, status, req.params.id]);
    }
    // Reopening (status back to 'pending') is the one change that wipes its own
    // evidence, so it matters most that it lands here.
    logTaskActivity({
      taskId: req.params.id, taskType: tt, oldStatus: task.status, newStatus: status,
      changedBy: uid,
      source: status === 'pending' && task.status === 'completed' ? 'reopen' : 'status-direct',
      note: newDate ? `due -> ${newDate}` : (reason || null)
    });
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The delay reason for a delegation task that was already finished late
// (before the reason became required at Done). Its doer, its assigner, or
// someone with the admin view of tasks may give it; only for tasks completed
// after their due date, on or after DELAY_REASON_FROM.
app.put('/api/tasks/:id/delay-reason', requireAuth, async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please enter the reason for the delay.' });
    await ensureDelayReasonColumn();
    const [[t]] = await db.query(
      `SELECT id, assigned_to, assigned_by, status,
              DATE_FORMAT(completed_at, '%Y-%m-%d') AS done_on, DATE_FORMAT(due_date, '%Y-%m-%d') AS due
         FROM delegation_tasks WHERE id=?`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    const uid = Number(req.session.userId);
    const privileged = ['admin', 'pc'].includes(req.session.role) || await userCanDo(req.session, 'admin_tasks');
    if (!privileged && uid !== Number(t.assigned_to) && uid !== Number(t.assigned_by)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    if (t.status !== 'completed' || !t.done_on || !t.due || t.done_on <= t.due) {
      return res.status(400).json({ error: 'Only a task completed after its due date takes a delay reason.' });
    }
    if (t.done_on < DELAY_REASON_FROM) {
      return res.status(400).json({ error: `Delay reasons are kept for tasks completed from ${DELAY_REASON_FROM}.` });
    }
    await db.query('UPDATE delegation_tasks SET delay_reason=? WHERE id=?', [reason.slice(0, 2000), t.id]);
    logTaskActivity({ taskId: t.id, taskType: 'delegation', oldStatus: 'completed', newStatus: 'completed',
      changedBy: uid, source: 'delay-reason', note: reason.slice(0, 250) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full history of one task — who changed what, from what to what, and through
// which action. Answers "I marked it done and it came back", and now also "my
// task moved to someone else" and "my due date changed on its own".
app.get('/api/tasks/:id/activity', requireAuth, async (req, res) => {
  try {
    const tt = (req.query.type || 'delegation') === 'checklist' ? 'checklist' : 'delegation';
    // The id comes off the URL, so without this any employee could read the full
    // change history of any task by editing the number.
    if (!(await canSeeTask(req, req.params.id, tt))) return res.status(403).json({ error: 'Not allowed' });
    const [rows] = await db.query(
      `SELECT a.id, a.field, a.old_value, a.new_value, a.old_status, a.new_status, a.source, a.note,
              DATE_FORMAT(a.created_at,'%Y-%m-%d %H:%i:%s') AS at,
              COALESCE(u.name,'—') AS by_name
         FROM task_activity a
         LEFT JOIN task_users u ON u.id = a.changed_by
        WHERE a.task_id=? AND a.task_type=?
        ORDER BY a.created_at ASC, a.id ASC`, [parseInt(req.params.id, 10), tt]);
    res.json({ activity: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT t.*,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date FROM ${table} t WHERE t.id=?`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
    // Admin/HOD see anything; otherwise only the assigner can pull a task's detail (needed for self-edit).
    const role = req.session.role;
    if (role !== 'admin' && role !== 'hod' && role !== 'pc' && !(await userCanDo(req.session, 'admin_tasks'))) {
      if (Number(rows[0].assigned_by) !== Number(req.session.userId) && Number(rows[0].assigned_to) !== Number(req.session.userId)) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }
    res.json({ task: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allow edit/delete if user is admin/hod OR if they are the task's assigner.
// This covers the "user delegated a task (incl. self-delegation) → can edit/delete" case.
// Normalise an optional "HH:MM" (24-hour) into a MySQL TIME.
// Blank/absent → null (clears the time). Invalid → undefined, so callers 400.
function parseDueTime(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(raw).trim());
  return m ? `${m[1]}:${m[2]}:00` : undefined;
}

async function canModifyTask(req, taskId, type) {
  if (req.session.role === 'admin' || req.session.role === 'hod' || await userCanDo(req.session, 'admin_tasks')) return true;
  const [rows] = await db.query(
    `SELECT assigned_by FROM ${getTable(type||'delegation')} WHERE id=?`, [taskId]
  );
  return !!rows[0] && Number(rows[0].assigned_by) === Number(req.session.userId);
}

app.put('/api/tasks/:id/edit', requireAuth, async (req, res) => {
  try {
    const { type, desc, date, priority, approval, remarks, url, client_id, clientId } = req.body;
    // Two questions, both must pass: is this task yours to touch (canModifyTask),
    // and are you allowed to edit tasks at all. The frontend already asks both —
    // `(isAdmin || isDelegateByMe || isMyDelegation) && canDo('edit_task')` — the
    // route only ever asked the first.
    if (!await canModifyTask(req, req.params.id, type)) return res.status(403).json({ error: 'Not allowed to edit this task' });
    if (!(await userCanDo(req.session, 'edit_task'))) return res.status(403).json({ error: 'You do not have edit access to tasks' });
    const table = getTable(type||'delegation');
    const cidRaw = client_id != null ? client_id : clientId;
    const cid = (() => { const n = parseInt(cidRaw, 10); return Number.isFinite(n) && n > 0 ? n : null; })();
    // Read the old date so a change can be recorded. Edit is one of four routes
    // that can move a deadline and, like the other three, it left no trace —
    // "my due date changed by itself" had no answer.
    const [[before]] = await db.query(
      `SELECT DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${table} WHERE id=?`, [req.params.id]);
    const logDateChange = () => {
      const from = before?.due_date || null;
      const to = date || null;
      if (from === to) return;
      logTaskActivity({
        taskId: req.params.id, taskType: type || 'delegation', field: 'due_date',
        oldValue: from, newValue: to, changedBy: req.session.userId, source: 'edit'
      });
    };
    if (type === 'delegation') {
      // due_time lives only on delegation_tasks. Blank clears it, so a task that
      // had a clock time can be put back to a date-only deadline.
      const dueTime = parseDueTime(req.body.dueTime);
      if (dueTime === undefined) return res.status(400).json({ error: 'Due time must be HH:MM (24-hour)' });
      // Writing a date here has to clear awaiting_due_date too, the way the
      // Set-due-date route does. Without it a client task edited this way kept
      // the flag at 1 while holding a real date: the row still showed the
      // "Awaiting date" badge instead of the date, and the 4-hourly nudge went
      // on firing for good, because that cron reads the flag and never looks at
      // due_date. Only touched when a date is actually written — an edit that
      // leaves the date blank must not silently declare it settled.
      const setsDueDate = !!(date && String(date).trim());
      await db.query(
        `UPDATE ${table} SET description=?,due_date=?,due_time=?,priority=?,approval=?,remarks=?,url=?,client_id=?`
        + (setsDueDate ? ',awaiting_due_date=0' : '') + ` WHERE id=?`,
        [desc, date, dueTime, priority||'low', approval||'no', remarks||'', url||null, cid, req.params.id]);
    }
    else await db.query(`UPDATE ${table} SET description=?,due_date=?,remarks=?,client_id=? WHERE id=?`, [desc, date, remarks||'', cid, req.params.id]);
    logDateChange();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    if (!await canModifyTask(req, req.params.id, type)) return res.status(403).json({ error: 'Not allowed to delete this task' });
    if (!(await userCanDo(req.session, 'delete_task'))) return res.status(403).json({ error: 'You do not have delete access to tasks' });
    const tbl = getTable(type||'delegation');
    const [rows] = await db.query(`SELECT * FROM ${tbl} WHERE id=?`, [req.params.id]);
    await archiveDeleted(tbl, rows, req, { summary: r => `Task: ${r.description || ''}` });
    await db.query(`DELETE FROM ${tbl} WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete every checklist row that shares description + assigned_to with the given
// task and has due_date >= today. Use this to nuke a recurring "series" so it
// doesn't keep reappearing day after day.
app.delete('/api/tasks/:id/checklist-series', requireAuth, async (req, res) => {
  try {
    if (!await canModifyTask(req, req.params.id, 'checklist')) return res.status(403).json({ error: 'Not allowed' });
    // Same permission the single-row delete asks for.
    if (!(await userCanDo(req.session, 'delete_task'))) return res.status(403).json({ error: 'You do not have delete access to tasks' });
    const [[task]] = await db.query('SELECT description, assigned_to, assigned_by, client_id FROM checklist_tasks WHERE id=?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const includePast = req.query.includePast === '1';
    const dateClause = includePast ? '' : ' AND due_date >= CURDATE()';
    // A series is one assigner's recurring task for one doer, for one client.
    // Matching on description + doer alone also swept up a same-named
    // checklist someone else had set for that person, without their delete
    // rights being asked; leaving the client out swept up the same task set
    // for that doer's other clients ("Post daily story" for every client).
    const match = 'description=? AND assigned_to=? AND assigned_by <=> ? AND client_id <=> ?';
    const args = [task.description, task.assigned_to, task.assigned_by, task.client_id];
    const [doomed] = await db.query(`SELECT * FROM checklist_tasks WHERE ${match}${dateClause}`, args);
    await archiveDeleted('checklist_tasks', doomed, req, {
      summary: r => `Checklist series: ${r.description || ''}`,
      reason: 'Recurring checklist series deleted',
    });
    const [result] = await db.query(`DELETE FROM checklist_tasks WHERE ${match}${dateClause}`, args);
    res.json({ success: true, deleted: result.affectedRows || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk delete by user
app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    const [doomed] = await db.query(`SELECT * FROM ${table} WHERE assigned_to = ?`, [req.params.userId]);
    await archiveDeleted(table, doomed, req, {
      summary: r => `Task: ${r.description || ''}`,
      reason: `Bulk delete of all ${table} rows for user ${req.params.userId}`,
    });
    await db.query(`DELETE FROM ${table} WHERE assigned_to = ?`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transfer pending tasks to today
app.put('/api/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, async (req, res) => {
  try {
    // IST today — the UTC date is still yesterday before 05:30 IST, which moved
    // every pending task to yesterday and made it overdue at once.
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { type } = req.query;
    const table = getTable(type || 'delegation');
    // Read them first: this is one blanket UPDATE with no confirmation and no
    // undo, so the old dates have to be captured before they are gone.
    const [moving] = await db.query(
      `SELECT id, DATE_FORMAT(due_date,'%Y-%m-%d') AS due_date FROM ${table}
        WHERE assigned_to=? AND status='pending'`, [req.params.userId]);
    await db.query(`UPDATE ${table} SET due_date=? WHERE assigned_to=? AND status='pending'`,
      [today, req.params.userId]);
    for (const t of moving) {
      if (t.due_date === today) continue;
      logTaskActivity({ taskId: t.id, taskType: type || 'delegation', field: 'due_date',
        oldValue: t.due_date, newValue: today, changedBy: req.session.userId,
        source: 'transfer-today', note: `bulk move of ${moving.length} task(s)` });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/delete-by-date', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Date required' });
    const [doomed] = await db.query('SELECT * FROM checklist_tasks WHERE due_date=?', [date]);
    await archiveDeleted('checklist_tasks', doomed, req, {
      summary: r => `Checklist: ${r.description || ''}`,
      reason: `Bulk delete of all checklist tasks due ${date}`,
    });
    const [result] = await db.query('DELETE FROM checklist_tasks WHERE due_date=?', [date]);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Every open task still carrying no due date, grouped for the "Awaiting Date"
// tab. Delegation only: checklist rows are generated per date and always carry
// one, and no_due_date_reason exists on delegation_tasks alone.
//
// The filter is `due_date IS NULL`, not `awaiting_due_date=1`. The flag marks
// the doer-sets-date mode specifically, but a task can arrive dateless without
// it — client-delegated tasks do, and the handler fills the date in later. The
// question this tab answers is "what has no deadline", so it asks that directly.
//
// Read-only by decision: no Set-due-date control here. The date is the doer's
// call, made from their own board; this is the view that stops the gap being
// invisible, not a place to overrule them.
// ══════════════════════════════════════════════════════
// NEW-TASK POPUP — what this doer has been assigned and not yet seen
//
// The doer already gets an email on delegation, but nothing tells them
// inside the app: they had to notice a new row on their own board. These
// two routes back a popup that opens when they next open the ERP.
//
// ⚠️ Bounded by created_at, and that bound is load-bearing. Every row that
// predates the seen_at column has seen_at NULL, so an unbounded query would
// greet everyone with every task ever assigned to them on the first open
// after deploy. A task older than the window is not news.
const VD_UNSEEN_DAYS = 7;
// How many the popup lists. The rest are counted, not printed — a modal is
// not a task board, and a bulk CSV upload can land fifty rows on one doer.
const VD_POPUP_SHOW = 5;

app.get('/api/tasks/unseen', requireAuth, async (req, res) => {
  try {
    // Counted separately from the rows so the headline can say 23 while the
    // list shows 5. `upto` is the cursor the dismissal marks against: every
    // unseen row up to this instant was counted in `total`, so dismissing
    // clears exactly what the popup claimed and nothing newer.
    // ⚠️ Formatted in SQL, not handed back as a Date. mysql2 returns a JS Date
    // that JSON-serialises to ISO-8601 with a Z, and MySQL rejects that on the
    // way back in ("Incorrect datetime value") — which the browser swallows,
    // leaving the popup to reopen every thirty seconds forever. The string
    // form also dodges the timezone question entirely: it goes back exactly as
    // the column stores it.
    const [[agg]] = await db.query(
      `SELECT COUNT(*) AS total, DATE_FORMAT(MAX(created_at),'%Y-%m-%d %H:%i:%s') AS upto
         FROM delegation_tasks
        WHERE assigned_to = ?
          AND seen_at IS NULL
          AND status IN ('pending','revised')
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [req.session.userId, VD_UNSEEN_DAYS]);
    const [rows] = await db.query(
      `SELECT t.id, t.description, t.priority,
              DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,
              t.awaiting_due_date,
              DATE_FORMAT(t.created_at,'%Y-%m-%d %H:%i') AS assigned_at,
              a.name AS assigned_by_name,
              COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name
         FROM delegation_tasks t
         LEFT JOIN task_users a   ON t.assigned_by = a.id
         LEFT JOIN clients c ON t.client_id   = c.id
        WHERE t.assigned_to = ?
          AND t.seen_at IS NULL
          AND t.status IN ('pending','revised')
          AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY t.created_at DESC
        LIMIT ?`,
      [req.session.userId, VD_UNSEEN_DAYS, VD_POPUP_SHOW]);
    res.json({ tasks: rows, total: agg.total || 0, upto: agg.upto || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backs the topbar bell. Same rows as /unseen but without the seen filter, so
// the panel keeps showing what was already read — a notification list that
// empties itself the moment you look at it is a list you cannot go back to.
// `is_new` is what the panel highlights and what the badge counts.
app.get('/api/tasks/notifications', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.id, t.description, t.priority, t.status,
              DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,
              t.awaiting_due_date,
              DATE_FORMAT(t.created_at,'%Y-%m-%d %H:%i') AS assigned_at,
              (t.seen_at IS NULL) AS is_new,
              a.name AS assigned_by_name,
              COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name
         FROM delegation_tasks t
         LEFT JOIN task_users a   ON t.assigned_by = a.id
         LEFT JOIN clients c ON t.client_id   = c.id
        WHERE t.assigned_to = ?
          AND t.status <> 'completed'
          AND t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        ORDER BY t.created_at DESC
        LIMIT 50`,
      [req.session.userId]);
    res.json({ items: rows, unread: rows.filter(r => r.is_new).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marks the popup's contents read. Scoped to the caller's own rows on the
// server, not on the ids the client sends — a doer must not be able to clear
// somebody else's notification by posting their task id.
// Two modes. `ids` marks exactly those rows — the bell uses it when one
// notification is clicked. `upto` marks every unseen row created at or
// before that instant, which is what the popup's dismissal needs: it
// announced a COUNT, not a list, so clearing only the five it printed would
// bring the other eighteen straight back thirty seconds later.
//
// The cursor is what keeps that honest. A task delivered while the popup was
// on screen is newer than `upto`, so it survives the dismissal and is
// announced properly next time instead of being silently buried.
app.post('/api/tasks/seen', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(n => parseInt(n, 10)).filter(Number.isFinite)
      : [];
    // Only the exact shape /unseen hands out. Anything else is rejected rather
    // than passed to MySQL to interpret.
    const raw = req.body?.upto;
    const upto = (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) ? raw : null;

    if (upto) {
      const [result] = await db.query(
        `UPDATE delegation_tasks
            SET seen_at = NOW()
          WHERE assigned_to = ?
            AND seen_at IS NULL
            AND created_at <= ?`,
        [req.session.userId, upto]);
      return res.json({ marked: result.affectedRows });
    }

    if (!ids.length) return res.json({ marked: 0 });
    const [result] = await db.query(
      `UPDATE delegation_tasks
          SET seen_at = NOW()
        WHERE assigned_to = ?
          AND seen_at IS NULL
          AND id IN (${ids.map(() => '?').join(',')})`,
      [req.session.userId, ...ids]);
    res.json({ marked: result.affectedRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/awaiting-date', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const taskAdmin = await userCanDo(req.session, 'admin_tasks');
    if (role !== 'admin' && role !== 'hod' && !taskAdmin) return res.status(403).json({ error: 'Admin or HOD only' });
    const params = [];
    let deptClause = '';
    if (role === 'hod' && !taskAdmin) {
      // Same scoping rule as MIS: a hod sees their own department and nothing
      // else. Fails closed — a hod with no department on their row sees none.
      const [[me]] = await db.query('SELECT department FROM task_users WHERE id=?', [req.session.userId]);
      const dept = (me?.department || '').trim();
      if (!dept) return res.json({ departments: [], total: 0 });
      deptClause = 'AND TRIM(u.department) = ?';
      params.push(dept);
    }
    const [rows] = await db.query(
      `SELECT t.id, t.description,
              DATE_FORMAT(t.created_at,'%Y-%m-%d') AS given_on,
              t.no_due_date_reason,
              u.id AS doer_id, u.name AS doer_name,
              TRIM(COALESCE(u.department,'')) AS department
         FROM delegation_tasks t
         JOIN task_users u ON t.assigned_to = u.id
        WHERE t.due_date IS NULL
          AND t.status IN ('pending','revised')
          AND u.role <> 'client' AND u.client_id IS NULL
          ${deptClause}
        ORDER BY department ASC, u.name ASC, t.created_at ASC`, params);

    // Shape it the way the tab reads it — department, then doer, then tasks —
    // so the client renders instead of regrouping.
    const byDept = new Map();
    for (const r of rows) {
      const dept = r.department || 'No department';
      if (!byDept.has(dept)) byDept.set(dept, new Map());
      const doers = byDept.get(dept);
      if (!doers.has(r.doer_id)) doers.set(r.doer_id, { id: r.doer_id, name: r.doer_name, tasks: [] });
      doers.get(r.doer_id).tasks.push({
        id: r.id, type: 'Delegation', description: r.description,
        given_on: r.given_on, reason: r.no_due_date_reason || ''
      });
    }
    res.json({
      total: rows.length,
      departments: [...byDept.entries()].map(([name, doers]) => ({
        name,
        count: [...doers.values()].reduce((n, d) => n + d.tasks.length, 0),
        doers: [...doers.values()]
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Count checklist tasks for a user (all time or by year)
app.get('/api/tasks/checklist-year-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, year } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    let rows;
    if (!year || year === 'all') {
      [rows] = await db.query(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=?`, [userId]);
    } else {
      [rows] = await db.query(`SELECT COUNT(*) AS count FROM checklist_tasks WHERE assigned_to=? AND YEAR(due_date)=?`, [userId, year]);
    }
    res.json({ count: rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete all checklist tasks for a user (POST used to avoid body parse issues with DELETE)
app.post('/api/tasks/checklist-year-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const [doomed] = await db.query(`SELECT * FROM checklist_tasks WHERE assigned_to=?`, [userId]);
    await archiveDeleted('checklist_tasks', doomed, req, {
      summary: r => `Checklist: ${r.description || ''}`,
      reason: `Bulk delete of all checklist tasks for user ${userId}`,
    });
    const [result] = await db.query(`DELETE FROM checklist_tasks WHERE assigned_to=?`, [userId]);
    res.json({ success: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
};
