// ══════════════════════════════════════════════════════
// CORRECTIONS
// A client sends changes by email after the order has been designed. Whoever
// reads that mail raises a correction against the order; it lands on the
// designer the order already belongs to, who says what they changed — or why
// they have not.
//
// One row per correction, never per order. The same order comes back a second
// and a third time, and each round has its own date and its own account.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { logOrderEvent } = require('../../utils/auditlog');
// A number typed here names the job, and a job can have been made more than
// once. This turns it into the run that is on the floor now.
const { liveRunFor, rootOrderId } = require('../../utils/remake');

const IST = { timeZone: 'Asia/Kolkata', hour12: true };
const stamp = d => (d ? new Date(d).toLocaleString('en-GB', IST) : '');

// Who may raise one and see everybody's. Doing one needs only to be the
// designer it landed on.
function canRaise(user) {
  const role = (user && user.role) || '';
  return role === 'SuperAdmin' || role === 'Head' || (user && user.domain === 'Head');
}

const one = async (sql, params) => {
  const [rows] = await db.query(sql, params);
  return rows[0] || null;
};

function shape(r) {
  return {
    id: r.id,
    // The run this correction is against, which is what every action sends
    // back, and the number to print beside it. They differ only on a repeat.
    orderId: r.order_id,
    orderNo: rootOrderId(r.order_id),
    designer: r.designer,
    clientNote: r.client_note || '',
    raisedBy: r.raised_by || '',
    raisedAt: stamp(r.created_at),
    status: r.status,
    workNote: r.work_note || '',
    delayReason: r.delay_reason || '',
    closedAt: stamp(r.closed_at),
    // Carried along so the list can show whose order it is without a second
    // request per row.
    dealer: r.dealer_name || '',
    client: r.client_name || '',
  };
}

const SELECT = `
  SELECT c.*, o.dealer_name, o.client_name
    FROM corrections c
    LEFT JOIN orders o ON o.order_id = c.order_id
`;

// ── GNA designers ──
// The short list a correction can be handed to instead of the order's own
// designer. Registered before /order/:id and /:id so "gna" is never read as
// one of those.

