// One-shot smoke test: boots the app, hits each route in-process,
// prints results, then exits. Used only for verifying correctness
// inside the sandbox (the real server.js runs persistently).
require('dotenv').config();
const express = require('express');
const http = require('http');

const dbModule = require('./db');
const { refreshAll } = require('./db/refresh');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const copilotRoutes = require('./routes/copilot');
const syncRoutes = require('./routes/sync');

const app = express();
app.use(express.json());
app.use('/api', dashboardRoutes);
app.use('/api/copilot', copilotRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/sync', syncRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true }));

(async () => {
  await dbModule.init();
  console.log('[boot] db ready');
  const r = await refreshAll();
  console.log('[boot] refresh:', r);

  const server = app.listen(0, () => {
    const port = server.address().port;
    console.log('[boot] listening on', port);

    const paths = [
      '/api/health',
      '/api/exec-summary',
      '/api/revenue-trend',
      '/api/bd-performance',
      '/api/source-performance',
      '/api/followups',
      '/api/leakage',
      '/api/forecast',
      '/api/manipulation',
      '/api/collections',
      '/api/funnel',
      '/api/bd-daily-calls?bd_id=bd_rahul&days=7',
      '/api/uncalled-leads?bucket=15%2Bd&bd_id=bd_varun&include_daywise=1',
      '/api/settings',
    ];

    let i = 0;
    function next() {
      if (i >= paths.length) { server.close(); return; }
      const p = paths[i++];
      http.get(`http://localhost:${port}${p}`, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          console.log(`\n=== ${p} (${res.statusCode}) ===`);
          try {
            const json = JSON.parse(data);
            console.log(JSON.stringify(json, null, 2).slice(0, 1200));
          } catch {
            console.log(data.slice(0, 500));
          }
          next();
        });
      }).on('error', e => { console.error(p, 'ERROR', e.message); next(); });
    }
    next();
  });
})();
