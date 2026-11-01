/**
 * THE VECTOR FILE, STRAIGHT TO DRIVE.
 *
 * The box had never once worked. Everything on this screen was posted to our
 * own server, the server is on Vercel, and Vercel refuses a request body over
 * 4.5MB before a line of our code runs - so a print-ready .ai, which is
 * routinely ten times that, could not arrive. Nine thousand proofs had gone
 * up fine; not one piece of artwork ever had.
 *
 * Now the bytes go from the designer's machine to Drive and never touch us.
 * That moves the risk rather than removing it: our server no longer sees the
 * file, so it has to be TOLD which file arrived - and being told is not the
 * same as knowing. Most of what follows is about that gap.
 *
 * Drive is stubbed. It has to be: the Google keys live only on the deployed
 * site, so the one leg this suite cannot walk is the leg over the network to
 * Google. What it does cover is every decision our own code makes.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_vupload_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';

// ── The stub stands in for Google, and remembers what it was asked ──
const drive = {
  sessions: [],     // every session opened
  files: {},        // id -> {name, size}
  shared: [],       // ids made readable by link
  nextId: 1,
};
{
  const p = require.resolve(path.join(ROOT, 'utils/drive.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      uploadToDrive: async () => 'https://drive.test/file',
      startResumableUpload: async ({ fileName, mimeType, size, origin }) => {
        const driveName = Date.now() + '_' + fileName;
        drive.sessions.push({ driveName, mimeType, size, origin });
        return { sessionUrl: 'https://upload.test/session/' + drive.sessions.length, driveName };
      },
      claimUpload: async (fileId, expectedName) => {
        const f = drive.files[fileId];
        if (!f) throw new Error('No such file.');
        if (f.name !== expectedName) throw new Error('That file is not the one this upload was opened for.');
        drive.shared.push(fileId);
        return { url: 'https://drive.test/' + fileId, name: f.name, size: f.size };
      },
    },
  };
}
{
  const p = require.resolve(path.join(ROOT, 'utils/mailer.js'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      sendMail: async () => ({ sent: true }),
      verifyMail: async () => ({ ok: true }),
      isMailConfigured: () => true,
    },
  };
}

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra === undefined ? '' : '  ->  ' + JSON.stringify(extra))); }
};

(async () => {
  if (!LIVE_DB || LIVE_DB === TEST_DB) throw new Error('refusing to run against DB_NAME');

  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await admin.query('DROP DATABASE IF EXISTS `' + TEST_DB + '`');
  await admin.query('CREATE DATABASE `' + TEST_DB + '` CHARACTER SET utf8mb4');

  const app = require(path.join(ROOT, 'server.js'));
  await require(path.join(ROOT, 'config/initDb.js')).ensureSchema();
  const db = require(path.join(ROOT, 'config/db.js'));

  await db.query(
    'INSERT INTO orders (order_id, client_name, india_designer, design_status) VALUES '
    + "('V-1','Client One','Rakesh','Fresh Design'), ('V-2','Client Two','Rakesh','Fresh Design')");

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  const login = await go('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  });
  const jar = (login.headers.get('set-cookie') || '').split(';')[0];

  const post = async (url, body, loggedIn) => {
    const headers = { 'Content-Type': 'application/json' };
    if (loggedIn !== false) headers.cookie = jar;
    const res = await go(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const session = (id, body, loggedIn) =>
    post('/api/dashboards/till-approval/' + id + '/vector-session', body, loggedIn);
  const claim = (id, body) =>
    post('/api/dashboards/till-approval/' + id + '/vector-claim', body);

  // The browser's half: the bytes land at Drive, Drive hands back an id.
  const uploadBytes = (driveName, size) => {
    const id = 'drive-file-' + (drive.nextId++);
    drive.files[id] = { name: driveName, size: size || 1 };
    return id;
  };
  const lastSession = () => drive.sessions[drive.sessions.length - 1];

  console.log('\nOpening an upload');
  const stranger = await session('V-1', { fileName: 'a.ai', size: 1024 }, false);
  check('a stranger cannot open one', stranger.status === 302 || stranger.status === 401, stranger.status);

  const big = await session('V-1', { fileName: 'art.ai', mimeType: 'application/postscript', size: 40 * 1048576 });
  check('a 40MB file is allowed - the old ceiling was 4MB', big.json && big.json.success === true, big.json);
  check('and the browser is given somewhere to send it', !!(big.json && big.json.sessionUrl));
  check('and a ticket to come back with', !!(big.json && big.json.token));
  check('the page\'s own origin reaches Google, or the upload dies on CORS',
    !!lastSession().origin && /^https?:\/\//.test(lastSession().origin), lastSession().origin);
  check('and Google is told how big it is, so it can refuse early',
    lastSession().size === 40 * 1048576);
  // Caught now rather than counted off the end later: every refusal below
  // stops before Drive is asked anything, so the list does not grow.
  const goodName = lastSession().driveName;

  const wrongType = await session('V-1', { fileName: 'notes.docx', size: 1024 });
  check('a .docx is refused, whatever the picker let through',
    wrongType.json && wrongType.json.success === false, wrongType.json);

  const huge = await session('V-1', { fileName: 'enormous.ai', size: 400 * 1048576 });
  check('400MB is refused, and refused before anything is uploaded',
    huge.json && huge.json.success === false && /limit/i.test(huge.json.error || ''), huge.json);

  const empty = await session('V-1', { fileName: 'art.ai', size: 0 });
  check('an empty file is refused', empty.json && empty.json.success === false, empty.json);

  const noOrder = await session('V-NOPE', { fileName: 'art.ai', size: 1024 });
  check('an order that does not exist is refused', noOrder.status === 404, noOrder.status);

  console.log('\nTaking delivery');
  const fileId = uploadBytes(goodName, 40 * 1048576);

  const forged = await claim('V-1', { token: big.json.token, fileId: uploadBytes('someone-elses-file.ai', 10) });
  check('an id for a file we did not name is refused', forged.json && forged.json.success === false, forged.json);

  const [[stillOpen]] = await db.query(
    'SELECT used_at FROM vector_upload_tickets WHERE token = ?', [big.json.token]);
  check('and the ticket survives a failure that was not the designer\'s doing', stillOpen.used_at === null);

  const filed = await claim('V-1', { token: big.json.token, fileId });
  check('the real file is filed, as v1',
    filed.json && filed.json.success === true && filed.json.version === 1, filed.json);
  check('and made readable by link, like every other file here', drive.shared.includes(fileId));

  const [[row]] = await db.query(
    'SELECT file_name, uploaded_by FROM order_vector_files WHERE order_id = ?', ['V-1']);
  check('under the name the designer gave it, not the one we gave Drive', row.file_name === 'art.ai', row.file_name);
  check('with the uploader recorded', row.uploaded_by === process.env.ADMIN_EMAIL, row.uploaded_by);

  const [log] = await db.query(
    "SELECT action FROM order_logs WHERE order_id = 'V-1' AND action = 'Vector file'");
  check('and written into the order\'s history', log.length === 1, log.length);

  const twice = await claim('V-1', { token: big.json.token, fileId });
  check('the same ticket cannot be spent again', twice.json && twice.json.success === false, twice.json);
  const [[one]] = await db.query("SELECT COUNT(*) c FROM order_vector_files WHERE order_id = 'V-1'");
  check('so one upload is one version, not two', one.c === 1, one.c);

  console.log('\nA ticket belongs to one order');
  const forOne = await session('V-1', { fileName: 'second.ai', size: 2048 });
  const secondId = uploadBytes(lastSession().driveName, 2048);
  const crossed = await claim('V-2', { token: forOne.json.token, fileId: secondId });
  check('it cannot be redeemed against another order', crossed.json && crossed.json.success === false, crossed.json);
  const [[none]] = await db.query("SELECT COUNT(*) c FROM order_vector_files WHERE order_id = 'V-2'");
  check('and nothing lands on the order it was pointed at', none.c === 0, none.c);

  const back = await claim('V-1', { token: forOne.json.token, fileId: secondId });
  check('on its own order it files as v2 - nothing is overwritten',
    back.json && back.json.success === true && back.json.version === 2, back.json);

  console.log('\nThe rule this was all for');
  const gate = require(path.join(ROOT, 'utils/vectorGate.js'));
  check('V-1 may now be called Proofing Done', (await gate.blockProofing('V-1', false)) === null);
  check('V-2 still may not', typeof (await gate.blockProofing('V-2', false)) === 'string');

  console.log('\nThe screen matches the server');
  const fs = require('fs');
  const view = fs.readFileSync(path.join(ROOT, 'views/views/tillApproval.ejs'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'views/app.ejs'), 'utf8');
  check('the vector box no longer rides along in the form', !/formData\.append\('vectorFile'/.test(view));
  check('it uploads to Drive instead', /ta_sendVector\(/.test(view));
  check('the artwork goes up before the status is saved, not after',
    view.indexOf('ta_sendVector(ta_editId') > -1
    && view.indexOf('ta_sendVector(ta_editId') < view.indexOf('method:\'PUT\', body:formData'));
  check('and a failed upload stops the save, so nothing is marked done without it',
    /That file was not uploaded[\s\S]{0,160}return;/.test(view));
  check('the shell\'s 4MB warning leaves this one box alone',
    /dataset && el\.dataset\.direct/.test(shell) && /data-direct="drive"/.test(view));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
