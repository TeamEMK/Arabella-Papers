/**
 * Takes a full dump of the live database to the Desktop.
 *
 * Railway keeps automatic backups on the Pro plan only, so on Hobby there is
 * nothing standing between a bad UPDATE and 8,600 lost orders. This is the
 * stand-in: run it before anything risky, and on a schedule if you can.
 *
 *   node scripts/backup-live.js
 *
 * The connection string is read from a file that is never committed, so the
 * live password does not end up in the repo or in anyone's shell history.
 * Create `.env.backup` next to this project with one line, copied from
 * Railway -> MySQL -> Variables -> MYSQL_PUBLIC_URL:
 *
 *   LIVE_DB_URL=mysql://root:PASSWORD@host.proxy.rlwy.net:12345/railway
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function connectionUrl() {
  if (process.env.LIVE_DB_URL) return process.env.LIVE_DB_URL;

  const file = path.join(ROOT, '.env.backup');
  if (!fs.existsSync(file)) {
    console.error('\nNo connection string.\n');
    console.error('Create .env.backup in the project folder with one line:');
    console.error('  LIVE_DB_URL=mysql://root:PASSWORD@host.proxy.rlwy.net:12345/railway\n');
    console.error('Copy it from Railway -> MySQL -> Variables -> MYSQL_PUBLIC_URL.\n');
    process.exit(1);
  }
  const line = fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('LIVE_DB_URL='));
  if (!line) {
    console.error('.env.backup has no LIVE_DB_URL= line.');
    process.exit(1);
  }
  return line.slice('LIVE_DB_URL='.length).trim();
}

// mysqldump is installed with MySQL Server but is not always on PATH.
function findMysqldump() {
  const guesses = [
    'mysqldump',
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 9.0\\bin\\mysqldump.exe',
  ];
  return guesses.find(g => g === 'mysqldump' || fs.existsSync(g));
}

const url = new URL(connectionUrl());
// Named in office time, not UTC - a file called 14-32 taken at half seven in
// the evening is no use when you are looking for the one from before lunch.
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })
  .slice(0, 16).replace(/[: ]/g, '-');
const outDir = path.join(os.homedir(), 'Desktop', 'arabella-backups');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `arabella-${stamp}.sql`);

// --single-transaction so the dump is consistent without locking the live
// tables while the office is using the system.
const args = [
  `--host=${url.hostname}`,
  `--port=${url.port || 3306}`,
  `--user=${decodeURIComponent(url.username)}`,
  `--password=${decodeURIComponent(url.password)}`,
  '--single-transaction',
  '--routines',
  '--events',
  '--default-character-set=utf8mb4',
  url.pathname.replace('/', '') || 'railway',
];

console.log(`\nBacking up ${url.hostname} -> ${outFile}`);

const out = fs.createWriteStream(outFile);
const dump = spawn(findMysqldump(), args);
dump.stdout.pipe(out);
dump.stderr.on('data', d => {
  const msg = d.toString();
  // mysqldump warns about the password on the command line every single run.
  if (!msg.includes('Using a password on the command line')) process.stderr.write(msg);
});

dump.on('error', err => {
  console.error('\nCould not run mysqldump:', err.message);
  console.error('Install MySQL Server, or add its bin folder to PATH.\n');
  process.exit(1);
});

dump.on('close', code => {
  out.end();
  if (code !== 0) {
    console.error(`\nmysqldump exited with code ${code}. The file may be incomplete.\n`);
    process.exit(code);
  }
  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`Done. ${mb} MB written.\n`);
});
