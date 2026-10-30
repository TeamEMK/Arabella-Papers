const express = require('express');
const router = express.Router();
const db = require('../config/db');
const pricing = require('../utils/pricing');
const { buildQuotePdf } = require('../utils/quotePdf');
const { sendMail } = require('../utils/mailer');
const { TRADING_NAME } = require('../utils/office');

// ══════════════════════════════════════════════════════
// THE PUBLIC PRICE CALCULATOR
//
// Two links, one per brand, that a customer can open with no login:
//
//   /quote/arabella   priced from the ARABELLA (ARB) list
//   /quote/kpc        priced from the KPC list
//
// The brand is the link, not a dropdown. Somebody sent the Arabella link
// should not be able to switch themselves onto the other price list, and a
// dealer handed one should not have to understand there are two.
//
// A name and an email are asked for before the calculator opens. That is the
// whole of what the office gets out of this: who is pricing what.
//
// What a stranger can reach is the same arithmetic and the same rate list
// the browser already downloads on the internal page - public/pricing is
// served to anyone - so this exposes no number that was not already out. It
// writes rows to the database, though, which is why it is rate limited.
// ══════════════════════════════════════════════════════

// Each link names the copy of the module that prices it, because they are
// not the same price list. Arabella is on the office's own customer build,
// which shows list price with no discount; KPC is on the older shared one
// until its build arrives.
//
// The copy is part of the link, not a setting, so a page cannot be drawn by
// one engine and priced by another.
const BRANDS = {
  arabella: {
    code: 'ARA', label: 'ARABELLA (ARB)',
    assets: 'pricing-arabella', pricing: pricing.forArabella,
    // Their build's own words, from the mount call at the foot of the file
    // they sent. Theirs, not ours to reword.
    wordmark: 'ARABELLA PAPERS',
    title: 'Wedding stationery price estimate',
  },
  kpc: {
    code: 'KPC', label: 'KPC',
    assets: 'pricing-kpc', pricing: pricing.forKpc,
    wordmark: 'KPC',
    title: 'Wedding stationery price estimate',
  },
};

// Enough for somebody pricing a real job several ways over, and nowhere near
// enough to fill the table from a script.
const MAX_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60 * 1000;
const HITS = new Map();

function overLimit(ip) {
  const now = Date.now();
  const seen = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  HITS.set(ip, seen);
  if (HITS.size > 5000) {
    for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > WINDOW_MS) HITS.delete(k);
  }
  return seen.length >= MAX_PER_WINDOW;
}
function countSend(ip) {
  const seen = HITS.get(ip) || [];
  seen.push(Date.now());
  HITS.set(ip, seen);
}
function callerIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',');
  return (chain[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
}

const text = (v, n) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s ? s.slice(0, n) : '';
};

// Deliberately loose. This is a lead, not a login: refusing somebody over a
// new top-level domain costs more than letting one bad address through.
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

// GET /quote/:brand — the page.
router.get('/:brand', (req, res, next) => {
  const brand = BRANDS[String(req.params.brand || '').toLowerCase()];
  if (!brand) return next();
  res.render('quote', {
    brandCode: brand.code,
    brandLabel: brand.label,
    brandSlug: String(req.params.brand).toLowerCase(),
    assets: brand.assets,
    wordmark: brand.wordmark,
    pageTitle: brand.title,
  });
});

/**
 * POST /quote/:brand/api/send
 *
 * One endpoint behind both buttons. Copy and Download do the same three
 * things - price it here, keep it, send it - and differ only in what comes
 * back, because a quote the customer walked away with should be a quote the
 * office can see either way.
 */
