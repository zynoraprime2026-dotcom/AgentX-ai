// Vercel serverless entry: waits for the DB/seed init before handling requests.
const { app, ready } = require('../server');

module.exports = (req, res) =>
  ready.then(() => app(req, res)).catch(() => {
    res.status(500).json({ error: 'startup failed' });
  });
