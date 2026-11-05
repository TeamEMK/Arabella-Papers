/**
 * EVERY OTHER DESIGN FILE BOX, STRAIGHT TO DRIVE.
 *
 * The vector box has gone browser-to-Drive since the day it was built. The
 * four boxes beside it had not, and so still stopped at four megabytes: the
 * design files on a new order, the upload on Update Order Status, the one on
 * Edit Details, and the final approval on Till Approval. Somebody holding a
 * 69MB .ai was told to send a flattened PDF - for a limit that had already
 * been solved one box over.
 *
 * Drive is stubbed, as it must be: the Google keys live only on the deployed
 * site. What is covered here is every decision our own code makes, and in
 * particular the one new risk this design creates - the server no longer sees
 * the file, so it has to be TOLD, and being told is not knowing.
 */
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const TEST_DB = 'arabella_dupload_probe';
const LIVE_DB = process.env.DB_NAME;

process.env.DB_NAME = TEST_DB;
process.env.VERCEL = '1';
process.env.ADMIN_EMAIL = 'probe@test.local';
process.env.ADMIN_PASSWORD = 'probe-pass-123';
process.env.DRIVE_FOLDER_ID = 'the-proofs-folder';
process.env.VECTOR_DRIVE_FOLDER_ID = 'the-artwork-folder';

