// The words out of a PDF, for tests that care what the paper says.
//
// pdfkit writes its text as hex strings inside TJ arrays in a deflated
// stream, so "does this file contain that number" cannot be answered by
// searching the bytes. Without this, a PDF with the right header and
// entirely the wrong figures passes every check anybody thinks to write.
const zlib = require('zlib');

function pdfText(buf) {
  const s = buf.toString('latin1');
  const out = [];
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let txt;
    try {
      txt = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (e) {
      continue; // fonts and other binary streams - not text
    }
    for (const block of txt.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let line = '';
      for (const h of block[1].matchAll(/<([0-9a-fA-F]+)>/g)) {
        line += Buffer.from(h[1], 'hex').toString('latin1');
      }
      if (line.trim()) out.push(line);
    }
  }
  return out.join('\n');
}

module.exports = { pdfText };
