// ══════════════════════════════════════════════════════
// A SCHEDULED JOB THAT CANNOT GO OUT TWICE
//
// The two nightly jobs did their work every time they were called and kept
// no record of having run. That is fine while nothing calls them twice, and
// two things do:
//
//   THE PLATFORM RETRIES. A function that times out or answers 5xx is
//   called again. The stage report sends its mail and then builds nothing
//   else, so the likeliest failure is a timeout AFTER the mail has gone -
//   and the retry sends it again, to the whole office.
//
//   ANYBODY HOLDING THE TOKEN. The token is the only way in and it is not
//   meant to leave Vercel, but a secret that has leaked should cost one
//   duplicate mail, not a hundred.
//
// So the run is CLAIMED BEFORE THE WORK, in a table with the job and the
// day as its primary key. The second caller's insert collides, is told the
// job has already run, and does nothing. Two callers arriving in the same
// second are decided by the index rather than by whichever read first.
//
// IT FAILS CLOSED, and that costs nothing here: the claim is a write to the
// same database the reports are built from, so a database that cannot take
// the claim could not have produced the report either. Refusing with a 503
// has the platform try again later, which is the right answer.
//
// A run that FAILS releases its claim, so the retry that follows is allowed
// to do the work. The one case this cannot help with is a job that half
// succeeded - some mail out, then a throw - and for that the honest answer
// is that the report is better sent twice than never.
// ══════════════════════════════════════════════════════
const db = require('../config/db');

/** The day in IST, which is the day the office means. */
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Claim today's run of this job.
 *
 * @returns {Promise<{ours: boolean, ran?: object}>} ours: true when this
 *          caller is the one that should do the work.
 * @throws  when the claim cannot be written at all - the caller answers 503.
 */
async function claim(job, runKey) {
  const key = runKey || todayIST();
  // INSERT IGNORE rather than "SELECT then INSERT": the gap between the two
  // is exactly where a retry arriving in the same second slips through.
  const [res] = await db.query(
    'INSERT IGNORE INTO cron_runs (job, run_key) VALUES (?, ?)', [job, key]);
  if (res.affectedRows === 1) return { ours: true, key };

  const [[row]] = await db.query(
    'SELECT started_at, finished_at, outcome FROM cron_runs WHERE job = ? AND run_key = ?',
    [job, key]);
  return { ours: false, key, ran: row || null };
}

/** Done. What happened is kept, so the table reads as a log of the week. */
async function finish(job, runKey, outcome) {
  try {
    await db.query(
      `UPDATE cron_runs SET finished_at = NOW(), outcome = ?
        WHERE job = ? AND run_key = ?`,
      [String(outcome || '').slice(0, 255), job, runKey]);
  } catch (err) {
    console.error('[cron] could not record the finish of ' + job + ':', err.message);
  }
}

/** It threw. The claim goes, so the platform's retry may do the work. */
async function release(job, runKey) {
  try {
    await db.query('DELETE FROM cron_runs WHERE job = ? AND run_key = ?', [job, runKey]);
  } catch (err) {
    console.error('[cron] could not release the claim on ' + job + ':', err.message);
  }
}

/**
 * Wraps a job so it runs at most once a day.
 *
 * `force` is for the office asking for the report again by hand, with the
 * same token the scheduler uses. It is written into the log as a forced run
 * rather than quietly replacing the day's record.
 */
async function runOnce(job, work, { force } = {}) {
  const key = todayIST();

  if (force) {
    console.warn('[cron] ' + job + ' forced for ' + key + ' - the once-a-day guard was skipped');
    const out = await work();
    await db.query(
      `INSERT INTO cron_runs (job, run_key, finished_at, outcome)
       VALUES (?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE finished_at = NOW(), outcome = VALUES(outcome)`,
      [job, key + ' forced ' + Date.now(), 'forced: ' + JSON.stringify(out).slice(0, 200)],
    ).catch(err => console.error('[cron] could not log a forced run:', err.message));
    return { ...out, forced: true };
  }

  const got = await claim(job, key);
  if (!got.ours) {
    return {
      alreadyRan: true,
      job,
      day: key,
      startedAt: got.ran && got.ran.started_at,
      outcome: got.ran && got.ran.outcome,
    };
  }

  try {
    const out = await work();
    await finish(job, key, JSON.stringify(out).slice(0, 200));
    return out;
  } catch (err) {
    await release(job, key);
    throw err;
  }
}

module.exports = { runOnce, claim, finish, release, todayIST };
