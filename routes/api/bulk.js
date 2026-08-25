const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { logOrderEvent } = require('../../utils/auditlog');
const { requireRole } = require('../../middleware/auth');
const { readRows, normalizeHeader, toCsv } = require('../../utils/sheet');
const { generateOrderIds } = require('../../utils/idgen');

// Vercel rejects request bodies over 4.5MB before they reach this handler.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Importing writes straight into shared data, so it stays with the roles that
// already own master data rather than everyone who can punch an order.
const canImport = requireRole('SuperAdmin', 'Head');

const MAX_ROWS = 2000;
const CHUNK = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cassie stopped punching orders; the overseas name lives on the old rows
// only. A bulk file naming it would create a new one.
const PUNCHED_BY = ['India Team'];
const DESIGN_TIMES = ['10 Minutes', '2 Hours', '4 Hours', 'EOD'];

// Accepts whichever of these the user's header says, so a sheet exported from
// the old system imports without being re-titled by hand.
const TYPES = {
  orders: {
    label: 'Orders',
    columns: [
      { key: 'email', header: 'Email Address', aliases: ['email'], required: true },
      { key: 'punchedBy', header: 'Order Punched By', aliases: ['punched by'], required: true },
      { key: 'dealer', header: 'Name of Dealer', aliases: ['dealer name', 'dealer'], required: true },
      { key: 'client', header: 'Client Name', aliases: ['client'], required: true },
      { key: 'remarks', header: 'Remarks / Subject Line', aliases: ['remarks', 'subject line', 'subject'], required: false },
      { key: 'designer', header: 'Designer', aliases: ['designer name'], required: true },
      { key: 'designTime', header: 'Possible Design Time', aliases: ['design time'], required: true },
    ],
    // Spread across the samples: both punched-by values, several design times,
    // and a blank optional column — so the file answers "what goes here?"
    // without anyone having to read a separate note.
    samples: [
      ['orders@arabella.com', 'India Team', 'Sharma Traders', 'Hotel Grand', 'Menu card reprint', 'Ravi Kumar', '2 Hours'],
      ['orders@arabella.com', 'India Team', 'Verma Papers', 'Cafe Mocha', 'Wedding invite - gold foil', 'Priya Sharma', 'EOD'],
      ['orders@arabella.com', 'India Team', 'Gupta Enterprises', 'Sunrise Hotel', '', 'Neha Sharma', '10 Minutes'],
    ],
  },
  dealers: {
    label: 'Dealers',
    columns: [
      { key: 'name', header: 'Dealer Name', aliases: ['name'], required: true },
      { key: 'email', header: 'Email', aliases: ['email address'], required: false },
      { key: 'mobile', header: 'Mobile No', aliases: ['mobile', 'mobile number', 'phone'], required: false },
    ],
    samples: [
      ['Sharma Traders', 'sharma@example.com', '9876543210'],
      ['Verma Papers', 'verma@example.com', '9811122233'],
      ['Gupta Enterprises', '', ''],
    ],
  },
  designers: {
    label: 'Designers',
    columns: [
      { key: 'name', header: 'Designer Name', aliases: ['name'], required: true },
      { key: 'email', header: 'Email', aliases: ['email address'], required: false },
    ],
    samples: [
      ['Ravi Kumar', 'ravi@example.com'],
      ['Neha Sharma', 'neha@example.com'],
      ['Amit Patel', ''],
    ],
  },
};

function matchOne(list, value) {
  const wanted = String(value || '').trim().toLowerCase();
  return list.find(item => item.toLowerCase() === wanted) || null;
}

// Pulls each configured column out of a parsed row by header or alias.
function extract(type, values) {
  const out = {};
  for (const col of TYPES[type].columns) {
    const names = [col.header, ...(col.aliases || [])].map(normalizeHeader);
    let found = '';
    for (const name of names) {
      if (values[name] !== undefined && values[name] !== '') {
        found = values[name];
        break;
      }
    }
    out[col.key] = String(found).trim();
  }
  return out;
}

// The preview hands the browser rows already keyed by field name, and those
// come back on import — they still get re-validated, just not re-extracted.
function fromKeys(type, obj) {
  const out = {};
  for (const col of TYPES[type].columns) {
    const v = obj ? obj[col.key] : '';
    out[col.key] = String(v === undefined || v === null ? '' : v).trim();
  }
  return out;
}

