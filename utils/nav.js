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

  if (roleStr === 'SuperAdmin') {
    menu.push({ id: 'users', name: 'Users' });
  }

  return menu;
}

module.exports = { getNavMenu };
