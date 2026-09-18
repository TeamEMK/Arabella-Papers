const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { uploadToDrive } = require('../../utils/drive');
const { generateOrderId } = require('../../utils/idgen');
const { notifyDesignerAssigned } = require('../../utils/notify');
const { logOrderUpdate, logOrderEvent } = require('../../utils/auditlog');
const { recordPunchedOrder } = require('../../utils/scot');
const { requireLogin } = require('../../middleware/auth');
// Dates are stored as IST wall-clock and read back through a +05:30
// connection. Vercel runs the server in UTC, so without naming the zone here
// every timestamp rendered 5:30 earlier than the sheet said.
// Every date the boards show goes through here. 12-hour because that is how
// the office says the time - "18:42" is a moment nobody reads aloud.
const IST = { timeZone: 'Asia/Kolkata', hour12: true };

// Multer: memory storage (files go to Drive)
// 4MB per file — Vercel rejects any request body over 4.5MB before it reaches
// this handler, so a larger limit here would only turn into an opaque 413.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 10 },
});

/**
 * Which orders this user is allowed to see. SuperAdmin, Head and the
 * production managers work the whole floor; everybody else sees the orders
 * assigned to them by name, and the ones they punched themselves.
 *
 * The list and the View modal both ask this one question, so the modal cannot
 * quietly hand over an order the list would have hidden.
 *
 * The name must match exactly. It used to also match LIKE '%name%', which put
 * all 352 of Kanu Priya's orders in front of Riya - "riya" sits inside
 * "priya". A designer seeing nothing of their own is a complaint; a designer
 * seeing another designer's work is a breach.
 */
function visibleOrders(user) {
  const role = user.role || '';
  const isAdmin = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' ||
    role.includes('Production Manager');
  if (isAdmin) return { isAdmin, where: '', params: [] };

  const name = user.username || '';
  return {
    isAdmin,
    where: ` AND (
      LOWER(TRIM(IFNULL(india_designer, ''))) = LOWER(TRIM(?)) OR
      LOWER(TRIM(IFNULL(overseas_designer, ''))) = LOWER(TRIM(?)) OR
      LOWER(IFNULL(email_address, '')) = LOWER(?)
    )`,
    params: [name, name, user.email || ''],
  };
}

