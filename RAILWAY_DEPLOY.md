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

GOOGLE_SERVICE_ACCOUNT_EMAIL = akhileshvyas@reactwebappav.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
DRIVE_FOLDER_ID  = YOUR_GOOGLE_DRIVE_FOLDER_ID

NODE_ENV         = production
PORT             = 3000
```

---

## Step 4: Run Schema

1. Go to MySQL service → **Query** tab (or use any MySQL client with Railway's connection string)
2. Paste the contents of `config/schema.sql` and run it
3. This creates all tables and the default admin user

---

## Step 5: Deploy

Railway auto-deploys when you push to GitHub. Or click **Deploy** manually.

Default admin login:
- **Email**: `admin@arabella.com`
- **Password**: `admin123`

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
