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

// ── ONE-TIME: remove demo/seed data, keep real synced data + config ──
// Visit this URL once (in browser, or with your admin token if set) to
// strip out the original demo BDs/leads/calls/sales/etc. that shipped
// with seed.sql, leaving only data synced from OCRM / Sales API plus
// your config and connector settings. Safe to run multiple times —
// it does nothing on the second run since the seed rows are gone.
app.get('/api/cleanup-seed', requireAdmin, (req, res) => {
  const { all, run } = require('./db');
  const seedBds = ['bd_priya','bd_ajay','bd_sneha','bd_neha','bd_kabir','bd_varun','bd_rahul','bd_dev'];
  const seedCamps = ['camp_referral','camp_fb','camp_yt','camp_google','camp_organic','camp_wa'];
  const seedTls = ['tl_anand','tl_meena'];
  const ph = arr => arr.map(() => '?').join(',');

  const before = {
    leads: all(`SELECT COUNT(*) AS n FROM leads WHERE lead_id GLOB 'lead_[0-9][0-9][0-9][0-9][0-9]'`)[0].n,
    bds: all(`SELECT COUNT(*) AS n FROM bds WHERE bd_id IN (${ph(seedBds)})`, seedBds)[0].n,
    calls: all(`SELECT COUNT(*) AS n FROM calls WHERE bd_id IN (${ph(seedBds)})`, seedBds)[0].n,
    sales: all(`SELECT COUNT(*) AS n FROM sales WHERE bd_id IN (${ph(seedBds)})`, seedBds)[0].n,
    followups: all(`SELECT COUNT(*) AS n FROM followups WHERE bd_id IN (${ph(seedBds)})`, seedBds)[0].n,
    collections: all(`SELECT COUNT(*) AS n FROM collections WHERE order_id LIKE 'order_%'`)[0].n,
    campaigns: all(`SELECT COUNT(*) AS n FROM campaigns WHERE campaign_id IN (${ph(seedCamps)})`, seedCamps)[0].n,
    team_leaders: all(`SELECT COUNT(*) AS n FROM team_leaders WHERE tl_id IN (${ph(seedTls)})`, seedTls)[0].n,
  };

  // Delete dependent rows first
  run(`DELETE FROM sales WHERE bd_id IN (${ph(seedBds)})`, seedBds);
  run(`DELETE FROM calls WHERE bd_id IN (${ph(seedBds)})`, seedBds);
  run(`DELETE FROM followups WHERE bd_id IN (${ph(seedBds)})`, seedBds);
  run(`DELETE FROM collections WHERE order_id LIKE 'order_%'`);

  // Delete seed leads (exact pattern: lead_NNNNN, 5 digits)
  run(`DELETE FROM leads WHERE lead_id GLOB 'lead_[0-9][0-9][0-9][0-9][0-9]'`);

  // Delete seed BDs, campaigns, team leaders
  run(`DELETE FROM bds WHERE bd_id IN (${ph(seedBds)})`, seedBds);
  run(`DELETE FROM campaigns WHERE campaign_id IN (${ph(seedCamps)})`, seedCamps);
  run(`DELETE FROM team_leaders WHERE tl_id IN (${ph(seedTls)})`, seedTls);

  const refreshed = refreshAll();

  res.json({ ok: true, deleted_counts: before, refreshed });
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
