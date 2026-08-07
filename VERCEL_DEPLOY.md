# Arabella Paper FMS — Vercel (app) + Railway (MySQL)

The whole Express app runs as a Vercel serverless function; Railway hosts only
the MySQL database. If you would rather run everything on Railway, see
[RAILWAY_DEPLOY.md](RAILWAY_DEPLOY.md) — that path needs no code changes and has
none of the limits listed at the bottom of this file.

---

## Step 1: MySQL on Railway

1. [railway.app](https://railway.app) → **New Project** → **+ New** → **Database** → **MySQL**
2. Open the MySQL service → **Variables** tab

> ⚠️ **Use the PUBLIC connection details, not the private ones.**
> Railway shows a private host like `mysql.railway.internal`. That only resolves
> inside Railway's network — Vercel cannot reach it and every request will hang
> until it times out. You need the public TCP proxy.

3. In the **Variables** tab find `MYSQL_PUBLIC_URL`. It looks like:

   ```
   mysql://root:PASSWORD@shinkansen.proxy.rlwy.net:41234/railway
            └─user┘ └─pass─┘ └────── host ──────┘ └port┘ └ db ┘
   ```

   Pull the five pieces out of it — those are your `DB_*` values below.

---

## Step 2: Create the tables

1. MySQL service → **Data** tab → **Query**
2. Paste all of [config/schema.sql](config/schema.sql) and run it

This creates the tables plus the default admin user. The `sessions` table is
created automatically by the app on first boot.

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
   | `DB_NAME` | usually `railway` |
   | `SESSION_SECRET` | long random string (see below) |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `akhileshvyas@reactwebappav.iam.gserviceaccount.com` |
   | `GOOGLE_PRIVATE_KEY` | `"-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"` |
   | `DRIVE_FOLDER_ID` | your Drive folder ID |

   Do **not** set `PORT` or `VERCEL` — Vercel manages both.

5. **Deploy**

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Default login is `admin@arabella.com` / `admin123` — **change it right after the
first login.**

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
`VERCEL` is set for exactly this reason. If you start seeing
`ER_CON_COUNT_ERROR` or `Too many connections`, that is the cause — raise the
Railway plan's connection limit or move the app to Railway.

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
| Login redirects back to `/login` forever | `SESSION_SECRET` missing, or the `sessions` table could not be created — check the DB user's privileges. |
| 500 on every page | Function logs: Vercel → project → **Logs**. Usually a wrong `DB_*` value. |
| `File too large` on upload | Over the 4MB per-file cap. See limits above. |
| Uploads fail with a Drive permission error | Folder not shared with the service account, or `DRIVE_FOLDER_ID` is wrong. |
| Blank page / `Failed to lookup view` | `views/**` missing from the bundle — confirm `includeFiles` in [vercel.json](vercel.json). |
