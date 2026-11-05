// ════════════════════════════════════════════════════════════════════
// Task comments
// Taken over from the ERP's server.js as it was; ctx comes from core.js.
// ════════════════════════════════════════════════════════════════════
module.exports = function register(app, ctx) {
  const {
    db, requireAuth, requireAdmin, liveRole, invalidateRoleCache, sendMail, getNotifyTarget, waTextToEmailHtml, emailUserWaText, sendWhatsApp, sendWhatsAppRaw, getTable, findRecentDuplicateTask, logTaskActivity, fillDeletedUserNames, archiveDeleted, canTouchSubtasks, canSeeTask, seesAllApprovals, getEffectivePerms, userCanDo, fmtClock, isHandlerOf, dashboardUserFilter, _toDateStr, _addDays, isUserOffOn, loadHolidaysSet, isLastSaturdayOfMonth, getTodayOffIST, nextWorkingDay,
  } = ctx;

  // server.js 3995-4033

  // ══════════════════════════════════════════════════════
  // COMMENTS
  // ══════════════════════════════════════════════════════
  app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
    try {
      // Comments are a conversation about one task, so seeing them follows seeing
      // the task. Both ids arrive in the URL; without this, walking the number
      // read every discussion in the company.
      if (!(await canSeeTask(req, req.params.taskId, req.params.type))) {
        return res.status(403).json({ error: 'Not allowed' });
      }
      const [rows] = await db.query(`SELECT tc.id,tc.comment,tc.created_at,u.name AS userName FROM task_comments tc JOIN task_users u ON tc.user_id=u.id WHERE tc.task_id=? AND tc.task_type=? ORDER BY tc.created_at ASC`, [req.params.taskId, req.params.type]);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/comments', requireAuth, async (req, res) => {
    try {
      const { taskId, taskType, comment } = req.body;
      if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
      // Writing followed the same open path as reading — the comment was stored
      // under the caller's own name, but against whatever task id they sent.
      if (!(await canSeeTask(req, taskId, taskType))) return res.status(403).json({ error: 'Not allowed' });
      await db.query('INSERT INTO task_comments (task_id,task_type,user_id,comment) VALUES (?,?,?,?)', [taskId, taskType, req.session.userId, comment]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/comments/:id', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.query('SELECT * FROM task_comments WHERE id=?', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      if (Number(rows[0].user_id) !== Number(req.session.userId) && !(await userCanDo(req.session, 'admin_tasks'))) return res.status(403).json({ error: 'Not allowed' });
      await archiveDeleted('task_comments', rows[0], req, { summary: r => `Comment: ${r.comment || ''}` });
      await db.query('DELETE FROM task_comments WHERE id=?', [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