// GET /api/corrections/gna — the list, for the dropdown.
router.get('/gna', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name FROM gna_designers ORDER BY name');
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GNA list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/corrections/gna — add a name to it.
router.post('/gna', requireLogin, async (req, res) => {
  try {
    if (!canRaise(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can change this list.' });
    }
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Pick a name.' });

    const existing = await one(
      'SELECT id FROM gna_designers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [name]);
    if (existing) return res.json({ success: true, id: existing.id, already: true });

    const [ins] = await db.query(
      'INSERT INTO gna_designers (name, added_by) VALUES (?, ?)',
      [name, req.session.user.username || req.session.user.email || '']);
    res.json({ success: true, id: ins.insertId });
  } catch (err) {
    console.error('GNA add failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/corrections/gna/:id — take one off the list. Corrections already
// sent to that person are untouched: they are still theirs to answer.
router.delete('/gna/:id', requireLogin, async (req, res) => {
  try {
    if (!canRaise(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can change this list.' });
    }
    await db.query('DELETE FROM gna_designers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('GNA delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/corrections/order/:id — who this order belongs to.
 *
 * The point of typing an order number is that the designer appears without
 * anybody having to remember it, so this is what the field calls as it is
 * filled in.
 */
router.get('/order/:id', requireLogin, async (req, res) => {
  try {
    if (!canRaise(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can raise a correction.' });
    }
    const order = await one(
      `SELECT order_id, dealer_name, client_name,
              india_designer, overseas_designer, design_status
         FROM orders WHERE order_id = ? AND is_deleted = 0 LIMIT 1`,
      [await liveRunFor(String(req.params.id).trim())]
    );
    if (!order) return res.status(404).json({ success: false, error: 'No order with that number.' });

    const designer = (order.india_designer || order.overseas_designer || '').trim();
    // How many rounds this order has already had, because raising a fourth
    // correction on the same order is worth noticing before you save it.
    const [[prior]] = await db.query(
      'SELECT COUNT(*) AS c FROM corrections WHERE order_id = ?', [order.order_id]);

    res.json({
      success: true,
      data: {
        orderId: order.order_id,
        orderNo: rootOrderId(order.order_id),
        designer,
        dealer: order.dealer_name || '',
        client: order.client_name || '',
        priorCorrections: prior.c,
      },
    });
  } catch (err) {
    console.error('Correction lookup failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * The order numbers out of whatever was pasted in.
 *
 * The office copies them from a mail, a sheet cell or a chat message, so they
 * arrive separated by commas, spaces, semicolons or line breaks - and often
 * several of those in one paste. Split on all of them and keep the order they
 * were typed in, so the list on screen reads the way the paste did.
 *
 * Repeats are dropped rather than refused: pasting the same number twice is a
 * slip, and raising two identical corrections would be the wrong answer to it.
 */
function parseOrderIds(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const piece of raw) {
    const id = String(piece || '').trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

// One correction is one order, but they are raised a batch at a time, and a
// cap keeps a stray paste from turning into a thousand rows nobody meant.
const MAX_AT_ONCE = 200;

/**
 * POST /api/corrections/lookup — what several order numbers turn out to be.
 *
 * A POST rather than a GET because the list can be long, and a hundred order
 * numbers in a query string is a request some proxy will quietly truncate.
 */
router.post('/lookup', requireLogin, async (req, res) => {
  try {
    if (!canRaise(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can raise a correction.' });
    }
    const typed = parseOrderIds(req.body.orderIds);
    if (!typed.length) return res.json({ success: true, data: [] });

    // Every run of a job carries the same number, so a number typed here means
    // the run being made now - not the one that shipped months ago. The
    // correction is about work in front of somebody, and that is the open run.
    const ids = [];
    for (const t of typed) ids.push(await liveRunFor(t));
    if (ids.length > MAX_AT_ONCE) {
      return res.json({ success: false, error: `That is ${ids.length} orders — ${MAX_AT_ONCE} at a time is the limit.` });
    }

    // Two queries for the whole list rather than two per order.
    const marks = ids.map(() => '?').join(', ');
    const [orders] = await db.query(
      `SELECT order_id, dealer_name, client_name, india_designer, overseas_designer
         FROM orders WHERE is_deleted = 0 AND order_id IN (${marks})`, ids);
    const [prior] = await db.query(
      `SELECT order_id, COUNT(*) AS c FROM corrections
        WHERE order_id IN (${marks}) GROUP BY order_id`, ids);

    const byId = new Map(orders.map(o => [String(o.order_id).toLowerCase(), o]));
    const priorBy = new Map(prior.map(p => [String(p.order_id).toLowerCase(), p.c]));

    res.json({
      success: true,
      data: ids.map((id, i) => {
        const o = byId.get(id.toLowerCase());
        if (!o) return { typed: typed[i], found: false };
        return {
          typed: typed[i],
          found: true,
          orderId: o.order_id,
          orderNo: rootOrderId(o.order_id),
          designer: (o.india_designer || o.overseas_designer || '').trim(),
          dealer: o.dealer_name || '',
          client: o.client_name || '',
          priorCorrections: priorBy.get(id.toLowerCase()) || 0,
        };
      }),
    });
  } catch (err) {
    console.error('Correction lookup failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/corrections?status=pending|done|delayed
 *
 * Whoever raises them sees every correction; everybody else sees the ones on
 * their own name. Same rule as the boards: the name has to match exactly, or
 * "Riya" collects everything belonging to "Kanu Priya".
 */
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const all = canRaise(user);

    const where = ['1=1'];
    const params = [];
    if (!all) {
      where.push("LOWER(TRIM(c.designer)) = LOWER(TRIM(?))");
      params.push(user.username || '');
    }
    if (['pending', 'done', 'delayed'].includes(req.query.status)) {
      where.push('c.status = ?');
      params.push(req.query.status);
    }

    const [rows] = await db.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT 1000`,
      params
    );

    // The three counts the buttons carry, on the same scope as the list.
    // DELAYED is a reserved word in MySQL, so the aliases are prefixed rather
    // than named after the states they count.
    const [[counts]] = await db.query(
      `SELECT
         SUM(status = 'pending') AS n_pending,
         SUM(status = 'done')    AS n_done,
         SUM(status = 'delayed') AS n_delayed
       FROM corrections c
       WHERE ${all ? '1=1' : 'LOWER(TRIM(c.designer)) = LOWER(TRIM(?))'}`,
      all ? [] : [user.username || '']
    );

    res.json({
      success: true,
      data: rows.map(shape),
      canRaise: all,
      counts: {
        pending: Number(counts.n_pending || 0),
        done: Number(counts.n_done || 0),
        delayed: Number(counts.n_delayed || 0),
      },
    });
  } catch (err) {
    console.error('Correction list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/corrections — raise one against an order.
router.post('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (!canRaise(user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can raise a correction.' });
    }
    // One order or a hundred: the same route, so the two cannot drift apart
    // over who a correction goes to or what gets written in the log.
    const typed = parseOrderIds(req.body.orderIds || req.body.orderId);
    if (!typed.length) return res.status(400).json({ success: false, error: 'Give the order number.' });
    // Onto the run being made now, the same as the lookup that listed them.
    // Idempotent, so it makes no difference whether the screen sent back the
    // number somebody typed or the one the lookup resolved it to.
    const ids = [];
    for (const t of typed) ids.push(await liveRunFor(t));
    if (ids.length > MAX_AT_ONCE) {
      return res.status(400).json({
        success: false,
        error: `That is ${ids.length} orders — ${MAX_AT_ONCE} at a time is the limit.`,
      });
    }

    const marks = ids.map(() => '?').join(', ');
    const [orders] = await db.query(
      `SELECT order_id, india_designer, overseas_designer
         FROM orders WHERE is_deleted = 0 AND order_id IN (${marks})`, ids);
    const byId = new Map(orders.map(o => [String(o.order_id).toLowerCase(), o]));

    // Whoever was picked, else the name on the order. A GNA correction goes to
    // one of the GNA designers however the order is credited - and the order's
    // own designer is sometimes somebody with no login, which is a correction
    // nobody would ever see.
    //
    // Copied rather than looked up later: reassigning the order next month must
    // not move a correction somebody has already answered.
    const chosen = String(req.body.designer || '').trim();
    const clientNote = String(req.body.clientNote || '').trim() || null;
    const raisedBy = user.username || user.email || '';

    // Each order is judged on its own. One bad number in a paste of fifty must
    // not throw away the other forty-nine, so the failures are reported back
    // rather than raised as an error for the whole batch.
    const results = [];
    for (const typed of ids) {
      const order = byId.get(typed.toLowerCase());
      if (!order) { results.push({ typed, ok: false, error: 'No order with that number.' }); continue; }

      const designer = chosen
        || String(order.india_designer || order.overseas_designer || '').trim();
      if (!designer) {
        results.push({ typed, ok: false, error: 'No designer on this order — pick who it is for.' });
        continue;
      }

      try {
        await db.query(
          `INSERT INTO corrections (order_id, designer, client_note, raised_by)
           VALUES (?, ?, ?, ?)`,
          [order.order_id, designer, clientNote, raisedBy],
        );
        await logOrderEvent(order.order_id, 'Correction raised', 'for ' + designer, user);
        results.push({
          typed, ok: true, orderId: order.order_id,
          orderNo: rootOrderId(order.order_id), designer,
        });
      } catch (e) {
        console.error(`[corrections] ${order.order_id}:`, e.message);
        results.push({ typed, ok: false, error: 'Could not save this one.' });
      }
    }

    const created = results.filter(r => r.ok).length;
    // Nothing saved at all is a failure worth showing as one; anything else is
    // a partial success the caller can read off the results.
    res.json({ success: created > 0, created, results,
      error: created ? undefined : (results[0] && results[0].error) || 'Nothing was saved.' });
  } catch (err) {
    console.error('Correction create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/corrections/:id — the designer answers.
 *
 * Two ways out and no third: say what was corrected, or say why it has not
 * been. Which one was filled in is what sets the status, so the two can never
 * disagree.
 */
router.put('/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const row = await one('SELECT * FROM corrections WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, error: 'Correction not found.' });

    const mine = String(row.designer || '').trim().toLowerCase()
      === String(user.username || '').trim().toLowerCase();
    if (!mine && !canRaise(user)) {
      return res.status(403).json({ success: false, error: 'This correction is not yours.' });
    }

    const workNote = String(req.body.workNote || '').trim();
    const delayReason = String(req.body.delayReason || '').trim();
    if (!workNote && !delayReason) {
      return res.status(400).json({
        success: false,
        error: 'Say what you corrected, or why it has not been done yet.',
      });
    }

    // One or the other, never both. The status is derived from which was
    // filled in, so keeping the other would leave a row saying it was done and
    // giving a reason it was not - which is what a row did say before this.
    // The screen stops it happening; this stops a stale page doing it anyway.
    const status = workNote ? 'done' : 'delayed';
    await db.query(
      `UPDATE corrections
          SET work_note = ?, delay_reason = ?, status = ?, closed_at = NOW()
        WHERE id = ?`,
      [status === 'done' ? workNote : null,
       status === 'delayed' ? delayReason : null,
       status, row.id]
    );
    await logOrderEvent(row.order_id,
      status === 'done' ? 'Correction done' : 'Correction delayed',
      (workNote || delayReason).slice(0, 400), user);

    res.json({ success: true, status });
  } catch (err) {
    console.error('Correction update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/corrections/:id — raised against the wrong order.
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    if (!canRaise(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin can remove a correction.' });
    }
    const row = await one('SELECT order_id FROM corrections WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, error: 'Correction not found.' });
    await db.query('DELETE FROM corrections WHERE id = ?', [req.params.id]);
    await logOrderEvent(row.order_id, 'Correction removed', '', req.session.user);
    res.json({ success: true });
  } catch (err) {
    console.error('Correction delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
