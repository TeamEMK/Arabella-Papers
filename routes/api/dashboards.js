const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { uploadToDrive } = require('../../utils/drive');
const { requireLogin } = require('../../middleware/auth');

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
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB') : '',
      Actual_1: r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB') : '',
      Actual: r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB') : '',
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

    // Every live order, not only the client-approved ones.
    //
    // The approval gate was written for a flow this shop does not follow: work
    // starts when the order arrives, and the approval column is updated later
    // if at all. It was hiding 1298 orders that already had paper cut and
    // printing done, and it kept every freshly punched order out of the queue
    // the production team actually works from.
    //
    // So the queue is now "anything still in play": not dispatched, not
    // rejected, not cancelled. Narrowing it again is a matter of adding the
    // approval condition back to this WHERE clause.
    const [rows] = await db.query(`
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND (status_4 IS NULL OR status_4 = '')
        AND LOWER(IFNULL(design_approval_status_from_client, '')) NOT LIKE '%rejected%'
        AND LOWER(IFNULL(design_approval_status_from_client, '')) NOT LIKE '%cancel%'
        AND LOWER(IFNULL(design_status, '')) NOT LIKE '%cancel%'
      ORDER BY id DESC
    `);

    const data = rows.map(r => ({
      ID: r.order_id,
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB') : '',
      Actual_Date: r.actual_2 ? new Date(r.actual_2).toLocaleString('en-GB') : '',
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Designer: r.india_designer || r.overseas_designer || '',
      Design_Approval_Status_From_Client: r.design_approval_status_from_client,
      Guest_Name: r.guest_name || '',
      Paper_Cutting: r.paper_cutting || '',
      Dye_Status: r.dye_status || '',
      Dye_Status_Actual_Time: r.dye_status_actual_time ? new Date(r.dye_status_actual_time).toLocaleString('en-GB') : '',
      NO_DIE_Actual_Time: r.no_die_actual_time ? new Date(r.no_die_actual_time).toLocaleString('en-GB') : '',
      DIE_NOT_RECEIVED_Actual_Time: r.die_not_received_actual_time ? new Date(r.die_not_received_actual_time).toLocaleString('en-GB') : '',
      DIE_CUTTING_DONE_Actual_Time: r.die_cutting_done_actual_time ? new Date(r.die_cutting_done_actual_time).toLocaleString('en-GB') : '',
      DIE_SENT_Actual_Time: r.die_sent_actual_time ? new Date(r.die_sent_actual_time).toLocaleString('en-GB') : '',
      Block_Status: r.block_status || '',
      Block_Status_Actual_Time: r.block_status_actual_time ? new Date(r.block_status_actual_time).toLocaleString('en-GB') : '',
      NO_BLOCK_Actual_Time: r.no_block_actual_time ? new Date(r.no_block_actual_time).toLocaleString('en-GB') : '',
      BLOCK_NOT_RECEIVED_Actual_Time: r.block_not_received_actual_time ? new Date(r.block_not_received_actual_time).toLocaleString('en-GB') : '',
      BLOCK_PRINTED_Actual_Time: r.block_printed_actual_time ? new Date(r.block_printed_actual_time).toLocaleString('en-GB') : '',
      BLOCK_SENT_Actual_Time: r.block_sent_actual_time ? new Date(r.block_sent_actual_time).toLocaleString('en-GB') : '',
      Printing: r.printing || '',
      Edges: r.edges || '',
      Laser_Cutting: r.laser_cutting || '',
      No_Laser_Cutting_Actual_Time: r.no_laser_cutting_actual_time ? new Date(r.no_laser_cutting_actual_time).toLocaleString('en-GB') : '',
      Done_Laser_Cutting_Actual_Time: r.done_laser_cutting_actual_time ? new Date(r.done_laser_cutting_actual_time).toLocaleString('en-GB') : '',
      Pending_Laser_Cutting_Actual_Time: r.pending_laser_cutting_actual_time ? new Date(r.pending_laser_cutting_actual_time).toLocaleString('en-GB') : '',
      Output: r.output || '',
      No_Output_Actual_Time: r.no_output_actual_time ? new Date(r.no_output_actual_time).toLocaleString('en-GB') : '',
      Output_Done_Actual_Time: r.output_done_actual_time ? new Date(r.output_done_actual_time).toLocaleString('en-GB') : '',
      Output_Pending_Actual_Time: r.output_pending_actual_time ? new Date(r.output_pending_actual_time).toLocaleString('en-GB') : '',
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
      await updateProductionOrder(u.ID, u);
    }
    res.json({ success: true, count: updates.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper for bulk production
async function updateProductionOrder(orderId, u) {
  const now = new Date();
  const updates = {};

  const simpleMap = {
    Guest_Name: 'guest_name',
    Paper_Cutting: 'paper_cutting',
    Printing: 'printing',
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

    const [rows] = await db.query(`
      SELECT * FROM orders
      WHERE is_deleted = 0
        AND status_4 IS NOT NULL AND status_4 != ''
      ORDER BY id DESC
    `);

    const data = rows.map(r => ({
      ID: r.order_id,
      Timestamp: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB') : '',
      Dealer_name: r.dealer_name,
      Client_name: r.client_name,
      Dispatch_Courier_Name: r.courier || '',
      Docket_No: r.ups_dhl_fedex_tracking_number || '',
      Dispatch_Date: r.actual_4 ? new Date(r.actual_4).toLocaleString('en-GB') : '',
      Dispatch_Status: r.status_4,
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
router.get('/analytics', requireLogin, async (req, res) => {
  try {
    const user = req.session.user;
    const role = user.role || '';
    const email = user.email || '';
    const name = user.username || '';
    const canSeeAll = role === 'SuperAdmin' || role === 'Head' || user.domain === 'Head' ||
      role.includes('Production Manager');

    let query = `SELECT * FROM orders WHERE is_deleted = 0`;
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
          Date: r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB') : '',
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
    'Timestamp': r.timestamp ? new Date(r.timestamp).toLocaleString('en-GB') : '',
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
    'Actual_1': r.actual_1 ? new Date(r.actual_1).toLocaleString('en-GB') : '',
    'Design Approval Status From Client': r.design_approval_status_from_client,
    'Actual_2': r.actual_2 ? new Date(r.actual_2).toLocaleString('en-GB') : '',
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
    'Actual_4': r.actual_4 ? new Date(r.actual_4).toLocaleString('en-GB') : '',
    'Invoice Number': r.invoice_number,
    'Invoice Amount': r.invoice_amount,
    'Number of Boxes': r.number_of_boxes,
    'Weight': r.weight,
    'Volumetric Weigh': r.volumetric_weight,
  };
}

module.exports = router;
