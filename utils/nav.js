/**
 * Returns allowed nav menu items based on role/domain
 * Same logic as GAS getNavMenu()
 */
function getNavMenu(role, domain) {
  const roleStr = role ? role.toString().trim() : '';
  const menu = [];

  if (roleStr === 'SuperAdmin' || domain === 'Head' || roleStr.includes('Designer')) {
    menu.push({ id: 'dashboard', name: 'Orders Dashboard' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head' || roleStr.includes('TillApprover')) {
    menu.push({ id: 'tillApproval', name: 'Till Approval' });
  }

  if (roleStr === 'SuperAdmin' || roleStr.includes('Production Manager')) {
    menu.push({ id: 'productionBD', name: 'Production Dashboard' });
  }

  if (roleStr === 'SuperAdmin' || roleStr === 'Accounts') {
    menu.push({ id: 'dispatchBD', name: 'Dispatch Dashboard' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head') {
    menu.push({ id: 'o2dsummary', name: 'Analytics' });
  }

  // Bulk Upload has no tab of its own: it is reached from the Bulk Upload
  // button inside the Add Dealer, Add Designer and New Order modals, where
  // someone with a list to import actually is. The view itself is still
  // permission-checked in routes/views.js.

  if (roleStr === 'SuperAdmin') {
    menu.push({ id: 'users', name: 'Users' });
  }

  return menu;
}

module.exports = { getNavMenu };
