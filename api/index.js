// Vercel serverless entry point.
// server.js skips app.listen() when VERCEL is set and just exports the Express
// app, which Vercel invokes as the handler for every incoming request.
module.exports = require('../server');