router.post('/:brand/api/send', express.json({ limit: '256kb' }), async (req, res) => {
  const brand = BRANDS[String(req.params.brand || '').toLowerCase()];
  if (!brand) return res.status(404).json({ success: false, error: 'No such price list.' });

  try {
    const ip = callerIp(req);
    if (overLimit(ip)) {
      return res.status(429).json({
        success: false,
        error: 'That is a lot of quotes in a short while. Please try again later.',
      });
    }

    const body = req.body || {};
    const name = text(body.name, 200);
    const email = text(body.email, 255);
    if (!name) return res.json({ success: false, error: 'Please give your name.' });
    if (!looksLikeEmail(email)) return res.json({ success: false, error: 'Please give a working email address.' });

    // The brand comes from the link, never from what was posted. Otherwise
    // the Arabella link prices on the KPC list for anybody who asks it to.
    let checked;
    try {
      checked = brand.pricing.verify(
        {
          brand: brand.code,
          additionalDiscount: body.additionalDiscount,
          rushFee: body.rushFee,
          items: body.items,
        },
        body.totals,
      );
    } catch (err) {
      return res.json({ success: false, error: err.message });
    }
    if (!checked.ok) return res.json({ success: false, error: checked.error });

    const r = checked.result;
    const who = { store: text(body.store, 200), customer: name };
    const summary = brand.pricing.summary(r, who);

    const [out] = await db.query(
      `INSERT INTO pricing_quotes
         (order_id, brand, store_name, customer_name, customer_email, total,
          base_discount_amount, additional_discount_amount, rush_fee_percent,
          rush_fee_amount, balance, summary_text, quote_json, rates_version,
          created_by, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        null, r.brand, who.store || null, name, email,
        r.total, r.baseDiscountAmount, r.additionalDiscountAmount,
        r.rushFeePercent || 0, r.rushFeeAmount || 0, r.balance,
        summary,
        JSON.stringify({
          brand: r.brand,
          additionalDiscount: r.additionalDiscountPercent,
          rushFee: r.rushFeePercent || 0,
          items: body.items,
        }),
        r.ratesVersion || null,
        email, 'public',
      ],
    );
    countSend(ip);

    const pdf = await buildQuotePdf(r, {
      name, email, store: who.store, brandLabel: brand.label,
    });

    // To the customer only. The office reads these off the saved quotes
    // rather than out of its inbox.
    const mail = await sendMail({
      to: email,
      subject: `Your cost summary from ${TRADING_NAME}`,
      html: mailHtml(r, name, brand.label),
      text: summary,
      attachments: [{ filename: 'Arabella-Quote-' + out.insertId + '.pdf', content: pdf }],
    }).catch(err => {
      // A mail that does not go is not a reason to lose the quote or to
      // refuse the download - the customer is standing there waiting for it.
      console.error('[quote] mail failed:', err.message);
      return { sent: false };
    });

    res.json({
      success: true,
      id: out.insertId,
      summary,
      emailed: !!mail.sent,
      pdf: pdf.toString('base64'),
    });
  } catch (err) {
    console.error('Public quote failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mailHtml(r, name, brandLabel) {
  const cur = r.currency || 'US$';
  const money = (v) => cur + ' ' + Number(v || 0).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lines = (r.lines || []).map((l, i) =>
    `<tr><td style="padding:6px 0;color:#555;width:22px;">${i + 1}.</td>
         <td style="padding:6px 0;">${esc(l)}</td></tr>`).join('');

  const row = (label, value, bold) => `
    <tr>
      <td style="padding:4px 0;color:#666;">${esc(label)}</td>
      <td style="padding:4px 0;text-align:right;${bold ? 'font-weight:700;font-size:17px;' : ''}">${esc(value)}</td>
    </tr>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#222;">
    <div style="letter-spacing:.2em;font-size:12px;color:#b08a3e;font-weight:700;">
      ${esc(TRADING_NAME.toUpperCase())}
    </div>
    <h2 style="margin:6px 0 2px;">Your cost summary</h2>
    <p style="margin:0 0 18px;color:#666;">${esc(brandLabel)} price list</p>
    <p style="margin:0 0 14px;">Dear ${esc(name)}, here is the quote you put together. The same thing is attached as a PDF.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${lines}</table>
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${row('Total', money(r.total))}
      ${r.baseDiscountPercent > 0 ? row('Less (' + r.baseDiscountPercent + '%)', '- ' + money(r.baseDiscountAmount)) : ''}
      ${r.additionalDiscountPercent > 0 ? row('Less (' + r.additionalDiscountPercent + '%)', '- ' + money(r.additionalDiscountAmount)) : ''}
      ${r.rushFeePercent > 0 ? row('Rush fee (' + r.rushFeePercent + '%)', '+ ' + money(r.rushFeeAmount)) : ''}
      ${row('Balance', money(r.balance), true)}
    </table>
    <p style="margin:18px 0 0;color:#666;font-size:12px;">
      An estimate from the ${esc(r.ratesVersion || '')} price list, not an invoice.
      Prices are subject to confirmation of artwork, quantity and finishing.
    </p>
  </div>`;
}

module.exports = router;
