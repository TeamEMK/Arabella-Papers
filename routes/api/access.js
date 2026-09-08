const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireRole } = require('../../middleware/auth');
const { SECTIONS, MANAGEABLE_IDS, defaultSectionIds } = require('../../utils/nav');
const { loadOverrides } = require('../../utils/access');

const onlySuperAdmin = requireRole('SuperAdmin');

// What a person ends up with: their role's sections, with the grants laid over.
function resolve(byRole, overrides) {
  const allowed = new Set(byRole);
  for (const [section, on] of overrides) {
    if (!MANAGEABLE_IDS.includes(section)) continue;
    if (on) allowed.add(section);
    else allowed.delete(section);
  }
  return [...allowed];
}

// GET /api/access — the people to choose from, and the sections on offer
router.get('/', onlySuperAdmin, async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT id, emp_id, username, email, role, domain
       FROM users ORDER BY username`,
    );
    // Which people have been given or denied something, so the picker can mark
    // them without a query per person.
    const [touched] = await db.query(
      'SELECT DISTINCT user_id FROM user_sections',
    );
    res.json({
      success: true,
      users,
      customised: touched.map(r => r.user_id),
      sections: SECTIONS.map(s => ({ id: s.id, name: s.name, icon: s.icon, locked: !!s.locked })),
      currentUserId: req.session.user.id,
    });
  } catch (err) {
    console.error('Access list failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// GET /api/access/:id — what this person opens, and where each section comes from
router.get('/:id', onlySuperAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await db.query(
      'SELECT id, emp_id, username, email, role, domain FROM users WHERE id = ?',
      [id],
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found.' });

    const user = rows[0];
    const byRole = defaultSectionIds(user.role, user.domain);
    const overrides = await loadOverrides(id);

    res.json({
      success: true,
      user,
      byRole,
      effective: resolve(byRole, overrides),
      overrides: Object.fromEntries([...overrides].filter(([s]) => MANAGEABLE_IDS.includes(s))),
      isSelf: id === req.session.user.id,
    });
  } catch (err) {
    console.error('Access read failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// PUT /api/access/:id — body { sections: [ids] }, the complete list this person should have
router.put('/:id', onlySuperAdmin, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    const wanted = req.body && req.body.sections;
    if (!Array.isArray(wanted)) {
      return res.status(400).json({ success: false, error: 'Send the list of sections.' });
    }

    // Taking away your own access to this page cannot be undone from inside
    // the app — the only screen that could put it back would be the one you
    // just shut yourself out of.
    if (id === req.session.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot change your own access.' });
    }

    const [rows] = await conn.query('SELECT role, domain FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'User not found.' });

    const chosen = new Set(wanted.filter(s => MANAGEABLE_IDS.includes(s)));
    const byRole = new Set(defaultSectionIds(rows[0].role, rows[0].domain));

    // Only the differences are written down. A section that matches the role
    // again has its row deleted rather than stored, so changing the role later
    // still carries through instead of being pinned by a leftover row.
    const writes = MANAGEABLE_IDS
      .filter(s => chosen.has(s) !== byRole.has(s))
      .map(s => [id, s, chosen.has(s) ? 1 : 0, req.session.user.email]);

    // Clearing then inserting is two statements; a failure between them would
    // silently drop somebody back to their role, so they go in one transaction.
    await conn.beginTransaction();
    await conn.query('DELETE FROM user_sections WHERE user_id = ?', [id]);
    if (writes.length) {
      await conn.query(
        'INSERT INTO user_sections (user_id, section, allowed, updated_by) VALUES ?',
        [writes],
      );
    }
    await conn.commit();

    // The side panel is built at page load from the session, so the change
    // shows for them on their next page load, not mid-session.
    res.json({ success: true, changes: writes.length });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('Access save failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  } finally {
    conn.release();
  }
});

module.exports = router;
