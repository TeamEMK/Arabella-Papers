// ════════════════════════════════════════════════════════════════════
// Holidays (adding one moves / removes that day's tasks)
// Taken over from the ERP's server.js as it was; ctx comes from core.js.
// ════════════════════════════════════════════════════════════════════
module.exports = function register(app, ctx) {
  const {
    db, requireAuth, requireAdmin, liveRole, invalidateRoleCache, sendMail, getNotifyTarget, waTextToEmailHtml, emailUserWaText, sendWhatsApp, sendWhatsAppRaw, getTable, findRecentDuplicateTask, logTaskActivity, fillDeletedUserNames, archiveDeleted, canTouchSubtasks, canSeeTask, seesAllApprovals, getEffectivePerms, userCanDo, fmtClock, isHandlerOf, dashboardUserFilter, _toDateStr, _addDays, isUserOffOn, loadHolidaysSet, isLastSaturdayOfMonth, getTodayOffIST, nextWorkingDay,
  } = ctx;

  app.get('/api/holidays', requireAuth, async (req, res) => {
    try {
      const [rows] = await db.query(`
        SELECT id, name, DATE_FORMAT(holiday_date,'%Y-%m-%d') AS holiday_date
        FROM holidays ORDER BY holiday_date ASC`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { date, name } = req.body;
      if (!date || !name) return res.status(400).json({ error: 'date and name required' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

      await db.query(
        'INSERT INTO holidays (holiday_date, name, created_by) VALUES (?,?,?) ' +
        'ON DUPLICATE KEY UPDATE name=VALUES(name)',
        [date, name.trim(), req.session.userId]
      );

      // Cascade: delete checklist tasks on this date + push delegation tasks forward
      const cascade = await cascadeHolidayDate(date, req);
      res.json({ success: true, ...cascade });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Bulk holidays — accepts array of {date, name}
  app.post('/api/holidays/bulk', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { holidays } = req.body;
      if (!Array.isArray(holidays) || !holidays.length) return res.status(400).json({ error: 'No holidays provided' });

      let added = 0, skipped = 0, errors = [];
      let cascadeDeleted = 0, cascadePushed = 0;

      for (const h of holidays) {
        const date = (h.date || '').trim();
        const name = (h.name || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) {
          skipped++; errors.push({ row: h, reason: 'invalid date or empty name' });
          continue;
        }
        try {
          await db.query(
            'INSERT INTO holidays (holiday_date, name, created_by) VALUES (?,?,?) ' +
            'ON DUPLICATE KEY UPDATE name=VALUES(name)',
            [date, name, req.session.userId]
          );
          const c = await cascadeHolidayDate(date, req);
          cascadeDeleted += c.deletedChecklist || 0;
          cascadePushed += c.pushedDelegation || 0;
          added++;
        } catch (e) {
          skipped++; errors.push({ row: h, reason: e.message });
        }
      }

      res.json({ success: true, added, skipped, cascadeDeleted, cascadePushed, errors });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [doomed] = await db.query('SELECT * FROM holidays WHERE id=?', [parseInt(req.params.id, 10)]);
      await archiveDeleted('holidays', doomed, req, { summary: r => `Holiday: ${r.name || ''} (${r.holiday_date || ''})` });
      await db.query('DELETE FROM holidays WHERE id=?', [parseInt(req.params.id, 10)]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // On holiday add: delete checklist tasks on that date + push delegation tasks
  async function cascadeHolidayDate(dateStr, req) {
    let deletedChecklist = 0, pushedDelegation = 0;
    try {
      // These rows vanish as a side effect of marking a holiday — the user never
      // explicitly deleted them — so archiving them matters more here, not less.
      const [doomed] = await db.query(
        "SELECT * FROM checklist_tasks WHERE due_date=? AND status='pending'", [dateStr]);
      await archiveDeleted('checklist_tasks', doomed, req, {
        summary: r => `Checklist: ${r.description || ''}`,
        via: 'cascadeHolidayDate',
        reason: `Auto-deleted: ${dateStr} was marked a holiday`,
      });
      const [del] = await db.query("DELETE FROM checklist_tasks WHERE due_date=? AND status='pending'", [dateStr]);
      deletedChecklist = del.affectedRows || 0;
    } catch (e) { console.error('cascade checklist:', e.message); }

    try {
      const holidaysSet = await loadHolidaysSet();
      const [delegationsOnDate] = await db.query(
        "SELECT t.id, t.assigned_to, u.week_off, u.extra_off " +
        "FROM delegation_tasks t JOIN task_users u ON t.assigned_to=u.id " +
        "WHERE t.due_date=? AND t.status='pending'",
        [dateStr]
      );
      for (const t of delegationsOnDate) {
        const newDate = nextWorkingDay(t, dateStr, holidaysSet);
        await db.query('UPDATE delegation_tasks SET due_date=? WHERE id=?', [newDate, t.id]);
        logTaskActivity({ taskId: t.id, field: 'due_date', oldValue: dateStr, newValue: newDate,
          changedBy: req?.session?.userId, source: 'holiday-cascade',
          note: `${dateStr} marked a holiday` });
        pushedDelegation++;
      }
    } catch (e) { console.error('cascade delegation:', e.message); }

    return { deletedChecklist, pushedDelegation };
  }
};
