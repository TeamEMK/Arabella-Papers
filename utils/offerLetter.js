const PDFDocument = require('pdfkit');
const { COMPANY, LETTERHEAD } = require('./office');

// ══════════════════════════════════════════════════════
// THE OFFER LETTER
//
// Built as a PDF rather than filled into the Word file it came from. Nothing
// on this host can turn a .docx into a PDF — that needs LibreOffice or Word,
// and the app runs as a serverless function with neither — so the letter is
// drawn here instead, to the same page it was written on: US Letter, one inch
// top and bottom, three quarters at the sides, Times New Roman at 12pt.
//
// The wording below is the office's own, word for word out of
// "Arabella Final Offer Letter.docx". It says what a candidate is being
// offered and what they must bring, so it is not ours to improve: change the
// text here only when the office changes the letter.
//
// Two things in the template were left as they were found and are worth
// knowing about: it says nothing about salary — "on the terms and conditions
// as mutually discussed" is the whole of it — and the documents list ends with
// "Any other bank account", which reads like a line that was being edited when
// the file was last saved.
// ══════════════════════════════════════════════════════

// Whoever signs. In the letter rather than in the database because one person
// signs all of them, and a name that changes twice a decade is not a field
// somebody should have to fill in every time.
const SIGNATORY = {
  name: 'Laveena Shrivastava',
  email: 'Laveena@arabellapapers.com',
  phone: '+91 87644 43333',
};

