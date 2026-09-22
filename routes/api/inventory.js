const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');

// ── WHO MAY DO WHAT ───────────────────────────────────
// Two levels, not one. Seeing the tab is everyone's — what you are holding is
// yours to look at, and saying "I am giving this back" is yours to say. Handing
// kit out, confirming it is physically back, and taking it off the register are
// the custodian's, because they are statements about company property rather
// than about your own desk.
//
// The custodian here is a SuperAdmin or a Head, which is the same pair the FMS
// Admin, Analytics and Logs tabs already answer to. Leave is decided by a
// SuperAdmin alone; equipment is not, because a Head hands out laptops.
function isCustodian(user) {
  return !!user && (user.role === 'SuperAdmin' || user.domain === 'Head');
}

// The read side of the same page. Every role opens Inventory by default, so
// this refuses nobody today — it is here so that setting Inventory to No
// Access on the Access Control page closes the API too, not just the tab.
function canSeeInventory(user) {
  return canSee(user, 'inventory');
}

const TYPES = ['laptop', 'keyboard', 'mouse', 'mobile', 'sim', 'charger', 'other'];
const CONDITIONS = ['new', 'good', 'fair', 'poor'];

// Why an assignment ended, and where that leaves the item. One source of truth
// for both the reasons on offer and the status each one implies — the view
// carries the same three, so keep them in step.
const RETURN_REASONS = Object.freeze({
  offboarding: { label: 'Offboarding', itemStatus: 'available' },
  damaged: { label: 'Damaged', itemStatus: 'damaged' },
  retired: { label: 'Retired', itemStatus: 'retired' },
});

// Own-property check rather than a bare lookup: the reason comes off the wire,
// and `RETURN_REASONS['constructor']` would otherwise pass and then blow up
// with an undefined itemStatus.
const returnReason = r =>
  (typeof r === 'string' && Object.prototype.hasOwnProperty.call(RETURN_REASONS, r))
    ? RETURN_REASONS[r]
    : null;

// Retiring an item is a judgement about the asset's life, so it stays with the
// custodian. Somebody handing kit back can only say why they are handing it
// back, not that it is finished.
const HOLDER_REASONS = new Set(['offboarding', 'damaged']);

// The browser shrinks a photo to about 1000px before sending it, which lands
// well under this. The cap is here for what the browser did not send: a
// hand-rolled request that would otherwise put megabytes on the row.
const MAX_PHOTO_CHARS = 1.5 * 1024 * 1024;

function cleanPhoto(photo) {
  if (photo === undefined || photo === null || photo === '') return { value: null };
  if (typeof photo !== 'string' || !/^data:image\/[a-z+]+;base64,/i.test(photo)) {
    return { error: 'That photo could not be read.' };
  }
  if (photo.length > MAX_PHOTO_CHARS) return { error: 'That photo is too large.' };
  return { value: photo };
}

// What the form sends, checked the same way whether the item is going into the
// shared pool or straight onto the adder's own desk.
function cleanItem(body) {
  const type = String(body.type || '').trim();
  if (!TYPES.includes(type)) return { error: 'Choose a valid type.' };

  // Brand and model are what tell two items of the same type apart on the
  // card, since there is no free-text name field.
  const brand = String(body.brand || '').trim();
  const model = String(body.model || '').trim();
  if (!brand) return { error: 'Brand is required.' };
  if (!model) return { error: 'Model is required.' };

  const name = String(body.name || '').trim();
  if (!name) return { error: 'Name is required.' };

  const photo = cleanPhoto(body.photo);
  if (photo.error) return { error: photo.error };

  const condition = String(body.item_condition || 'good').trim();

  return {
    row: {
      name,
      type,
      brand,
      model,
      serial_number: String(body.serial_number || '').trim(),
      photo: photo.value,
      item_condition: CONDITIONS.includes(condition) ? condition : 'good',
      notes: String(body.notes || '').trim(),
    },
  };
}

// An item, with whoever is holding it now. The join is deliberately on the two
// open states only: a returned assignment is history, and pulling it in here
// would show a laptop as still being with the person who gave it back.
const SELECT_ITEMS = `
  SELECT i.*,
         u.id AS assigned_to_id, u.username AS assigned_to_name, u.role AS assigned_to_role,
         a.id AS assignment_id, a.assigned_at, a.handover_status, a.return_reason, a.handover_notes,
         cu.username AS created_by_name
    FROM inventory_items i
    LEFT JOIN inventory_assignments a
      ON a.item_id = i.id AND a.handover_status IN ('active', 'pending_handover')
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN users cu ON cu.id = i.created_by
`;

