/**
 * Tasks page (views/views/tasks.ejs): Delegation + Checklist on top of the
 * task module's API (modules/tasks). Loaded once; the page calls
 * TaskModule.init() on every visit because the shell swaps the markup.
 *
 * The API decides what each person may do and answers 403 otherwise; this file
 * only hides the buttons that would be refused, from /api/task-module/me.
 */
window.TaskModule = (function () {
  'use strict';

  const S = { me: null, users: [], tab: 'delegation', status: 'pending', rows: [], detail: null, editing: null, revising: null, dueFor: null };
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);   // IST
  const ymd = v => (v ? String(v).slice(0, 10) : '');
  const fmt = v => { const d = ymd(v); return d ? d.split('-').reverse().join('-') : '—'; };
  const isAdmin = () => !!(S.me && S.me.role === 'admin');
  const can = a => !!(S.me && (S.me.can.all || S.me.can.actions.includes(a)));
  const modal = id => bootstrap.Modal.getOrCreateInstance($(id));

  async function api(method, url, body) {
    try {
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await r.json(); } catch (e) { data = {}; }
      if (r.status === 401) data = { error: 'Your session has expired. Please log in again.' };
      return { ok: r.ok, status: r.status, data: data || {} };
    } catch (e) { return { ok: false, status: 0, data: { error: 'Could not reach the server.' } }; }
  }
  const toast = (msg, icon = 'success') => Swal.fire({ toast: true, position: 'top-end', icon, title: msg, showConfirmButton: false, timer: 2600 });
  const showErr = (id, msg) => { const e = $(id); if (!e) return; e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; };
  const confirmBox = (title, text, ok = 'Yes') => Swal.fire({ title, text, icon: 'question', showCancelButton: true, confirmButtonText: ok }).then(r => r.isConfirmed);

  // ── start ──
  async function init() {
    const me = await api('GET', '/api/task-module/me');
    if (!me.ok) { $('tk_list').innerHTML = `<div class="alert alert-danger">${esc(me.data.error || 'Could not load tasks.')}</div>`; return; }
    S.me = me.data;
    const users = await api('GET', '/api/task-module/users');
    S.users = Array.isArray(users.data) ? users.data : [];
    if (isAdmin()) { $('tk_personWrap').style.display = ''; $('tk_holBtn').style.display = ''; $('tk_tabAwaitWrap').style.display = ''; }
    $('tk_person').innerHTML = '<option value="">Everyone</option>' + S.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
    S.tab = 'delegation'; S.status = 'pending';
    await load();
    badges();
    newTaskNotice();
  }

  // Tasks given to me since I last looked: shown once, then marked seen.
  async function newTaskNotice() {
    const r = await api('GET', '/api/tasks/unseen');
    const list = (r.data && r.data.tasks) || [];
    if (!list.length) return;
    await Swal.fire({
      title: list.length === 1 ? 'A new task for you' : `${list.length} new tasks for you`, icon: 'info',
      html: '<div class="text-start">' + list.slice(0, 8).map(t => `<div class="border-bottom py-1"><b>${esc(t.description)}</b><div class="small text-muted">From ${esc(t.assignedByName || t.assigned_by_name || '—')} · due ${fmt(t.due_date)}</div></div>`).join('') + '</div>',
      confirmButtonText: 'Got it',
    });
    await api('POST', '/api/tasks/seen', { ids: list.map(t => t.id) });
  }

  async function badges() {
    const a = await api('GET', '/api/approvals/count');
    const n = (a.data && a.data.count) || 0;
    $('tk_apprBadge').textContent = n; $('tk_apprBadge').style.display = n ? '' : 'none';
    const t = await api('GET', '/api/transfers/count');
    const m = (t.data && (t.data.count ?? t.data.pending)) || 0;
    $('tk_trBadge').textContent = m; $('tk_trBadge').style.display = m ? '' : 'none';
  }

  // ── the list ──
  function setTab(tab, el) {
    S.tab = tab;
    document.querySelectorAll('#tk_tabs .nav-link').forEach(b => b.classList.toggle('active', b === el));
    load();
  }
  function setStatus(status, el) {
    S.status = status;
    document.querySelectorAll('#tk_statusPills .btn').forEach(b => b.classList.toggle('active', b === el));
    render();
  }
  function clearFilters() {
    $('tk_search').value = ''; $('tk_person').value = ''; $('tk_from').value = ''; $('tk_to').value = '';
    load();
  }
  const flat = d => (d && d.grouped ? d.grouped.flatMap(g => g.tasks) : (d && d.tasks) || []);

  async function load() {
    if (!S.me) return;
    $('tk_list').innerHTML = '<div class="text-center py-5 text-muted"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</div>';
    const q = new URLSearchParams();
    if ($('tk_from').value) q.set('from', $('tk_from').value);
    if ($('tk_to').value) q.set('to', $('tk_to').value);
    let rows = [];
    if (S.tab === 'awaiting') {
      const r = await api('GET', '/api/tasks/awaiting-date');
      rows = (r.data && (r.data.tasks || r.data.rows)) || (Array.isArray(r.data) ? r.data : []);
      rows = rows.map(t => ({ ...t, type: 'delegation' }));
    } else if (S.tab === 'mine') {
      const [d, c] = await Promise.all([api('GET', `/api/tasks?type=delegation&mine=1&${q}`), api('GET', `/api/tasks?type=checklist&mine=1&${q}`)]);
      rows = [...flat(d.data), ...flat(c.data)];
    } else {
      const r = await api('GET', `/api/tasks?type=${S.tab}&${q}`);
      if (!r.ok) { $('tk_list').innerHTML = `<div class="alert alert-danger">${esc(r.data.error)}</div>`; return; }
      rows = flat(r.data);
    }
    S.rows = rows;
    render();
  }

  function shown() {
    const q = $('tk_search').value.trim().toLowerCase();
    const person = $('tk_person').value;
    const t0 = today();
    return S.rows.filter(t => {
      const open = t.status === 'pending' || t.status === 'revised';
      if (S.tab !== 'awaiting') {
        if (S.status === 'pending' && !(open && (!t.due_date || ymd(t.due_date) <= t0))) return false;
        if (S.status === 'upcoming' && !(open && t.due_date && ymd(t.due_date) > t0)) return false;
        if (S.status === 'completed' && t.status !== 'completed') return false;
      }
      if (person && String(t.assigned_to) !== person) return false;
      if (q && !`${t.description} ${t.assignedToName} ${t.assignedByName} ${t.remarks || ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => String(ymd(a.due_date) || '9999').localeCompare(String(ymd(b.due_date) || '9999')));
  }

  function statusBadge(t) {
    if (Number(t.waiting_approval)) return '<span class="badge bg-info text-dark">Waiting approval</span>';
    if (t.status === 'completed') return '<span class="badge bg-success">Done</span>';
    if (Number(t.awaiting_due_date) && !t.due_date) return '<span class="badge bg-secondary">Needs a date</span>';
    if (t.status === 'revised') return '<span class="badge bg-warning text-dark">Date change asked</span>';
    if (t.due_date && ymd(t.due_date) < today()) return '<span class="badge bg-danger">Overdue</span>';
    return '<span class="badge bg-warning text-dark">Pending</span>';
  }

  function actions(t) {
    const mineToDo = Number(t.assigned_to) === Number(S.me.id);
    const gaveIt = Number(t.assigned_by) === Number(S.me.id);
    const open = t.status !== 'completed';
    const waiting = Number(t.waiting_approval) === 1;
    const deleg = t.type === 'delegation';
    const b = [];
    const key = `'${t.type}',${t.id}`;
    if (open && !waiting && (mineToDo || isAdmin())) b.push(`<button class="btn btn-success" title="Mark done" onclick="TaskModule.done(${key})"><i class="fas fa-check"></i></button>`);
    if (deleg && open && !waiting && Number(t.awaiting_due_date) && !t.due_date && (mineToDo || gaveIt || isAdmin())) b.push(`<button class="btn btn-outline-primary" title="Set due date" onclick="TaskModule.openDue(${t.id})"><i class="fas fa-calendar-day"></i></button>`);
    if (deleg && open && !waiting && t.due_date && mineToDo) b.push(`<button class="btn btn-outline-warning" title="Ask for a new date" onclick="TaskModule.openRevise(${t.id})"><i class="fas fa-calendar-plus"></i></button>`);
    if (!open && can('reopen_task')) b.push(`<button class="btn btn-outline-secondary" title="Reopen" onclick="TaskModule.reopen(${key})"><i class="fas fa-rotate-left"></i></button>`);
    b.push(`<button class="btn btn-outline-dark" title="Details and comments" onclick="TaskModule.openDetail(${key})"><i class="fas fa-comments"></i></button>`);
    if ((isAdmin() || gaveIt) && can('edit_task')) b.push(`<button class="btn btn-outline-primary" title="Edit" onclick="TaskModule.openEdit(${key})"><i class="fas fa-pen"></i></button>`);
    if ((isAdmin() || gaveIt) && can('delete_task')) b.push(`<button class="btn btn-outline-danger" title="Delete" onclick="TaskModule.remove(${key})"><i class="fas fa-trash"></i></button>`);
    return b.join(' ');
  }

  function render() {
    const list = shown();
    if (!list.length) { $('tk_list').innerHTML = '<div class="text-center py-5 text-muted"><i class="fas fa-inbox fa-2x mb-2 d-block"></i>No tasks here.</div>'; return; }
    const t0 = today();
    const showType = S.tab === 'mine';
    $('tk_list').innerHTML = `<div class="card shadow-sm"><div class="table-responsive"><table class="table table-hover align-middle mb-0">
      <thead class="table-light"><tr><th>#</th><th>Task</th>${showType ? '<th>Type</th>' : ''}<th>Doer</th><th>Given by</th><th>Due</th><th>Priority</th><th>Status</th><th class="text-end">Actions</th></tr></thead>
      <tbody>${list.map((t, i) => {
        const late = t.due_date && ymd(t.due_date) < t0 && t.status !== 'completed';
        return `<tr>
          <td class="text-muted small">${i + 1}</td>
          <td><div class="tk-desc fw-semibold">${esc(t.description)}</div>
            ${t.remarks ? `<div class="small text-muted">${esc(t.remarks)}</div>` : ''}
            ${t.no_due_date_reason && !t.due_date ? `<div class="small text-secondary"><i class="fas fa-circle-info me-1"></i>${esc(t.no_due_date_reason)}</div>` : ''}
            ${t.url ? `<a class="small" href="${esc(t.url)}" target="_blank" rel="noopener"><i class="fas fa-link me-1"></i>Link</a>` : ''}</td>
          ${showType ? `<td><span class="badge bg-light text-dark border">${t.type === 'checklist' ? 'Checklist' : 'Delegation'}</span></td>` : ''}
          <td>${esc(t.assignedToName || '—')}</td>
          <td>${esc(t.assignedByName || '—')}</td>
          <td class="${late ? 'tk-overdue' : ''}">${fmt(t.due_date)}</td>
          <td><span class="tk-prio tk-prio-${esc(t.priority || 'low')}">${esc(t.priority || 'low')}</span></td>
          <td>${statusBadge(t)}</td>
          <td class="text-end tk-actions text-nowrap">${actions(t)}</td></tr>`;
      }).join('')}</tbody></table></div></div>
      <div class="small text-muted mt-2">${list.length} task${list.length === 1 ? '' : 's'}</div>`;
  }
  const find = (type, id) => S.rows.find(t => t.type === type && Number(t.id) === Number(id));

  // ── done / reopen ──
  async function done(type, id, extra = {}) {
    const r = await api('PUT', `/api/tasks/${id}/status`, { status: 'completed', type, ...extra });
    if (r.ok) { toast(r.data.needsApproval ? 'Sent for approval' : 'Marked done'); load(); badges(); return; }
    if (r.data.needsDelayReason) {
      const v = await Swal.fire({ title: 'Finished late', text: `This task is ${r.data.lateDays} day(s) past its due date. Why?`, input: 'textarea', inputPlaceholder: 'Reason for the delay', showCancelButton: true, confirmButtonText: 'Mark done', inputValidator: x => (!x || !x.trim() ? 'Please give a reason' : undefined) });
      if (v.isConfirmed) return done(type, id, { delay_reason: v.value.trim() });
      return;
    }
    if (r.data.needsDueDate) { openDue(id); return; }
    Swal.fire('Not done', r.data.error || 'Could not mark it done.', 'warning');
  }
  async function reopen(type, id) {
    if (!(await confirmBox('Reopen this task?', 'It goes back to pending.'))) return;
    const r = await api('PUT', `/api/tasks/${id}/status`, { status: 'pending', type });
    r.ok ? (toast('Reopened'), load()) : Swal.fire('Not reopened', r.data.error, 'warning');
  }

  // ── delegate ──
  const userOptions = (blank = 'Select a person') => `<option value="">${blank}</option>` + S.users.map(u => `<option value="${u.id}">${esc(u.name)}${u.department ? ' — ' + esc(u.department) : ''}</option>`).join('');
  function openDelegate() {
    showErr('tk_dErr');
    $('tk_dDoer').innerHTML = userOptions();
    $('tk_dPriority').value = 'low'; $('tk_dApproval').value = 'no';
    $('tk_dDate').value = today(); $('tk_dDate').min = today(); $('tk_dDate').disabled = false; $('tk_dDoerSets').checked = false;
    $('tk_dUrl').value = ''; $('tk_dDesc').value = ''; $('tk_dRemarks').value = '';
    modal('tk_delegateModal').show();
  }
  function doerSetsChange() {
    const on = $('tk_dDoerSets').checked;
    $('tk_dDate').disabled = on;
    $('tk_dDate').value = on ? '' : today();
  }
  async function saveDelegate() {
    showErr('tk_dErr');
    const doer = $('tk_dDoer').value, desc = $('tk_dDesc').value.trim(), doerSets = $('tk_dDoerSets').checked, date = $('tk_dDate').value;
    if (!doer) return showErr('tk_dErr', 'Please pick the doer');
    if (!doerSets && !date) return showErr('tk_dErr', 'Please pick a due date');
    if (!desc) return showErr('tk_dErr', 'Please write the task');
    const btn = $('tk_dSave'); btn.disabled = true; btn.textContent = 'Assigning…';
    const r = await api('POST', '/api/tasks', {
      type: 'delegation', desc, assignedTo: doer, date: doerSets ? '' : date, priority: $('tk_dPriority').value,
      approval: $('tk_dApproval').value, approver: '', remarks: $('tk_dRemarks').value.trim(), client_id: null,
      url: $('tk_dUrl').value.trim() || null, doerSetsDueDate: doerSets,
    });
    btn.disabled = false; btn.textContent = 'Assign';
    if (!r.ok) return showErr('tk_dErr', r.data.error || 'Could not assign the task');
    modal('tk_delegateModal').hide();
    toast(r.data.duplicate ? 'That task was already created a moment ago' : r.data.adjusted ? `Delegated — moved to ${fmt(r.data.effectiveDate)} (holiday)` : 'Task delegated');
    load();
  }

  // ── checklist ──
  // Every date of the series, skipping the doer's off days (week_off / extra_off).
  function generateDates(start, freq, weekOffStr, extraOffStr, endDate) {
    const dates = [];
    const d = new Date(start + 'T00:00:00');
    const endCap = endDate ? new Date(endDate + 'T00:00:00') : null;
    const count = { daily: 365, weekly: 52, alternative_week: 26, monthly: 12, quarterly: 4, yearly: 1 }[freq];
    const weekOff = String(weekOffStr || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    let extraOff = []; try { extraOff = extraOffStr ? JSON.parse(extraOffStr) : []; } catch (e) { extraOff = []; }
    const isExtraOff = x => extraOff.some(e => e.day === x.getDay() && (e.weeks || []).includes(Math.ceil(x.getDate() / 7)));
    let added = 0, safety = count * 14;
    while (added < count && safety-- > 0) {
      if (endCap && d > endCap) break;
      if (freq === 'daily' && (weekOff.includes(d.getDay()) || isExtraOff(d))) { d.setDate(d.getDate() + 1); continue; }
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      added++;
      if (freq === 'daily') d.setDate(d.getDate() + 1);
      else if (freq === 'weekly') d.setDate(d.getDate() + 7);
      else if (freq === 'alternative_week') d.setDate(d.getDate() + 14);
      else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
      else if (freq === 'quarterly') d.setMonth(d.getMonth() + 3);
      else d.setFullYear(d.getFullYear() + 1);
    }
    return dates;
  }
  function checklistDates() {
    const u = S.users.find(x => String(x.id) === $('tk_cDoer').value) || {};
    return $('tk_cStart').value ? generateDates($('tk_cStart').value, $('tk_cFreq').value, u.week_off, u.extra_off, $('tk_cEnd').value) : [];
  }
  function openChecklist() {
    showErr('tk_cErr');
    $('tk_cDoer').innerHTML = userOptions();
    $('tk_cFreq').value = 'daily'; $('tk_cStart').value = today(); $('tk_cStart').min = today(); $('tk_cEnd').value = ''; $('tk_cEnd').min = today();
    $('tk_cDesc').value = ''; $('tk_cRemarks').value = '';
    checklistPreview();
    modal('tk_checklistModal').show();
  }
  function checklistPreview() {
    const box = $('tk_cPreview'), desc = $('tk_cDesc').value.trim(), dates = checklistDates();
    if (!desc || !dates.length) { box.style.display = 'none'; return; }
    box.innerHTML = `<b>"${esc(desc)}"</b> — ${dates.length} task${dates.length === 1 ? '' : 's'} from ${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}`;
    box.style.display = '';
  }
  async function saveChecklist() {
    showErr('tk_cErr');
    const doer = $('tk_cDoer').value, desc = $('tk_cDesc').value.trim(), start = $('tk_cStart').value, end = $('tk_cEnd').value;
    if (!doer) return showErr('tk_cErr', 'Please pick the doer');
    if (!start) return showErr('tk_cErr', 'Please pick a start date');
    if (!desc) return showErr('tk_cErr', 'Please write the task');
    if (end && end < start) return showErr('tk_cErr', 'The end date must be on or after the start date');
    const dates = checklistDates();
    if (!dates.length) return showErr('tk_cErr', 'No dates fall between the start and the end. Pick a wider range.');
    const btn = $('tk_cSave'); btn.disabled = true; btn.textContent = 'Generating…';
    const r = await api('POST', '/api/tasks/bulk-checklist', { desc, assignedTo: doer, priority: 'low', remarks: $('tk_cRemarks').value.trim(), dates, client_id: null });
    btn.disabled = false; btn.textContent = 'Generate Tasks';
    if (!r.ok) return showErr('tk_cErr', r.data.error || 'Could not create the checklist');
    modal('tk_checklistModal').hide();
    toast(`${r.data.count || dates.length} checklist tasks created${r.data.skipped ? ` (${r.data.skipped} holiday date${r.data.skipped === 1 ? '' : 's'} skipped)` : ''}`);
    load();
  }

  // ── edit ──
  async function openEdit(type, id) {
    const r = await api('GET', `/api/tasks/${id}/detail?type=${type}`);
    if (!r.ok) return Swal.fire('Not available', r.data.error, 'warning');
    const t = r.data.task; S.editing = { type, id };
    showErr('tk_eErr');
    $('tk_eDesc').value = t.description || ''; $('tk_eDate').value = ymd(t.due_date); $('tk_eRemarks').value = t.remarks || '';
    $('tk_eTime').value = String(t.due_time || '').slice(0, 5); $('tk_ePriority').value = t.priority || 'low'; $('tk_eApproval').value = t.approval || 'no'; $('tk_eUrl').value = t.url || '';
    document.querySelectorAll('#tk_editModal .tk-deleg-only').forEach(e => { e.style.display = type === 'delegation' ? '' : 'none'; });
    modal('tk_editModal').show();
  }
  async function saveEdit() {
    const { type, id } = S.editing || {};
    const desc = $('tk_eDesc').value.trim(), date = $('tk_eDate').value;
    if (!desc) return showErr('tk_eErr', 'The task cannot be empty');
    if (!date) return showErr('tk_eErr', 'Please pick a due date');
    const body = { desc, date, remarks: $('tk_eRemarks').value.trim(), type, client_id: null };
    if (type === 'delegation') Object.assign(body, { priority: $('tk_ePriority').value, approval: $('tk_eApproval').value, dueTime: $('tk_eTime').value, url: $('tk_eUrl').value.trim() || null });
    const r = await api('PUT', `/api/tasks/${id}/edit`, body);
    if (!r.ok) return showErr('tk_eErr', r.data.error || 'Could not save');
    modal('tk_editModal').hide(); toast('Task updated'); load();
  }

  // ── revise (ask for a new date) ──
  function openRevise(id) {
    S.revising = id; showErr('tk_rErr');
    const tm = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);
    $('tk_rDate').value = ''; $('tk_rDate').min = tm; $('tk_rReason').value = '';
    modal('tk_reviseModal').show();
  }
  async function saveRevise() {
    const date = $('tk_rDate').value, reason = $('tk_rReason').value.trim();
    if (!date) return showErr('tk_rErr', 'Please pick the new date');
    if (!reason) return showErr('tk_rErr', 'Please give a reason');
    const r = await api('PUT', `/api/tasks/${S.revising}/status`, { status: 'revised', type: 'delegation', newDate: date, reason });
    if (!r.ok) return showErr('tk_rErr', r.data.error || 'Could not send');
    modal('tk_reviseModal').hide();
    toast(r.data.needsApproval ? 'Sent to the person who gave the task' : 'Date changed');
    load(); badges();
  }

  // ── set due date (doer-defined) ──
  function openDue(id) {
    S.dueFor = id; showErr('tk_sErr');
    const t = find('delegation', id) || {};
    $('tk_sDate').value = ''; $('tk_sDate').min = today(); $('tk_sDate').disabled = false;
    $('tk_sNoDate').checked = !!t.no_due_date_reason; $('tk_sReason').value = t.no_due_date_reason || '';
    noDateChange();
    modal('tk_dueModal').show();
  }
  function noDateChange() {
    const on = $('tk_sNoDate').checked;
    $('tk_sDate').disabled = on; if (on) $('tk_sDate').value = '';
    $('tk_sReasonWrap').style.display = on ? '' : 'none';
  }
  async function saveDue() {
    const noDate = $('tk_sNoDate').checked, date = $('tk_sDate').value, reason = $('tk_sReason').value.trim();
    if (!noDate && !date) return showErr('tk_sErr', 'Please pick a date');
    if (noDate && !reason) return showErr('tk_sErr', 'Please write a reason');
    const r = await api('PUT', `/api/tasks/${S.dueFor}/due-date`, noDate ? { reason } : { date });
    if (!r.ok) return showErr('tk_sErr', r.data.error || 'Could not save');
    modal('tk_dueModal').hide();
    toast(r.data.reasonSaved ? 'Reason saved — a date is still needed before it can be done' : 'Due date set');
    load();
  }

  // ── delete ──
  async function remove(type, id) {
    if (type === 'checklist') {
      const c = await Swal.fire({ title: 'Delete checklist task', icon: 'warning', showDenyButton: true, showCancelButton: true,
        confirmButtonText: 'Only this one', denyButtonText: 'This and all later ones', confirmButtonColor: '#dc3545', denyButtonColor: '#7f1d1d' });
      if (c.isDismissed) return;
      const r = c.isDenied ? await api('DELETE', `/api/tasks/${id}/checklist-series`) : await api('DELETE', `/api/tasks/${id}?type=checklist`);
      r.ok ? (toast(c.isDenied ? `${r.data.deleted || 0} deleted` : 'Deleted'), load()) : Swal.fire('Not deleted', r.data.error, 'warning');
      return;
    }
    if (!(await confirmBox('Delete this task?', 'It is kept in the deleted records and can be restored by an admin.', 'Delete'))) return;
    const r = await api('DELETE', `/api/tasks/${id}?type=${type}`);
    r.ok ? (toast('Deleted'), load()) : Swal.fire('Not deleted', r.data.error, 'warning');
  }

  // ── details, comments, history ──
  async function openDetail(type, id) {
    S.detail = { type, id };
    $('tk_detBody').innerHTML = '<div class="text-muted">Loading…</div>'; $('tk_cmtList').innerHTML = ''; $('tk_histList').innerHTML = ''; $('tk_cmtInput').value = '';
    modal('tk_detailModal').show();
    const [d, h] = await Promise.all([api('GET', `/api/tasks/${id}/detail?type=${type}`), api('GET', `/api/tasks/${id}/activity?type=${type}`)]);
    // The detail route sends the row itself; the names come from the list row.
    const listRow = find(type, id) || {};
    const t = { ...((d.data && d.data.task) || {}), ...['assignedToName', 'assignedByName', 'delegated_on'].reduce((o, k) => (listRow[k] ? { ...o, [k]: listRow[k] } : o), {}) };
    $('tk_detTitle').textContent = t.description ? String(t.description).slice(0, 80) : 'Task';
    const row = (k, v) => (v ? `<tr><th class="text-muted small" style="width:140px">${k}</th><td>${v}</td></tr>` : '');
    $('tk_detBody').innerHTML = `<table class="table table-sm mb-0">
      ${row('Task', `<div class="tk-desc">${esc(t.description)}</div>`)}
      ${row('Type', type === 'checklist' ? 'Checklist' : 'Delegation')}
      ${row('Doer', esc(t.assignedToName))}${row('Given by', esc(t.assignedByName))}
      ${row('Given on', fmt(t.delegated_on || t.created_at))}${row('Due', fmt(t.due_date) + (t.due_time ? ' ' + esc(String(t.due_time).slice(0, 5)) : ''))}
      ${row('Status', statusBadge(t))}${row('Priority', `<span class="tk-prio tk-prio-${esc(t.priority || 'low')}">${esc(t.priority || 'low')}</span>`)}
      ${row('Approval', t.approval === 'yes' ? 'Needed to close' : '')}
      ${row('Remarks', esc(t.remarks))}${row('Delay reason', esc(t.delay_reason))}
      ${row('Link', t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a>` : '')}</table>`;
    const acts = (h.data && h.data.activity) || [];
    $('tk_histList').innerHTML = acts.length ? acts.map(a => `<div>${esc(a.at)} — <b>${esc(a.by_name)}</b>: ${a.field === 'status' ? `${esc(a.old_status || '—')} → ${esc(a.new_status || '—')}` : `${esc(a.field)} ${esc(a.old_value || '—')} → ${esc(a.new_value || '—')}`}${a.note ? ` <i>(${esc(a.note)})</i>` : ''}</div>`).join('') : 'Nothing yet.';
    loadComments();
  }
  async function loadComments() {
    const { type, id } = S.detail;
    const r = await api('GET', `/api/comments/${type}/${id}`);
    const list = Array.isArray(r.data) ? r.data : [];
    $('tk_cmtList').innerHTML = !r.ok ? `<div class="text-danger small">${esc(r.data.error)}</div>` : list.length
      ? list.map(c => `<div class="tk-cmt"><div class="d-flex justify-content-between"><b class="small">${esc(c.userName)}</b>
          <span class="small text-muted">${esc(new Date(c.created_at).toLocaleString('en-IN'))}
          ${Number(c.user_id) === Number(S.me.id) || isAdmin() ? `<button class="btn btn-link btn-sm text-danger p-0 ms-2" onclick="TaskModule.deleteComment(${c.id})"><i class="fas fa-xmark"></i></button>` : ''}</span></div>
          <div class="small">${esc(c.comment)}</div></div>`).join('')
      : '<div class="small text-muted">No comments yet.</div>';
  }
  async function addComment() {
    const text = $('tk_cmtInput').value.trim();
    if (!text) return;
    const { type, id } = S.detail;
    const r = await api('POST', '/api/comments', { taskId: id, taskType: type, comment: text });
    if (!r.ok) return Swal.fire('Not sent', r.data.error, 'warning');
    $('tk_cmtInput').value = ''; loadComments();
  }
  async function deleteComment(cid) {
    if (!(await confirmBox('Delete this comment?', ''))) return;
    await api('DELETE', `/api/comments/${cid}`); loadComments();
  }

  // ── approvals ──
  async function openApprovals() {
    modal('tk_apprModal').show();
    $('tk_apprList').innerHTML = '<div class="text-muted">Loading…</div>';
    const r = await api('GET', '/api/approvals');
    const list = Array.isArray(r.data) ? r.data : [];
    $('tk_apprAllBtn').style.display = isAdmin() && list.some(a => a.action_type === 'revised') ? '' : 'none';
    $('tk_apprList').innerHTML = !list.length ? '<div class="text-center text-muted py-4">Nothing is waiting for approval.</div>'
      : `<table class="table table-sm align-middle"><thead><tr><th>Task</th><th>Asked by</th><th>Request</th><th></th></tr></thead><tbody>${list.map(a => `<tr>
          <td>${esc(a.description)}</td><td>${esc(a.requestedByName)}</td>
          <td>${a.action_type === 'revised' ? `New date <b>${fmt(a.reviseToDate || a.new_date)}</b> (now ${fmt(a.currentDue)})${a.note ? `<div class="small text-muted">${esc(a.note)}</div>` : ''}` : 'Mark as done'}</td>
          <td class="text-nowrap"><button class="btn btn-sm btn-success" onclick="TaskModule.decide(${a.id},'approved')">Approve</button>
            <button class="btn btn-sm btn-outline-danger" onclick="TaskModule.decide(${a.id},'rejected')">Reject</button></td></tr>`).join('')}</tbody></table>`;
  }
  async function decide(id, action) {
    let note = '';
    if (action === 'rejected') {
      const v = await Swal.fire({ title: 'Reject', input: 'text', inputPlaceholder: 'Reason (optional)', showCancelButton: true, confirmButtonText: 'Reject' });
      if (!v.isConfirmed) return; note = v.value || '';
    }
    const r = await api('PUT', `/api/approvals/${id}`, { action, note });
    if (!r.ok) return Swal.fire('Not saved', r.data.error, 'warning');
    toast(action === 'approved' ? 'Approved' : 'Rejected'); openApprovals(); load(); badges();
  }
  async function approveAllRevises() {
    if (!(await confirmBox('Approve every date change?', 'Each task moves to the date that was asked for.'))) return;
    const r = await api('POST', '/api/approvals/approve-all-revises', {});
    r.ok ? (toast(`${r.data.approved || 0} approved`), openApprovals(), load(), badges()) : Swal.fire('Not saved', r.data.error, 'warning');
  }

  // ── transfers ──
  async function openTransfers() {
    showErr('tk_trErr');
    $('tk_trFromWrap').style.display = isAdmin() ? '' : 'none';
    $('tk_trFrom').innerHTML = S.users.map(u => `<option value="${u.id}"${Number(u.id) === Number(S.me.id) ? ' selected' : ''}>${esc(u.name)}</option>`).join('');
    $('tk_trTo').innerHTML = userOptions('Hand over to…');
    modal('tk_trModal').show();
    loadTransferTasks(); loadTransferRequests();
  }
  async function loadTransferTasks() {
    const from = isAdmin() ? $('tk_trFrom').value : S.me.id;
    $('tk_trTasks').innerHTML = '<div class="text-muted small">Loading…</div>';
    const [d, c] = await Promise.all([api('GET', '/api/tasks?type=delegation'), api('GET', '/api/tasks?type=checklist')]);
    const open = [...flat(d.data), ...flat(c.data)].filter(t => String(t.assigned_to) === String(from) && t.status !== 'completed' && !Number(t.waiting_approval));
    $('tk_trTasks').innerHTML = open.length ? open.map(t => `<label class="d-flex gap-2 align-items-start py-1 small">
        <input type="checkbox" class="form-check-input mt-1 tk-trCb" data-id="${t.id}" data-type="${t.type}">
        <span><b>${esc(t.description)}</b> <span class="text-muted">· ${t.type} · due ${fmt(t.due_date)}</span></span></label>`).join('')
      : '<div class="text-muted small">No open tasks to hand over.</div>';
  }
  async function sendTransfer() {
    showErr('tk_trErr');
    const to = $('tk_trTo').value;
    const tasks = [...document.querySelectorAll('.tk-trCb:checked')].map(c => ({ taskId: Number(c.dataset.id), taskType: c.dataset.type }));
    if (!tasks.length) return showErr('tk_trErr', 'Tick the tasks to hand over');
    if (!to) return showErr('tk_trErr', 'Pick who takes them');
    const r = await api('POST', '/api/transfers', { tasks, toUserId: Number(to) });
    if (!r.ok) return showErr('tk_trErr', r.data.error || 'Could not send');
    toast('Transfer requested'); loadTransferTasks(); loadTransferRequests(); badges();
  }
  async function loadTransferRequests() {
    const [all, my] = await Promise.all([api('GET', '/api/transfers'), api('GET', '/api/transfers/my')]);
    const toDecide = Array.isArray(all.data) ? all.data : (all.data.transfers || []);
    const mine = Array.isArray(my.data) ? my.data : (my.data.transfers || []);
    const seen = new Set(toDecide.map(t => t.id));
    const rows = [...toDecide.map(t => ({ ...t, decide: t.status === 'pending' })), ...mine.filter(t => !seen.has(t.id))];
    $('tk_trList').innerHTML = !rows.length ? '<div class="text-muted small">No transfer requests.</div>'
      : `<table class="table table-sm align-middle"><thead><tr><th>Task</th><th>From</th><th>To</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(t => `<tr>
          <td>${esc(t.description || t.task_description || ('#' + t.task_id))}</td><td>${esc(t.fromUserName)}</td><td>${esc(t.toUserName)}</td>
          <td><span class="badge ${t.status === 'approved' ? 'bg-success' : t.status === 'rejected' ? 'bg-danger' : 'bg-warning text-dark'}">${esc(t.status)}</span></td>
          <td class="text-nowrap">${t.decide ? `<button class="btn btn-sm btn-success" onclick="TaskModule.decideTransfer(${t.id},'approved')">Approve</button>
            <button class="btn btn-sm btn-outline-danger" onclick="TaskModule.decideTransfer(${t.id},'rejected')">Reject</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  }
  async function decideTransfer(id, action) {
    const r = await api('PUT', `/api/transfers/${id}`, { action });
    if (!r.ok) return Swal.fire('Not saved', r.data.error, 'warning');
    toast(action === 'approved' ? 'Transferred' : 'Rejected'); loadTransferRequests(); load(); badges();
  }

  // ── holidays (SuperAdmin) ──
  async function openHolidays() {
    showErr('tk_hErr'); $('tk_hDate').value = ''; $('tk_hDate').min = today(); $('tk_hName').value = '';
    modal('tk_holModal').show(); loadHolidays();
  }
  async function loadHolidays() {
    const r = await api('GET', '/api/holidays');
    const list = Array.isArray(r.data) ? r.data : [];
    $('tk_holList').innerHTML = !list.length ? '<div class="text-muted small">No holidays added yet.</div>'
      : list.map(h => `<div class="d-flex justify-content-between align-items-center border-bottom py-1"><span><b>${fmt(h.holiday_date)}</b> — ${esc(h.name)}</span>
          <button class="btn btn-sm btn-outline-danger" onclick="TaskModule.removeHoliday(${h.id})">Remove</button></div>`).join('');
  }
  async function addHoliday() {
    showErr('tk_hErr');
    const date = $('tk_hDate').value, name = $('tk_hName').value.trim();
    if (!date || !name) return showErr('tk_hErr', 'Date and name are both needed');
    const r = await api('POST', '/api/holidays', { date, name });
    if (!r.ok) return showErr('tk_hErr', r.data.error || 'Could not add');
    const bits = [];
    if (r.data.deletedChecklist) bits.push(`${r.data.deletedChecklist} checklist task(s) removed`);
    if (r.data.pushedDelegation) bits.push(`${r.data.pushedDelegation} delegation task(s) moved forward`);
    toast('Holiday added' + (bits.length ? ' — ' + bits.join(', ') : ''));
    $('tk_hDate').value = ''; $('tk_hName').value = '';
    loadHolidays(); load();
  }
  async function removeHoliday(id) {
    if (!(await confirmBox('Remove this holiday?', ''))) return;
    const r = await api('DELETE', `/api/holidays/${id}`);
    r.ok ? (toast('Holiday removed'), loadHolidays()) : Swal.fire('Not removed', r.data.error, 'warning');
  }

  return {
    init, load, render, setTab, setStatus, clearFilters,
    done, reopen, openDelegate, doerSetsChange, saveDelegate, openChecklist, checklistPreview, saveChecklist,
    openEdit, saveEdit, openRevise, saveRevise, openDue, noDateChange, saveDue, remove,
    openDetail, addComment, deleteComment, openApprovals, decide, approveAllRevises,
    openTransfers, loadTransferTasks, sendTransfer, decideTransfer, openHolidays, addHoliday, removeHoliday,
  };
})();
