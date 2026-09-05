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
    // Same board, the orders from before the August cutoff. Whoever works the
    // queue is who needs to look one of them up, so it goes right below it.
    menu.push({ id: 'oldProduction', name: 'Backup Production', icon: 'fa-box-archive' });
  }

  if (roleStr === 'SuperAdmin' || roleStr === 'Accounts') {
    menu.push({ id: 'dispatchBD', name: 'Dispatch Dashboard', icon: 'fa-truck-fast' });
    // The same board, for parcels sent before the cutoff. Whoever works the
    // queue is who needs to look one up, so it sits right below it.
    menu.push({ id: 'oldDispatch', name: 'Backup Dispatch', icon: 'fa-box-archive' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head') {
    menu.push({ id: 'o2dsummary', name: 'Analytics', icon: 'fa-chart-line' });
  }

  // Bulk Upload has no tab of its own: it is reached from the Bulk Upload
  // button inside the Add Dealer, Add Designer and New Order modals, where
  // someone with a list to import actually is. The view itself is still
  // permission-checked in routes/views.js.

  // What paper is in stock is asked by everyone who takes an order, so the
  // tab is open to all.
  menu.push({ id: 'stock', name: 'Stock', icon: 'fa-layer-group' });

  // Everybody takes leave, so everybody gets the tab. What differs is what is
  // on it: your own requests, plus everyone's if you are the one deciding.
  menu.push({ id: 'leave', name: 'Leave', icon: 'fa-calendar-check' });

  // Staff records carry mobiles, emergency contacts and document status, so
  // the tab is not offered to anyone who has no business opening it.
  if (roleStr === 'SuperAdmin' || roleStr.includes('HR')) {
    menu.push({ id: 'hr', name: 'HR', icon: 'fa-id-card' });
  }

  if (roleStr === 'SuperAdmin' || domain === 'Head') {
    menu.push({ id: 'logs', name: 'Logs', icon: 'fa-clock-rotate-left' });
  }

  if (roleStr === 'SuperAdmin') {
    menu.push({ id: 'users', name: 'Users', icon: 'fa-users' });
  }

  return menu;
}

module.exports = { getNavMenu };