function validate(type, data, context) {
  const errors = [];
  const warnings = [];

  for (const col of TYPES[type].columns) {
    if (col.required && !data[col.key]) errors.push(col.header + ' is required');
  }

  if (type === 'orders') {
    if (data.email && !EMAIL_RE.test(data.email)) errors.push('Email Address is not a valid email');

    const punched = matchOne(PUNCHED_BY, data.punchedBy);
    if (data.punchedBy && !punched) {
      errors.push('Order Punched By must be "India Team"');
    } else if (punched) {
      data.punchedBy = punched;
    }

    const time = matchOne(DESIGN_TIMES, data.designTime);
    if (data.designTime && !time) {
      errors.push('Possible Design Time must be one of: ' + DESIGN_TIMES.join(', '));
    } else if (time) {
      data.designTime = time;
    }

    // Not an error: the single-order form also stores an unknown dealer and
    // simply leaves the dealer email blank.
    if (data.dealer && context.dealerEmails && !context.dealerEmails.has(data.dealer.toLowerCase())) {
      warnings.push('Dealer not in master list — will import with no dealer email');
    }
  }

  if (type === 'dealers' || type === 'designers') {
    if (data.email && !EMAIL_RE.test(data.email)) errors.push('Email is not a valid email');
    if (data.name && context.existingNames && context.existingNames.has(data.name.toLowerCase())) {
      warnings.push('Already exists — this row will be skipped');
      data.__skip = true;
    }
  }

  return { errors, warnings };
}

// `team` only matters for designers, whose India and Cassie names sit in
// different columns — checking a Cassie import against the India names would
// both miss real duplicates and reject names that are free on that side.
async function buildContext(type, team) {
  if (type === 'orders') {
    const [dealers] = await db.query('SELECT name, email FROM dealers');
    const dealerEmails = new Map();
    for (const d of dealers) dealerEmails.set(String(d.name || '').toLowerCase(), d.email || '');
    return { dealerEmails };
  }
  if (type === 'dealers') {
    const [rows] = await db.query('SELECT name FROM dealers');
    return { existingNames: new Set(rows.map(r => String(r.name || '').toLowerCase())) };
  }
  const col = team === 'Cassie' ? 'overseas_name' : 'india_name';
  const [rows] = await db.query(`SELECT ${col} AS name FROM designers`);
  return { existingNames: new Set(rows.map(r => String(r.name || '').toLowerCase())) };
}

// Duplicates inside the file itself are invisible to a database check, since
// nothing has been inserted yet.
function flagInFileDuplicates(type, results) {
  if (type === 'orders') return;
  const seen = new Set();
  for (const r of results) {
    if (r.errors.length || r.data.__skip) continue;
    const key = (r.data.name || '').toLowerCase();
    if (seen.has(key)) {
      r.warnings.push('Duplicate of an earlier row in this file — will be skipped');
      r.data.__skip = true;
    } else {
      seen.add(key);
    }
  }
}

async function analyse(type, rows, team) {
  const context = await buildContext(type, team);
  const results = rows.map(row => {
    const data = extract(type, row.values);
    const { errors, warnings } = validate(type, data, context);
    return { line: row.line, data, errors, warnings };
  });
  flagInFileDuplicates(type, results);

  return {
    results,
    summary: {
      total: results.length,
      ready: results.filter(r => !r.errors.length && !r.data.__skip).length,
      skipped: results.filter(r => !r.errors.length && r.data.__skip).length,
      invalid: results.filter(r => r.errors.length).length,
    },
  };
}

// GET /api/bulk/template/:type — a sample file showing the exact headers and
// the kind of value each column takes. Deliberately importable as-is: no
// comment or instruction rows, since anything extra becomes a broken row the
// moment someone edits this file and uploads it.
router.get('/template/:type', canImport, (req, res) => {
  const type = TYPES[req.params.type];
  if (!type) return res.status(404).json({ success: false, error: 'Unknown import type.' });

  const csv = toCsv([type.columns.map(c => c.header)].concat(type.samples));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-sample.csv"`);
  // Excel reads a plain UTF-8 CSV as the local codepage and mangles any
  // non-ASCII name; the BOM is what makes it open correctly on a double-click.
  res.send('﻿' + csv);
});

// GET /api/bulk/columns/:type — what the UI shows above the file picker
router.get('/columns/:type', canImport, (req, res) => {
  const type = TYPES[req.params.type];
  if (!type) return res.status(404).json({ success: false, error: 'Unknown import type.' });

  res.json({
    success: true,
    columns: type.columns.map(c => ({
      key: c.key,
      header: c.header,
      required: !!c.required,
      allowed: c.key === 'punchedBy' ? PUNCHED_BY
        : c.key === 'designTime' ? DESIGN_TIMES
        : null,
    })),
  });
});

