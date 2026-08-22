// Check the SMTP settings without punching a real order.
//
//   npm run mail:test                       — just verify the credentials
//   npm run mail:test you@arabellapapers.com — verify, then send a sample
//
// Run it after filling SMTP_* in .env, and again on the server once the same
// variables are set there. A wrong app password fails here in two seconds
// instead of silently swallowing a designer's assignment notice later.
require('dotenv').config();

const { verifyMail, sendMail, isMailConfigured } = require('../utils/mailer');

(async () => {
  if (!isMailConfigured()) {
    console.log('Mail is OFF — SMTP_USER / SMTP_PASS are not set.');
    console.log('Fill them in .env (see .env.example) and run this again.');
    process.exit(1);
  }

  console.log(`host : ${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || 465}`);
  console.log(`user : ${process.env.SMTP_USER}`);

  const check = await verifyMail();
  if (!check.ok) {
    console.error(`\nSMTP login FAILED: ${check.error}`);
    console.error('For Google Workspace this is almost always the App Password —');
    console.error('the normal account password will not work over SMTP.');
    process.exit(1);
  }
  console.log('\nSMTP login OK.');

  const to = process.argv[2];
  if (!to) {
    console.log('Pass an address to also send a sample: npm run mail:test you@example.com');
    return;
  }

  const result = await sendMail({
    to,
    subject: 'Arabella Papers FMS — mail test',
    text: 'If you are reading this, the FMS can send designer assignment notices.',
    html: '<p>If you are reading this, the FMS can send designer assignment notices.</p>',
  });

  console.log(result.sent ? `Sample sent to ${to}.` : `Sample FAILED: ${result.error || result.skipped}`);
  process.exit(result.sent ? 0 : 1);
})();
