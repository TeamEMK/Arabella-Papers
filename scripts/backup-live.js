/**
 * Takes a full dump of the live database to the Desktop.
 *
 * Railway keeps automatic backups on the Pro plan only, so on Hobby there is
 * nothing standing between a bad UPDATE and 8,600 lost orders. This is the
 * stand-in: run it before anything risky, and on a schedule if you can.
 *
 *   node scripts/backup-live.js "mysql://root:PASS@host.proxy.rlwy.net:12345/railway"
 *
 * That is the first run: paste the URL from Railway -> MySQL -> Variables ->
 * MYSQL_PUBLIC_URL. It is saved to .env.backup, which is gitignored, so the
 * live password stays out of the repo. Every run after that is just:
 *
 *   node scripts/backup-live.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function connectionUrl() {
  // Pasted on the command line the first time, saved so the next run needs
  // nothing. Creating a dotfile by hand on Windows is more trouble than it is
  // worth, and this is meant to be run in a hurry.
  const arg = process.argv[2];
  if (arg && arg.startsWith('mysql://')) {
    fs.writeFileSync(path.join(ROOT, '.env.backup'), `LIVE_DB_URL=${arg}\n`);
    console.log('Saved the connection string. Next time just run the script.');
    return arg;
  }

  if (process.env.LIVE_DB_URL) return process.env.LIVE_DB_URL;

  const file = path.join(ROOT, '.env.backup');
  if (!fs.existsSync(file)) {
    console.error('\nNo connection string yet. Run it once with the URL:\n');
    console.error('  node scripts/backup-live.js "mysql://root:PASS@host.proxy.rlwy.net:12345/railway"\n');
    console.error('Copy that from Railway -> MySQL -> Variables -> MYSQL_PUBLIC_URL.');
    console.error('It gets saved, so later runs need nothing.\n');
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
  // The dump goes over Railway's TCP proxy from an office line, and on
  // 20 October it dropped mid-table: "Lost connection to MySQL server during
  // query" while reading activity_log, which is a tenth of a megabyte. It was
  // the link, not the size. Fewer bytes on the wire, a connect that is allowed
  // to take its time, and room for a big row.
  //
  // Every option on this list has been run against the live server. That is
  // not a boast, it is the whole lesson of 20-23 October: --net-read-timeout
  // and --net-write-timeout were added here to cure a dropped link, and they
  // are SERVER variables, not mysqldump options. The client refuses an unknown
  // variable outright - "unknown variable 'net-read-timeout=600'", exit 7 -
  // before it has connected to anything, so the dump did not get slower or
  // flakier, it stopped happening at all. Three mornings, no backup, and the
  // only thing standing between the office and a bad UPDATE was a dialog
  // somebody clicked OK on. --connect-timeout is rejected the same way.
  //
  // So: nothing goes on this list that has not been run. There is no
  // client-side read timeout for mysqldump; the retry in backup-auto.ps1 is
  // what actually carries a dump past a blip.
  // --compress was here and printed a deprecation notice on every run. That
  // notice is the first thing the failure dialog shows, above the line that
  // says what actually went wrong - on 25 October it pushed "Unknown MySQL
  // server host" into second place. A warning nobody needs, sitting on top of
  // the message somebody does, is how warnings stop being read. This is the
  // replacement it names, and it has been run against the live server: same
  // output, no notice.
  '--compression-algorithms=zlib',
  '--max-allowed-packet=1G',
  // This dump is restored into a different server, so the source's GTIDs are
  // not wanted - and leaving it off printed a warning on every single run
  // that trained everybody to ignore the warnings.
  '--set-gtid-purged=OFF',
  url.pathname.replace('/', '') || 'railway',
];

console.log(`\nBacking up ${url.hostname} -> ${outFile}`);

const out = fs.createWriteStream(outFile);
const dump = spawn(findMysqldump(), args);
dump.stdout.pipe(out);
// Filtered a line at a time, not a chunk at a time.
//
// mysqldump warns about the password on every single run and that warning is
// noise, but it arrives in the same write as whatever follows it. Testing the
// whole chunk threw the real message away with it: on 21 October the log of a
// failed run read "FAILED - exit 7 - mysqldump:" and nothing else, while the
// line that explained the whole thing - "[ERROR] unknown variable
// 'net-read-timeout=600'" - had been swallowed by the same filter. Three
// mornings of failures were diagnosed by reproducing them instead of by
// reading the log, which is what the log is for.
dump.stderr.on('data', d => {
  const keep = d.toString().split(/\r?\n/)
    .filter(line => line.trim() && !line.includes('Using a password on the command line'));
  if (keep.length) process.stderr.write(keep.join('\n') + '\n');
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