// POST /api/bulk/preview — parse and validate, writing nothing
router.post('/preview', canImport, upload.single('file'), async (req, res) => {
  try {
    const type = req.body.type;
    if (!TYPES[type]) return res.status(400).json({ success: false, error: 'Choose what you are importing.' });
    if (!req.file) return res.status(400).json({ success: false, error: 'Attach a .xlsx or .csv file.' });

    const { headers, rows } = await readRows(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ success: false, error: 'That file has headers but no data rows.' });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({
        success: false,
        error: `That file has ${rows.length} rows. Import up to ${MAX_ROWS} at a time.`,
      });
    }

    const { results, summary } = await analyse(type, rows, req.body.team);
    res.json({ success: true, type, headers, summary, rows: results });
  } catch (err) {
    // An unreadable upload is the user's problem, not a fault — log the reason
    // without a stack so real failures stay visible in the logs.
    console.warn('Bulk preview rejected:', err.message);
    res.status(400).json({ success: false, error: err.message || 'Could not read that file.' });
  }
});

async function insertChunks(sql, values) {
  let inserted = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await db.query(sql, [chunk]);
    inserted += chunk.length;
  }
  return inserted;
}

// POST /api/bulk/import — re-validates before writing; the browser's copy of
// the rows is never trusted.
router.post('/import', canImport, async (req, res) => {
  try {
    const { type, rows, team } = req.body;
    if (!TYPES[type]) return res.status(400).json({ success: false, error: 'Choose what you are importing.' });
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, error: 'Nothing to import.' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ success: false, error: `Import up to ${MAX_ROWS} rows at a time.` });
    }

    const context = await buildContext(type, team);
    const valid = [];
    const rejected = [];
    const seen = new Set();

    for (const row of rows) {
      const data = row.data ? fromKeys(type, row.data) : extract(type, row.values || {});
      const { errors } = validate(type, data, context);

      if (errors.length) {
        rejected.push({ line: row.line, errors });
        continue;
      }
      if (data.__skip) continue;

      // Repeated inside the request too: buildContext only knows what was
      // already in the table, so two identical names in one payload would both
      // pass the database check.
      if (type !== 'orders') {
        const key = data.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
      }

      valid.push(data);
    }

    if (!valid.length) {
      return res.status(400).json({ success: false, error: 'No rows left to import.', rejected });
    }

    let imported = 0;

    if (type === 'orders') {
      const ids = await generateOrderIds(valid.length);
      const values = valid.map((d, i) => [
        ids[i],
        d.email,
        d.punchedBy,
        d.dealer,
        context.dealerEmails.get(d.dealer.toLowerCase()) || '',
        d.client,
        d.punchedBy === 'India Team' ? d.designer : null,
        d.punchedBy === 'Cassie' ? d.designer : null,
        d.designTime,
        d.remarks || '',
        'No Files',
        'Fresh Design',
      ]);
      imported = await insertChunks(
        `INSERT INTO orders
           (order_id, email_address, order_punched_by, dealer_name, dealer_email,
            client_name, india_designer, overseas_designer, possible_design_time,
            special_remarks, upload_design_file, design_status)
         VALUES ?`,
        values,
      );

      // Imported orders get the same trail as punched ones, so the log can
      // answer "where did this row come from" months later.
      for (let i = 0; i < valid.length; i++) {
        await logOrderEvent(ids[i], 'Imported', (valid[i].dealer || '-') + ' / ' + (valid[i].client || '-'), req.session.user);
      }
    } else if (type === 'dealers') {
      imported = await insertChunks(
        'INSERT INTO dealers (name, email, mobile) VALUES ?',
        valid.map(d => [d.name, d.email || '', d.mobile || '']),
      );
    } else {
      // Same rule as the single-designer route: the team picked in the modal
      // decides the column, since that is what marks an order India vs Cassie.
      const cols = team === 'Cassie'
        ? ['overseas_name', 'overseas_email']
        : ['india_name', 'india_email'];
      imported = await insertChunks(
        `INSERT INTO designers (${cols[0]}, ${cols[1]}) VALUES ?`,
        valid.map(d => [d.name, d.email || '']),
      );
    }

    const u = req.session.user;
    await db.query(
      'INSERT INTO activity_log (email, action, role, domain) VALUES (?,?,?,?)',
      [u.email, 'Bulk Import', u.role, u.domain],
    ).catch(() => {});

    res.json({ success: true, imported, rejected });
  } catch (err) {
    console.error('Bulk import failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Import failed.' });
  }
});

module.exports = router;
