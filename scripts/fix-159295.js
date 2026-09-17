/**
 * One-off repair for K-159295.
 *
 * On 17/09 the order was marked Reprint while the old behaviour was still
 * live, so the run that was actually made and sent got written over: the
 * approval, the dispatch, all ten production stages and every stamp behind
 * them. This puts that run back on K-159295 and opens K-159295-R1 for the
 * reprint, which is where the new run should have gone.
 *
 * Every value below is read off the change log - the old_value column of the
 * rows written at 17/09 11:28:16 - or off the timestamp of the log row that
 * recorded the change. Nothing is invented. Two stamps cannot be recovered
 * (paper_cutting and guest_name were set before the log existed) and are left
 * blank; neither is printed anywhere on its own.
 *
 * DEPLOY FIRST. This needs the remake_of column, which the app adds on boot,
 * and it calls the new code to open the reprint entry.
 *
 *   node scripts/fix-159295.js           # says what it would do, writes nothing
 *   node scripts/fix-159295.js --apply   # does it
 *
 * Run it from the project folder - it reads .env.backup for the live
 * connection string, the same file scripts/backup-live.js writes.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const ID = 'K-159295';

// The run that was made and sent, exactly as the change log recorded it.
const RESTORE = {
  design_approval_status_from_client: 'Final Approval For Production',
  // From order_approvals, which kept the round the reset did not touch.
  actual_2: '2026-08-21 11:20:28',

  guest_name: 'No',
  paper_cutting: 'Done',
  dye_status: 'DIE CUTTING DONE',
  block_status: 'BLOCK PRINTED',
  printing: 'Done',
  printing_type: 'Letterpress',
  edges: 'No',
  laser_cutting: 'No',
  output: 'Done',
  card_assembly: 'Done',

  // Kailash, 02/09 14:22:39.
  dye_status_actual_time: '2026-09-02 14:22:39',
  die_cutting_done_actual_time: '2026-09-02 14:22:39',
  block_status_actual_time: '2026-09-02 14:22:39',
  block_printed_actual_time: '2026-09-02 14:22:39',
  printing_actual_time: '2026-09-02 14:22:39',
  no_laser_cutting_actual_time: '2026-09-02 14:22:39',
  // Ranjan, 04/09 12:25:04.
  edges_actual_time: '2026-09-04 12:25:04',
  card_assembly_actual_time: '2026-09-04 12:25:04',
  output_done_actual_time: '2026-09-04 12:25:04',

  // Handed to Dispatch by Ranjan, sent by Jitendra Singh. The same two log
  // rows the dispatch_ready_at migration itself read.
  status_4: 'Dispatched',
  dispatch_ready_at: '2026-09-04 12:25:13',
  actual_4: '2026-09-08 12:02:04',

  // All four were blank before 17/09. What was typed today is about the
  // reprint, and is carried to the new entry below instead.
  remarks: null,
  remark: null,
  remark_actual_time: null,
  pending_laser_cutting_actual_time: null,
  output_pending_actual_time: null,
};

// What was typed today, which belongs to the new run.
const REPRINT_REASON = 'digital color not matching';
const NEW_RUN_REMARK = 'direction card only color matching issue.';

function liveUrl() {
  if (process.env.LIVE_DB_URL) return process.env.LIVE_DB_URL;
  const file = path.join(process.cwd(), '.env.backup');
  if (!fs.existsSync(file)) throw new Error('No .env.backup - run this from the project folder.');
  return fs.readFileSync(file, 'utf8').trim().replace(/^LIVE_DB_URL=/, '');
}

/**
 * Point the app's own pool at the live database.
 *
 * config/db reads DB_HOST and friends off .env, which on this machine is the
 * local copy - and the second half of this script goes through the app's own
 * code, not through the connection opened below. Has to be set before anything
 * requires config/db.
 */
function aimAppAtLive() {
  const u = new URL(liveUrl());
  process.env.DB_HOST = u.hostname;
  process.env.DB_PORT = u.port || '3306';
  process.env.DB_USER = decodeURIComponent(u.username);
  process.env.DB_PASSWORD = decodeURIComponent(u.password);
  process.env.DB_NAME = u.pathname.replace(/^\//, '');
  return `${u.hostname}:${u.port}/${process.env.DB_NAME}`;
}

(async () => {
  console.log('Live database:', aimAppAtLive());
  const c = await mysql.createConnection({ uri: liveUrl(), timezone: '+05:30' });
  await c.query("SET time_zone = '+05:30'");

  const [cols] = await c.query("SHOW COLUMNS FROM orders LIKE 'remake_of'");
  if (!cols.length) throw new Error('remake_of is not on the database yet - deploy first.');

  const [[before]] = await c.query('SELECT * FROM orders WHERE order_id = ?', [ID]);
  if (!before) throw new Error(ID + ' not found.');

  // The row as it stands, saved before anything is touched.
  const backup = path.join(process.cwd(), `${ID}-before-repair.json`);
  fs.writeFileSync(backup, JSON.stringify(before, null, 2));
  console.log('Row as it stands saved to:', backup);

  console.log('\nOn ' + ID + ':');
  for (const [k, v] of Object.entries(RESTORE)) {
    const now = before[k] instanceof Date ? before[k].toISOString() : before[k];
    console.log(`  ${k}: ${JSON.stringify(now ?? null)} -> ${JSON.stringify(v)}`);
  }
  console.log('\n  and the 17/09 Reprint round comes off its approval history.');
  console.log('\nThen a new entry K-159295-R1 for the reprint, dated today,');
  console.log(`  reason: "${REPRINT_REASON}"`);
  console.log(`  production remark: "${NEW_RUN_REMARK}"`);

  if (!APPLY) {
    console.log('\nNothing written. Run again with --apply to do it.');
    await c.end();
    return;
  }

  const keys = Object.keys(RESTORE);
  await c.query(
    `UPDATE orders SET ${keys.map(k => `\`${k}\` = ?`).join(', ')} WHERE order_id = ?`,
    [...keys.map(k => RESTORE[k]), ID],
  );
  await c.query(
    "DELETE FROM order_approvals WHERE order_id = ? AND status = 'Reprint' AND DATE(approved_at) = '2026-09-17'",
    [ID],
  );
  await c.query(
    `INSERT INTO order_logs (order_id, action, field, old_value, new_value, changed_by)
     VALUES (?, 'Repaired', 'The 17/09 reprint had been written over this run; put back from the change log', '', '', 'system')`,
    [ID],
  );
  console.log('\n' + ID + ' is back to the run that went out on 08/09.');
  await c.end();

  // The reprint, opened properly this time - through the app's own code, so
  // the entry is built exactly the way the Till Approval screen builds one.
  // aimAppAtLive() has already pointed that code at the live database.
  const { raiseRemake } = require(path.join(process.cwd(), 'utils', 'remake'));
  const db = require(path.join(process.cwd(), 'config', 'db'));
  const made = await raiseRemake(ID, 'Reprint', {
    remark: REPRINT_REASON,
    user: { username: 'Ram Chandra Sharma' },
  });
  if (!made) throw new Error('The reprint entry was not opened - check utils/remake.js.');
  await db.query('UPDATE orders SET remark = ?, remark_actual_time = NOW() WHERE order_id = ?',
    [NEW_RUN_REMARK, made.childId]);
  console.log('Reprint opened as ' + made.childId + ', dated today, stages blank.');
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
