const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../../config/db');
const { logOrderEvent } = require('../../utils/auditlog');
const { recordPunchedOrder } = require('../../utils/scot');
const { requireRole } = require('../../middleware/auth');
const { readRows, normalizeHeader, toCsv } = require('../../utils/sheet');
const { generateOrderIds } = require('../../utils/idgen');
const { STATUSES, matchStatus, mapStatus } = require('../../utils/recruitStatus');

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
// The answers the punch box offers. Not a whitelist any more: that box also
// takes a typed one, so a file carrying 'Tuesday 4 pm' is saying something the
// office can say by hand, and refusing it here would only send them to the
// single-order form to type the same thing. The list is still what the import
// page shows as the usual answers, and a value that matches one is normalised
// to its spelling so the column does not fill with 'eod' and 'EOD'.
const DESIGN_TIMES = ['10 Minutes', '30 Minutes', '1 Hour', '1.5 Hours', '2 Hours', '4 Hours', 'EOD'];

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
      // Whether this one is compulsory is the office's to decide, so it is not
      // marked required here - validate() asks the setting instead.
      { key: 'orderQuantity', header: 'Order Quantity', aliases: ['order qty', 'quantity', 'qty'], required: false },
      { key: 'addOns', header: 'Add Ons', aliases: ['add on', 'addons', 'addon'], required: false },
    ],
    // Spread across the samples: both punched-by values, several design times,
    // and a blank optional column — so the file answers "what goes here?"
    // without anyone having to read a separate note.
    samples: [
      ['orders@arabella.com', 'India Team', 'Sharma Traders', 'Hotel Grand', 'Menu card reprint', 'Ravi Kumar', '2 Hours', '250', 'RSVP Card x 50; Menu Card x 250'],
      ['orders@arabella.com', 'India Team', 'Verma Papers', 'Cafe Mocha', 'Wedding invite - gold foil', 'Priya Sharma', 'EOD', '120', 'Thank You Card x 120'],
      ['orders@arabella.com', 'India Team', 'Gupta Enterprises', 'Sunrise Hotel', '', 'Neha Sharma', '10 Minutes', '80', ''],
    ],
  },
  candidates: {
    label: 'Recruitment candidates',
    columns: [
      // On the sheet because the office's own copy has one. Nothing is done
      // with it: where a row sits in a file is not a fact about the person.
      { key: 'srNo', header: 'Sr. No', aliases: ['sr no', 'sno', 's no', 'serial no', '#'], required: false },
      { key: 'name', header: 'Name', aliases: ['candidate name', 'candidate'], required: true },
      { key: 'phone', header: 'Contact Number', aliases: ['contact no', 'contact', 'mobile', 'mobile no', 'phone', 'phone number'], required: false },
      // Not required, though it was at first, on the reasoning that every
      // letter this section sends goes to an address. The office's own list
      // settled it: 87 of its 206 rows have a phone number and no email,
      // because that is what a job board gives you. Refusing them kept 42% of
      // a real list out of the system to protect a letter nobody was trying to
      // send. A row with no address imports and can be called; the moment
      // somebody tries to write to them the portal refuses and says why.
      { key: 'email', header: 'Email', aliases: ['email address', 'email id'], required: false },
      { key: 'position', header: 'Position', aliases: ['profile', 'role', 'designation', 'position applied for'], required: false },
      { key: 'status', header: 'Status', aliases: ['stage'], required: false },
      // Where the candidate is, not where the job is.
      { key: 'location', header: 'Location', aliases: ['current location', 'city', 'candidate location', 'present location'], required: false },
      { key: 'salary', header: 'Expected Salary', aliases: ['salary', 'expected ctc', 'ctc', 'expected'], required: false },
      { key: 'notice', header: 'Notice Period', aliases: ['notice'], required: false },
      // Last, which is where the office's own sheet keeps it. The position in
      // the file does not actually matter - columns are found by their header,
      // not their order - but a sample file that reads like theirs is one less
      // thing to reconcile.
      { key: 'sourcing', header: 'Sourcing', aliases: ['source', 'sourced from', 'sourcing from'], required: false },
    ],
    // Spread across the samples: a full row, a row at a later stage, and one
    // with every optional column blank - so the file answers "what goes
    // here?" without anybody having to read a separate note.
    // The first row is Applied on purpose: a list being moved in is mostly
    // people nobody has arranged anything with yet, and a sample that showed
    // Scheduled would teach the wrong habit.
    // The third row has no email on purpose. That is the commonest row in a
    // real list - a name and a number off a job board - and the sample has to
    // show it imports, or somebody will go looking for addresses they do not
    // have before uploading.
    samples: [
      ['1', 'Kavita Nair', '9876500031', 'kavita@example.com', 'Accounts Executive', 'Applied', 'Jaipur', '4.5 LPA', '30 days', 'Indeed'],
      ['2', 'Imran Qureshi', '9876500032', 'imran@example.com', 'Production Manager', 'Selected', 'Udaipur', '7 LPA', 'Immediate', 'Naukri'],
      ['3', 'Deepak Joshi', '9876500033', '', 'Designer', 'not responding', '', '', '', ''],
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
function extract(type, values, sheetName) {
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

  // When a workbook is split into a tab per role - which is how the office
  // keeps theirs - the tab name is where the department is written down, and
  // for a row with an empty Position cell it is the only place it exists.
  // The cell wins where there is one: a tab is a filing decision, and the cell
  // is somebody saying what this particular person applied for.
  //
  // The caller only passes a name when the workbook actually has several tabs.
  // One sheet's name says nothing about anybody - it is "Sheet1", or whatever
  // a CSV got called on the way in - and writing that into a person's position
  // would be inventing data out of a filename.
  if (type === 'candidates' && !out.position && sheetName) out.position = sheetName;

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
  // Not a column on anybody's sheet: the Status cell as it was actually typed,
  // worked out during the preview and needed again at the insert. Everything
  // else here is rebuilt from the named columns, so without this one line the
  // caller's wording would not survive the trip through the browser.
  if (obj && obj.statusRaw !== undefined) out.statusRaw = String(obj.statusRaw || '').trim();
  return out;
}

/**
 * "RSVP Card x 50; Menu Card x 250" into rows.
 *
 * One cell has to carry a list of pairs, so the file needs a shape a person
 * can type. Semicolons separate the cards - names contain commas often enough
 * that a comma would split them in the wrong place - and x, * or : separates
 * the name from the number, because three offices will type three of them.
 *
 * Returns { rows } or { error }.
 */
function parseAddOnCell(raw) {
  const text = String(raw || '').trim();
  if (!text) return { rows: [] };

  const rows = [];
  const seen = new Set();
  for (const piece of text.split(/[;\n]+/)) {
    const part = piece.trim();
    if (!part) continue;
    const m = part.match(/^(.*?)\s*[x*:]\s*(\d+)$/i);
    if (!m) return { error: `Add Ons: "${part}" should read like "RSVP Card x 50"` };
    const name = m[1].trim();
    const qty = Number(m[2]);
    if (!name) return { error: `Add Ons: "${part}" has no card name` };
    if (qty < 1) return { error: `Add Ons: quantity for "${name}" must be 1 or more` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `Add Ons: "${name}" is listed twice` };
    seen.add(key);
    rows.push({ name, qty });
  }
  return { rows };
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
    if (time) data.designTime = time;

    // Not an error: the single-order form also stores an unknown dealer and
    // simply leaves the dealer email blank.
    if (data.dealer && context.dealerEmails && !context.dealerEmails.has(data.dealer.toLowerCase())) {
      warnings.push('Dealer not in master list — will import with no dealer email');
    }

    // Same rule the punch form follows, and from the same setting, so a file
    // cannot put in what the form would have refused.
    const qty = String(data.orderQuantity ?? '').trim();
    if (qty === '') {
      if (context.orderQuantityRequired) errors.push('Order Quantity is required');
    } else if (!/^\d+$/.test(qty) || Number(qty) < 1) {
      errors.push('Order Quantity must be a whole number of 1 or more');
    } else {
      data.orderQuantity = Number(qty);
    }

    const parsed = parseAddOnCell(data.addOns);
    if (parsed.error) {
      errors.push(parsed.error);
    } else {
      data.addOnRows = parsed.rows;
      const unknown = parsed.rows
        .filter(r => context.addOnNames && !context.addOnNames.has(r.name.toLowerCase()))
        .map(r => r.name);
      if (unknown.length) {
        warnings.push(`Not on the Add Ons list — will import anyway: ${unknown.join(', ')}`);
      }
    }
  }

  if (type === 'candidates') {
    // A space typed inside an address, which is the same slip that used to
    // split an order number in two: the office's own list had
    // "deepanshukumawat328@ gmail.com" on two rows, and both were turned away
    // for an address that is plainly correct and plainly fixable. No address
    // has a space in it, so removing them cannot change what was meant - and
    // it is done before the duplicate check, so the two rows now collapse into
    // the one person they always were.
    data.email = data.email.replace(/\s+/g, '');
    if (data.email && !EMAIL_RE.test(data.email)) errors.push('Email is not a valid email');

    // A sheet filled in by hand says "offer sent", "Offer  Sent" and "OFFER
    // SENT", and all three mean the same stage. It also says "not responding"
    // and "asking for WFH only", because the people keeping it are recording
    // phone calls, not moving cards along a board.
    //
    // This used to refuse anything that was not one of our stages, which read
    // as strictness and was really just a refusal to understand the file: of
    // the office's 206 rows, ten would have passed. mapStatus reads the intent
    // instead, and the cell's own wording is kept on the candidate so the
    // guess can be checked.
    // The cell as typed, kept under its own key rather than left in
    // data.status. validate() runs twice - once for the preview, once more on
    // import, over the rows the browser sends back - and the second pass sees
    // whatever the first one wrote. Mapping data.status in place meant the
    // import re-read "Rejected" as a literal stage and the caller's own words
    // were gone by the time there was a row to attach them to.
    if (data.statusRaw === undefined || data.statusRaw === '') data.statusRaw = data.status;

    const mapped = mapStatus(data.statusRaw);
    data.status = mapped.status;
    if (!mapped.matched) {
      warnings.push(`Read "${data.statusRaw}" as ${data.status} — the original wording is kept on the candidate`);
    }

    const key = dedupeKey('candidates', data);
    if (key !== null && context.existingCandidates && context.existingCandidates.has(key)) {
      // Naming the role matters: the same person under a different one is not
      // a duplicate, and without it this reads as a wrong answer.
      warnings.push('Already on the list for ' + (data.position || 'this role') + ' — this row will be skipped');
      data.__skip = true;
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

    const [addOns] = await db.query('SELECT name FROM add_ons');
    const [[qtyRule]] = await db.query(
      `SELECT value FROM app_settings WHERE name = 'order_quantity_required'`);

    return {
      dealerEmails,
      addOnNames: new Set(addOns.map(a => String(a.name || '').toLowerCase())),
      orderQuantityRequired: !qtyRule || qtyRule.value !== '0',
    };
  }
  if (type === 'candidates') {
    // Name and phone as well as the address, because dedupeKey falls back to
    // those for a candidate who has no address - and a check that only knew
    // about emails would wave the whole phone-only half of a re-uploaded
    // sheet straight back in.
    const [rows] = await db.query(
      'SELECT name, email, phone, profile_position FROM recruit_candidates WHERE is_deleted = 0');
    const existing = new Set();
    for (const r of rows) {
      const key = dedupeKey('candidates', r);
      if (key !== null) existing.add(key);
    }
    return { existingCandidates: existing };
  }
  if (type === 'dealers') {
    const [rows] = await db.query('SELECT name FROM dealers');
    return { existingNames: new Set(rows.map(r => String(r.name || '').toLowerCase())) };
  }
  const col = team === 'Cassie' ? 'overseas_name' : 'india_name';
  const [rows] = await db.query(`SELECT ${col} AS name FROM designers`);
  return { existingNames: new Set(rows.map(r => String(r.name || '').toLowerCase())) };
}

/**
 * What makes two rows the same person or thing, or null if nothing does.
 *
 * One function because there are two places that need it - the preview, which
 * warns about repeats inside the file, and the import, which drops them - and
 * they had drifted apart: the preview compared candidates by name while the
 * import compared them by email, so a file with one mailbox under two names
 * previewed clean and imported once.
 *
 * A candidate is one person FOR ONE ROLE, so the position is part of the key.
 *
 * That is the office's own unit, and it took seeing the whole workbook to
 * notice: 92 of their 1136 rows are somebody who appears under two roles -
 * considered as a Graphic Designer and again as an AI Manager - against only
 * 12 who are genuinely the same row twice. Keyed on the address alone, those
 * 92 kept their first role and lost the second, which also quietly broke the
 * department filter they are there to be found by: ask for AI Manager and four
 * of the five would not come back.
 *
 * Within a role, the address identifies the person. Where there is no address
 * - the common case, since phone-only rows import - it is the name and the
 * number together. Neither half of that pair would do alone: a blank email
 * keyed on its own would fold every phone-only row into one candidate, and the
 * name alone would merge two real people who happen to share one.
 */
function dedupeKey(type, data) {
  if (type === 'orders') return null;
  if (type === 'candidates') {
    // The role as typed, folded, since "Graphic Designer" and "Graphic
    // designer" are one role. Not the tab name: a candidate already in the
    // table has a position and no tab, and this key has to mean the same thing
    // on both sides of the comparison.
    const role = String(data.position || data.profile_position || '').trim().toLowerCase();
    const email = String(data.email || '').trim().toLowerCase();
    if (email) return 'e:' + email + '|' + role;
    const name = String(data.name || '').trim().toLowerCase();
    const phone = String(data.phone || '').replace(/\D/g, '');
    return name && phone ? 'np:' + name + '|' + phone + '|' + role : null;
  }
  return String(data.name || '').trim().toLowerCase() || null;
}

// Duplicates inside the file itself are invisible to a database check, since
// nothing has been inserted yet.
function flagInFileDuplicates(type, results) {
  if (type === 'orders') return;
  const seen = new Set();
  for (const r of results) {
    if (r.errors.length || r.data.__skip) continue;
    const key = dedupeKey(type, r.data);
    if (key === null) continue;
    if (seen.has(key)) {
      r.warnings.push('Duplicate of an earlier row in this file — will be skipped');
      r.data.__skip = true;
    } else {
      seen.add(key);
    }
  }
}

async function analyse(type, rows, team, tabsAreMeaningful) {
  const context = await buildContext(type, team);
  const results = rows.map(row => {
    const data = extract(type, row.values, tabsAreMeaningful ? row.sheet : '');
    const { errors, warnings } = validate(type, data, context);
    // The tab travels with the result: "row 42" is not a place anybody can go
    // and look in a workbook of eleven sheets.
    return { line: row.line, sheet: row.sheet, data, errors, warnings };
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
router.get('/columns/:type', canImport, async (req, res) => {
  const type = TYPES[req.params.type];
  if (!type) return res.status(404).json({ success: false, error: 'Unknown import type.' });

  // Order Quantity is the one column whose requiredness the office controls,
  // so the hint has to ask rather than read it off the spec - otherwise it
  // would say optional while the import refused the file.
  let qtyRequired = true;
  if (req.params.type === 'orders') {
    const [[row]] = await db.query(
      `SELECT value FROM app_settings WHERE name = 'order_quantity_required'`);
    qtyRequired = !row || row.value !== '0';
  }

  res.json({
    success: true,
    columns: type.columns.map(c => ({
      key: c.key,
      header: c.header,
      required: c.key === 'orderQuantity' ? qtyRequired : !!c.required,
      // Only a genuinely closed set goes in `allowed` - the format line prints
      // it as the values the column takes, and design time takes others now.
      // Only a genuinely closed set goes in `allowed`. Status left it when the
      // import started reading call outcomes: printing the seven stages as
      // "the values this column takes" would tell the office to go and rewrite
      // a column the import now understands as it stands.
      allowed: c.key === 'punchedBy' ? PUNCHED_BY : null,
      hint: c.key === 'addOns' ? 'e.g. RSVP Card x 50; Menu Card x 250'
        : c.key === 'designTime' ? 'e.g. ' + DESIGN_TIMES.slice(0, 3).join(', ') + ', or your own'
        : c.key === 'srNo' ? 'ignored — here so your own sheet imports unchanged'
        : c.key === 'status' ? STATUSES.join(', ') + ' — or your own call notes, which are read and kept'
        : c.key === 'email' ? 'leave blank if you only have a phone number'
        : c.key === 'location' ? 'where the candidate is, not where the job is'
        : c.key === 'notice' ? 'e.g. 30 days, Immediate'
        : c.key === 'sourcing' ? 'e.g. Indeed, Naukri, or the agency name'
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

    const { headers, rows, sheets } = await readRows(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ success: false, error: 'That file has headers but no data rows.' });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({
        success: false,
        error: `That file has ${rows.length} rows across ${sheets.length} sheet(s). `
          + `Import up to ${MAX_ROWS} at a time.`,
      });
    }

    const { results, summary } = await analyse(type, rows, req.body.team, sheets.length > 1);
    // sheets so the widget can say which tabs it read and how many rows each
    // gave. A workbook of eleven tabs that quietly imported one of them is the
    // failure this is here to make impossible to miss.
    res.json({ success: true, type, headers, sheets, summary, rows: results });
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
      const data = row.data ? fromKeys(type, row.data) : extract(type, row.values || {}, row.sheet);
      const { errors } = validate(type, data, context);

      if (errors.length) {
        rejected.push({ line: row.line, sheet: row.sheet, errors });
        continue;
      }
      if (data.__skip) continue;

      // Repeated inside the request too: buildContext only knows what was
      // already in the table, so two identical names in one payload would both
      // pass the database check.
      const key = dedupeKey(type, data);
      if (key !== null) {
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
        d.orderQuantity || null,
      ]);
      imported = await insertChunks(
        `INSERT INTO orders
           (order_id, email_address, order_punched_by, dealer_name, dealer_email,
            client_name, india_designer, overseas_designer, possible_design_time,
            special_remarks, upload_design_file, design_status, order_quantity)
         VALUES ?`,
        values,
      );

      // The cards each imported order carries. One statement for the whole
      // file rather than one per order - a 2000-row import would otherwise
      // spend longer on its add-ons than on the orders themselves.
      const addOnValues = [];
      valid.forEach((d, i) => {
        for (const a of (d.addOnRows || [])) addOnValues.push([ids[i], a.name, a.qty]);
      });
      if (addOnValues.length) {
        await insertChunks(
          'INSERT IGNORE INTO order_add_ons (order_id, name, qty) VALUES ?',
          addOnValues,
        );
      }

      // Imported orders get the same trail as punched ones, so the log can
      // answer "where did this row come from" months later.
      for (let i = 0; i < valid.length; i++) {
        await logOrderEvent(ids[i], 'Imported', (valid[i].dealer || '-') + ' / ' + (valid[i].client || '-'), req.session.user);
        const rows = valid[i].addOnRows || [];
        if (rows.length) {
          await logOrderEvent(ids[i], 'Add-ons',
            rows.map(a => `${a.name} x${a.qty}`).join(', '), req.session.user);
        }
      }

      // An import is a punch as far as the calling sheet is concerned. Once per
      // dealer, not once per order: a file of forty orders from one dealer
      // would otherwise rewrite the same row forty times over.
      for (const dealer of new Set(valid.map(v => String(v.dealer || '').trim()).filter(Boolean))) {
        await recordPunchedOrder(dealer);
      }
    } else if (type === 'candidates') {
      // Nothing is sent. This is an existing list arriving, and a hundred
      // people do not want an invitation to an interview they already had.
      // Letters start from the board, once somebody is looking at the row.
      imported = await insertChunks(
        `INSERT INTO recruit_candidates
           (name, email, phone, profile_position, status, current_location, salary,
            notice_period, sourcing, internal_remark, created_by)
         VALUES ?`,
        // internal_remark only carries the Status cell when it was not already
        // one of our stages. A row that said "Rejected" needs no remark - the
        // status says it - whereas "currently working not looking foe job" is
        // the only record of why, and the stage alone throws it away.
        valid.map(d => [d.name, d.email || '', d.phone || '', d.position || '', d.status,
                        d.location || '', d.salary || '', d.notice || '', d.sourcing || '',
                        (!d.statusRaw || matchStatus(d.statusRaw)) ? null : d.statusRaw,
                        req.session.user.id]),
      );
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
