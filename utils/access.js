const db = require('../config/db');
const { SECTIONS, MANAGEABLE_IDS, defaultSectionIds } = require('./nav');

/**
 * What each person may open.
 *
 * A role still decides on its own — see the rules in utils/nav.js. The
 * Access Control page writes down only the *differences* from that role, so
 * a person nobody has touched has no rows here at all and opens exactly the
 * sections their role has always opened. Nothing is granted by installing
 * this: the table starts empty and stays that way until somebody is given
 * something by hand.
 *
 * Storing the differences rather than a full list is what keeps a role change
 * meaningful afterwards. Snapshotting every section against the person would
 * freeze them: promote a designer later and the promotion would do nothing,
 * because a stale row would still be answering for every section.
 */
async function loadOverrides(userId) {
  if (!userId) return new Map();
  const [rows] = await db.query(
    'SELECT section, allowed FROM user_sections WHERE user_id = ?',
    [userId],
  );
  return new Map(rows.map(r => [r.section, !!r.allowed]));
}

/** Role rule + the grants laid over it, as a Set of section ids. */
async function sectionsFor(user) {
  const allowed = new Set(defaultSectionIds(user.role, user.domain));
  const overrides = await loadOverrides(user.id);
  for (const [section, on] of overrides) {
    // Users and Access Control are never handed out from this table, whatever
    // it happens to hold — their APIs answer 403 to anyone but a SuperAdmin,
    // so the tab would open onto a page that cannot do anything.
    if (!MANAGEABLE_IDS.includes(section)) continue;
    if (on) allowed.add(section);
    else allowed.delete(section);
  }
  return allowed;
}

/** The side panel, in section order. */
async function getNavMenu(user) {
  const allowed = await sectionsFor(user);
  return SECTIONS
    .filter(s => allowed.has(s.id))
    .map(s => ({ id: s.id, name: s.name, icon: s.icon }));
}

async function canSee(user, sectionId) {
  const allowed = await sectionsFor(user);
  return allowed.has(sectionId);
}

module.exports = { sectionsFor, getNavMenu, canSee, loadOverrides };
