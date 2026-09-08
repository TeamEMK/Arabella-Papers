// ══════════════════════════════════════════════════════
// GOOGLE SHEETS
// The FMS section reads and writes a Google Sheet that stays the real record;
// this app is a better way to write to it than opening the sheet.
//
// Credentials come from the same service account the Drive upload already uses.
// Two shapes are accepted because the two places they live differ: a whole
// service-account JSON in a file (local) or in GOOGLE_CREDENTIALS, and the
// email/key pair Vercel already holds for Drive.
// ══════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');

let _readClient = null;
let _writeClient = null;

/**
 * A service-account JSON pasted into an environment variable arrives damaged
 * more often than not — a byte-order mark, wrapping quotes, or the private
 * key's \n escapes turned into real line breaks, which JSON.parse rejects.
 * Repair the usual damage rather than failing every sheet feature at once with
 * a bare syntax error.
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

/**
 * Whichever of the two forms this deployment has. The file wins when it is
 * there: it is the whole key, and it is what a developer just downloaded.
 */
function loadCredentials() {
  const file = path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(file)) return require(file);

  if (process.env.GOOGLE_CREDENTIALS) return parseServiceAccountJson(process.env.GOOGLE_CREDENTIALS);

  const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const private_key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (client_email && private_key) return { client_email, private_key };

  throw new Error(
    'No Google credentials. Put credentials.json at the project root, or set '
    + 'GOOGLE_CREDENTIALS, or GOOGLE_SERVICE_ACCOUNT_EMAIL with GOOGLE_PRIVATE_KEY.');
}

const READ_SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const WRITE_SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];

async function client(scopes) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function getReadClient() {
  if (!_readClient) _readClient = await client(READ_SCOPE);
  return _readClient;
}

async function getWriteClient() {
  if (!_writeClient) _writeClient = await client(WRITE_SCOPE);
  return _writeClient;
}

// ── Reads ─────────────────────────────────────────────
// A short-lived cache, because one screen can ask for the same sheet three
// times in a second. Entries hold the promise as well as the rows, so two
// callers arriving together share one HTTP call instead of racing.
//
// On Vercel the container is frozen between requests, so this mostly helps
// within a single request rather than across them. That is where the repeats
// were anyway.
const CACHE_MS = Number(process.env.SHEET_CACHE_MS || 20000);
const _cache = new Map();

async function readValues(spreadsheetId, range, { fresh = false } = {}) {
  const key = `${spreadsheetId}!${range}`;
  if (!fresh && CACHE_MS > 0) {
    const hit = _cache.get(key);
    if (hit && Date.now() < hit.expires) return hit.promise;
    if (hit) _cache.delete(key);
  }
  const promise = (async () => {
    const api = await getReadClient();
    const resp = await api.spreadsheets.values.get({ spreadsheetId, range });
    return resp.data.values || [];
  })();
  if (CACHE_MS > 0) _cache.set(key, { promise, expires: Date.now() + CACHE_MS });
  try { return await promise; }
  catch (e) { _cache.delete(key); throw e; }   // never cache a failure
}

// Called after a write, so the next read does not serve what we just replaced.
function invalidateSheet(spreadsheetId) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${spreadsheetId}!`)) _cache.delete(key);
  }
}

// ── Tabs ──────────────────────────────────────────────
const _tabs = new Map();

async function listTabs(spreadsheetId) {
  if (_tabs.has(spreadsheetId)) return _tabs.get(spreadsheetId);
  const api = await getReadClient();
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tabs = (meta.data.sheets || []).map(s => s.properties);
  _tabs.set(spreadsheetId, tabs);
  return tabs;
}

async function findTabByTitle(spreadsheetId, title) {
  return (await listTabs(spreadsheetId)).find(p => p.title === title) || null;
}

function forgetTabs(spreadsheetId) { _tabs.delete(spreadsheetId); }

/**
 * Which address the server signs its Sheets calls as. A sheet has to be shared
 * with THIS one, and on a deployment the credentials come from an environment
 * variable, so it is rarely the address whose name is on the file.
 */
function serviceAccountEmail() {
  try { return loadCredentials().client_email || null; }
  catch (_) { return null; }
}

module.exports = {
  getReadClient, getWriteClient, READ_SCOPE, WRITE_SCOPE,
  readValues, invalidateSheet,
  listTabs, findTabByTitle, forgetTabs,
  serviceAccountEmail, parseServiceAccountJson,
};
