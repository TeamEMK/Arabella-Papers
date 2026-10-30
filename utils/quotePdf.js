// ══════════════════════════════════════════════════════
// A QUOTE, AS A PDF
//
// What the customer downloads from the public calculator and what is
// attached to the email they get. Built on the server from the server's own
// figures - the same ones that were worked out again from the items - so the
// paper and the record always agree.
//
// Plain on purpose. It is a price, read once and forwarded to whoever
// approves the spend, so it has to survive being printed in black and white
// and read by somebody who was not there.
// ══════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const { TRADING_NAME, officeLines } = require('./office');

const GOLD = '#b08a3e';
const INK = '#1d1d1d';
const GREY = '#6b6b6b';

const money = (cur, v) => cur + ' ' + Number(v || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param {object} r   the engine's result
 * @param {object} who {name, email, store, brandLabel}
 * @returns {Promise<Buffer>}
 */
function buildQuotePdf(r, who) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const cur = r.currency || 'US$';
    const right = doc.page.width - 50;

    // ── Letterhead ──
    // The trading name, not the registered one. This goes to a customer,
    // and "Pvt. Ltd." was taken off the catalogue mail for the same reason:
    // it reads as a certificate of incorporation rather than a stationer.
    // The letterhead's own name is still there for the offer letter.
    doc.font('Times-Bold').fontSize(16).fillColor(INK)
       .text(TRADING_NAME.toUpperCase(), 50, 50);
    doc.font('Helvetica').fontSize(8).fillColor(GREY);
    let y = 52;
    for (const line of officeLines().slice(1)) {
      doc.text(line, right - 220, y, { width: 220, align: 'right' });
      y += 11;
    }
    doc.moveTo(50, 100).lineTo(right, 100).strokeColor(GOLD).lineWidth(1.5).stroke();

    doc.font('Times-Bold').fontSize(18).fillColor(INK)
       .text('Cost Summary', 50, 118);
    doc.font('Helvetica').fontSize(9).fillColor(GREY)
       .text((who.brandLabel || '') + ' price list  ·  '
         + new Date().toLocaleDateString('en-GB',
           { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' }),
         50, 140);

    // ── Who it is for ──
    let top = 162;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
    if (who.name) { doc.text(who.name, 50, top); top += 14; }
    doc.font('Helvetica').fontSize(9).fillColor(GREY);
    if (who.store) { doc.text(who.store, 50, top); top += 12; }
    if (who.email) { doc.text(who.email, 50, top); top += 12; }

    // ── The lines ──
    top += 10;
    doc.moveTo(50, top).lineTo(right, top).strokeColor('#dddddd').lineWidth(0.5).stroke();
    top += 12;

    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    (r.lines || []).forEach((line, i) => {
      // A line can run long - "2 Layer Invitation Cost(With Foil Printing;
      // Back: Digital Printing) = ..." - so it wraps rather than being cut.
      const text = (i + 1) + '.  ' + line;
      const h = doc.heightOfString(text, { width: right - 50 - 10 });
      if (top + h > doc.page.height - 120) { doc.addPage(); top = 60; }
      doc.text(text, 50, top, { width: right - 50 - 10 });
      top += h + 6;
    });

    // ── The money ──
    top += 8;
    doc.moveTo(50, top).lineTo(right, top).strokeColor('#dddddd').lineWidth(0.5).stroke();
    top += 14;

    const row = (label, value, opts) => {
      const o = opts || {};
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.big ? 12 : 10)
         .fillColor(o.bold ? INK : GREY);
      doc.text(label, right - 300, top, { width: 180, align: 'right' });
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK);
      doc.text(value, right - 120, top, { width: 120, align: 'right' });
      top += o.big ? 20 : 15;
    };

    row('Total', money(cur, r.total));
    if (r.baseDiscountPercent > 0) {
      row('Less (' + r.baseDiscountPercent + '%)', '- ' + money(cur, r.baseDiscountAmount));
    }
    if (r.additionalDiscountPercent > 0) {
      row('Less (' + r.additionalDiscountPercent + '%)', '- ' + money(cur, r.additionalDiscountAmount));
    }
    if (r.rushFeePercent > 0) {
      row('Rush fee (' + r.rushFeePercent + '%)', '+ ' + money(cur, r.rushFeeAmount));
    }
    top += 4;
    doc.moveTo(right - 300, top).lineTo(right, top).strokeColor(GOLD).lineWidth(1).stroke();
    top += 10;
    row('Balance', money(cur, r.balance), { bold: true, big: true });

    // ── Footer ──
    const foot = doc.page.height - 70;
    doc.moveTo(50, foot).lineTo(right, foot).strokeColor('#dddddd').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
       .text('An estimate from the ' + (r.ratesVersion || '') + ' price list, not an invoice. '
         + 'Prices are subject to confirmation of artwork, quantity and finishing.',
         50, foot + 8, { width: right - 50 });

    doc.end();
  });
}

module.exports = { buildQuotePdf };
