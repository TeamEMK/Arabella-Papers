// ══════════════════════════════════════════════════════
// PMS — THE API
//
// Three readers and two writers. The board (every running order and the step
// it is sitting on), one order's own steps, and whatever is waiting on me;
// then marking a step done, and editing the catalogue.
//
// Every datetime leaving here goes through clock.istOf. The column holds the
// right characters, but the driver hands back a Date and a Date prints in the
// server's timezone — UTC on Vercel. Sending the raw value would put the
// wrong hour, and near midnight the wrong day, on every board.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const clock = require('../../utils/pms/clock');
const engine = require('../../utils/pms/engine');

const STEP_TIMES = ['planned_at', 'opened_at', 'actual_at'];

function isAdmin(user) {
  const role = (user && user.role) || '';
  return role === 'SuperAdmin' || (user && user.domain === 'Head')
    || role.includes('Production Manager');
}

function who(user) {
  return {
    email: (user && (user.email || user.username)) || '',
    name: (user && (user.name || user.username || user.email)) || '',
  };
}

/**
 * A step row the way every screen wants it: IST strings, and how late it is
 * worked out once here rather than three times in three views.
 *
 * `late` is only ever counted against a planned date that exists. A step
 * whose TAT nobody has filled in yet is not late, it is untimed, and the two
 * must not look the same on a board the floor is asked to act on.
 */
function stepRow(r, today) {
  const row = clock.withIst(r, STEP_TIMES);
  const late = row.status === 'pending' ? clock.daysLate(row.planned_at, today) : 0;
  return { ...row, late, untimed: !row.planned_at };
}

// ── THE SWITCH ──

/**
 * The start date: the day the board begins counting, and the only thing that
 * turns it on at all. Empty means off.
 */
router.get('/start-date', requireLogin, async (req, res) => {
  try {
    const from = await engine.startDate();
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM pms_order_steps`);
    res.json({ success: true, startDate: from || '', onBoard: Number(row.n) });
  } catch (err) {
    console.error('[pms] start-date:', err.message);
    res.status(500).json({ success: false, error: 'Could not read the start date.' });
  }
});

router.put('/start-date', requireLogin, async (req, res) => {
  try {
    if (!isAdmin(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const v = String((req.body && req.body.startDate) || '').trim();
    // Empty switches it off. Anything else has to be a real date, or every
    // punch from here on would silently skip the board.
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return res.status(400).json({ success: false, error: 'Use a date like 2026-11-01, or leave it empty to switch the board off.' });
    }
    await db.query(
      `INSERT INTO app_settings (name, value, updated_by) VALUES ('pms_start_date', ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [v, who(req.session.user).email]);
    res.json({ success: true, startDate: v });
  } catch (err) {
    console.error('[pms] save start-date:', err.message);
    res.status(500).json({ success: false, error: 'Could not save the start date.' });
  }
});

// ── THE CATALOGUE ──

