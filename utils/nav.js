/**
 * Every section of the app, in the order the side panel lists them.
 *
 * `rule` is what a role opens on its own — the same conditions that have been
 * in this file since the app went in, moved into one list so the side panel,
 * the view routes and the Access Control page all read from a single place
 * instead of three copies drifting apart.
 *
 * A rule is only the starting point. utils/access.js lays the per-person
 * grants from the Access Control page over the top; somebody with no grants
 * resolves to exactly their rule, which is what everyone gets today.
 *
 * `group` is the heading the side panel files it under. Fourteen tabs in one
 * flat column read as a wall; the headings are what turn it back into a list
 * of a few things. A heading with nothing under it is never drawn, so somebody
 * who opens four tabs sees no headings they cannot use.
 *
 * `icon` is a Font Awesome 6 class. The side panel shows icons alone when it is
 * collapsed, so every item needs one — keep it here with the item rather than
 * in the template, so adding a tab is a one-line change.
 *
 * `locked` sections are not on offer from the Access Control page. Their APIs
 * sit behind requireRole('SuperAdmin'), so handing the tab to anybody else
 * would open a page whose every button answers 403.
 */
const SECTIONS = [
  {
    id: 'dashboard', group: 'Orders', name: 'Orders Dashboard', icon: 'fa-clipboard-list',
    rule: (role, domain) => role === 'SuperAdmin' || domain === 'Head' || role.includes('Designer'),
  },
  {
    id: 'tillApproval', group: 'Orders', name: 'Till Approval', icon: 'fa-circle-check',
    rule: (role, domain) => role === 'SuperAdmin' || domain === 'Head' || role.includes('TillApprover'),
  },
  // Changes the client asks for by email after the design is done. Open to
  // everyone: a designer's own corrections are the point of the page, and
  // raising one is guarded in the API rather than by hiding the tab.
  { id: 'corrections', group: 'Orders', name: 'Corrections', icon: 'fa-pen-ruler', rule: () => true },
  {
    id: 'productionBD', group: 'Production', name: 'Production Dashboard', icon: 'fa-industry',
    rule: (role) => role === 'SuperAdmin' || role.includes('Production Manager'),
  },
  // Same board, the orders from before the August cutoff. Whoever works the
  // queue is who needs to look one of them up, so it goes right below it.
  {
    id: 'oldProduction', group: 'Production', name: 'Backup Production', icon: 'fa-box-archive',
    rule: (role) => role === 'SuperAdmin' || role.includes('Production Manager'),
  },
  {
    id: 'dispatchBD', group: 'Dispatch', name: 'Dispatch Dashboard', icon: 'fa-truck-fast',
    rule: (role) => role === 'SuperAdmin' || role === 'Accounts',
  },
  // The same board, for parcels sent before the cutoff. Whoever works the
  // queue is who needs to look one up, so it sits right below it.
  {
    id: 'oldDispatch', group: 'Dispatch', name: 'Backup Dispatch', icon: 'fa-box-archive',
    rule: (role) => role === 'SuperAdmin' || role === 'Accounts',
  },
  // Work that lives in a Google Sheet — an enquiry or an order walked through
  // its steps. Two tabs, because they are two jobs: mapping a sheet is done
  // once by whoever sets the process up, and working a step is done every day
  // by everybody else. One page carrying both put a setup button in front of
  // people who will never press it.
  {
    id: 'fmsAdmin', group: 'FMS', name: 'FMS Admin', icon: 'fa-sitemap',
    rule: (role, domain) => role === 'SuperAdmin' || domain === 'Head',
  },
  // Open to everyone: being named on a step is what puts anything on this
  // page, and somebody on no step sees an empty tab rather than a locked door.
  { id: 'fms', group: 'FMS', name: 'FMS Task', icon: 'fa-diagram-project', rule: () => true },
  // What paper is in stock is asked by everyone who takes an order, so the
  // tab is open to all.
  { id: 'stock', group: 'Company', name: 'Stock', icon: 'fa-layer-group', rule: () => true },
  // Everybody takes leave, so everybody gets the tab. What differs is what is
  // on it: your own requests, plus everyone's if you are the one deciding.
  { id: 'leave', group: 'Company', name: 'Leave', icon: 'fa-calendar-check', rule: () => true },
  // Staff records carry mobiles, emergency contacts and document status, so
  // the tab is not offered to anyone who has no business opening it.
  {
    id: 'hr', group: 'Company', name: 'HR', icon: 'fa-id-card',
    rule: (role) => role === 'SuperAdmin' || role.includes('HR'),
  },
  {
    id: 'o2dsummary', group: 'Admin', name: 'Analytics', icon: 'fa-chart-line',
    rule: (role, domain) => role === 'SuperAdmin' || domain === 'Head',
  },
  {
    id: 'logs', group: 'Admin', name: 'Logs', icon: 'fa-clock-rotate-left',
    rule: (role, domain) => role === 'SuperAdmin' || domain === 'Head',
  },
  {
    id: 'users', group: 'Admin', name: 'Users', icon: 'fa-users',
    rule: (role) => role === 'SuperAdmin', locked: true,
  },
  {
    id: 'access', group: 'Admin', name: 'Access Control', icon: 'fa-user-shield',
    rule: (role) => role === 'SuperAdmin', locked: true,
  },
];

// Bulk Upload has no tab of its own: it is reached from the Bulk Upload
// button inside the Add Dealer, Add Designer and New Order modals, where
// someone with a list to import actually is. The view itself is still
// permission-checked in routes/views.js.

const SECTION_IDS = SECTIONS.map(s => s.id);
const MANAGEABLE_SECTIONS = SECTIONS.filter(s => !s.locked);
const MANAGEABLE_IDS = MANAGEABLE_SECTIONS.map(s => s.id);

/**
 * The sections a role opens by itself, before any per-person grant. Pure — no
 * database — so the Access Control page can show what somebody would have on
 * their role alone next to what they actually have.
 */
function defaultSectionIds(role, domain) {
  const roleStr = role ? role.toString().trim() : '';
  const dom = domain || '';
  return SECTIONS.filter(s => s.rule(roleStr, dom)).map(s => s.id);
}

module.exports = { SECTIONS, SECTION_IDS, MANAGEABLE_SECTIONS, MANAGEABLE_IDS, defaultSectionIds };
