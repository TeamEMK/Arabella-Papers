# Arabella Paper FMS — Railway Deployment Guide

## Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app) → New Project
2. Select **"Deploy from GitHub repo"**
3. Connect your GitHub and push this code

---

## Step 2: Add MySQL Database

1. In your Railway project → **+ New Service** → **MySQL**
2. Click MySQL service → **Variables** tab
3. Copy: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQL_DATABASE`

---

## Step 3: Add Environment Variables to Node.js Service

Go to your Node.js service → **Variables** tab, add:

```
DB_HOST          = <from MySQL MYSQL_HOST>
DB_PORT          = <from MySQL MYSQL_PORT>
DB_USER          = <from MySQL MYSQLUSER>
DB_PASSWORD      = <from MySQL MYSQLPASSWORD>
DB_NAME          = <from MySQL MYSQL_DATABASE>

SESSION_SECRET   = any_random_long_string_here

ADMIN_EMAIL      = admin@arabella.com
ADMIN_PASSWORD   = a_strong_password_you_choose

GOOGLE_SERVICE_ACCOUNT_EMAIL = akhileshvyas@reactwebappav.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DRIVE_FOLDER_ID  = YOUR_GOOGLE_DRIVE_FOLDER_ID

NODE_ENV         = production
PORT             = 3000
```

---

## Step 4: Schema — nothing to do

The app creates its own tables. `config/initDb.js` runs `config/schema.sql` on
first boot if the database is empty, and skips it otherwise.

The first admin comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, hashed at runtime —
there is no password or hash in the repo, so nobody gets a working login just by
reading the code. It is created only while the `users` table is empty; after
that, change passwords through the app.

The boot log tells you which happened:

```
Database: schema created
Admin:    created admin@arabella.com

Database: schema already present
Admin:    not created (users already exist)
```

`Admin: not created (ADMIN_PASSWORD not set)` means the tables exist but nobody
can log in — set the variable and restart.

---

## Step 5: Deploy

Railway auto-deploys when you push to GitHub. Or click **Deploy** manually.

Log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in Step 3.

⚠️ Change this password immediately after first login!

---

## Google Drive Private Key Format

In Railway variables, paste the key exactly as:
```
"-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
```
The `\n` newlines are important — don't paste literal line breaks.

---

## DRIVE_FOLDER_ID

1. Go to your Google Drive folder
2. Copy the ID from the URL: `drive.google.com/drive/folders/THIS_PART`
3. Share the folder with: `akhileshvyas@reactwebappav.iam.gserviceaccount.com` (Editor)

---

## Troubleshooting

- **Session issues**: Make sure `SESSION_SECRET` is set
- **DB connection failed**: Double-check Railway MySQL variables
- **File upload fails**: Check `DRIVE_FOLDER_ID` and service account permissions
- **View logs**: Railway → your service → **Logs** tab
