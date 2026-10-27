const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendMail } = require('../utils/mailer');
const { COMPANY } = require('../utils/office');

// ══════════════════════════════════════════════════════
// DESIGN CATALOGUE — the public half
//
// The link the client gives their customers. No login, and nothing here
// reaches anything but the catalogue table: no orders, no clients, no names.
// Whatever the admin page puts up shows here on the next page load, and
// whatever it hides stops showing.
//
// Deliberately separate from routes/api/catalogue.js. The admin half is all
// behind requireLogin and a role check; keeping the two in one file is how
// an unguarded route eventually appears next to a guarded one and reads as
// though it were covered too.
// ══════════════════════════════════════════════════════

// GET /catalogue — the page.
router.get('/', (req, res) => {
  res.render('catalogue');
});

// GET /catalogue/api/items — only what is meant to be seen.
//
// is_active is filtered in SQL, not in the page. A hidden design must not
// travel to the browser at all: "not displayed" is not hidden when the reply
// is one right-click away.
router.get('/api/items', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, category, name, code
         FROM catalogue_items
        WHERE is_active = 1
        ORDER BY category, sort_order, id DESC`);
    res.json({
      success: true,
      categories: [...new Set(rows.map(r => r.category))],
      data: rows,
    });
  } catch (err) {
    console.error('Public catalogue failed:', err);
    res.status(500).json({ success: false, error: 'Could not load the catalogue just now.' });
  }
});

// GET /catalogue/image/:id — the picture itself.
router.get('/image/:id', async (req, res) => {
  try {
    const [[item]] = await db.query(
      'SELECT mime_type, bytes FROM catalogue_items WHERE id = ? AND is_active = 1',
      [parseInt(req.params.id, 10)]);
    // A hidden item answers exactly as a missing one does. Anything else and
    // the gap between the two says which ids are real.
    if (!item || !item.bytes) return res.status(404).send('Not found.');

    res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', item.bytes.length);
    // A catalogue picture changes about never, and this page is meant to be
    // opened by a lot of people who are not paying for the bandwidth.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(item.bytes);
  } catch (err) {
    console.error('Catalogue image failed:', err);
    res.status(500).send('Could not load that image.');
  }
});

// ══════════════════════════════════════════════════════
// EMAILING A SELECTION
//
// A customer ticks the designs they like and has them sent to themselves,
// with a copy to the office so somebody there knows what was asked for.
//
// This is the one public route that can make the server send mail, so what it
// will and will not do is deliberately narrow:
//
//   * There is no message field. The customer cannot put words in the mail,
//     only pick designs from the catalogue, so it cannot be used to deliver
//     somebody else's text to somebody else's inbox.
//   * The ids are looked up and only live ones are used, so a hidden design
//     cannot be mailed out by quoting its number.
//   * A few sends per address per hour, which is more than any real customer
//     needs and not enough to flood an inbox with.
// ══════════════════════════════════════════════════════

const MAX_PICKS = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDS = new Map();
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS = 5;

function sentTooOften(ip) {
  const now = Date.now();
  const seen = (SENDS.get(ip) || []).filter(t => now - t < SEND_WINDOW_MS);
  seen.push(now);
  SENDS.set(ip, seen);
  if (SENDS.size > 2000) {
    for (const [k, v] of SENDS) if (!v.length || now - v[v.length - 1] > SEND_WINDOW_MS) SENDS.delete(k);
  }
  return seen.length > MAX_SENDS;
}

function siteUrl(req) {
  // Whatever host the customer actually reached us on, so the links in the
  // mail work from the domain they were already using.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

function pickedHtml(rows, base) {
  const cells = rows.map(r => `
    <td style="padding:0 10px 22px 0;vertical-align:top;width:170px">
      <div style="border:1px solid #e6e8eb;border-radius:10px;overflow:hidden;background:#fff">
        <div style="height:150px;background:#fcfcfd;text-align:center;line-height:150px">
          <img src="${base}/catalogue/image/${r.id}" alt="${r.name || r.category}"
               style="max-width:150px;max-height:140px;vertical-align:middle">
        </div>
        <div style="padding:9px 11px;border-top:1px solid #e6e8eb">
          <div style="font:500 13px Helvetica,Arial,sans-serif;color:#1b1f23">${r.name || r.category}</div>
          <div style="font:400 11px Helvetica,Arial,sans-serif;color:#6c757d;margin-top:2px">
            ${r.category}${r.code ? ' &middot; ' + r.code : ''}
          </div>
        </div>
      </div>
    </td>`);

  // A table of rows of three, because an email client is not a browser and
  // flexbox is not to be relied on in one.
  let out = '';
  for (let i = 0; i < cells.length; i += 3) {
    out += '<tr>' + cells.slice(i, i + 3).join('') + '</tr>';
  }
  return '<table cellpadding="0" cellspacing="0" border="0">' + out + '</table>';
}

// POST /catalogue/api/email
router.post('/api/email', express.json(), async (req, res) => {
  try {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',');
    const ip = (chain[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
    if (sentTooOften(ip)) {
      return res.status(429).json({
        success: false,
        error: 'That is a few emails in a short time. Please try again a little later.',
      });
    }

    const email = String((req.body && req.body.email) || '').trim();
    if (!EMAIL_RE.test(email)) {
      return res.json({ success: false, error: 'That does not look like an email address.' });
    }

    const ids = Array.isArray(req.body && req.body.ids)
      ? [...new Set(req.body.ids.map(n => parseInt(n, 10)).filter(Number.isInteger))]
      : [];
    if (!ids.length) return res.json({ success: false, error: 'Pick a design first.' });
    if (ids.length > MAX_PICKS) {
      return res.json({ success: false, error: `Up to ${MAX_PICKS} designs at a time.` });
    }

    // is_active again, so a design taken down cannot be mailed out by id.
    const [rows] = await db.query(
      `SELECT id, category, name, code FROM catalogue_items
        WHERE is_active = 1 AND id IN (?) ORDER BY category, sort_order, id`, [ids]);
    if (!rows.length) return res.json({ success: false, error: 'Those designs are no longer available.' });

    const base = siteUrl(req);
    const list = rows.map(r => `${r.category}${r.code ? ' — ' + r.code : ''}${r.name ? ' (' + r.name + ')' : ''}`);

    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;color:#1b1f23;max-width:620px">
        <div style="letter-spacing:.2em;font-size:12px;color:#5A6E96;font-weight:600">${COMPANY.toUpperCase()}</div>
        <h2 style="font-weight:500;margin:14px 0 6px">The designs you picked</h2>
        <p style="color:#6c757d;font-size:14px;margin:0 0 22px">
          ${rows.length} ${rows.length === 1 ? 'design' : 'designs'} from our catalogue.
          Quote the code when you place your order.
        </p>
        ${pickedHtml(rows, base)}
        <p style="font-size:13px;color:#6c757d;margin-top:14px">
          The full catalogue is at <a href="${base}/catalogue" style="color:#5A6E96">${base.replace(/^https?:\/\//, '')}/catalogue</a>.
        </p>
      </div>`;

    const text = 'The designs you picked from the ' + COMPANY + ' catalogue:\n\n'
      + list.map(l => '  - ' + l).join('\n')
      + '\n\nQuote the code when you place your order.\n'
      + 'The full catalogue: ' + base + '/catalogue\n';

    const sent = await sendMail({
      to: email,
      subject: `Your selection from the ${COMPANY} catalogue`,
      html,
      text,
    });
    if (!sent || sent.sent === false) {
      return res.json({ success: false, error: 'The email could not be sent just now. Please try again.' });
    }

    // The office's copy, so somebody knows what a customer asked about before
    // they ring up. Sent separately and never allowed to fail the customer's:
    // their mail has already gone, and telling them otherwise would be wrong.
    const office = process.env.CATALOGUE_NOTIFY_TO || process.env.MAIL_FROM;
    if (office) {
      sendMail({
        to: office,
        subject: `Catalogue selection sent to ${email}`,
        text: email + ' asked for these from the catalogue:\n\n'
          + list.map(l => '  - ' + l).join('\n') + '\n',
      }).catch(() => {});
    }

    res.json({ success: true, sent: rows.length });
  } catch (err) {
    console.error('Catalogue email failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
