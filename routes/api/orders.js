const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { uploadToDrive } = require('../../utils/drive');
const { generateOrderId } = require('../../utils/idgen');
const { notifyDesignerAssigned } = require('../../utils/notify');
const { requireLogin } = require('../../middleware/auth');
// Dates are stored as IST wall-clock and read back through a +05:30
// connection. Vercel runs the server in UTC, so without naming the zone here
// every timestamp rendered 5:30 earlier than the sheet said.
const IST = { timeZone: 'Asia/Kolkata' };

// Multer: memory storage (files go to Drive)
// 4MB per file — Vercel rejects any request body over 4.5MB before it reaches
// this handler, so a larger limit here would only turn into an opaque 413.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 10 },
});

// ─────────────────────────────────────────────
// GET /api/orders — Orders Dashboard Data
// ─────────────────────────────────────────────
router.get('/', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    const email = user.email || '';
    const name = user.username || '';
    const isAdmin = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' || role.includes('Production Manager');

    // "Local Order" is a real dealer with 3576 orders behind it, but it is not
    // work anyone tracks here - it was crowding out 41% of both this list and
    // the production queue, and padding every total on Analytics. The rows
    // stay in the table; they are only kept off the boards.
    let query = `
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND LOWER(IFNULL(dealer_name, '')) <> 'local order'
    `;
    const params = [];

    if (!isAdmin) {
      query += ` AND (
        LOWER(india_designer) = LOWER(?) OR
        LOWER(india_designer) LIKE LOWER(?) OR
        LOWER(overseas_designer) = LOWER(?) OR
        LOWER(overseas_designer) LIKE LOWER(?) OR
        LOWER(email_address) = LOWER(?)
      )`;
      params.push(email, `%${name}%`, email, `%${name}%`, email);
    }

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
      Status: r.design_status,
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
    const role = user.role || '';
    const isAdmin = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' ||
      role.includes('Production Manager');

    const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? AND is_deleted = 0', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Order not found.' });

    res.json({ success: true, rowData: buildRowData(rows[0], isAdmin) });
  } catch (err) {
    console.error('Order details failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/orders — Submit New Order
// ─────────────────────────────────────────────
router.post('/', requireLogin, upload.array('files', 10), async (req, res) => {
  try {
    const { email, punchedBy, dealer, client, remarks, designer, designTime } = req.body;
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
         special_remarks, upload_design_file, design_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      orderId, email, punchedBy, dealer, dealerEmail,
      client, indiaDesigner, overseasDesigner, designTime,
      remarks, finalLinks, 'Fresh Design'
    ]);

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
