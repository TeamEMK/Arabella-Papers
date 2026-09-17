/**
 * Re-print and Re-order: a new entry for the new run, the old one left alone.
 *
 * Asked for by Sanjay Sir on 17/09 against K-159295, and it is the third time
 * the same complaint has come back in a different shape. The approval used to
 * be written onto the order that had already been made: the stages went back
 * to Pending, the dispatch was cleared, and the row was pushed onto the live
 * production board. Every one of those overwrites something that really
 * happened, and the date the board printed still came off a row punched in
 * July - so a reprint raised today read as three months old however many of
 * its dates were patched.
 *
 * Nothing on the old order is touched now. The repeat is a new row carrying
 * today's date, blank production stages and nothing in Dispatch, and it says
 * which order it is a repeat of. The old run keeps its own dates, its stages
 * as the floor left them, and the parcel that went out.
 */
const db = require('../config/db');
const { remakeOrderId, rootOrderId } = require('./idgen');
const { logOrderUpdate, logOrderEvent, logApproval } = require('./auditlog');

/**
 * The two answers that mean "make this one again".
 *
 * Sample is deliberately not here. It is a round on the way to a job rather
 * than a repeat of a finished one - an order is approved as a Sample first and
 * for production afterwards - so there is no earlier run to keep.
 */
const SPLIT_STATUSES = ['Reprint', 'Reorder'];

/** Has this order already been made and sent? */
const LEFT_FOR_DISPATCH = (r) =>
  !!((r.status_4 && String(r.status_4).trim()) || r.actual_4);

/**
 * What the new entry inherits: who it is for, and the design that was already
 * settled. Everything else - the production stages, the stamps behind them,
 * the dispatch, whichever board the old run was pinned to - belongs to the run
 * that has been and is left off, so the new row starts as blank as a freshly
 * punched order.
 *
 * `remarks` is left off too: the box on the approval screen is asking why it
 * is being made again, and that answer is about the new run, not the old.
 */
const INHERITED = [
  'email_address', 'order_punched_by',
  'dealer_name', 'dealer_email', 'client_name',
  'india_designer', 'overseas_designer', 'possible_design_time',
  'special_remarks', 'upload_design_file',
  'design_status', 'no_of_design_revision',
  'upload_design', 'revision_design_upload', 'approved_design',
  'order_quantity',
];

function isRemakeStatus(status) {
  return SPLIT_STATUSES.includes(String(status || '').trim());
}

/**
 * A repeat of this order that is still being made.
 *
 * The same approval gets saved more than once - three times inside twenty
 * minutes on K-159295, two different people fixing the remark - and each save
 * would otherwise open another entry. One run at a time: while a repeat is
 * still on the floor, saying "reprint" again is talking about that one.
 */
async function openRemake(root) {
  const [rows] = await db.query(
    `SELECT order_id, design_approval_status_from_client FROM orders
      WHERE remake_of = ? AND is_deleted = 0
        AND IFNULL(status_4, '') = '' AND actual_4 IS NULL
      ORDER BY id DESC LIMIT 1`,
    [root],
  );
  return rows[0] || null;
}

/**
 * Raise the repeat, or hand back the one already open.
 *
 * Returns null when this is not a repeat at all, and the caller then does what
 * it always did. Two ways that happens: the status is something else, or the
 * order never went out - a job still on the floor has no finished run to keep,
 * and opening a second entry for it would put the same work on the board
 * twice.
 *
 *   { childId, root, created, status }
 */
async function raiseRemake(parentId, status, opts = {}) {
  const value = String(status || '').trim();
  if (!isRemakeStatus(value)) return null;

  const [[parent]] = await db.query(
    'SELECT * FROM orders WHERE order_id = ? AND is_deleted = 0 LIMIT 1',
    [parentId],
  );
  if (!parent || !LEFT_FOR_DISPATCH(parent)) return null;

  const { remark, fileUrl, user, userEmail } = opts;
  const who = user || userEmail;
  const root = rootOrderId(parentId);
  const note = String(remark || '').trim();
  const now = new Date();

  // Already open: the same repeat being saved again. Keep whatever new was
  // typed and leave the entry where it is.
  const open = await openRemake(root);
  if (open) {
    const updates = {};
    if (note) updates.remarks = note;
    if (fileUrl) updates.approved_design = fileUrl;
    if (String(open.design_approval_status_from_client || '').trim() !== value) {
      updates.design_approval_status_from_client = value;
      updates.actual_2 = now;
      await logApproval(open.order_id, value, now, who);
    }
    if (Object.keys(updates).length) {
      await logOrderUpdate(open.order_id, updates, who);
      await db.query(
        `UPDATE orders SET ${Object.keys(updates).map(k => `${k} = ?`).join(', ')}
          WHERE order_id = ?`,
        [...Object.values(updates), open.order_id],
      );
    }
    return { childId: open.order_id, root, created: false, status: value };
  }

  // The columns the parent actually has. Read off the row rather than spelled
  // out against the schema, so a column added in a later migration cannot
  // break the insert on a database that has not caught up yet.
  const cols = INHERITED.filter(c => c in parent);
  const childId = await remakeOrderId(root);

  const fields = [
    'order_id', ...cols,
    'remake_of',
    // Punched now, because that is when this run was asked for. Design was
    // settled the same moment - there is nothing to draw again - so the design
    // stage is stamped with it too rather than carrying July's date over.
    'timestamp', 'actual_1',
    'design_approval_status_from_client', 'actual_2', 'approval_updated_by',
    'remarks',
  ];
  const values = [
    childId, ...cols.map(c => parent[c]),
    root,
    now, now,
    value, now, (user && user.email) || userEmail || '',
    note || null,
  ];
  if (fileUrl) { fields.push('approved_design'); values.push(fileUrl); }

  await db.query(
    `INSERT INTO orders (${fields.map(f => `\`${f}\``).join(', ')})
     VALUES (${fields.map(() => '?').join(', ')})`,
    values,
  );

  // The same cards as last time, unless somebody changes them - a repeat of an
  // order is a repeat of what was in it.
  await db.query(
    `INSERT INTO order_add_ons (order_id, name, qty)
     SELECT ?, name, qty FROM order_add_ons WHERE order_id = ?`,
    [childId, parentId],
  );

  const label = value === 'Reorder' ? 'Re-order' : 'Re-print';
  await logOrderEvent(childId, 'Created',
    `${label} of ${parentId} - ${parent.dealer_name || '-'} / ${parent.client_name || '-'}`, who);
  await logOrderEvent(parentId, `${label} raised`,
    `New entry ${childId}. This order is left as it went out.`, who);
  await logApproval(childId, value, now, who);

  return { childId, root, created: true, status: value };
}

module.exports = { raiseRemake, isRemakeStatus, SPLIT_STATUSES };
