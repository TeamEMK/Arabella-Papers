/**
 * WHICH BUILD IS THIS.
 *
 * One short string that changes when the app does, and stays the same while
 * it does not. The browser asks for it every few minutes and reloads itself
 * when the answer stops matching the one it started with - see
 * public/js/version-watch.js.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *   1. The commit Vercel built. Exactly right, and free.
 *   2. A hash of the two files that actually carry the app to a browser -
 *      the shell and the stylesheet inside it. For a server started by hand
 *      this is what changes when somebody edits either of them.
 *   3. The moment the process started. A fallback for the case where
 *      neither file can be read; it makes every restart look like a new
 *      build, which is noisy but never wrong in the dangerous direction.
 *
 * Read once, at startup. The point is to describe the running build, so
 * re-reading the files later would defeat it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function compute() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA;
  if (sha) return String(sha).slice(0, 8);

  try {
    const root = path.join(__dirname, '..');
    const files = [
      path.join(root, 'views', 'app.ejs'),
      path.join(root, 'views', 'partials', 'stylesheet.ejs'),
    ];
    const h = crypto.createHash('sha1');
    files.forEach(f => h.update(fs.readFileSync(f)));
    return h.digest('hex').slice(0, 8);
  } catch (err) {
    return 'b' + Date.now().toString(36);
  }
}

module.exports = compute();
