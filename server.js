// ════════════════════════════════════════════════════════════════
// server.js — RISCC backend entry point
// ════════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const dbModule = require('./db');
const { refreshAll } = require('./db/refresh');

const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const copilotRoutes = require('./routes/copilot');
const syncRoutes = require('./routes/sync');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Simple bearer-token auth for write endpoints (settings/sync) ──
// Set ADMIN_TOKEN in .env. If unset, these routes are open — fine for
// local/dev, but set this before deploying publicly.
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(); // no token configured -> open (dev mode)
  const header = req.headers.authorization || '';
  if (header === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'Unauthorized — missing/invalid admin token' });
}

// ── Routes ──────────────────────────────────────────────────────
app.use('/api', dashboardRoutes);
app.use('/api/copilot', copilotRoutes);
app.use('/api/settings', requireAdmin, settingsRoutes);
app.use('/api/sync', requireAdmin, syncRoutes);

app.get('/api/refresh', requireAdmin, (req, res) => {
  res.json(refreshAll());
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── Serve the frontend (place RISCC_dashboard.html in /public) ───
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot ────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection:', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});

async function start() {
  await dbModule.init();
  console.log('[boot] db ready, running initial refresh...');
  try {
    const r = refreshAll();
    console.log('[boot] refresh complete:', r);
  } catch (e) {
    console.error('[boot] refresh failed:', e);
    throw e;
  }

  // Refresh every 15 minutes per Doc 5
  cron.schedule('*/15 * * * *', () => {
    console.log('[cron] refreshing materialized tables...');
    refreshAll();
  });

  app.listen(PORT, () => {
    console.log(`\n  RISCC backend running -> http://localhost:${PORT}`);
    console.log(`  Dashboard:            http://localhost:${PORT}/`);
    console.log(`  API health:           http://localhost:${PORT}/api/health`);
    console.log(`  Settings (API keys):  http://localhost:${PORT}/api/settings\n`);
  });
}

start().catch(e => {
  console.error('[boot] FATAL:', e);
  process.exit(1);
});
