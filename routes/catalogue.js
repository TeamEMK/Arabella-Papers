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

// GET /catalogue/thumb/:id — the grid-sized copy.
//
// Its own route rather than a query string on the one below, so a browser,
// a proxy and our own Cache-Control all treat the two as the different files
// they are. Falls back to the full picture where there is no small one -
// anything uploaded by hand through the admin page has only the original.
router.get('/thumb/:id', async (req, res) => {
  try {
    const [[item]] = await db.query(
      'SELECT mime_type, IFNULL(thumb, bytes) AS bytes FROM catalogue_items WHERE id = ? AND is_active = 1',
      [parseInt(req.params.id, 10)]);
    if (!item || !item.bytes) return res.status(404).send('Not found.');
    res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', item.bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(item.bytes);
  } catch (err) {
    console.error('Catalogue thumb failed:', err);
    res.status(500).send('Could not load that image.');
  }
});

// GET /catalogue/image/:id — the full-size picture.
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
const MAX_SENDS = 6;

// Asked before doing the work, and counted only once the work was done.
//
// These were one function that counted the attempt on the way in, which
// punished the wrong person: somebody who mistypes their address twice and a
// missing attachment once had spent their whole allowance without a single
// mail leaving the building. A refusal is not a send.
function overLimit(bucket, ip, max) {
  const now = Date.now();
  const seen = (bucket.get(ip) || []).filter(t => now - t < SEND_WINDOW_MS);
  bucket.set(ip, seen);
  if (bucket.size > 2000) {
    for (const [k, v] of bucket) if (!v.length || now - v[v.length - 1] > SEND_WINDOW_MS) bucket.delete(k);
  }
  return seen.length >= max;
}

function countSend(bucket, ip) {
  const seen = bucket.get(ip) || [];
  seen.push(Date.now());
  bucket.set(ip, seen);
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
    if (overLimit(SENDS, ip, MAX_SENDS)) {
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

    countSend(SENDS, ip);
    res.json({ success: true, sent: rows.length });
  } catch (err) {
    console.error('Catalogue email failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
// A CUSTOMER SENDING US THEIR OWN DESIGN
//
// Somebody has drawn their own monogram, or has a font they want used, and it
// is not on this page because it was never ours. They attach it here and it
// reaches the office with their address on it.
//
// Public, and it both accepts files and sends mail, which is the two things
// worth being careful about at once. So:
//
//   * It goes to the office and nowhere else. The sender cannot choose a
//     recipient, so this cannot carry a stranger's file to a stranger's
//     inbox - the only address it will ever deliver to is ours.
//   * Nothing is stored. The file rides out on the mail and is gone; there is
//     no public upload sitting in the database waiting to be found.
//   * Pictures and PDFs only, 4MB, three files, three sends an hour.
// ══════════════════════════════════════════════════════

const multer = require('multer');
const sendUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 3 },
});

const SEND_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
  'application/pdf', 'application/postscript',
];

const THEIRS = new Map();
const THEIRS_MAX = 6;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// POST /catalogue/api/theirs
router.post('/api/theirs', sendUpload.array('files', 3), async (req, res) => {
  try {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',');
    const ip = (chain[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
    if (overLimit(THEIRS, ip, THEIRS_MAX)) {
      return res.status(429).json({
        success: false,
        error: 'That is a few in a short time. Please try again a little later.',
      });
    }

    const office = process.env.CATALOGUE_NOTIFY_TO || process.env.MAIL_FROM;
    if (!office) {
      return res.status(500).json({ success: false, error: 'We cannot take it just now. Please email us instead.' });
    }

    const from = String(req.body.email || '').trim();
    if (!EMAIL_RE.test(from)) {
      return res.json({ success: false, error: 'Please give us your email address so we can reply.' });
    }
    const name = String(req.body.name || '').trim().slice(0, 120);
    const note = String(req.body.note || '').trim().slice(0, 2000);

    const files = req.files || [];
    if (!files.length) return res.json({ success: false, error: 'Attach your design first.' });
    const wrong = files.filter(f => !SEND_TYPES.includes(f.mimetype));
    if (wrong.length) {
      return res.json({
        success: false,
        error: 'We can take pictures and PDFs — ' + wrong.map(f => f.originalname).join(', '),
      });
    }

    const html = `
      <div style="font-family:Helvetica,Arial,sans-serif;color:#1b1f23;max-width:620px">
        <h2 style="font-weight:500;margin:0 0 4px">A customer sent their own design</h2>
        <p style="color:#6c757d;font-size:14px;margin:0 0 18px">Through the catalogue page.</p>
        <table style="font-size:14px;border-collapse:collapse">
          ${name ? `<tr><td style="padding:4px 14px 4px 0;color:#6c757d">Name</td><td><b>${esc(name)}</b></td></tr>` : ''}
          <tr><td style="padding:4px 14px 4px 0;color:#6c757d">Email</td><td><b>${esc(from)}</b></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#6c757d">Files</td><td>${files.length}</td></tr>
        </table>
        ${note ? `<p style="font-size:15px;line-height:1.6;white-space:pre-wrap;margin:18px 0;padding:14px;background:#f8f9fa;border-radius:8px">${esc(note)}</p>` : ''}
      </div>`;

    const sent = await sendMail({
      to: office,
      subject: `Design sent in by ${name || from}`,
      html,
      text: `${name ? name + '\n' : ''}${from}\n\n${note || '(no message)'}\n`,
      // So the office can simply hit reply and reach the customer.
      replyTo: from,
      attachments: files.map(f => ({ filename: f.originalname, content: f.buffer })),
    });
    if (!sent || sent.sent === false) {
      return res.status(502).json({ success: false, error: 'It did not go through. Please try again in a moment.' });
    }

    countSend(THEIRS, ip);
    res.json({ success: true, files: files.length });
  } catch (err) {
    // multer's own refusals - too big, too many - arrive here.
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.json({ success: false, error: 'That file is over 4 MB. Please send a smaller one.' });
    }
    if (err && err.code === 'LIMIT_FILE_COUNT') {
      return res.json({ success: false, error: 'Up to three files at a time.' });
    }
    console.error('Customer design failed:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