// ─────────────────────────────────────────────
// GET /api/orders — Orders Dashboard Data
// ─────────────────────────────────────────────
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const mine = visibleOrders(user);
    const isAdmin = mine.isAdmin;

    // "Local Order" is a real dealer the shop still punches against, so this
    // list shows it. The working boards do not - see LOCAL_ORDER_OFF_BOARDS in
    // dashboards.js for why.
    //
    // A repeat is not on this list at all. It is a second run of an order that
    // was taken once, months ago - it was never punched, no dealer placed it,
    // and listing it here would count the same order twice in everything this
    // page feeds. Asked for by name: "it should appear with the same old
    // number in production not order dashboard". Production is where the work
    // is; the repeat is there.
    let query = `
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND remake_of IS NULL
    `;
    const params = [];

    query += mine.where;
    params.push(...mine.params);

    query += ` ORDER BY id DESC`;

    const [rows] = await db.query(query, params);

    const data = rows.map(r => ({
      ID: r.order_id,
      Email: r.email_address,
      Order_punch_by: r.order_punched_by,
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Possible_design_time: r.possible_design_time,
      Designer: r.india_designer || r.overseas_designer || '',
      Status: currentStage(r),
      // The design status on its own. The column above has moved past it once
      // the client or dispatch have had their say, but whether a designer may
      // still edit the order is decided by this one.
      Design_Status: r.design_status || '',
      Timestamp: r.timestamp ? formatDate(r.timestamp) : '',
      Raw_Timestamp: r.timestamp,
      // The full row used to ride along on every order here. At 8000+ orders
      // that was 79% of an 11MB response, to fill a modal opened one order at
      // a time - it is fetched on demand now. Remarks stays because the edit
      // form needs it without a round trip.
      Remarks: r.remarks,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/orders/:id/details — one order's full row, for the View modal.
// Applies the same admin check the list did, so a non-admin still does not see
// the dealer's email.
// ─────────────────────────────────────────────
router.get('/:id/details', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const mine = visibleOrders(user);

    const [rows] = await db.query(
      `SELECT * FROM orders WHERE order_id = ? AND is_deleted = 0${mine.where}`,
      [req.params.id, ...mine.params]
    );
    // Not yours reads the same as not there. Order ids run in sequence, so
    // saying "you may not see that one" would confirm it exists and who it
    // belongs to, which is most of what was being hidden.
    if (!rows.length) return res.status(404).json({ success: false, error: 'Order not found.' });

    const [addOns] = await db.query(
      'SELECT name, qty FROM order_add_ons WHERE order_id = ? ORDER BY name ASC',
      [req.params.id],
    );
    rows[0].add_ons_text = addOns.map(a => `${a.name} x ${a.qty}`).join(', ');

    res.json({ success: true, rowData: buildRowData(rows[0], mine.isAdmin) });
  } catch (err) {
    console.error('Order details failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/orders — Submit New Order
// ─────────────────────────────────────────────
/**
 * The add-ons sent with a punch, checked before anything is written.
 *
 * Arrives as JSON because the form is multipart - files ride along with it -
 * and a repeated field would give the server no way to tell which quantity
 * belongs to which card.
 *
 * Returns { rows } or { error }. Every quantity has to be a whole number of at
 * least one: a card ordered zero times is a card nobody ordered, and letting
 * it through would put a line on the order that means nothing.
 */
function parseAddOns(raw) {
  if (!raw) return { rows: [] };
  let list;
  try { list = JSON.parse(raw); } catch (_) { return { error: 'Add-ons could not be read.' }; }
  if (!Array.isArray(list)) return { error: 'Add-ons could not be read.' };

  const rows = [];
  const seen = new Set();
  for (const item of list) {
    const name = String((item && item.name) || '').trim();
    if (!name) continue;
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      return { error: `Quantity for "${name}" must be 1 or more.` };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `"${name}" is listed twice.` };
    seen.add(key);
    rows.push({ name, qty });
  }
  return { rows };
}

/** Whether Order Quantity has to be filled in. The office can turn this off. */
async function orderQuantityRequired() {
  const [[row]] = await db.query(
    `SELECT value FROM app_settings WHERE name = 'order_quantity_required'`);
  return !row || row.value !== '0';
}

router.post('/', requireLogin, upload.array('files', 10), async (req, res) => {
  try {
    const { email, punchedBy, dealer, client, remarks, designer, designTime } = req.body;

    // Checked before the order id is taken and before anything reaches Drive,
    // so a rejected punch does not burn a number or leave a file behind.
    const { rows: addOns, error: addOnError } = parseAddOns(req.body.addOns);
    if (addOnError) return res.json({ success: false, error: addOnError });

    const rawQty = String(req.body.orderQuantity ?? '').trim();
    let orderQuantity = null;
    if (rawQty !== '') {
      const n = Number(rawQty);
      if (!Number.isInteger(n) || n < 1) {
        return res.json({ success: false, error: 'Order Quantity must be 1 or more.' });
      }
      orderQuantity = n;
    } else if (await orderQuantityRequired()) {
      return res.json({ success: false, error: 'Order Quantity is required.' });
    }

    const orderId = await generateOrderId();

    // Upload files to Drive
    let fileLinks = [];
    if (req.files && req.files.length > 0) {
      for (const f of req.files) {
        const url = await uploadToDrive(f.buffer, f.originalname, f.mimetype);
        fileLinks.push(url);
      }
    }
    const finalLinks = fileLinks.length > 0 ? fileLinks.join('\n') : 'No Files';

    // Fetch dealer email
    const [dealers] = await db.query(
      'SELECT email FROM dealers WHERE LOWER(name) = LOWER(?)', [dealer]
    );
    const dealerEmail = dealers[0]?.email || '';

    // Assign designer columns
    const indiaDesigner = punchedBy === 'India Team' ? designer : null;
    const overseasDesigner = punchedBy === 'Cassie' ? designer : null;

    await db.query(`
      INSERT INTO orders 
        (order_id, email_address, order_punched_by, dealer_name, dealer_email,
         client_name, india_designer, overseas_designer, possible_design_time,
         special_remarks, upload_design_file, design_status, order_quantity)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      orderId, email, punchedBy, dealer, dealerEmail,
      client, indiaDesigner, overseasDesigner, designTime,
      remarks, finalLinks, 'Fresh Design', orderQuantity
    ]);

    if (addOns.length) {
      await db.query(
        `INSERT INTO order_add_ons (order_id, name, qty) VALUES ${addOns.map(() => '(?,?,?)').join(', ')}`,
        addOns.flatMap(a => [orderId, a.name, a.qty]),
      );
    }

    await logOrderEvent(orderId, 'Created', (dealer || '-') + ' / ' + (client || '-'), req.session.user);
    if (addOns.length) {
      await logOrderEvent(orderId, 'Add-ons',
        addOns.map(a => `${a.name} x${a.qty}`).join(', '), req.session.user);
    }

    // The calling sheet counts orders by the day they were punched, so this is
    // the moment it changes. Awaited for the same reason the designer's mail
    // below is - the container stops when the response goes out - and it can
    // only ever return, never throw, so a sheet nobody shared with us cannot
    // stop the office taking an order.
    await recordPunchedOrder(dealer);

    // Let the designer know before we answer. On Vercel the container is
    // frozen the moment the response goes out, so anything left running after
    // res.json() would simply never be delivered.
    if (String(designer || '').trim()) {
      await notifyDesignerAssigned({
        orderId,
        designerName: designer,
        client,
        designTime,
        remarks,
        assignedBy: req.session.user && req.session.user.username,
      });
    }

    res.json({ success: true, orderId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/orders/:id/status — Update Design Status
// ─────────────────────────────────────────────
router.put('/:id/status', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const { designStatus, remark, userEmail } = req.body;
    const orderId = req.params.id;

    const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ?', [orderId]);
    if (!rows.length) return res.json({ success: false, error: 'Order not found' });

    const order = rows[0];
    let fileUrl = null;
    const newRev = (order.no_of_design_revision || 0) + 1;

    if (req.file) {
      fileUrl = await uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    const clientStatus = designStatus !== 'Cancelled' ? 'Proofing Done' : '';

    const updates = {
      design_status: designStatus,
      remarks: remark,
      actual_1: new Date(),
      doer_id: userEmail,
      no_of_design_revision: newRev,
      design_approval_status_from_client: clientStatus,
    };

    if (fileUrl) {
      if (newRev > 1) updates.revision_design_upload = fileUrl;
      else updates.upload_design = fileUrl;
    }

    await logOrderUpdate(orderId, updates, req.session.user);

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), orderId];

    await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, values);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/orders/:id/edit — Edit Order Details
// ─────────────────────────────────────────────
router.put('/:id/edit', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const { dealerName, clientName, designerName, designTime, remark } = req.body;
    const orderId = req.params.id;

    const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ?', [orderId]);
    if (!rows.length) return res.json({ success: false, error: 'Order not found' });

    const order = rows[0];
    const updates = {
      dealer_name: dealerName,
      client_name: clientName,
      possible_design_time: designTime,
      remarks: remark,
    };

    // Update designer in the correct column
    if (order.india_designer) updates.india_designer = designerName;
    else if (order.overseas_designer) updates.overseas_designer = designerName;
    else updates.india_designer = designerName;

    if (req.file) {
      const fileUrl = await uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
      updates.upload_design_file = fileUrl;
    }

    await logOrderUpdate(orderId, updates, req.session.user);

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, [...Object.values(updates), orderId]);

    // Only a genuine handover is worth a mail. Editing the dealer or the
    // remarks leaves the designer where they were, and they should not get a
    // "reassigned to you" notice for an order they already have.
    const previousDesigner = order.india_designer || order.overseas_designer || '';
    const isHandover = String(designerName || '').trim() &&
      String(designerName).trim().toLowerCase() !== String(previousDesigner).trim().toLowerCase();

    if (isHandover) {
      await notifyDesignerAssigned({
        orderId,
        designerName,
        client: clientName,
        designTime,
        remarks: remark,
        assignedBy: req.session.user && req.session.user.username,
        isReassignment: true,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/orders/:id — Hard Delete
// ─────────────────────────────────────────────
router.delete('/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'SuperAdmin') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    await logOrderEvent(req.params.id, 'Deleted', '', user);
    await db.query('DELETE FROM orders WHERE order_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/orders/bulk-status — Bulk Update Status
// ─────────────────────────────────────────────
router.post('/bulk-status', requireLogin, async (req, res) => {
  try {
    const { updates } = req.body; // [{id, status, remark, userEmail}]
    if (!Array.isArray(updates)) return res.json({ success: false, error: 'Invalid data' });

    let count = 0;
    for (const u of updates) {
      const [rows] = await db.query('SELECT no_of_design_revision FROM orders WHERE order_id = ?', [u.id]);
      if (!rows.length) continue;

      const newRev = (rows[0].no_of_design_revision || 0) + 1;
      const clientStatus = u.status !== 'Cancelled' ? 'Proofing Done' : '';

      await logOrderUpdate(u.id, {
        design_status: u.status,
        remarks: u.remark,
        no_of_design_revision: newRev,
        design_approval_status_from_client: clientStatus,
      }, req.session.user);

      await db.query(`
        UPDATE orders SET
          design_status = ?,
          remarks = ?,
          actual_1 = NOW(),
          doer_id = ?,
          no_of_design_revision = ?,
          design_approval_status_from_client = ?
        WHERE order_id = ?
      `, [u.status, u.remark, u.userEmail, newRev, clientStatus, u.id]);

      count++;
    }
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
// Where the order has actually got to.
//
// Three teams write three different columns - the designer sets design_status,
// Till Approval sets the client's answer, Dispatch sets its own - and the
// Orders board showed only the first. An order that had been printed, packed
// and couriered still read "Proofing Done" there, because nothing after the
// design stage touches that column. So report the furthest point reached.
function currentStage(r) {
  const design = (r.design_status || '').trim();
  const client = (r.design_approval_status_from_client || '').trim();
  const dispatch = (r.status_4 || '').trim();

  // A cancelled or rejected order is finished wherever it happened, and that
  // is the answer whatever else was recorded afterwards.
  const ended = design + ' ' + client;
  if (/reject/i.test(ended)) return 'Rejected';
  if (/cancel/i.test(ended)) return 'Cancelled';

  // "Ready" is the dispatch desk's word for not gone yet; say so plainly.
  if (dispatch) return /^ready$/i.test(dispatch) ? 'Ready for Dispatch' : dispatch;
  if (r.actual_4) return 'Dispatched';

  if (client) return client;
  return design || 'Fresh Design';
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-GB', IST);
}

function buildRowData(r, isAdmin) {
  const data = {
    'Order ID': r.order_id,
    'Timestamp': r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
    'Email address': r.email_address,
    'Order Punched by': r.order_punched_by,
    'Name of Dealer': r.dealer_name,
    'Client Name': r.client_name,
    'India Designer': r.india_designer || '',
    'Overseas Designer': r.overseas_designer || '',
    'Possible Design Time': r.possible_design_time,
    'Order Quantity': r.order_quantity == null ? '' : r.order_quantity,
    // Filled in by the details route, which has to fetch them separately -
    // they live on their own table, one row per card.
    'Add Ons': r.add_ons_text || '',
    'Special Remarks/E-mail Subject Line': r.special_remarks,
    'Upload the one Design file': r.upload_design_file,
    'Design Status': r.design_status,
    'No of Design Revision.': r.no_of_design_revision,
    'Upload Design': r.upload_design,
    'Revision Design Upload': r.revision_design_upload,
    'Approved Design': r.approved_design,
    'Remarks': r.remarks,
    'Actual_1': r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB', IST) : '',
    'Design Approval Status From Client': r.design_approval_status_from_client,
    'Actual_2': r.actual_2 ? new Date(r.actual_2).toLocaleString('en-GB', IST) : '',
    'Guest Name': r.guest_name,
    'Paper Cutting': r.paper_cutting,
    'Dye Status': r.dye_status,
    'Block Status': r.block_status,
    'Printing': r.printing,
    'Deckled/Beveled/Painted Edges': r.edges,
    'Laser Cutting': r.laser_cutting,
    'Output': r.output,
    'Card Assembly': r.card_assembly,
    'Remark': r.remark,
    'Reason For Delay': r.reason_for_delay,
    'Status_4': r.status_4,
    'Courier': r.courier,
    'UPS DHL Fedex Tracking Number': r.ups_dhl_fedex_tracking_number,
    'Actual_4': r.actual_4 ? new Date(r.actual_4).toLocaleString('en-GB', IST) : '',
    'Invoice Number': r.invoice_number,
    'Invoice Amount': r.invoice_amount,
    'Number of Boxes': r.number_of_boxes,
    'Weight': r.weight,
    'Volumetric Weigh': r.volumetric_weight,
  };

  if (isAdmin) {
    data['Dealer E-Mail'] = r.dealer_email;
  }

  return data;
}

module.exports = router;
