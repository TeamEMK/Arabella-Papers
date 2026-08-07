# Arabella Paper FMS — Vercel (app) + Railway (MySQL)

The whole Express app runs as a Vercel serverless function; Railway hosts only
the MySQL database. If you would rather run everything on Railway, see
[RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md) — that path needs no code changes and has
none of the limits listed at the bottom of this file.

---

## Step 1: MySQL on Railway

1. [railway.app](https://railway.app) → **New Project** → **+ New** → **Database** → **MySQL**

### Turn on public networking — this is not optional

A fresh Railway MySQL is reachable **only from inside Railway**. Its variables
all point at the private domain:

```
MYSQLHOST = ${{RAILWAY_PRIVATE_DOMAIN}}   →  mysql.railway.internal
MYSQLPORT = 3306
```

`mysql.railway.internal` does not resolve from the public internet, so a Vercel
function using it will hang until the request times out. There is no `DB_*`
combination that makes the private host work from Vercel — you have to expose a
public endpoint.

2. MySQL service → **Settings** → **Networking** → **Public Networking** →
   **TCP Proxy** → choose port `3306` → apply.

Railway then generates a public address and adds two variables that did not
exist before:

| Variable | Example |
|---|---|
| `RAILWAY_TCP_PROXY_DOMAIN` | `shinkansen.proxy.rlwy.net` |
| `RAILWAY_TCP_PROXY_PORT` | `41234` |

`MYSQL_PUBLIC_URL` also appears once the proxy is on:

```
mysql://root:PASSWORD@shinkansen.proxy.rlwy.net:41234/railway
        └user┘ └─pass─┘ └────── host ──────┘ └port┘ └ db ┘
```

> ⚠️ **The public port is not 3306.** The proxy listens on a random high port.
> Copying the public host but leaving `DB_PORT=3306` is the single most common
> way this setup fails — and it fails as a silent timeout, not a clear error.

Settings → Networking shows the mapping as `<public-host>:<public-port> → :3306`.
The left side is what you want; the `3306` on the right is the internal port the
proxy forwards to, and never goes into `DB_PORT`.

Verify the endpoint from your own machine before touching Vercel — if this
fails, nothing deployed will work either:

```bash
mysql -h <public-host> -P <public-port> -u root -p railway -e "SELECT VERSION();"
```

---

## Step 2: Create the tables — nothing to do

The app builds its own schema. [config/initDb.js](config/initDb.js) checks for
the `users` table on the first request and, if the database is empty, runs
[config/schema.sql](config/schema.sql) against whatever `DB_NAME` points at.

It is safe to run repeatedly: every statement is `CREATE TABLE IF NOT EXISTS` or
`INSERT IGNORE`, and the check short-circuits once the tables exist. Concurrent
requests during a cold start share one promise, so the schema is never built
twice in parallel.

One detail worth knowing: `schema.sql` opens with

```sql
CREATE DATABASE IF NOT EXISTS arabella_paper ...;
USE arabella_paper;
```

Hosted MySQL hands you an already-created database (Railway calls it `railway`),
so `initDb.js` strips that header before running the statements. That is why
`DB_NAME=railway` works even though the file names a different database. If you
ever load the file by hand instead, skip those two lines or the tables will land
somewhere `DB_NAME` isn't pointing.

The default admin user is created along with the tables.

---

## Step 3: Deploy to Vercel

1. [vercel.com](https://vercel.com) → **Add New** → **Project**
2. Import `TeamEMK/Arabella-Papers`
3. Framework Preset: **Other**. Leave build/output settings empty —
   [vercel.json](vercel.json) already routes every request to
   [api/index.js](api/index.js).
4. Expand **Environment Variables** and add:

   | Variable | Value |
   |---|---|
   | `DB_HOST` | public proxy host, e.g. `shinkansen.proxy.rlwy.net` |
   | `DB_PORT` | public proxy port, e.g. `41234` |
   | `DB_USER` | usually `root` |
   | `DB_PASSWORD` | from `MYSQL_PUBLIC_URL` |
   | `DB_NAME` | `railway` — must match whichever database you loaded the schema into in Step 2 |
   | `SESSION_SECRET` | long random string (see below) |
   | `ADMIN_EMAIL` | `admin@arabella.com` |
   | `ADMIN_PASSWORD` | a strong password you choose — this becomes your login |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `akhileshvyas@reactwebappav.iam.gserviceaccount.com` |
   | `GOOGLE_PRIVATE_KEY` | `"-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"` |
   | `DRIVE_FOLDER_ID` | your Drive folder ID |

   Do **not** set `PORT` or `VERCEL` — Vercel manages both.

5. **Deploy**

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Your login is the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you just set. The account is
created on the first request, and only while the `users` table is empty — it is
never re-created or reset afterwards, so changing `ADMIN_PASSWORD` later does
nothing. Change passwords through the app once you are in.

No password or hash lives in the repo, so read access to the code grants no
login.

---

## Google Drive setup

- `GOOGLE_PRIVATE_KEY` must keep its literal `\n` sequences, wrapped in quotes.
  Do not paste real line breaks — [utils/drive.js](utils/drive.js) converts `\n`
  back to newlines at runtime.
- Share the Drive folder with the service account email as **Editor**, or every
  upload fails with a permission error.
- `DRIVE_FOLDER_ID` is the last path segment of the folder URL:
  `drive.google.com/drive/folders/THIS_PART`

---

## Known limits of running this on Vercel

These are consequences of serverless, not bugs. Each one is a real behaviour
change versus running the app on Railway.

**Uploads are capped at 4MB per file.** Vercel rejects any request body over
4.5MB before your code sees it. The multer limits in
[routes/api/orders.js](routes/api/orders.js) and
[routes/api/dashboards.js](routes/api/dashboards.js) are set to 4MB so users get
a clear "File too large" message instead of an opaque platform 413. The order
form accepts up to 10 files at once, but the **combined** body still has to stay
under 4.5MB — ten 4MB files will be rejected by Vercel regardless of the
per-file limit. Larger design files need a different path (direct
browser-to-Drive upload, or host the app on Railway).

**Cold starts are slow.** A request arriving at an idle function pays for Node
boot plus a fresh MySQL handshake to Railway — typically 2–5 seconds. Warm
requests are fast.

**Database connections are the thing most likely to break under load.** Every
warm function instance holds its own pool, and Vercel runs many instances
concurrently. [config/db.js](config/db.js) caps each pool at 2 connections when
`VERCEL` is set for exactly this reason. Railway MySQL allows 151 connections
(`SELECT @@max_connections`), so roughly 75 concurrent warm instances would
exhaust it — comfortable for an internal tool, not for a public traffic spike.
If you start seeing `ER_CON_COUNT_ERROR` or `Too many connections`, that is the
cause — raise the Railway plan's connection limit or move the app to Railway.

**Every query crosses the public internet.** Vercel function → Railway public
proxy → MySQL, on each query. On Railway both services share a private network
instead. Dashboard pages that run several queries feel this most.

**Expired session rows are never cleaned up.** The store's cleanup timer is
disabled under `VERCEL` ([server.js](server.js)) because a serverless function
gets frozen before an interval can fire. Sessions still expire correctly for
users — the cookie and the `expires` column both enforce the 8-hour limit — but
dead rows accumulate in the `sessions` table. Clear them occasionally:

```sql
DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP();
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Requests hang, then 504 | `DB_HOST` is the private `.railway.internal` host. Use the public proxy host. |
| `ER_NO_SUCH_TABLE` | `DB_NAME` points at a different database than the one you loaded the schema into. See Step 2. |
| Login redirects back to `/login` forever | `SESSION_SECRET` missing, or the `sessions` table could not be created — check the DB user's privileges. |
| 500 on every page | Function logs: Vercel → project → **Logs**. Usually a wrong `DB_*` value. |
| `File too large` on upload | Over the 4MB per-file cap. See limits above. |
| Uploads fail with a Drive permission error | Folder not shared with the service account, or `DRIVE_FOLDER_ID` is wrong. |
| Blank page / `Failed to lookup view` | `views/**` missing from the bundle — confirm `includeFiles` in [vercel.json](vercel.json). |
