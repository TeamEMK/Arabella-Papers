// ══════════════════════════════════════════════════════
// ONE SERVICE ACCOUNT, ONE PLACE THAT FINDS IT
//
// Sheets and Drive run as the same Google service account, and until now each
// of them looked for it in its own way. Sheets accepted all three shapes the
// credentials actually come in; Drive accepted one - and production holds a
// different one. So the half of the app that uploads files was reading
// variables that are not set there.
//
// Three shapes, because the three places they live differ:
//
//   credentials.json at the project root   a developer's machine
//   GOOGLE_CREDENTIALS                     the whole JSON in one variable
//   GOOGLE_SERVICE_ACCOUNT_EMAIL + _KEY    the pair, split in two
//
// The file wins when it is there: it is the whole key and it is what somebody
// has just downloaded.
// ══════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');

/**
 * A service-account JSON pasted into an environment variable arrives damaged
 * more often than not — a byte-order mark, wrapping quotes, or the private
 * key's \n escapes turned into real line breaks, which JSON.parse rejects.
 * Repair the usual damage rather than failing every Google feature at once
 * with a bare syntax error.
 */
function parseServiceAccountJson(raw) {
  let text = String(raw).trim();
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const wrapped = (text.startsWith("'") && text.endsWith("'"))
    || (text.startsWith('"') && text.endsWith('"') && !text.startsWith('{"'));
  if (wrapped) text = text.slice(1, -1);

  try { return JSON.parse(text); } catch (_) { /* fall through to the repair */ }

  // Escape line breaks that fall INSIDE a string. Breaks between tokens are
  // legal whitespace, so this tracks the quoting rather than replacing blindly.
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = inString; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString && ch === '\n') { out += '\\n'; continue; }
    if (inString && ch === '\r') { out += '\\r'; continue; }
    out += ch;
  }

  try { return JSON.parse(out); } catch (e) {
    throw new Error(
      `GOOGLE_CREDENTIALS is set but is not valid JSON (${e.message}). It must be the `
      + 'contents of the service-account .json file, on one line, with the private key\'s '
      + 'line breaks written as \\n.');
  }
}

/** Whichever of the three forms this machine has. */
function loadCredentials() {
  const file = path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(file)) return require(file);

  if (process.env.GOOGLE_CREDENTIALS) return parseServiceAccountJson(process.env.GOOGLE_CREDENTIALS);

  const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // A key held in a variable has its line breaks written as the two
  // characters \ and n, because a variable cannot hold a real newline. Those
  // two characters are what this turns back into line breaks - so the pattern
  // is an escaped backslash followed by an n, and writing it as a plain \n
  // makes this a no-op that fails later with "invalid PEM".
  const private_key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (client_email && private_key) return { client_email, private_key };

  throw new Error(
    'No Google credentials. Put credentials.json at the project root, or set '
    + 'GOOGLE_CREDENTIALS, or GOOGLE_SERVICE_ACCOUNT_EMAIL with GOOGLE_PRIVATE_KEY.');
}

/** Which of them was used, for a message somebody has to act on. */
function credentialSource() {
  if (fs.existsSync(path.join(__dirname, '..', 'credentials.json'))) return 'credentials.json';
  if (process.env.GOOGLE_CREDENTIALS) return 'GOOGLE_CREDENTIALS';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return 'GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY';
  }
  return 'nothing';
}

module.exports = { loadCredentials, parseServiceAccountJson, credentialSource };
