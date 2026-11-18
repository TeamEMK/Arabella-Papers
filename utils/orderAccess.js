// ══════════════════════════════════════════════════════
// WHOSE ORDER IS THIS, AND MAY YOU TOUCH IT
//
// The Orders Dashboard has always been careful: a designer's list holds the
// orders assigned to them by name and the ones they punched, and the View
// box asks the same question so it cannot hand over one the list hid.
//
// Every OTHER route that takes an order id in its address asked nothing. An
// order id is K-1024 and the next one is K-1025, so changing the number in
// the address was the whole attack. Measured on a throwaway copy, signed in
// as one designer with no board access at all:
//
//   GET  /api/dashboards/order-details/K-B-1   200 - the whole order, every
//        column, including another designer's client and remarks
//   PUT  /api/orders/K-B-1/status              200 - their order Cancelled
//   PUT  /api/orders/K-B-1/edit                200 - dealer and client
//        overwritten with mine
//   PUT  /api/dashboards/production/K-B-1      200 - stages marked done
//   PUT  /api/dashboards/till-approval/K-B-1   200 - approval and remark
//
// Nothing on any screen offers those orders to that designer. The screens
// were the only thing stopping it.
//
// TWO WAYS TO BE ALLOWED, and the second is why this is not simply
// "your own orders":
//
//   THE ORDER IS YOURS - assigned to you by name, or punched from your
//   address. This is the designer's case.
//
//   YOU WORK THAT BOARD - you have been granted the section the route
//   belongs to. Production marks stages on orders nobody assigned to them;
//   that is the job. The office's own grants already say who may, and this
//   asks them rather than inventing a second answer.
//
// So a write is refused only for somebody who neither owns the order nor
// works the board it is on - which is exactly the case that was open.
// ══════════════════════════════════════════════════════
const db = require('../config/db');
const { canSee } = require('./access');

/**
 * The WHERE that limits a query to the orders this person may see.
 *
 * SuperAdmin, Head and the production managers work the whole floor and get
 * no clause at all. Everybody else gets the orders carrying their name.
 *
 * The name must match EXACTLY. It used to also match LIKE '%name%', which
 * put all 352 of Kanu Priya's orders in front of Riya - "riya" sits inside
 * "priya".
 */
function visibleOrders(user) {
  const role = (user && user.role) || '';
  const isAdmin = role === 'SuperAdmin' || role === 'Head'
    || (user && user.domain === 'Head') || role.includes('Production Manager');
  if (isAdmin) return { isAdmin, where: '', params: [] };

  const name = (user && user.username) || '';
  return {
    isAdmin,
    where: ` AND (
      LOWER(TRIM(IFNULL(india_designer, ''))) = LOWER(TRIM(?)) OR
      LOWER(TRIM(IFNULL(overseas_designer, ''))) = LOWER(TRIM(?)) OR
      LOWER(IFNULL(email_address, '')) = LOWER(?)
    )`,
    params: [name, name, user && user.email || ''],
  };
}

/** Is this order one of theirs by name or by the address that punched it? */
async function ownsOrder(user, orderId) {
  const mine = visibleOrders(user);
  if (mine.isAdmin) return true;
  try {
    const [rows] = await db.query(
      `SELECT 1 FROM orders WHERE order_id = ?${mine.where} LIMIT 1`,
      [orderId, ...mine.params]);
    return rows.length > 0;
  } catch (err) {
    // FAILS CLOSED. A question about permission that cannot be answered is
    // answered no: the alternative is an outage turning into open access.
    console.error('[orderAccess] could not check an order, refusing:', err.message);
    return false;
  }
}

/**
 * May this person reach this order through this route?
 *
 * @param sections the board(s) this route belongs to, e.g. ['productionBD'].
 *                 Pass none for a route that is nobody's board - then only
 *                 ownership counts.
 */
async function mayReach(user, orderId, sections) {
  if (await ownsOrder(user, orderId)) return true;
  for (const s of sections || []) {
    try {
      if (await canSee(user, s)) return true;
    } catch (err) {
      console.error('[orderAccess] could not read a grant, refusing:', err.message);
    }
  }
  return false;
}

/**
 * The refusal, written once.
 *
 * 404 AND THE SAME SENTENCE AS A MISSING ORDER, deliberately. Order ids run
 * in sequence; "you may not see that one" confirms it exists, which is most
 * of what was being kept back. The Orders Dashboard has answered this way
 * for a year and the office is used to it.
 *
 * Returns true when it has answered, so a route reads:
 *   if (await refuseUnlessAllowed(req, res, id, ['productionBD'])) return;
 */
async function refuseUnlessAllowed(req, res, orderId, sections) {
  const allowed = await mayReach(req.session && req.session.user, orderId, sections);
  if (allowed) return false;
  console.warn('[orderAccess] refused ' + req.method + ' ' + req.originalUrl
    + ' for ' + ((req.session && req.session.user && req.session.user.email) || 'nobody'));
  res.status(404).json({ success: false, error: 'Order not found.' });
  return true;
}

module.exports = { visibleOrders, ownsOrder, mayReach, refuseUnlessAllowed };