// GET /api/inventory — the register. A custodian gets everything; everybody
// else gets what is on their own desk, and nothing they could not already see.
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (!(await canSeeInventory(user))) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const manage = isCustodian(user);
    const [rows] = manage
      ? await db.query(`${SELECT_ITEMS} WHERE i.is_deleted = 0 ORDER BY i.created_at DESC`)
      : await db.query(
        `${SELECT_ITEMS} WHERE i.is_deleted = 0 AND a.user_id = ? ORDER BY i.created_at DESC`,
        [user.id],
      );

    res.json({ success: true, data: rows, canManage: manage, userId: user.id });
  } catch (err) {
    console.error('Inventory list failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/inventory/assignments — every spell of somebody holding something,
// including the ones already closed. This is the history view, so it is the
// custodian's alone.
router.get('/assignments', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const [rows] = await db.query(`
      SELECT a.*, i.name AS item_name, i.type AS item_type, i.brand, i.model,
             i.serial_number, i.photo,
             u.username AS user_name, u.role AS user_role,
             ab.username AS assigned_by_name
        FROM inventory_assignments a
        JOIN inventory_items i ON i.id = a.item_id
        JOIN users u ON u.id = a.user_id
        LEFT JOIN users ab ON ab.id = a.assigned_by
       WHERE i.is_deleted = 0
       ORDER BY a.assigned_at DESC
       LIMIT 500`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Inventory assignments failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/inventory/people — who an item can be handed to. Its own endpoint
// rather than /api/users, which is SuperAdmin-only and sends far more of the
// account than a name picker needs.
router.get('/people', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const [rows] = await db.query(
      'SELECT id, username, role, emp_id FROM users ORDER BY username',
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Inventory people failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/inventory — add to the shared pool, unassigned.
router.post('/', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin or Head can add to the register.' });
    }
    const { row, error } = cleanItem(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const [r] = await db.query(
      `INSERT INTO inventory_items
         (name, type, brand, model, serial_number, photo, item_condition, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.name, row.type, row.brand, row.model, row.serial_number, row.photo,
        row.item_condition, row.notes, req.session.user.id],
    );
    res.json({ success: true, id: r.insertId });
  } catch (err) {
    console.error('Inventory create failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/inventory/self-add — kit somebody already has, put on the register
// by the person holding it. No approval step: the register being right matters
// more than it being filed by the right hand, and the item lands assigned to
// them, which is what it already is in real life.
router.post('/self-add', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (!(await canSeeInventory(user))) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const { row, error } = cleanItem(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const [r] = await db.query(
      `INSERT INTO inventory_items
         (name, type, brand, model, serial_number, photo, item_condition, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?)`,
      [row.name, row.type, row.brand, row.model, row.serial_number, row.photo,
        row.item_condition, row.notes, user.id],
    );
    await db.query(
      'INSERT INTO inventory_assignments (item_id, user_id, assigned_by) VALUES (?, ?, ?)',
      [r.insertId, user.id, user.id],
    );
    res.json({ success: true, id: r.insertId });
  } catch (err) {
    console.error('Inventory self-add failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/inventory/assign — hand an item to somebody.
router.post('/assign', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin or Head can assign equipment.' });
    }
    const itemId = Number(req.body.item_id);
    const userId = Number(req.body.user_id);
    if (!itemId || !userId) {
      return res.status(400).json({ success: false, error: 'Pick an item and a person.' });
    }

    const [[item]] = await db.query(
      'SELECT status FROM inventory_items WHERE id = ? AND is_deleted = 0', [itemId],
    );
    if (!item) return res.status(404).json({ success: false, error: 'Item not found.' });
    // Only available stock goes out. 'damaged' and 'retired' are out of
    // circulation on purpose, and 'assigned' is already with somebody.
    if (item.status !== 'available') {
      return res.status(400).json({ success: false, error: `This item is ${item.status} — it cannot be handed out.` });
    }

    const [[person]] = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (!person) return res.status(404).json({ success: false, error: 'That person no longer has an account.' });

    await db.query(
      'INSERT INTO inventory_assignments (item_id, user_id, assigned_by) VALUES (?, ?, ?)',
      [itemId, userId, req.session.user.id],
    );
    await db.query("UPDATE inventory_items SET status = 'assigned' WHERE id = ?", [itemId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Inventory assign failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/inventory/handover/:id — step one: say it is coming back.
//
// Two ways in, one endpoint: a custodian starting the handover because someone
// is leaving, or the holder themselves saying "I am giving this back". Either
// way this only raises the intent — the item stays listed as theirs until the
// custodian confirms receipt through /return below.
router.post('/handover/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (!(await canSeeInventory(user))) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    const reason = String(req.body.reason || '');
    if (!returnReason(reason)) {
      return res.status(400).json({ success: false, error: 'Pick a reason.' });
    }

    const [[a]] = await db.query('SELECT * FROM inventory_assignments WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, error: 'Assignment not found.' });

    const custodian = isCustodian(user);
    if (!custodian && a.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'You can only return equipment assigned to you.' });
    }
    if (!custodian && !HOLDER_REASONS.has(reason)) {
      return res.status(403).json({ success: false, error: 'Only a custodian can retire an item.' });
    }
    if (a.handover_status !== 'active') {
      return res.status(400).json({ success: false, error: 'This one is already on its way back.' });
    }

    await db.query(
      `UPDATE inventory_assignments
          SET handover_status = 'pending_handover', handover_notes = ?, return_reason = ?
        WHERE id = ?`,
      [String(req.body.notes || '').trim(), reason, req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Inventory handover failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/inventory/return/:id — step two: the custodian has it in hand.
//
// The reason picked here is the final word — it may correct whatever the
// holder claimed at step one — and it decides where the item lands: damaged
// and retired take it out of circulation, offboarding puts it back in stock.
router.post('/return/:id', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin or Head can confirm a return.' });
    }
    const mapped = returnReason(String(req.body.reason || ''));
    if (!mapped) return res.status(400).json({ success: false, error: 'Pick a reason.' });

    const [[a]] = await db.query('SELECT * FROM inventory_assignments WHERE id = ?', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, error: 'Assignment not found.' });
    if (a.handover_status === 'returned') {
      return res.status(400).json({ success: false, error: 'This one is already back.' });
    }

    await db.query(
      `UPDATE inventory_assignments
          SET handover_status = 'returned', returned_at = NOW(), return_reason = ?
        WHERE id = ?`,
      [String(req.body.reason), req.params.id],
    );
    await db.query('UPDATE inventory_items SET status = ? WHERE id = ?', [mapped.itemStatus, a.item_id]);
    res.json({ success: true, itemStatus: mapped.itemStatus });
  } catch (err) {
    console.error('Inventory return failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/inventory/:id — correct an item's details. Whatever is not in the
// body is left alone, so a single field can be sent from the row itself.
router.put('/:id', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin or Head can edit the register.' });
    }

    const row = {};
    for (const f of ['name', 'brand', 'model', 'serial_number', 'notes']) {
      if (req.body[f] !== undefined) row[f] = String(req.body[f]).trim();
    }
    if (req.body.type !== undefined) {
      if (!TYPES.includes(String(req.body.type))) {
        return res.status(400).json({ success: false, error: 'Choose a valid type.' });
      }
      row.type = String(req.body.type);
    }
    if (req.body.item_condition !== undefined) {
      if (!CONDITIONS.includes(String(req.body.item_condition))) {
        return res.status(400).json({ success: false, error: 'Choose a valid condition.' });
      }
      row.item_condition = String(req.body.item_condition);
    }
    if (req.body.photo !== undefined) {
      const photo = cleanPhoto(req.body.photo);
      if (photo.error) return res.status(400).json({ success: false, error: photo.error });
      row.photo = photo.value;
    }
    // status is deliberately not editable here. Where an item stands is the
    // result of assigning it and taking it back — letting the edit form set it
    // by hand would leave an item marked available while somebody is still
    // holding it.

    const cols = Object.keys(row);
    if (!cols.length) return res.json({ success: true });

    await db.query(
      `UPDATE inventory_items SET ${cols.map(c => '`' + c + '` = ?').join(', ')}
        WHERE id = ? AND is_deleted = 0`,
      [...cols.map(c => row[c]), req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Inventory update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/inventory/:id — off the register, not erased. An item that has
// been in somebody's hands is a thing the office asks about a year later, and
// its assignment history hangs off this row.
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    if (!isCustodian(req.session.user)) {
      return res.status(403).json({ success: false, error: 'Only a SuperAdmin or Head can remove an item.' });
    }
    const [[item]] = await db.query(
      'SELECT status FROM inventory_items WHERE id = ? AND is_deleted = 0', [req.params.id],
    );
    if (!item) return res.status(404).json({ success: false, error: 'Item not found.' });
    // Taking an item off the register while somebody is holding it would lose
    // the only record that they have it.
    if (item.status === 'assigned') {
      return res.status(400).json({ success: false, error: 'Somebody is holding this. Take it back first.' });
    }
    await db.query('UPDATE inventory_items SET is_deleted = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Inventory delete failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
