// ════════════════════════════════════════════════════════════════
// routes/settings.js — API key / connector management
//
// SECURITY MODEL:
//  - Keys are stored ONLY in the server-side Postgres DB.
//  - GET /api/settings returns MASKED keys only (e.g. "sk-ant-...kx9Q")
//    — never the full value.
//  - POST /api/settings/:connector updates a key. Protected by
//    requireAdmin in server.js if ADMIN_TOKEN is set.
// ════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { all, one, run } = require('../db');

function mask(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

// GET /api/settings — list all connectors with masked keys
router.get('/', async (req, res) => {
  try {
    const rows = await all(`SELECT connector_key, label, base_url, api_key, extra_config, enabled, updated_at FROM api_settings`);
    res.json(rows.map(r => ({
      connector_key: r.connector_key,
      label: r.label,
      base_url: r.base_url,
      api_key_masked: mask(r.api_key),
      has_key: !!r.api_key,
      extra_config: JSON.parse(r.extra_config || '{}'),
      enabled: !!r.enabled,
      updated_at: r.updated_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:connector — update a connector's settings
// Body: { api_key?, base_url?, extra_config?, enabled? }
// Sending an empty string for api_key leaves the existing key unchanged
// (so the UI never needs to redisplay/re-send the real key).
router.post('/:connector', async (req, res) => {
  try {
    const { connector } = req.params;
    const existing = await one(`SELECT * FROM api_settings WHERE connector_key=?`, [connector]);
    if (!existing) return res.status(404).json({ error: 'Unknown connector: ' + connector });

    const { api_key, base_url, extra_config, enabled } = req.body;

    const newKey = (api_key === undefined || api_key === '') ? existing.api_key : api_key;
    const newBaseUrl = base_url === undefined ? existing.base_url : base_url;
    const newExtra = extra_config === undefined ? existing.extra_config : JSON.stringify(extra_config);
    const newEnabled = enabled === undefined ? existing.enabled : (enabled ? 1 : 0);

    await run(
      `UPDATE api_settings SET api_key=?, base_url=?, extra_config=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE connector_key=?`,
      [newKey, newBaseUrl, newExtra, newEnabled, connector]
    );

    const updated = await one(`SELECT connector_key, label, base_url, api_key, extra_config, enabled, updated_at FROM api_settings WHERE connector_key=?`, [connector]);
    res.json({
      connector_key: updated.connector_key,
      label: updated.label,
      base_url: updated.base_url,
      api_key_masked: mask(updated.api_key),
      has_key: !!updated.api_key,
      extra_config: JSON.parse(updated.extra_config || '{}'),
      enabled: !!updated.enabled,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/:connector/key — clear just the API key
router.delete('/:connector/key', async (req, res) => {
  try {
    const { connector } = req.params;
    const existing = await one(`SELECT * FROM api_settings WHERE connector_key=?`, [connector]);
    if (!existing) return res.status(404).json({ error: 'Unknown connector: ' + connector });
    await run(`UPDATE api_settings SET api_key='', enabled=0, updated_at=CURRENT_TIMESTAMP WHERE connector_key=?`, [connector]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
