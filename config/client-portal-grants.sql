-- ══════════════════════════════════════════════════════
-- THE CUSTOMER PORTAL'S OWN DATABASE LOGIN
--
-- Run this ONCE, on the live server, as root:
--   Railway → MySQL → Data / Query, or any client connected with
--   MYSQL_PUBLIC_URL.
--
-- Then set these two in Vercel → Project → Settings → Environment Variables
-- and redeploy:
--
--   CLIENT_DB_USER      arabella_portal
--   CLIENT_DB_PASSWORD  <the password you put below>
--
-- Until those are set the portal keeps using the office login and says so in
-- the log on every boot - see config/clientDb.js. Nothing breaks either way.
--
-- WHY. The client portal is the one part of this system a stranger can walk
-- into and open an account on. It shared the login that can read every table
-- and drop any of them, so a single injection or a careless route on the
-- customer's side was the whole order book. After this, that query is not a
-- bug with consequences - it is MySQL answering "SELECT command denied".
--
-- CHANGE THE PASSWORD BELOW before running it. Long and random; it is typed
-- once, into Vercel, and never again.
-- ══════════════════════════════════════════════════════

CREATE USER IF NOT EXISTS 'arabella_portal'@'%'
  IDENTIFIED BY 'CHANGE-THIS-TO-A-LONG-RANDOM-PASSWORD';

-- The three catalogues the customer browses. Read only: these are the
-- office's own content and the portal has no business changing them.
GRANT SELECT ON railway.catalogue_items       TO 'arabella_portal'@'%';
GRANT SELECT ON railway.envelope_linears      TO 'arabella_portal'@'%';
GRANT SELECT ON railway.envelope_linear_items TO 'arabella_portal'@'%';

-- The paper stock, for the customer's fourth door. Read only, and the
-- `note` column is never read by the route - it carries supplier names and
-- buying prices.
GRANT SELECT ON railway.stock_items TO 'arabella_portal'@'%';

-- Their own account: made at sign-up, read at sign-in, updated for the
-- code and the password. No DELETE - an account going missing should be a
-- decision somebody made in the office, not something this code can do.
GRANT SELECT, INSERT, UPDATE ON railway.client_users TO 'arabella_portal'@'%';

-- The quote they ask for. INSERT only: the portal writes one and never
-- reads the table back, so it cannot be made to hand over what another
-- customer was quoted.
GRANT INSERT ON railway.pricing_quotes TO 'arabella_portal'@'%';

FLUSH PRIVILEGES;

-- ── To check it afterwards ──
-- SHOW GRANTS FOR 'arabella_portal'@'%';
--
-- And the proof that matters, run while connected AS that user:
--   SELECT * FROM orders LIMIT 1;
-- It must answer:
--   ERROR 1142 (42000): SELECT command denied to user 'arabella_portal'@...
--
-- ── If it ever has to be undone ──
-- Clear the two Vercel variables and redeploy; the portal goes back to the
-- office login. The user itself can stay, or:
--   DROP USER 'arabella_portal'@'%';
