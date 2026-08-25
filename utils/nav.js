/**
 * Returns allowed nav menu items based on role/domain
 * Same logic as GAS getNavMenu()
 *
 * `icon` is a Font Awesome 6 class. The side panel shows icons alone when it is
 * collapsed, so every item needs one — keep it here with the item rather than
 * in the template, so adding a tab is a one-line change.
 */
function getNavMenu(role, domain) {
  const roleStr = role ? role.toString().trim() : '';
  const menu = [];

  if (roleStr === 'SuperAdmin' || domain === 'Head' || roleStr.includes('Designer')) {
    menu.push({ id: 'dashboard', name: 'Orders Dashboard', icon: 'fa-clipboard-list' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head' || roleStr.includes('TillApprover')) {
    menu.push({ id: 'tillApproval', name: 'Till Approval', icon: 'fa-circle-check' });
  }

  if (roleStr === 'SuperAdmin' || roleStr.includes('Production Manager')) {
    menu.push({ id: 'productionBD', name: 'Production Dashboard', icon: 'fa-industry' });
  }

  if (roleStr === 'SuperAdmin' || roleStr === 'Accounts') {
    menu.push({ id: 'dispatchBD', name: 'Dispatch Dashboard', icon: 'fa-truck-fast' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head') {
    menu.push({ id: 'o2dsummary', name: 'Analytics', icon: 'fa-chart-line' });
  }

  // Bulk Upload has no tab of its own: it is reached from the Bulk Upload
  // button inside the Add Dealer, Add Designer and New Order modals, where
  // someone with a list to import actually is. The view itself is still
  // permission-checked in routes/views.js.

  if (roleStr === 'SuperAdmin' || domain === 'Head') {
    menu.push({ id: 'logs', name: 'Logs', icon: 'fa-clock-rotate-left' });
  }

  if (roleStr === 'SuperAdmin') {
    menu.push({ id: 'users', name: 'Users', icon: 'fa-users' });
  }

  return menu;
}

module.exports = { getNavMenu };
