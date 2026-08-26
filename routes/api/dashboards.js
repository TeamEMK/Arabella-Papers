const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { uploadToDrive } = require('../../utils/drive');
const { logOrderUpdate } = require('../../utils/auditlog');
const { requireLogin } = require('../../middleware/auth');
// Dates are stored as IST wall-clock and read back through a +05:30
// connection. Vercel runs the server in UTC, so without naming the zone here
// every timestamp rendered 5:30 earlier than the sheet said.
const IST = { timeZone: 'Asia/Kolkata' };

// 4MB cap — Vercel rejects request bodies over 4.5MB before they reach here.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// ═══════════════════════════════════════════════
// TILL APPROVAL DASHBOARD
// ═══════════════════════════════════════════════

// GET /api/dashboards/till-approval
router.get('/till-approval', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    const isAuthorized = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' || role.includes('TillApprover');
    if (!isAuthorized) return res.json({ success: true, data: [] });

    const [rows] = await db.query(`
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND no_of_design_revision IS NOT NULL
        AND no_of_design_revision > 0
        AND (
          LOWER(design_status) LIKE '%proofing%' OR
          LOWER(design_status) LIKE '%approved%' OR
          (design_approval_status_from_client IS NOT NULL AND design_approval_status_from_client != '')
        )
      ORDER BY id DESC
    `);

    const data = rows.map(r => ({
      ID: r.order_id,
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
      Actual_1: r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB', IST) : '',
      Actual: r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB', IST) : '',
      Designer: r.india_designer || r.overseas_designer || '',
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Design_Approval_Status_From_Client: r.design_approval_status_from_client || '',
      // rowData ab on-demand aata hai (GET /api/dashboards/order-details/:id)
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/dashboards/till-approval/:id
router.put('/till-approval/:id', requireLogin, upload.single('file'), async (req, res) => {
  try {
    const { approvalStatus, remark, userEmail } = req.body;
    const orderId = req.params.id;

    let fileUrl = null;
    if (req.file) {
      fileUrl = await uploadToDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    const updates = {
      design_approval_status_from_client: approvalStatus,
      actual_2: new Date(),
      approval_updated_by: userEmail,
      remarks: remark,
    };

    if (fileUrl) updates.approved_design = fileUrl;
    if (approvalStatus === 'Rejected') updates.design_status = 'Rejected';

    await logOrderUpdate(orderId, updates, req.session.user || userEmail);

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, [...Object.values(updates), orderId]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dashboards/till-approval/bulk
router.post('/till-approval/bulk', requireLogin, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.json({ success: false, error: 'Invalid data' });

    let count = 0;
    for (const u of updates) {
      await logOrderUpdate(u.id, {
        design_approval_status_from_client: u.status,
        remarks: u.remark,
      }, req.session.user || u.userEmail);

      await db.query(`
        UPDATE orders SET
          design_approval_status_from_client = ?,
          remarks = ?,
          actual_2 = NOW(),
          approval_updated_by = ?
        WHERE order_id = ?
      `, [u.status, u.remark, u.userEmail, u.id]);
      count++;
    }
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// PRODUCTION DASHBOARD
// ═══════════════════════════════════════════════

// GET /api/dashboards/production
router.get('/production', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    const isAuthorized = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' || role.includes('Production Manager');
    if (!isAuthorized) return res.json({ success: true, data: [] });

    // An order the client has not signed off is not production's work yet:
    // "Proofing Done" means it is sitting with the client, and a blank means
    // it has not even been sent - an order punched an hour ago, design still
    // to do. Neither belongs on the floor's queue.
    //
    // The exception is the whole argument. The office records the approval
    // late if at all, and 1296 orders sit at "Proofing Done" with paper cut,
    // printing or assembly done. Excluding on the approval alone would take
    // those off the board while the stock is in the building, which is what
    // the team objected to the first time this gate went on. So an order the
    // floor has already started stays, whatever the approval column says.
    const [rows] = await db.query(`
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND (status_4 IS NULL OR status_4 = '')
        AND LOWER(IFNULL(design_approval_status_from_client, '')) NOT LIKE '%rejected%'
        AND LOWER(IFNULL(design_approval_status_from_client, '')) NOT LIKE '%cancel%'
        AND LOWER(IFNULL(design_status, '')) NOT LIKE '%cancel%'
        AND LOWER(IFNULL(dealer_name, '')) <> 'local order'
        AND (
          TRIM(IFNULL(design_approval_status_from_client, '')) NOT IN ('Proofing Done', '')
          OR LOWER(IFNULL(paper_cutting, ''))  LIKE '%done%'
          OR LOWER(IFNULL(printing, ''))       LIKE '%done%'
          OR LOWER(IFNULL(card_assembly, ''))  LIKE '%done%'
          OR LOWER(IFNULL(dye_status, ''))     LIKE '%done%'
          OR LOWER(IFNULL(block_status, ''))   LIKE '%printed%'
        )
      -- Newest into production first. That is the approval date, not the
      -- punch date: an order approved this morning may have been taken a
      -- month ago, and the floor wants it at the top of their queue today.
      ORDER BY COALESCE(actual_2, timestamp) DESC, id DESC
    `);

    const data = rows.map(r => ({
      ID: r.order_id,
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
      Actual_Date: r.actual_2 ? new Date(r.actual_2).toLocaleString('en-GB', IST) : '',
      // The date this order reached production. 88 of the orders on this board
      // carry no approval date - imported rows, mostly - so they fall back to
      // when they were punched rather than showing an empty cell.
      Production_Date: new Date(r.actual_2 || r.timestamp).toLocaleString('en-GB', IST),
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Designer: r.india_designer || r.overseas_designer || '',
      Design_Approval_Status_From_Client: r.design_approval_status_from_client,
      Guest_Name: r.guest_name || '',
      Paper_Cutting: r.paper_cutting || '',
      Dye_Status: r.dye_status || '',
      Block_Status: r.block_status || '',
      Printing: r.printing || '',
      Printing_Type: r.printing_type || '',
      Edges: r.edges || '',
      Laser_Cutting: r.laser_cutting || '',
      Output: r.output || '',
      // Per-stage *_actual_time fields used to be sent here too - 16 of them,
      // formatted for every order and read by nothing. On 5000 orders that was
      // 80k Intl formats and most of an 8MB response.
      // The per-stage *_actual_time fields used to be sent here as well - 16
      // of them, date-formatted for every order and read by nothing. On 5000
      // orders that was 80k Intl formats and most of an 8MB response.
      Card_Assembly: r.card_assembly || '',
      Remark: r.remark || '',
      Reason_For_Delay: r.reason_for_delay || '',
      Dispatch_Status: r.status_4 || '',
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/dashboards/production/:id
router.put('/production/:id', requireLogin, async (req, res) => {
  try {
    const orderId = req.params.id;
    const u = req.body;
    const now = new Date();

    const updates = {};
    if (u.userEmail) updates.production_updated_by = u.userEmail;

    // Stage map: field -> [status_col, time_col]
    const stageMap = {
      Guest_Name: ['guest_name', 'guest_name_actual_time'],
      Paper_Cutting: ['paper_cutting', 'paper_cutting_actual_time'],
      Printing: ['printing', 'printing_actual_time'],
      Printing_Type: ['printing_type', null],
      Edges: ['edges', 'edges_actual_time'],
      Card_Assembly: ['card_assembly', 'card_assembly_actual_time'],
      Remark: ['remark', 'remark_actual_time'],
      Reason_For_Delay: ['reason_for_delay', 'reason_for_delay_actual_time'],
      Dispatch_Status: ['status_4', null],
    };

    for (const [key, [col, timeCol]] of Object.entries(stageMap)) {
      if (u[key] !== undefined) {
        updates[col] = u[key];
        if (timeCol && u[key] && u[key] !== 'Pending' && u[key] !== 'No') {
          updates[timeCol] = now;
        }
      }
    }

    // Dye Status
    if (u.Dye_Status !== undefined) {
      updates.dye_status = u.Dye_Status;
      if (u.Dye_Status === 'NO DIE') { updates.no_die_actual_time = now; }
      else if (u.Dye_Status === 'DIE NOT RECEIVED') { updates.die_not_received_actual_time = now; }
      else if (u.Dye_Status === 'DIE CUTTING DONE') { updates.die_cutting_done_actual_time = now; }
      else if (u.Dye_Status === 'DIE SENT') { updates.die_sent_actual_time = now; updates.dye_status_actual_time = now; }
    }

    // Block Status
    if (u.Block_Status !== undefined) {
      updates.block_status = u.Block_Status;
      if (u.Block_Status === 'NO BLOCK') { updates.no_block_actual_time = now; }
      else if (u.Block_Status === 'BLOCK NOT RECEIVED') { updates.block_not_received_actual_time = now; }
      else if (u.Block_Status === 'BLOCK PRINTED') { updates.block_printed_actual_time = now; updates.block_status_actual_time = now; }
      else if (u.Block_Status === 'BLOCK SENT') { updates.block_sent_actual_time = now; }
    }

    // Laser Cutting
    if (u.Laser_Cutting !== undefined) {
      updates.laser_cutting = u.Laser_Cutting;
      if (u.Laser_Cutting === 'Done') { updates.done_laser_cutting_actual_time = now; }
      else if (u.Laser_Cutting === 'No') { updates.no_laser_cutting_actual_time = now; }
      else if (u.Laser_Cutting === 'Pending') { updates.pending_laser_cutting_actual_time = now; }
    }

    // Output
    if (u.Output !== undefined) {
      updates.output = u.Output;
      if (u.Output === 'Done') { updates.output_done_actual_time = now; }
      else if (u.Output === 'No') { updates.no_output_actual_time = now; }
      else if (u.Output === 'Pending') { updates.output_pending_actual_time = now; }
    }

    if (!Object.keys(updates).length) return res.json({ success: true });

    await logOrderUpdate(orderId, updates, req.session.user || u.userEmail);

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, [...Object.values(updates), orderId]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dashboards/production/bulk
router.post('/production/bulk', requireLogin, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates)) return res.json({ success: false, error: 'Invalid' });

    for (const u of updates) {
      // Reuse single update logic by calling it internally
      await updateProductionOrder(u.ID, u, req.session.user);
    }
    res.json({ success: true, count: updates.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper for bulk production
async function updateProductionOrder(orderId, u, user) {
  const now = new Date();
  const updates = {};

  const simpleMap = {
    Guest_Name: 'guest_name',
    Paper_Cutting: 'paper_cutting',
    Printing: 'printing',
    Printing_Type: 'printing_type',
    Edges: 'edges',
    Card_Assembly: 'card_assembly',
  };

  for (const [key, col] of Object.entries(simpleMap)) {
    if (u[key] !== undefined) updates[col] = u[key];
  }

  if (u.Dye_Status !== undefined) updates.dye_status = u.Dye_Status;
  if (u.Block_Status !== undefined) updates.block_status = u.Block_Status;
  if (u.Laser_Cutting !== undefined) updates.laser_cutting = u.Laser_Cutting;
  if (u.Output !== undefined) updates.output = u.Output;
  if (u.userEmail) updates.production_updated_by = u.userEmail;

  if (!Object.keys(updates).length) return;

  await logOrderUpdate(orderId, updates, user || u.userEmail);

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, [...Object.values(updates), orderId]);
}

// ═══════════════════════════════════════════════
// DISPATCH DASHBOARD
// ═══════════════════════════════════════════════

// GET /api/dashboards/dispatch
router.get('/dispatch', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'SuperAdmin' && user.role !== 'Accounts') {
      return res.json({ success: true, data: [] });
    }

    // status_4 is only set by this dashboard, so on its own it showed the 24
    // orders handled since the system went live and hid the 1770 the sheet
    // recorded as dispatched before that. A dispatch date is the same fact
    // written down differently, so an order carrying one belongs here too.
    const [rows] = await db.query(`
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND ((status_4 IS NOT NULL AND status_4 != '') OR actual_4 IS NOT NULL)
      ORDER BY COALESCE(actual_4, timestamp) DESC, id DESC
    `);

    const data = rows.map(r => ({
      ID: r.order_id,
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Dispatch_Courier_Name: r.courier || '',
      Docket_No: r.ups_dhl_fedex_tracking_number || '',
      Dispatch_Date: r.actual_4 ? new Date(r.actual_4).toLocaleString('en-GB', IST) : '',
      // A parcel with a dispatch date has gone, whatever the status column
      // says - the board reads a blank status as "Ready", which would put
      // 1760 delivered orders back in the queue.
      Dispatch_Status: r.status_4 || (r.actual_4 ? 'Dispatched' : ''),
      // This dashboard shows the invoice figures as table columns and reloads
      // them into its edit form, so unlike the others it needs them up front -
      // five fields rather than the whole row.
      Invoice_Number: r.invoice_number || '',
      Invoice_Amount: r.invoice_amount == null ? '' : r.invoice_amount,
      Number_of_Boxes: r.number_of_boxes == null ? '' : r.number_of_boxes,
      Weight: r.weight || '',
      Volumetric_Weight: r.volumetric_weight || '',
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/dashboards/dispatch/:id
router.put('/dispatch/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'SuperAdmin' && user.role !== 'Accounts') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { courier, docket, status, invoiceNo, invoiceAmount, boxes, weight, volWeight, userEmail } = req.body;
    const orderId = req.params.id;

    // invoice_amount is DECIMAL and number_of_boxes is INT: an untouched input
    // sends '', which MySQL rejects outright in strict mode and would fail the
    // whole dispatch update. Leave those columns empty instead.
    const num = v => (v === '' || v === undefined || v === null) ? null : v;

    await logOrderUpdate(orderId, {
      courier,
      ups_dhl_fedex_tracking_number: docket,
      status_4: status,
      invoice_number: invoiceNo,
      invoice_amount: num(invoiceAmount),
      number_of_boxes: num(boxes),
      weight,
      volumetric_weight: volWeight,
    }, req.session.user || userEmail);

    await db.query(`
      UPDATE orders SET
        courier = ?, ups_dhl_fedex_tracking_number = ?, status_4 = ?,
        invoice_number = ?, invoice_amount = ?, number_of_boxes = ?,
        weight = ?, volumetric_weight = ?, actual_4 = NOW(),
        dispatch_updated_by = ?
      WHERE order_id = ?
    `, [courier, docket, status, invoiceNo, num(invoiceAmount), num(boxes), weight, volWeight, userEmail, orderId]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// ORDER DETAILS (View modal)
// ═══════════════════════════════════════════════

// GET /api/dashboards/order-details/:id
// The three queue dashboards used to carry the full row for every order just to
// fill a modal opened one at a time. They fetch it from here instead.
router.get('/order-details/:id', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM orders WHERE order_id = ? AND is_deleted = 0', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Order not found.' });
    res.json({ success: true, rowData: buildFullRowData(rows[0]) });
  } catch (err) {
    console.error('Order details failed:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ═══════════════════════════════════════════════
// ANALYTICS (O2D Summary)
// ═══════════════════════════════════════════════

// GET /api/dashboards/analytics
// PUT /api/dashboards/quick/:id — the two things Analytics lets you set
// without leaving the report.
//
// It writes one field and nothing else on purpose. The obvious shortcut was to
// reuse the Till Approval route for the re-order flag, but that route also
// writes the remarks column, so a caller with nothing to say there would blank
// whatever the designer had written.
router.put('/quick/:id', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'SuperAdmin' && user.domain !== 'Head') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const orderId = req.params.id;
    const [rows] = await db.query('SELECT order_id FROM orders WHERE order_id = ? AND is_deleted = 0', [orderId]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'No such order.' });

    const updates = {};
    const now = new Date();

    if (req.body.clientStatus !== undefined) {
      const status = String(req.body.clientStatus || '').trim();
      if (!status) return res.json({ success: false, error: 'Pick a status.' });
      updates.design_approval_status_from_client = status;
      updates.actual_2 = now;
      updates.approval_updated_by = user.email || '';
    }

    if (req.body.reasonForDelay !== undefined) {
      const reason = String(req.body.reasonForDelay || '').trim();
      if (!reason) return res.json({ success: false, error: 'Write the reason.' });
      updates.reason_for_delay = reason;
      updates.reason_for_delay_actual_time = now;
    }

    if (!Object.keys(updates).length) {
      return res.json({ success: false, error: 'Nothing to update.' });
    }

    await logOrderUpdate(orderId, updates, user);

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE orders SET ${setClauses} WHERE order_id = ?`, [...Object.values(updates), orderId]);

    res.json({ success: true });
  } catch (err) {
    console.error('Quick update failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dashboards/today — the four numbers the Analytics cards carry
// underneath their own. Deliberately its own endpoint: it answers "what
// happened today" and must not move when someone changes the date range, and
// it is small enough to re-ask every couple of minutes without reloading a
// board of 5000 rows to do it.
router.get('/today', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'SuperAdmin' && user.domain !== 'Head') {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Today according to the office, not the database server - Railway runs in
    // UTC, so between midnight and half past five CURDATE() is still yesterday
    // here and the cards would sit on the previous day's numbers.
    const today = new Date().toLocaleDateString('en-CA', IST);

    const live = `is_deleted = 0 AND LOWER(IFNULL(dealer_name, '')) <> 'local order'`;
    const cancelled = `(LOWER(IFNULL(design_status, '')) LIKE '%cancel%'
                        OR LOWER(IFNULL(design_approval_status_from_client, '')) LIKE '%cancel%')`;

    const count = async (sql, params) => {
      const [[row]] = await db.query(sql, params);
      return row.c;
    };

    const [total, dispatched, inProgress, cancelledToday] = await Promise.all([
      // Orders punched today.
      count(`SELECT COUNT(*) AS c FROM orders WHERE ${live} AND DATE(timestamp) = ?`, [today]),
      // Parcels that actually went out today, whenever the order was punched.
      count(`SELECT COUNT(*) AS c FROM orders WHERE ${live} AND DATE(actual_4) = ?`, [today]),
      // Of today's intake, what is still moving.
      count(
        `SELECT COUNT(*) AS c FROM orders
          WHERE ${live} AND DATE(timestamp) = ?
            AND IFNULL(status_4, '') = '' AND NOT ${cancelled}`,
        [today]
      ),
      // Cancelling leaves no date of its own on the order, so this comes from
      // the change log - which means it counts from the day logging started.
      count(
        `SELECT COUNT(DISTINCT order_id) AS c FROM order_logs
          WHERE DATE(changed_at) = ?
            AND field IN ('Design Status', 'Client Approval')
            AND LOWER(IFNULL(new_value, '')) LIKE '%cancel%'`,
        [today]
      ),
    ]);

    res.json({ success: true, date: today, total, dispatched, inProgress, cancelled: cancelledToday });
  } catch (err) {
    console.error("Today's numbers failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/analytics', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    const email = user.email || '';
    const name = user.username || '';
    const canSeeAll = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' ||
      role.includes('Production Manager');

    // "Local Order" is off the Orders and Production boards already. It was
    // still padding the totals here - 3576 rows the business does not track,
    // in every count and chart on the page.
    let query = `
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND LOWER(IFNULL(dealer_name, '')) <> 'local order'
    `;
    const params = [];

    if (!canSeeAll) {
      query += ` AND (
        LOWER(india_designer) = LOWER(?) OR LOWER(india_designer) LIKE LOWER(?) OR
        LOWER(overseas_designer) = LOWER(?) OR LOWER(overseas_designer) LIKE LOWER(?)
      )`;
      params.push(email, `%${name}%`, email, `%${name}%`);
    }

    query += ' ORDER BY id DESC';
    const [rows] = await db.query(query, params);

    const data = rows
      .filter(r => r.order_id)
      .map(r => {
        const indiaName = r.india_designer;
        const overseasName = r.overseas_designer;
        let designer = '';
        let team = 'Unknown';

        if (indiaName && indiaName.trim()) {
          designer = indiaName;
          team = 'India Team';
        } else if (overseasName && overseasName.trim()) {
          designer = overseasName;
          team = 'Cassie';
        }

        return {
          ID: r.order_id,
          Date: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
          RawDate: r.timestamp,
          Dealer: r.dealer_name || '',
          Client: r.client_name || '',
          PunchBy: r.order_punched_by || '',
          Designer: designer,
          Team: team,
          DesignStatus: r.design_status || '',
          ClientStatus: r.design_approval_status_from_client || '',
          ProductionStatus: r.card_assembly || '',
          DispatchStatus: r.status_4 || '',
          Courier: r.courier || '',
          Docket: r.ups_dhl_fedex_tracking_number || '',
        };
      });

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// MASTER DATA (Dealers & Designers)
// ═══════════════════════════════════════════════

// GET /api/dashboards/master-data
router.get('/master-data', requireLogin, async (req, res) => {
  try {
    const [dealers] = await db.query('SELECT * FROM dealers ORDER BY name ASC');
    const [designers] = await db.query('SELECT * FROM designers ORDER BY india_name ASC');
    res.json({ success: true, dealers, designers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dashboards/form-options
router.get('/form-options', requireLogin, async (req, res) => {
  try {
    const [dealers] = await db.query('SELECT name FROM dealers ORDER BY name ASC');
    const [designers] = await db.query('SELECT india_name, overseas_name FROM designers ORDER BY india_name ASC');

    const indian = designers.map(d => d.india_name).filter(Boolean);
    const cassie = designers.map(d => d.overseas_name).filter(Boolean);

    res.json({
      success: true,
      dealers: dealers.map(d => d.name),
      indian,
      cassie,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dashboards/dealers
router.post('/dealers', requireLogin, async (req, res) => {
  try {
    const { name, email, mobile } = req.body;
    await db.query('INSERT INTO dealers (name, email, mobile) VALUES (?,?,?)', [name, email || '', mobile || '']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/dashboards/dealers/:id
router.put('/dealers/:id', requireLogin, async (req, res) => {
  try {
    const { name, email, mobile } = req.body;
    await db.query('UPDATE dealers SET name=?, email=?, mobile=? WHERE id=?', [name, email, mobile, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/dashboards/dealers/:id
router.delete('/dealers/:id', requireLogin, async (req, res) => {
  try {
    await db.query('DELETE FROM dealers WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dashboards/designers
router.post('/designers', requireLogin, async (req, res) => {
  try {
    const { name, email, team } = req.body;
    // Which column the name lands in is what makes an order count as India Team
    // or Cassie later, so the caller's choice decides it rather than always
    // assuming India.
    const cols = team === 'Cassie'
      ? ['overseas_name', 'overseas_email']
      : ['india_name', 'india_email'];
    await db.query(`INSERT INTO designers (${cols[0]}, ${cols[1]}) VALUES (?,?)`, [name, email || '']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/dashboards/designers/:id
router.put('/designers/:id', requireLogin, async (req, res) => {
  try {
    const { indiaName, indiaEmail, overseasName, overseasEmail } = req.body;
    await db.query(
      'UPDATE designers SET india_name=?, india_email=?, overseas_name=?, overseas_email=? WHERE id=?',
      [indiaName, indiaEmail, overseasName, overseasEmail, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/dashboards/designers/:id
router.delete('/designers/:id', requireLogin, async (req, res) => {
  try {
    await db.query('DELETE FROM designers WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dashboards/clients (unique clients from orders)
router.get('/clients', requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT client_name FROM orders 
      WHERE is_deleted = 0 AND client_name IS NOT NULL AND client_name != ''
      ORDER BY client_name ASC
    `);
    res.json({ success: true, clients: rows.map(r => r.client_name) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════
function buildFullRowData(r) {
  return {
    'Order ID': r.order_id,
    'Timestamp': r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB', IST) : '',
    'Email address': r.email_address,
    'Order Punched by': r.order_punched_by,
    'Name of Dealer': r.dealer_name,
    'Dealer E-Mail': r.dealer_email,
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
}

module.exports = router;