const NL = String.fromCharCode(10);
const drive = { sessions: [], files: {}, shared: [], nextId: 1 };
{
  const p = require.resolve(path.join(ROOT, 'utils/drive.js'));
  const real = require(p);
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      designFolder: real.designFolder,
      vectorFolder: real.vectorFolder,
      uploadToDrive: async () => 'https://drive.test/through-the-server',
      startResumableUpload: async ({ fileName, mimeType, size, origin, folderId }) => {
        const driveName = Date.now() + '_' + drive.nextId + '_' + fileName;
        drive.sessions.push({ driveName, mimeType, size, origin, folderId });
        return { sessionUrl: 'https://upload.test/session/' + drive.sessions.length, driveName };
      },
      claimUpload: async (fileId, expectedName, folderId) => {
        const f = drive.files[fileId];
        if (!f) throw new Error('No such file.');
        if (f.name !== expectedName) throw new Error('That file is not the one this upload was opened for.');
        drive.shared.push({ fileId, folderId });
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
    + "('D-1','Client One','Rakesh','Fresh Design'), ('D-2','Client Two','Rakesh','Fresh Design')");

  const server = app.listen(0);
  await new Promise(done => server.once('listening', done));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const go = (url, opts) => {
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Forwarded-Proto': 'https' }, opts.headers || {});
    opts.redirect = 'manual';
    return fetch(BASE + url, opts);
  };
  const signIn = async (email, password) => {
    const res = await go('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }),
    });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  };
  const jar = await signIn(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  const post = async (url, body, cookie) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie !== null) headers.cookie = cookie || jar;
    const res = await go(url, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const form = (url, fields, method) => go(url, {
    method: method || 'PUT',
    headers: { cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  }).then(r => r.json());

  const session = (body, cookie) => post('/api/uploads/session', body, cookie);
  const claim = (body, cookie) => post('/api/uploads/claim', body, cookie);

  // The browser's half: the bytes land at Drive, Drive hands back an id.
  const uploadBytes = (driveName, size) => {
    const id = 'drive-file-' + (drive.nextId++);
    drive.files[id] = { name: driveName, size: size || 1 };
    return id;
  };
  const lastSession = () => drive.sessions[drive.sessions.length - 1];

  /** The whole browser dance, as the screens do it. */
  const uploadFile = async (name, size) => {
    const opened = await session({ fileName: name, mimeType: '', size });
    const fileId = uploadBytes(lastSession().driveName, size);
    const filed = await claim({ token: opened.json.token, fileId });
    return { token: opened.json.token, url: filed.json && filed.json.url };
  };

  console.log(NL + 'Opening an upload');
  const stranger = await session({ fileName: 'a.ai', size: 1024 }, null);
  check('a stranger cannot open one', stranger.status === 302 || stranger.status === 401, stranger.status);

  const big = await session({ fileName: 'Foulger Holiday Card V1.ai', size: 69 * 1048576 });
  check('the 69MB file from the complaint is allowed - this box used to stop at 4MB',
    big.json && big.json.success === true, big.json);
  check('and the browser is given somewhere to send it', !!(big.json && big.json.sessionUrl));
  check('and a ticket to come back with', !!(big.json && big.json.token));
  check("the page's own origin is passed to Google, as its browser-upload docs ask",
    !!lastSession().origin && /^https?:/.test(lastSession().origin), lastSession().origin);
  check('and Google is told how big it is, so it can refuse early',
    lastSession().size === 69 * 1048576);
  const bigDriveName = lastSession().driveName;

  console.log(NL + 'Where it lands in Drive');
  // Getting this wrong means proofs filed in among the print-ready artwork,
  // or the other way round.
  check('a design file goes to the proofs folder, not the artwork one',
    lastSession().folderId === 'the-proofs-folder', lastSession().folderId);
  const vecOpen = await post('/api/dashboards/till-approval/D-1/vector-session',
    { fileName: 'art.ai', size: 1024 });
  check('and the vector box still goes to the artwork folder',
    vecOpen.json.success === true && lastSession().folderId === 'the-artwork-folder',
    lastSession().folderId);

  console.log(NL + 'What may be sent');
  const jpg = await session({ fileName: 'proof.jpg', size: 2048 });
  check('a proof is still a design file', jpg.json && jpg.json.success === true, jpg.json);
  const exe = await session({ fileName: 'setup.exe', size: 2048 });
  check('an .exe is refused, whatever the picker let through',
    exe.json && exe.json.success === false, exe.json);
  const huge = await session({ fileName: 'enormous.ai', size: 400 * 1048576 });
  check('400MB is refused, and refused before anything is uploaded',
    huge.json && huge.json.success === false && /limit/i.test(huge.json.error || ''), huge.json);
  const empty = await session({ fileName: 'art.ai', size: 0 });
  check('an empty file is refused', empty.json && empty.json.success === false, empty.json);

  console.log(NL + 'Taking delivery');
  const forged = await claim({ token: big.json.token, fileId: uploadBytes('someone-elses-file.ai', 10) });
  check('an id for a file we did not name is refused', forged.json && forged.json.success === false, forged.json);
  const [[stillOpen]] = await db.query(
    'SELECT used_at FROM design_upload_tickets WHERE token = ?', [big.json.token]);
  check("and the ticket survives a failure that was not the designer's doing", stillOpen.used_at === null);

  const realId = uploadBytes(bigDriveName, 69 * 1048576);
  const filed = await claim({ token: big.json.token, fileId: realId });
  check('the real file is taken', filed.json && filed.json.success === true, filed.json);
  check('under the name the designer gave it, not the one we gave Drive',
    filed.json.name === 'Foulger Holiday Card V1.ai', filed.json.name);
  check('and made readable by link, like every other file here',
    drive.shared.some(s => s.fileId === realId));
  const twice = await claim({ token: big.json.token, fileId: realId });
  check('the same ticket cannot be claimed twice', twice.json && twice.json.success === false, twice.json);

  console.log(NL + 'Update Order Status takes the big one');
  const saved = await form('/api/orders/D-1/status', {
    designStatus: 'Fresh Design', remark: 'with artwork',
    userEmail: process.env.ADMIN_EMAIL, orderQuantity: '', addOns: '[]',
    fileToken: big.json.token,
  });
  check('the status saves', saved.success === true, saved);
  const [[d1]] = await db.query("SELECT upload_design FROM orders WHERE order_id = 'D-1'");
  check('and the 69MB file is on the order',
    d1.upload_design === 'https://drive.test/' + realId, d1.upload_design);

  console.log(NL + 'A token is a ticket, not a suggestion');
  const typed = await form('/api/orders/D-2/status', {
    designStatus: 'Fresh Design', remark: '', userEmail: process.env.ADMIN_EMAIL,
    orderQuantity: '', addOns: '[]', fileUrl: 'https://evil.test/anything',
  });
  const [[d2]] = await db.query("SELECT upload_design FROM orders WHERE order_id = 'D-2'");
  check('a hand-typed fileUrl field is ignored - the URL is read from the ticket',
    typed.success === true && !/evil/.test(String(d2.upload_design || '')), d2.upload_design);

  const reused = await form('/api/orders/D-2/status', {
    designStatus: 'Fresh Design', remark: '', userEmail: process.env.ADMIN_EMAIL,
    orderQuantity: '', addOns: '[]', fileToken: big.json.token,
  });
  check('and a token already filed cannot be filed again on another order',
    reused.success === false, reused);

  const madeUp = await form('/api/orders/D-2/status', {
    designStatus: 'Fresh Design', remark: '', userEmail: process.env.ADMIN_EMAIL,
    orderQuantity: '', addOns: '[]', fileToken: 'a'.repeat(48),
  });
  check('an invented token is refused rather than quietly ignored', madeUp.success === false, madeUp);

  console.log(NL + 'An upload belongs to the person who opened it');
  const bcrypt = require('bcryptjs');
  await db.query(
    "INSERT INTO users (username, email, password, role) VALUES ('Other','other@test.local',?,'user')",
    [await bcrypt.hash('other-pass-123', 10)]);
  const otherJar = await signIn('other@test.local', 'other-pass-123');
  const mine = await session({ fileName: 'mine.ai', size: 1024 });
  const mineId = uploadBytes(lastSession().driveName, 1024);
  const stolen = await claim({ token: mine.json.token, fileId: mineId }, otherJar);
  check('somebody else cannot claim my upload', stolen.json && stolen.json.success === false, stolen.json);

  console.log(NL + 'A new order carries several');
  const a = await uploadFile('one.ai', 50 * 1048576);
  const b = await uploadFile('two.jpg', 1024);
  const punched = await go('/api/orders', {
    method: 'POST', headers: { cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      email: process.env.ADMIN_EMAIL, punchedBy: 'India Team', dealer: 'Someone',
      client: 'A Client', remarks: '', designer: 'Rakesh', designTime: '1 Hour',
      fileTokens: JSON.stringify([a.token, b.token]),
    }),
  }).then(r => r.json());
  check('the order is taken', punched.success === true, punched);
  const [[fresh]] = await db.query(
    'SELECT upload_design_file f FROM orders WHERE order_id = ?', [punched.orderId]);
  check('with both files on it, one per line',
    String(fresh.f || '').split(NL).filter(Boolean).length === 2, fresh.f);

  console.log(NL + 'Till Approval takes one too');
  const appr = await uploadFile('final approval.ai', 60 * 1048576);
  const approved = await form('/api/dashboards/till-approval/D-1', {
    approvalStatus: 'Modification Needed', remark: 'please adjust',
    userEmail: process.env.ADMIN_EMAIL, fileToken: appr.token,
  });
  check('the approval saves with a 60MB file attached', approved.success === true, approved);

  console.log(NL + 'The screens match the server');
  const fs = require('fs');
  const dash = fs.readFileSync(path.join(ROOT, 'views/views/dashboard.ejs'), 'utf8');
  const till = fs.readFileSync(path.join(ROOT, 'views/views/tillApproval.ejs'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'views/app.ejs'), 'utf8');

  check('the shell loads the uploader once, for every screen',
    (shell.match(/js.directUpload\.js/g) || []).length === 1);

  // A script tag pointing at a 404 leaves every box on both screens throwing
  // "ArabellaUpload is not defined" the moment somebody picks a file, and
  // reading the tag in the template cannot tell us that. So it is fetched
  // from the running server, the way a browser would.
  const served = await go('/js/directUpload.js');
  const body = await served.text();
  check('and that file is really served', served.status === 200, served.status);
  check('and it is the uploader, not an error page',
    /window\.ArabellaUpload|w\.ArabellaUpload/.test(body) && /\/api\/uploads\/session/.test(body));
  check('no design file rides along in a form body any more',
    !/formData\.append\(.files.,/.test(dash)
    && !/formData\.append\(.file.,\s*file\)/.test(dash)
    && !/formData\.append\(.file.,\s*file\)/.test(till));

  // Every file box on these two screens has to be exempted from the shell's
  // 4MB warning, or the one screen that CAN take a large file is the one
  // that clears the box and refuses it. Counted by sweep rather than by eye:
  // a box added later and forgotten is exactly how this happened the first
  // time.
  // The alternation is load-bearing: these are EJS templates, so an
  // `accept="<%= designFiles %>"` holds a `>` of its own, and a plain
  // [^>]* stops in the middle of the tag and never sees the attribute this
  // check is looking for - which made the sweep pass by accident the first
  // time it was written.
  const boxes = (html) => (html.match(/<input\b(?:%>|[^>])*>/g) || [])
    .filter(t => /type="file"/.test(t));
  for (const pair of [['the dashboard', dash], ['Till Approval', till]]) {
    const all = boxes(pair[1]);
    const missing = all.filter(b => !/data-direct="drive"/.test(b));
    check('every file box on ' + pair[0] + ' goes straight to Drive (' + all.length + ' of them)',
      all.length > 0 && missing.length === 0, missing);
  }
  check("the shell's 4MB warning stands aside for exactly those boxes",
    /dataset && el\.dataset\.direct/.test(shell));

  // Order matters: a save that happened first would mark an order done and
  // only then discover the artwork never arrived.
  check('the file goes up before the status is saved, not after',
    dash.indexOf('ArabellaUpload.send(file)') > -1
    && dash.indexOf('ArabellaUpload.send(file)') < dash.indexOf('/status`, { method:'),
    [dash.indexOf('ArabellaUpload.send(file)'), dash.indexOf('/status`, { method:')]);
  check('and a failed upload stops the save on every box of the dashboard',
    (dash.match(/could not be uploaded[\s\S]{0,140}return;/g) || []).length === 3,
    (dash.match(/could not be uploaded[\s\S]{0,140}return;/g) || []).length);
  check('and on Till Approval too',
    /could not be uploaded[\s\S]{0,140}return;/.test(till));

  console.log(NL + pass + ' passed, ' + fail + ' failed');
  server.close();
  await db.end();
  await admin.query('DROP DATABASE `' + TEST_DB + '`');
  await admin.end();
  console.log('Throwaway database dropped.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
