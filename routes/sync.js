// ════════════════════════════════════════════════════════════════
// routes/sync.js — connector sync jobs (Doc 6 §6 Phase 1: Foundation)
//
// These are PLACEHOLDER implementations. Once you fill in the
// base_url + api_key for 'ocrm' / 'sales_api' / 'gsheets' in
// Settings, implement the actual fetch+map logic in the marked
// TODO sections. The shape each connector must ultimately produce
// is documented inline so it slots into the existing `leads`,
// `calls`, `sales`, `followups`, `collections` tables (Doc 5 schema).
//
// POST /api/sync/:connector  — triggers a manual sync
// GET  /api/sync/status      — last sync time per connector
// ════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { one, run, all } = require('../db');
const { refreshAll } = require('../db/refresh');

router.get('/status', (req, res) => {
  const rows = all(`SELECT connector_key, label, enabled, updated_at FROM api_settings`);
  res.json(rows);
});

router.post('/:connector', async (req, res) => {
  const { connector } = req.params;
  const setting = one(`SELECT * FROM api_settings WHERE connector_key=?`, [connector]);
  if (!setting) return res.status(404).json({ error: 'Unknown connector' });
  if (!setting.enabled || !setting.api_key) {
    return res.status(400).json({ error: `${setting.label} is not configured/enabled. Add a key in Settings first.` });
  }

  try {
    let result;
    switch (connector) {
      case 'ocrm':
        result = await syncOcrm(setting);
        break;
      case 'sales_api':
        result = await syncSalesApi(setting);
        break;
      case 'gsheets':
        result = await syncGoogleSheets(setting);
        break;
      default:
        return res.status(400).json({ error: 'No sync handler for ' + connector });
    }

    // Recompute materialized tables after any sync
    const refreshed = refreshAll();
    res.json({ ok: true, connector, result, refreshed });
  } catch (err) {
    console.error(`[sync:${connector}]`, err.response?.data || err.message);
    res.status(502).json({ error: 'Sync failed', detail: err.response?.data || err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// OCRM — leads + calls + followups
// TODO: replace the example endpoint/response mapping with your
// actual OCRM API's shape. The goal is to upsert into `leads`,
// `calls`, and `followups` tables.
// ────────────────────────────────────────────────────────────────
async function syncOcrm(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');

  // Example call — adjust path/params to your OCRM API docs
  const resp = await axios.get(`${setting.base_url}/leads`, {
    headers: { Authorization: `Bearer ${setting.api_key}` },
    params: { updated_since: extra.last_sync || '2026-06-01' },
    timeout: 30000,
  });

  const leadsFromOcrm = resp.data.leads || resp.data || [];
  let upserted = 0;
  for (const l of leadsFromOcrm) {
    // TODO: map OCRM fields -> leads table columns (Doc 5 schema)
    run(`
      INSERT INTO leads (lead_id, phone_normalized, crm_id, email, name, source, campaign_id, state, category, assigned_bd_id, assigned_date, status, temperature, last_call_date, last_crm_update, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(lead_id) DO UPDATE SET
        status=excluded.status, temperature=excluded.temperature,
        last_call_date=excluded.last_call_date, last_crm_update=excluded.last_crm_update
    `, [
      l.lead_id, l.phone, l.crm_id, l.email, l.name, l.source, l.campaign_id,
      l.state, l.category, l.assigned_bd_id, l.assigned_date, l.status || 'Open',
      l.temperature || 'Cold', l.last_call_date || null, l.last_crm_update || null, l.created_at || new Date().toISOString(),
    ]);
    upserted++;
  }

  // bump last_sync watermark
  const newExtra = { ...extra, last_sync: new Date().toISOString() };
  run(`UPDATE api_settings SET extra_config=? WHERE connector_key='ocrm'`, [JSON.stringify(newExtra)]);

  return { leads_upserted: upserted };
}

// ────────────────────────────────────────────────────────────────
// Sales API — sales + collections
// TODO: map to your Sales Report API's actual response shape.
// ────────────────────────────────────────────────────────────────
async function syncSalesApi(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');

  const resp = await axios.get(`${setting.base_url}/orders`, {
    headers: { Authorization: `Bearer ${setting.api_key}` },
    params: { since: extra.last_sync || '2026-06-01' },
    timeout: 30000,
  });

  const orders = resp.data.orders || resp.data || [];
  let upserted = 0;
  for (const o of orders) {
    run(`
      INSERT INTO sales (order_id, lead_id, bd_id, course_id, gross_amount, waiver_amount, net_amount, sale_date, payment_type, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET
        gross_amount=excluded.gross_amount, waiver_amount=excluded.waiver_amount,
        net_amount=excluded.net_amount, status=excluded.status
    `, [
      o.order_id, o.lead_id, o.bd_id, o.course_id,
      o.gross_amount, o.waiver_amount || 0, o.net_amount ?? (o.gross_amount - (o.waiver_amount || 0)),
      o.sale_date, o.payment_type || 'Full', o.status || 'Confirmed',
    ]);
    upserted++;

    // also upsert a collections row if the API includes payment schedule
    if (o.amount_due !== undefined) {
      run(`
        INSERT INTO collections (collection_id, order_id, amount_due, amount_collected, due_date, payment_date, status)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(collection_id) DO UPDATE SET
          amount_collected=excluded.amount_collected, status=excluded.status, payment_date=excluded.payment_date
      `, [
        `coll_${o.order_id}`, o.order_id, o.amount_due, o.amount_collected || 0,
        o.due_date, o.payment_date || null, o.collection_status || 'Overdue',
      ]);
    }
  }

  const newExtra = { ...extra, last_sync: new Date().toISOString() };
  run(`UPDATE api_settings SET extra_config=? WHERE connector_key='sales_api'`, [JSON.stringify(newExtra)]);

  return { orders_upserted: upserted };
}

// ────────────────────────────────────────────────────────────────
// Google Sheets — generic CSV-style import (e.g. manual lead lists,
// targets/config overrides)
// TODO: point at your published-CSV or Sheets API v4 endpoint.
// ────────────────────────────────────────────────────────────────
async function syncGoogleSheets(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');
  if (!extra.sheet_id) throw new Error('extra_config.sheet_id is not set');

  // Example: published-to-web CSV export
  const url = `https://docs.google.com/spreadsheets/d/${extra.sheet_id}/export?format=csv`;
  const resp = await axios.get(url, { timeout: 30000 });

  const rows = resp.data.split('\n').map(r => r.split(','));
  const header = rows[0];
  // TODO: map columns -> config table or leads table depending on sheet purpose
  // Example: if sheet has columns "key,value" -> update config table
  let updated = 0;
  if (header[0]?.trim().toLowerCase() === 'key' && header[1]?.trim().toLowerCase() === 'value') {
    for (let i = 1; i < rows.length; i++) {
      const [key, value] = rows[i];
      if (!key) continue;
      run(`INSERT INTO config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key.trim(), (value || '').trim()]);
      updated++;
    }
  }

  return { rows_read: rows.length - 1, config_updated: updated };
}

module.exports = router;
