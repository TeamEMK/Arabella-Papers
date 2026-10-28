// ══════════════════════════════════════════════════════
// PRICING QUOTES
//
// Saving, listing and reopening what a job was quoted at. The arithmetic is
// in utils/pricing.js, which re-prices everything before it is stored - see
// the note there for why the browser's own totals are not taken on trust.
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const { canSee } = require('../../utils/access');
const pricing = require('../../utils/pricing');

// The tab is permission-checked when it is opened; so is every call behind
// it, because a page that was taken away is still a URL somebody has.
async function allowed(req, res, next) {
  try {
    if (await canSee(req.session.user, 'pricing')) return next();
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  } catch (err) {
    console.error('Pricing access check failed:', err.message);
    return res.status(500).json({ success: false, error: 'Could not check access.' });
  }
}

const text = (v, n) => String(v === null || v === undefined ? '' : v).trim().slice(0, n);

// POST /api/pricing/quote — price it here, then keep it.
router.post('/quote', requireLogin, allowed, async (req, res) => {
  try {
    const body = req.body || {};

    let checked;
    try {
      checked = pricing.verify(
        { brand: body.brand, additionalDiscount: body.additionalDiscount, items: body.items },
        body.totals,
      );
    } catch (err) {
      // A bad brand, an empty basket, an unknown item code: the engine's own
      // message is the useful one, so it goes through.
      return res.json({ success: false, error: err.message });
    }
    if (!checked.ok) {
      console.warn('[pricing] figures rejected:', JSON.stringify({
        by: req.session.user.email, field: checked.field,
        server: checked.server, sent: checked.sent,
      }));
      return res.json({ success: false, error: checked.error });
    }

    const r = checked.result;
    const who = { store: text(body.store, 200), customer: text(body.customer, 200) };

    const [out] = await db.query(
      `INSERT INTO pricing_quotes
         (order_id, brand, store_name, customer_name, total, base_discount_amount,
          additional_discount_amount, balance, summary_text, quote_json, rates_version, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        text(body.orderId, 50) || null, r.brand, who.store || null, who.customer || null,
        r.total, r.baseDiscountAmount, r.additionalDiscountAmount, r.balance,
        pricing.summary(r, who),
        JSON.stringify({ brand: r.brand, additionalDiscount: r.additionalDiscountPercent, items: body.items }),
        r.ratesVersion || null,
        req.session.user.email || '',
      ],
    );

    res.json({ success: true, id: out.insertId, quote: r, summary: pricing.summary(r, who) });
  } catch (err) {
    console.error('Saving a quote failed:', err);
    res.status(500).json({ success: false, error: 'Could not save the quote.' });
  }
});

// GET /api/pricing/quotes?orderId=&q=&limit=
router.get('/quotes', requireLogin, allowed, async (req, res) => {
  try {
    const where = [];
    const args = [];
    const orderId = text(req.query.orderId, 50);
    if (orderId) { where.push('order_id = ?'); args.push(orderId); }
    const q = text(req.query.q, 120);
    if (q) {
      where.push('(store_name LIKE ? OR customer_name LIKE ? OR order_id LIKE ?)');
      args.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const [rows] = await db.query(
      `SELECT id, order_id, brand, store_name, customer_name, total,
              base_discount_amount, additional_discount_amount, balance,
              rates_version, created_by, created_at
         FROM pricing_quotes
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC
        LIMIT ${limit}`,
      args,
    );

    res.json({
      success: true,
      // Formatted here, because sending a Date turns it into UTC on the way
      // and the page reads it back five and a half hours early.
      rows: rows.map(r => Object.assign({}, r, {
        created_at: new Date(r.created_at).toLocaleString('en-GB',
          { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
      })),
    });
  } catch (err) {
    console.error('Listing quotes failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the quotes.' });
  }
});

// GET /api/pricing/quote/:id — one quote, with what was asked for, so it can
// be reopened in the calculator and amended rather than rebuilt.
router.get('/quote/:id', requireLogin, allowed, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pricing_quotes WHERE id = ? LIMIT 1',
      [Number(req.params.id) || 0]);
    if (!rows.length) return res.json({ success: false, error: 'No such quote.' });
    const r = rows[0];
    let items = null;
    try { items = JSON.parse(r.quote_json || 'null'); } catch (e) {}
    res.json({ success: true, quote: r, input: items });
  } catch (err) {
    console.error('Reading a quote failed:', err);
    res.status(500).json({ success: false, error: 'Could not read the quote.' });
  }
});

module.exports = router;