router.get('/steps', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.id, s.step_order, s.name, s.condition_key, s.doer_role,
              s.tat_days, s.is_active, s.note, s.updated_by, s.updated_at,
              (SELECT COUNT(*) FROM pms_step_doers d WHERE d.step_id = s.id) AS doers
         FROM pms_steps s ORDER BY s.step_order, s.id`);
    res.json({
      success: true,
      steps: rows.map(r => ({ ...r, tat_days: r.tat_days === null ? null : Number(r.tat_days) })),
      conditions: Object.keys(engine.CONDITIONS),
      // What the floor still owes us. The screen leads with this because an
      // untimed step is the one thing stopping the board from working.
      missingTat: rows.filter(r => r.is_active && r.tat_days === null).length,
    });
  } catch (err) {
    console.error('[pms] steps:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the steps.' });
  }
});

/**
 * Edit one step. Only the TAT, the role, the note and the on/off switch —
 * not the name or the order, which rows already written are carrying copies
 * of.
 */
router.put('/steps/:id', requireLogin, async (req, res) => {
  try {
    if (!isAdmin(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Bad step.' });
    }

    const { tat_days: rawTat, doer_role: role, note, is_active: active } = req.body || {};
    let tat = null;
    if (rawTat !== null && rawTat !== undefined && String(rawTat).trim() !== '') {
      tat = Number(rawTat);
      // A TAT is a number of working days. Refusing nonsense here keeps a
      // typo out of every planned date computed from this step afterwards.
      if (!Number.isFinite(tat) || tat < 0 || tat > 365) {
        return res.status(400).json({ success: false, error: 'TAT must be between 0 and 365 days.' });
      }
    }

    const [out] = await db.query(
      `UPDATE pms_steps
          SET tat_days = ?, doer_role = ?, note = ?, is_active = ?, updated_by = ?
        WHERE id = ?`,
      [tat, String(role || '').slice(0, 60), String(note || '').slice(0, 255),
        active ? 1 : 0, who(req.session.user).email, id]);
    if (!out.affectedRows) {
      return res.status(404).json({ success: false, error: 'No such step.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[pms] save step:', err.message);
    res.status(500).json({ success: false, error: 'Could not save the step.' });
  }
});

// ── THE BOARD ──

/**
 * Every order that is still running, and the step it is sitting on.
 *
 * One query, not one per order: the board is the first thing the office opens
 * in the morning and a query per row would make it slower the busier the
 * floor gets.
 */
/**
 * The dashboard: the four figures at the top, the step-wise pipeline, what
 * ships this week and what came in last.
 *
 * One handler rather than four, because the screen shows them together and
 * four round trips on a cold Vercel container is four cold starts.
 */
router.get('/dashboard', requireLogin, async (req, res) => {
  try {
    const today = clock.nowIst();
    const me = who(req.session.user);
    const myRole = (req.session.user && req.session.user.role) || '';

    // Pipeline: every active step and what is sitting on it. A LEFT JOIN so a
    // step with nothing on it still shows - an empty step is information, and
    // dropping it would make the flow look shorter than it is.
    const [pipe] = await db.query(
      `SELECT s.id, s.step_order, s.name, s.tat_days,
              COUNT(os.id) AS pending,
              SUM(os.planned_at IS NOT NULL AND os.planned_at < NOW()) AS late
         FROM pms_steps s
         LEFT JOIN pms_order_steps os
           ON os.step_id = s.id AND os.status = 'pending'
         LEFT JOIN orders o
           ON o.order_id = os.order_id AND o.is_deleted = 0
        WHERE s.is_active = 1
        GROUP BY s.id
        ORDER BY s.step_order`);

    // The running orders, once, and the headline figures counted off them.
    const [running] = await db.query(
      `SELECT os.planned_at
         FROM pms_order_steps os
         JOIN orders o ON o.order_id = os.order_id AND o.is_deleted = 0
        WHERE os.status = 'pending'`);
    const late = running.filter(r => clock.daysLate(clock.istOf(r.planned_at), today) > 0).length;
    const untimed = running.filter(r => !r.planned_at).length;

    // Mine: named on the step, or failing that the step's role matches my own.
    const [[mine]] = await db.query(
      `SELECT COUNT(DISTINCT os.id) AS n
         FROM pms_order_steps os
         JOIN pms_steps s ON s.id = os.step_id
         JOIN orders o ON o.order_id = os.order_id AND o.is_deleted = 0
         LEFT JOIN pms_step_doers d ON d.step_id = os.step_id
         LEFT JOIN users u ON u.id = d.user_id
        WHERE os.status = 'pending'
          AND (u.email = ? OR (d.id IS NULL AND s.doer_role <> '' AND ? LIKE CONCAT('%', s.doer_role, '%')))`,
      [me.email, myRole]);

    // Through the last step this month. Counted off the final step actually
    // being done, not off a dispatch column, so it says what the board says.
    const [[finished]] = await db.query(
      `SELECT COUNT(*) AS n FROM pms_order_steps os
        WHERE os.status = 'done'
          AND os.step_order = (SELECT MAX(step_order) FROM pms_steps WHERE is_active = 1)
          AND YEAR(os.actual_at) = YEAR(NOW()) AND MONTH(os.actual_at) = MONTH(NOW())`);

    // What the office promised, for the orders still running. dispatch_days
    // runs from the approval, the same as the production board reads it.
    const [due] = await db.query(
      `SELECT DISTINCT o.order_id, o.client_name, o.dealer_name, o.order_type,
              o.dispatch_days, o.actual_2, o.timestamp,
              cur.step_order, cur.step_name
         FROM orders o
         JOIN pms_order_steps cur
           ON cur.order_id = o.order_id AND cur.status = 'pending'
        WHERE o.is_deleted = 0 AND o.dispatch_days IS NOT NULL
        ORDER BY o.timestamp`);

    const upcoming = due.map(r => {
      const from = clock.istOf(r.actual_2) || clock.istOf(r.timestamp);
      const day = clock.dayOf(from);
      if (!day) return null;
      const dueDay = clock.dayOf(clock.addWorkingDays(
        { ...clock.parts(day + ' 10:00:00') }, Number(r.dispatch_days)));
      return {
        order_id: r.order_id, client_name: r.client_name, dealer_name: r.dealer_name,
        order_type: r.order_type, step_order: r.step_order, step_name: r.step_name,
        due: dueDay, late: clock.daysLate(dueDay + ' 23:59:59', today),
      };
    }).filter(Boolean).sort((a, b) => (a.due < b.due ? -1 : 1)).slice(0, 8);

    const [recent] = await db.query(
      `SELECT o.order_id, o.client_name, o.dealer_name, o.timestamp,
              cur.step_order, cur.step_name
         FROM orders o
         LEFT JOIN pms_order_steps cur
           ON cur.order_id = o.order_id AND cur.status = 'pending'
        WHERE o.is_deleted = 0
          AND EXISTS (SELECT 1 FROM pms_order_steps x WHERE x.order_id = o.order_id)
        ORDER BY o.timestamp DESC LIMIT 8`);

    res.json({
      success: true,
      counts: {
        running: running.length, late, untimed,
        mine: mine.n, finishedThisMonth: finished.n,
      },
      pipeline: pipe.map(p => ({
        id: p.id, step_order: p.step_order, name: p.name,
        tat_days: p.tat_days === null ? null : Number(p.tat_days),
        pending: Number(p.pending || 0), late: Number(p.late || 0),
      })),
      upcoming,
      recent: recent.map(r => clock.withIst(r, ['timestamp'])),
    });
  } catch (err) {
    console.error('[pms] dashboard:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the dashboard.' });
  }
});

router.get('/board', requireLogin, async (req, res) => {
  try {
    const today = clock.nowIst();
    // A LEFT JOIN, so an order whose steps are all done still comes back - it
    // has no pending step, and an inner join would quietly drop it, leaving
    // the Completed tab permanently empty.
    const [rows] = await db.query(
      `SELECT o.order_id, o.dealer_name, o.client_name, o.order_type,
              o.timestamp, o.india_designer, o.overseas_designer,
              o.dispatch_days, o.actual_2,
              cur.step_order, cur.step_name, cur.planned_at, cur.opened_at,
              cur.id AS order_step_id, cur.step_id,
              s.doer_role,
              (SELECT COUNT(*) FROM pms_step_doers d WHERE d.step_id = cur.step_id) AS named,
              (SELECT COUNT(*) FROM pms_order_steps x
                WHERE x.order_id = o.order_id AND x.status = 'done') AS done_count,
              (SELECT COUNT(*) FROM pms_order_steps x
                WHERE x.order_id = o.order_id AND x.status <> 'skipped') AS total_count
         FROM orders o
         LEFT JOIN pms_order_steps cur
           ON cur.order_id = o.order_id AND cur.status = 'pending'
         LEFT JOIN pms_steps s ON s.id = cur.step_id
        WHERE o.is_deleted = 0
          AND EXISTS (SELECT 1 FROM pms_order_steps x WHERE x.order_id = o.order_id)
        ORDER BY cur.planned_at IS NULL, cur.planned_at, o.timestamp`);

    const orders = rows.map(r => {
      const row = clock.withIst(r, ['timestamp', 'planned_at', 'opened_at']);
      const running = !!r.step_order;
      const late = running ? clock.daysLate(row.planned_at, today) : 0;
      return {
        ...row,
        designer: r.india_designer || r.overseas_designer || '',
        running,
        late,
        untimed: running && !row.planned_at,
        progress: r.total_count ? Math.round(r.done_count / r.total_count * 100) : 0,
      };
    });

    res.json({
      success: true,
      orders,
      counts: {
        running: orders.filter(o => o.running).length,
        late: orders.filter(o => o.late > 0).length,
        untimed: orders.filter(o => o.untimed).length,
        done: orders.filter(o => !o.running).length,
        all: orders.length,
      },
    });
  } catch (err) {
    console.error('[pms] board:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the board.' });
  }
});

/** One order, every step, in order — done, skipped and still to come. */
router.get('/order/:orderId', requireLogin, async (req, res) => {
  try {
    const today = clock.nowIst();
    const [rows] = await db.query(
      `SELECT os.id, os.step_id, os.step_order, os.step_name, os.status,
              os.planned_at, os.opened_at, os.actual_at,
              os.doer_email, os.doer_name, os.remark, os.delay_reason,
              s.condition_key, s.doer_role, s.tat_days
         FROM pms_order_steps os
         JOIN pms_steps s ON s.id = os.step_id
        WHERE os.order_id = ?
        ORDER BY os.step_order, os.id`, [req.params.orderId]);

    if (!rows.length) {
      // Not an error: orders punched before the PMS started have no steps,
      // and saying so plainly is what lets the screen offer to give them some.
      return res.json({ success: true, steps: [], started: false });
    }
    res.json({ success: true, started: true, steps: rows.map(r => stepRow(r, today)) });
  } catch (err) {
    console.error('[pms] order:', err.message);
    res.status(500).json({ success: false, error: 'Could not load the order.' });
  }
});

/** What is waiting on me, oldest due first. */
router.get('/my-tasks', requireLogin, async (req, res) => {
  try {
    const today = clock.nowIst();
    const me = who(req.session.user);
    const [rows] = await db.query(
      `SELECT os.id, os.order_id, os.step_id, os.step_order, os.step_name,
              os.status, os.planned_at, os.opened_at,
              o.dealer_name, o.client_name, o.order_type,
              s.doer_role
         FROM pms_order_steps os
         JOIN pms_steps s ON s.id = os.step_id
         JOIN orders o ON o.order_id = os.order_id AND o.is_deleted = 0
         LEFT JOIN pms_step_doers d ON d.step_id = os.step_id
         LEFT JOIN users u ON u.id = d.user_id
        WHERE os.status = 'pending'
          AND (u.email = ? OR (d.id IS NULL AND s.doer_role <> '' AND ? LIKE CONCAT('%', s.doer_role, '%')))
        GROUP BY os.id
        ORDER BY os.planned_at IS NULL, os.planned_at`,
      [me.email, (req.session.user && req.session.user.role) || '']);
    res.json({ success: true, tasks: rows.map(r => stepRow(r, today)) });
  } catch (err) {
    console.error('[pms] my-tasks:', err.message);
    res.status(500).json({ success: false, error: 'Could not load your tasks.' });
  }
});

// ── WRITERS ──

/** Mark a step done. The engine opens whatever comes next. */
router.post('/order/:orderId/step/:stepId/done', requireLogin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const stepId = Number(req.params.stepId);
    if (!Number.isInteger(stepId) || stepId < 1) {
      return res.status(400).json({ success: false, error: 'Bad step.' });
    }

    const [[row]] = await db.query(
      `SELECT status, planned_at FROM pms_order_steps
        WHERE order_id = ? AND step_id = ? LIMIT 1`, [orderId, stepId]);
    if (!row) return res.status(404).json({ success: false, error: 'No such step on this order.' });
    if (row.status === 'done') return res.json({ success: true, already: true });
    if (row.status !== 'pending') {
      return res.status(409).json({ success: false, error: 'That step is not open yet.' });
    }

    // Past its date: ask why before accepting it. The reason is the only
    // record of what actually held the job up, and asked for later it is
    // guessed at rather than remembered.
    const planned = clock.istOf(row.planned_at);
    const late = clock.daysLate(planned, clock.nowIst());
    const reason = String((req.body && req.body.delayReason) || '').trim();
    if (late > 0 && !reason) {
      return res.status(400).json({
        success: false, needsReason: true, late,
        error: 'This step is ' + late + ' day(s) past its date. Please say why.',
      });
    }

    const out = await engine.markDone(orderId, stepId, who(req.session.user), {
      remark: String((req.body && req.body.remark) || '').trim(),
      delayReason: reason,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('[pms] done:', err.message);
    res.status(500).json({ success: false, error: 'Could not save that.' });
  }
});

/**
 * Give an order its steps.
 *
 * New orders get them on the punch. This is for putting an order that is
 * already running onto the board by hand — the rollout, one order at a time,
 * rather than nine thousand at once.
 */
router.post('/order/:orderId/start', requireLogin, async (req, res) => {
  try {
    if (!isAdmin(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const order = await engine.loadOrder(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, error: 'No such order.' });

    const made = await engine.createSteps(req.params.orderId);
    res.json({ success: true, created: made });
  } catch (err) {
    console.error('[pms] start:', err.message);
    res.status(500).json({ success: false, error: 'Could not start that order.' });
  }
});

module.exports = router;
