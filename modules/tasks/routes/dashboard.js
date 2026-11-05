// ════════════════════════════════════════════════════════════════════
// Dashboard: task counts, the 14-day trend and the task rows
// Taken over from the ERP's server.js as it was; ctx comes from core.js.
// ════════════════════════════════════════════════════════════════════
module.exports = function register(app, ctx) {
  const {
    db, requireAuth, requireAdmin, liveRole, invalidateRoleCache, sendMail, getNotifyTarget, waTextToEmailHtml, emailUserWaText, sendWhatsApp, sendWhatsAppRaw, getTable, findRecentDuplicateTask, logTaskActivity, fillDeletedUserNames, archiveDeleted, canTouchSubtasks, canSeeTask, seesAllApprovals, getEffectivePerms, userCanDo, fmtClock, isHandlerOf, dashboardUserFilter, _toDateStr, _addDays, isUserOffOn, loadHolidaysSet, isLastSaturdayOfMonth, getTodayOffIST, nextWorkingDay,
  } = ctx;

  // server.js 2247-2385
  // Each KPI card's "vs last month" figure and its 14-day sparkline. This month
  // so far is compared with the same days of last month. Checklist rows have no
  // completed_at, so a checklist counts on its due date (as the dashboard does).
  //   total     — tasks given: delegation by created_at, checklist by due_date
  //   completed — delegation by completed_at, checklist by due_date when done
  //   pending   — of those given in the period, the ones still open now
  //   upcoming  — tasks scheduled (due) in the period
  app.get('/api/dashboard/trend', requireAuth, async (req, res) => {
    try {
      const { userFilter, params } = await dashboardUserFilter(req);
      const ist = new Date(Date.now() + 330 * 60000);
      const ymd = d => d.toISOString().slice(0, 10);
      const today = ymd(ist);
      const day = ist.getUTCDate();
      const thisStart = ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1)));
      const lastStart = ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)));
      const lastMonthDays = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 0)).getUTCDate();
      const lastEnd = ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, Math.min(day, lastMonthDays))));
      const sparkStart = ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), day - 13)));
      const from = sparkStart < lastStart ? sparkStart : lastStart;

      // One grouped query per metric and table: day -> count, from `from` to today.
      const perDay = async (sql) => {
        const [rows] = await db.query(sql, [from, today, ...params]);
        const m = new Map();
        for (const r of rows) m.set(r.d, (m.get(r.d) || 0) + Number(r.n || 0));
        return m;
      };
      const q = (tbl, dateExpr, extra = '') =>
        `SELECT DATE_FORMAT(${dateExpr},'%Y-%m-%d') AS d, COUNT(*) AS n FROM ${tbl} t
          WHERE DATE(${dateExpr}) BETWEEN ? AND ? ${extra} ${userFilter} GROUP BY d`;
      const merge = (...maps) => { const m = new Map(); for (const x of maps) for (const [k, v] of x) m.set(k, (m.get(k) || 0) + v); return m; };
      const series = {
        total: merge(await perDay(q('delegation_tasks', 't.created_at')), await perDay(q('checklist_tasks', 't.due_date'))),
        completed: merge(await perDay(q('delegation_tasks', 't.completed_at', "AND t.status='completed'")),
                         await perDay(q('checklist_tasks', 't.due_date', "AND t.status='completed'"))),
        pending: merge(await perDay(q('delegation_tasks', 't.created_at', "AND t.status IN ('pending','revised')")),
                       await perDay(q('checklist_tasks', 't.due_date', "AND t.status='pending'"))),
        upcoming: merge(await perDay(q('delegation_tasks', 't.due_date')), await perDay(q('checklist_tasks', 't.due_date'))),
      };
      const sum = (m, a, b) => { let s = 0; for (const [k, v] of m) if (k >= a && k <= b) s += v; return s; };
      const days = [];
      for (let i = 13; i >= 0; i--) days.push(ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), day - i))));
      const out = {};
      for (const [key, m] of Object.entries(series)) {
        const now = sum(m, thisStart, today), before = sum(m, lastStart, lastEnd);
        out[key] = {
          thisPeriod: now, lastPeriod: before,
          // No figure when last month had nothing to compare with.
          change: before ? Math.round((now - before) / before * 100) : null,
          spark: days.map(d => m.get(d) || 0),
        };
      }
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/dashboard', requireAuth, async (req, res) => {
    try {
      const role = req.session.role;
      const isPC = role === 'pc';
      // PC date range filter — default to today if not provided
      const dateFrom = req.query.dateFrom || '';
      const dateTo   = req.query.dateTo   || '';
      const { userFilter, params } = await dashboardUserFilter(req);

      // Stats + Table:
      //   Delegation: ALL dates (matches FMS — no date cap, show all pending)
      //   Checklist : today + next 10 days (upcoming visibility for recurring tasks)
      // PC: if a date range was provided, use it (overrides both)
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const validDates = dateFrom && dateTo && dateRe.test(dateFrom) && dateRe.test(dateTo);
      const usingPCRange = isPC && validDates;
      const delDateClause = usingPCRange ? 'AND t.due_date BETWEEN ? AND ?' : '';
      const chlDateClause = usingPCRange ? 'AND t.due_date BETWEEN ? AND ?' : 'AND t.due_date <= LAST_DAY(CURDATE())';
      const delParams = usingPCRange ? [...params, dateFrom, dateTo] : params;
      const chlParams = usingPCRange ? [...params, dateFrom, dateTo] : params;

      const taskType = req.query.taskType || 'both';
      // status filter for the returned task rows. Default 'pending' for backward compat.
      // Counts (pending/revised/completed) are always computed so the stat cards stay in sync.
      const reqStatus = (req.query.status || 'pending').toLowerCase();
      const rowStatus = ['pending','completed','revised','all'].includes(reqStatus) ? reqStatus : 'pending';
      const rowStatusClause = rowStatus === 'all' ? '' : `AND t.status='${rowStatus}'`;
      const skipStats = req.query.skipStats === '1';
      let pending = 0, revised = 0, completed = 0;

      let upcoming = 0;
      if (!skipStats && (taskType === 'delegation' || taskType === 'both')) {
        const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' AND (due_date IS NULL OR due_date <= CURDATE()) THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' AND (due_date IS NULL OR due_date <= CURDATE()) THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM delegation_tasks t WHERE 1=1 ${userFilter} ${delDateClause}`, delParams);
        pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
      }
      if (!skipStats && (taskType === 'checklist' || taskType === 'both')) {
        const [d] = await db.query(`SELECT SUM(CASE WHEN status='pending' AND (due_date IS NULL OR due_date <= CURDATE()) THEN 1 ELSE 0 END) AS pending,SUM(CASE WHEN status='revised' AND (due_date IS NULL OR due_date <= CURDATE()) THEN 1 ELSE 0 END) AS revised,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM checklist_tasks t WHERE 1=1 ${userFilter} ${chlDateClause}`, chlParams);
        pending += parseInt(d[0].pending)||0; revised += parseInt(d[0].revised)||0; completed += parseInt(d[0].completed)||0;
      }
      if (!skipStats && (taskType === 'delegation' || taskType === 'both')) {
        const [[u1]] = await db.query(`SELECT COUNT(*) AS cnt FROM delegation_tasks t WHERE status IN ('pending','revised') AND due_date > CURDATE() AND YEAR(due_date)=YEAR(CURDATE()) AND MONTH(due_date)=MONTH(CURDATE()) ${userFilter}`, params);
        upcoming += parseInt(u1.cnt)||0;
      }
      if (!skipStats && (taskType === 'checklist' || taskType === 'both')) {
        const [[u2]] = await db.query(`SELECT COUNT(*) AS cnt FROM checklist_tasks t WHERE status IN ('pending','revised') AND due_date > CURDATE() AND YEAR(due_date)=YEAR(CURDATE()) AND MONTH(due_date)=MONTH(CURDATE()) ${userFilter}`, params);
        upcoming += parseInt(u2.cnt)||0;
      }

      let delegationRows = [], checklistRows = [];
      // Completed rows come newest first. The list is capped at 500, and in
      // due-date order it held the oldest 500 completions, with the undated ones
      // on top, so recent work never appeared on the dashboard. Delegation goes
      // by when the task was done (completed_at), checklist by its due date (it
      // keeps no completion time). Every other view stays oldest-due first.
      const delOrder = rowStatus === 'completed'
        ? 'ORDER BY COALESCE(t.completed_at, t.due_date) IS NULL, COALESCE(t.completed_at, t.due_date) DESC, t.id DESC'
        : 'ORDER BY t.due_date ASC';
      const chlOrder = rowStatus === 'completed'
        ? 'ORDER BY t.due_date IS NULL, t.due_date DESC, t.id DESC'
        : 'ORDER BY t.due_date ASC';
      // The row queries, by status clause and order, so the revised rows below run the same ones.
      const delRows = (statusClause, order) => db.query(`SELECT t.id,'delegation' AS type,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,COALESCE(t.approval,'no') AS approval,COALESCE(t.waiting_approval,0) AS waiting_approval,COALESCE(t.awaiting_due_date,0) AS awaiting_due_date,t.no_due_date_reason,t.remarks,t.url,t.client_id,COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS delegated_on,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,DATE_FORMAT(t.completed_at,'%Y-%m-%d') AS completed_on,COALESCE(u1.name,'— deleted user —') AS assignedToName,COALESCE(u2.name,'—') AS assignedByName FROM delegation_tasks t LEFT JOIN task_users u1 ON t.assigned_to=u1.id LEFT JOIN task_users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id WHERE 1=1 ${statusClause} ${delDateClause} ${userFilter} ${order} LIMIT 500`, delParams).then(r => r[0]);
      const chlRows = (statusClause, order) => db.query(`SELECT t.id,'checklist' AS type,t.description,t.status,t.assigned_to,t.assigned_by,COALESCE(t.priority,'low') AS priority,'no' AS approval,0 AS waiting_approval,0 AS awaiting_due_date,t.remarks,t.client_id,COALESCE(NULLIF(TRIM(c.brand_name),''), c.name) AS client_name,DATE_FORMAT(t.created_at,'%Y-%m-%d') AS delegated_on,DATE_FORMAT(t.due_date,'%Y-%m-%d') AS due_date,NULL AS completed_on,COALESCE(u1.name,'— deleted user —') AS assignedToName,COALESCE(u2.name,'—') AS assignedByName FROM checklist_tasks t LEFT JOIN task_users u1 ON t.assigned_to=u1.id LEFT JOIN task_users u2 ON t.assigned_by=u2.id LEFT JOIN clients c ON t.client_id=c.id WHERE 1=1 ${statusClause} ${chlDateClause} ${userFilter} ${order} LIMIT 500`, chlParams).then(r => r[0]);
      if (taskType === 'delegation' || taskType === 'both') delegationRows = await delRows(rowStatusClause, delOrder);
      if (taskType === 'checklist' || taskType === 'both') checklistRows = await chlRows(rowStatusClause, chlOrder);
      // withRevised=1 on the pending load: the revised rows come in the same
      // answer, as the separate status=revised call would have returned them.
      // The dashboard used to make that call per type, two more requests (and
      // two more function wake-ups) on every open.
      let revisedRows = null;
      if (req.query.withRevised === '1' && rowStatus === 'pending') {
        revisedRows = [];
        if (taskType === 'delegation' || taskType === 'both') revisedRows.push(...await delRows(`AND t.status='revised'`, 'ORDER BY t.due_date ASC'));
        if (taskType === 'checklist' || taskType === 'both') revisedRows.push(...await chlRows(`AND t.status='revised'`, 'ORDER BY t.due_date ASC'));
      }
      await fillDeletedUserNames([...delegationRows, ...checklistRows, ...(revisedRows || [])], [['assigned_to', 'assignedToName'], ['assigned_by', 'assignedByName']]);
      // `todayPending` kept for backwards compatibility (regular pending load still uses it).
      // `tasks` is the generic field for any status filter.
      res.json({ pending, revised, completed, upcoming, todayPending: [...delegationRows, ...checklistRows], tasks: [...delegationRows, ...checklistRows], status: rowStatus,
        ...(revisedRows ? { revisedTasks: revisedRows } : {}) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