// The blanks in the template read ___/___/2026, so the dates that fill them
// are written the same way round rather than as "26 September".
function dmy(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return String(d);
  const p = n => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

// Everything the candidate is told to bring on their first day, in the order
// the template lists it. The empty bullet sitting in the middle of the Word
// file is not reproduced — it is an editing artefact, not an instruction.
const DOCUMENTS = [
  'Six Passport Size Photographs with a white background.',
  'All Educational/Vocational degrees/certificates in original with a photocopy, or.',
  'Appointment letter with Annexure (salary break-up) of the current/previous entity.',
  'Resignation & Relieving Letter from previous employer.',
  'PAN Card.',
  'Aadhaar Card.',
  'Bank Details with Account Number (for salary payment process).',
  'Last 3 months Bank Statement (for salary verification).',
  'Last 3 months Salary Slips.',
  'Address Proof.',
  'Any other bank account.',
];

const INK = '#000000';
const SIZE = 12;
const LEAD = 1.35;

/**
 * @param {object} c        the candidate row
 * @param {object} [joining] their onboarding form answers, when they have been
 *                           sent back — that is the only place the app ever
 *                           learns a candidate's home address
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
function buildOfferLetter(c, joining) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 72, bottom: 72, left: 54, right: 54 },
    bufferPages: true,           // so the page numbers can be written at the end
    info: {
      Title: `Offer Letter - ${c.name || ''}`,
      Author: COMPANY,
      Subject: 'Offer of employment',
    },
  });

  const chunks = [];
  doc.on('data', ch => chunks.push(ch));
  const done = new Promise(resolve => doc.on('end', resolve));

  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const body = () => doc.font('Times-Roman').fontSize(SIZE).fillColor(INK);
  const bold = () => doc.font('Times-Bold').fontSize(SIZE).fillColor(INK);
  const para = (text, gap) => {
    body().text(text, { align: 'justify', lineGap: (LEAD - 1) * SIZE });
    doc.moveDown(gap === undefined ? 0.7 : gap);
  };

  // ── Letterhead ──
  //
  // The offer template's own header is empty: on paper it printed onto the
  // company's stationery. Emailed as a PDF there is no stationery behind it,
  // and an offer of employment arriving on a blank sheet with no company name
  // is not one anybody would want to sign. So the head of the page is drawn
  // as the office's letterhead draws it — the name on the left, the contact
  // details on the right behind a rule, a double line under both.
  const L = LETTERHEAD;
  const BLUE = L.blue;
  const detailSize = 8.6;
  const headTop = doc.y;

  doc.font('Helvetica').fontSize(detailSize);
  const rightW = Math.max(...L.lines.map(t => doc.widthOfString(t)));
  const gutter = 15;
  const rightX = doc.page.margins.left + W - rightW;
  const dividerX = rightX - gutter;

  // The name is set to whatever fits the space the details leave, so a longer
  // address never pushes it off the page or overlaps the rule.
  const nameW = dividerX - gutter - doc.page.margins.left;
  const spacing = 1.1;
  let nameSize = 23;
  doc.font('Times-Roman');
  while (nameSize > 9
    && doc.fontSize(nameSize).widthOfString(L.name) + spacing * L.name.length > nameW) nameSize -= 0.5;

  // Details first: they set how tall the block is, and the name is then
  // centred against them rather than sitting on the first line.
  doc.font('Helvetica').fontSize(detailSize).fillColor('#3F3F3F');
  const lineH = doc.currentLineHeight() + 2.6;
  L.lines.forEach((t, i) => {
    doc.text(t, rightX, headTop + i * lineH, { width: rightW, align: 'left', lineBreak: false });
  });
  const blockH = L.lines.length * lineH;

  doc.font('Times-Roman').fontSize(nameSize).fillColor(BLUE);
  const nameH = doc.currentLineHeight();
  doc.text(L.name, doc.page.margins.left, headTop + (blockH - nameH) / 2 - 1,
    { width: nameW, align: 'left', characterSpacing: spacing, lineBreak: false });

  // The upright rule between the two halves, and the double one beneath.
  doc.moveTo(dividerX, headTop - 1).lineTo(dividerX, headTop + blockH - 2)
     .lineWidth(1).strokeColor(BLUE).stroke();

  const ruleAt = headTop + blockH + 7;
  doc.moveTo(doc.page.margins.left, ruleAt).lineTo(doc.page.margins.left + W, ruleAt)
     .lineWidth(2.4).strokeColor(BLUE).stroke();
  doc.moveTo(doc.page.margins.left, ruleAt + 3.6).lineTo(doc.page.margins.left + W, ruleAt + 3.6)
     .lineWidth(0.7).strokeColor(BLUE).stroke();

  doc.y = ruleAt + 18;
  doc.x = doc.page.margins.left;

  // ── The date, and who it is to ──
  body().text(dmy(new Date()), { align: 'left' });
  doc.moveDown(0.9);

  // The address is only ever known if the onboarding form has come back, and
  // the offer often goes out before it has. A line reading "Address 1: " with
  // nothing after it helps nobody, so the ones we cannot fill are left out.
  const addressLines = [];
  if (joining) {
    if (joining.street) addressLines.push(String(joining.street));
    const tail = [joining.city, joining.state, joining.pincode].filter(Boolean).join(', ');
    if (tail) addressLines.push(tail);
  }

  const to = [['Employee Name', c.name]];
  addressLines.forEach((line, i) => to.push([`Address ${i + 1}`, line]));
  if (c.phone) to.push(['Contact No.', c.phone]);
  if (c.email) to.push(['Email ID', c.email]);
  for (const [label, value] of to) {
    body().text(`${label}: `, { continued: true });
    bold().text(String(value || ''));
  }

  doc.moveDown(1.4);
  bold().fontSize(13).text('OFFER LETTER', { align: 'center', underline: true });
  doc.moveDown(1.2);

  // ── The letter ──
  body().text('Dear ', { continued: true });
  bold().text(String(c.name || ''), { continued: true });
  body().text(',');
  doc.moveDown(0.7);

  body().text('With reference to your application and subsequent interview you had with us, we are pleased to offer you a position of ', { continued: true, align: 'justify' });
  bold().text(String(c.profile_position || ''), { continued: true });
  body().text(' in ', { continued: true });
  bold().text(String(c.department || ''), { continued: true });
  body().text(' in ', { continued: true });
  bold().text(String(c.work_location || ''), { continued: true });
  body().text(` Office of the ${COMPANY}, (hereinafter referred to as the “Entity”) on the terms and conditions as mutually discussed and agreed with you.`);
  doc.moveDown(0.7);

  body().text('Your employment with the Entity is scheduled to commence on ', { continued: true, align: 'justify' });
  bold().text(dmy(c.joining_date), { continued: true });
  body().text(' (the “Joining Date”), subject to your acceptance of this Offer letter and completion of joining formalities.');
  doc.moveDown(0.7);

  para('The Entity may also, at its discretion, carry out background verification and has the right to withdraw the Offer if the results of such verification are not satisfactory.');
  para('An Appointment Letter detailing the comprehensive terms and conditions of your Employment shall be issued to you upon your joining the aforesaid position and after a satisfactory background verification check.');

  body().text('Further, this Offer is valid only till ', { continued: true, align: 'justify' });
  bold().text(dmy(c.offer_valid_till), { continued: true });
  body().text('. You are required to communicate your acceptance of the Offer on or before this date.');
  doc.moveDown(1);

  // ── What to bring ──
  //
  // The list is kept whole. Left to flow it broke after "Address Proof",
  // putting one lonely bullet at the top of page two, which reads as though
  // somebody forgot to check. If it does not fit, the whole thing moves over -
  // and page one then ends on the validity paragraph, which is a proper place
  // for a letter to turn.
  const intro = 'You are required to bring the following documents at the time of joining:';
  const listHeight = DOCUMENTS.reduce(
    (h, d) => h + body().heightOfString(d, { width: W - 24, lineGap: (LEAD - 1) * SIZE }) + 2,
    body().heightOfString(intro, { width: W }) + 14);
  if (doc.y + listHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();

  para(intro, 0.5);
  body().list(DOCUMENTS, {
    bulletRadius: 1.8,
    textIndent: 14,
    bulletIndent: 10,
    lineGap: (LEAD - 1) * SIZE,
    paragraphGap: 2,
  });
  doc.moveDown(0.8);
  para('The originals of the above documents shall be returned after verification.');
  doc.moveDown(0.3);
  para('Wishing you a successful career in our organization!');

  // ── Who it is from ──
  // Kept on one page with what it signs off: a signature block orphaned at the
  // top of a second page is the classic way a letter looks careless.
  const signBlock = 128;
  if (doc.y + signBlock > doc.page.height - doc.page.margins.bottom) doc.addPage();

  doc.moveDown(0.8);

  // On the left, as the office asked and as the Word file has it: the
  // Name / E-mail / Phone lines in the template carry no tab at all and sit
  // against the left margin, and only "Sincerely," was nudged in by a third
  // of an inch. The whole block goes at the margin so it lines up with the
  // letter above it rather than stepping in and out.
  const signLines = [
    ['Sincerely,', 'Times-Roman'],
    [`For ${COMPANY}`, 'Times-Bold'],
    [null, null],                       // room to sign
    ['Authorized Signatory', 'Times-Roman'],
    [`Name: ${SIGNATORY.name}`, 'Times-Roman'],
    [`E-mail: ${SIGNATORY.email}`, 'Times-Roman'],
    [`Phone: ${SIGNATORY.phone}`, 'Times-Roman'],
  ];
  const signX = doc.page.margins.left;
  const signW = W;

  for (const [text, font] of signLines) {
    if (!text) { doc.moveDown(2.4); continue; }
    doc.font(font).fontSize(SIZE).fillColor(INK)
       .text(text, signX, doc.y, { width: signW, align: 'left', lineBreak: false });
  }

  // ── What the candidate signs ──
  const acceptBlock = 150;
  if (doc.y + acceptBlock > doc.page.height - doc.page.margins.bottom) doc.addPage();
  else doc.moveDown(2);

  doc.x = doc.page.margins.left;
  bold().text('Acknowledgement and Acceptance:');
  doc.moveDown(0.5);
  body().text('I, the undersigned, have read and understood this Offer Letter and accept the Offer. I will join by ', { continued: true, align: 'justify' });
  bold().text(dmy(c.joining_date), { continued: true });
  body().text(' failing which the Offer shall stand withdrawn.');
  doc.moveDown(2.6);

  const col = W / 3;
  const ruleY = doc.y;
  for (let i = 0; i < 3; i++) {
    const x = doc.page.margins.left + col * i;
    doc.moveTo(x, ruleY).lineTo(x + col - 22, ruleY).lineWidth(0.8).strokeColor(INK).stroke();
  }
  doc.y = ruleY + 5;
  ['Name', 'Signature', 'Date'].forEach((label, i) => {
    body().text(label, doc.page.margins.left + col * i, doc.y, { width: col - 22, align: 'left' });
    if (i < 2) doc.y -= doc.currentLineHeight() + (LEAD - 1) * SIZE;
  });

  doc.moveDown(1.6);
  body().text('************', doc.page.margins.left, doc.y, { width: W, align: 'center' });

  // ── Page numbers, once the page count is known ──
  //
  // The footer sits below the bottom margin, and pdfkit answers text that far
  // down by starting a fresh page - which then gets a footer of its own, and
  // so on. Dropping the margin to nothing for the length of the write is what
  // stops a two-page letter turning into four.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Times-Roman').fontSize(9).fillColor('#444444')
       .text(`Page ${i + 1} of ${range.count}`,
             doc.page.margins.left,
             doc.page.height - keep + 26,
             { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.flushPages();

  doc.end();

  return done.then(() => ({
    buffer: Buffer.concat(chunks),
    filename: `Offer Letter - ${String(c.name || 'candidate').replace(/[^\w .-]+/g, ' ').trim()}.pdf`,
  }));
}

module.exports = { buildOfferLetter, SIGNATORY, COMPANY, DOCUMENTS, dmy };
