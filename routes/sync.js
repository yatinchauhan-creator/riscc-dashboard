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
const { one, run, all, runNoPersist, persist } = require('../db');
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
// Sales API — Testbook Redash query 22259 (transactions feed)
//
// Source: https://data.testbook.com/api/queries/22259/results.json
// Auth: Redash uses ?api_key=... in the URL (NOT a Bearer header)
// Response shape: { query_result: { data: { rows: [ {...}, ... ] } } }
//
// Each row's relevant columns (from the query's column list):
//   mobile, pid, signUpDate, product, email, paymentMethod, TxnOn,
//   Txnmonth, center, signUpMonth, Amount, platformFees, paidAmount,
//   Goal, refund, sid, date, empCode, Agent, AgentEmpId, AgentEmail,
//   AgentMobile, Student, Team, ocrm_transId, paymentMode, couponCode,
//   couponType, DaysValidity, source, TxnId, client, goalId, expiresOn,
//   paymentGateway, emiId, eBookRevenue, bookRevenue, productRevenue,
//   status, dp, centerType, netAmount
//
// payment_type logic:
//   emiId present/non-empty -> 'EMI'
//   emiId blank + paidAmount < netAmount -> 'Partial'
//   emiId blank + paidAmount >= netAmount -> 'Full' (paid in full at once)
// ────────────────────────────────────────────────────────────────
async function syncSalesApi(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');

  // Redash: API key goes in the query string, not a header
  const url = setting.base_url.includes('api_key=')
    ? setting.base_url
    : `${setting.base_url}${setting.base_url.includes('?') ? '&' : '?'}api_key=${setting.api_key}`;

  const resp = await axios.get(url, { timeout: 60000 });

  // Redash results.json shape
  const rows = resp.data?.query_result?.data?.rows
    || resp.data?.rows
    || resp.data
    || [];

  let upserted = 0;
  let bdsCreated = 0;
  let leadsCreated = 0;
  const seenBds = new Set();
  const seenLeads = new Set();

  for (const r of rows) {
    // ── 1. Ensure a BD record exists for this agent ──
    const bdId = r.AgentEmpId ? `bd_${String(r.AgentEmpId).trim()}` : null;
    if (bdId && !seenBds.has(bdId)) {
      seenBds.add(bdId);
      const exists = one(`SELECT bd_id FROM bds WHERE bd_id=?`, [bdId]);
      if (!exists) {
        runNoPersist(`
          INSERT INTO bds (bd_id, name, team_leader_id, team_id, join_date, status, monthly_target_revenue, monthly_target_sales)
          VALUES (?, ?, NULL, ?, date('now'), 'Active', 0, 0)
          ON CONFLICT(bd_id) DO NOTHING
        `, [bdId, r.Agent || bdId, r.Team ? `team_${r.Team}` : null]);
        bdsCreated++;
      }
    }

    // ── 2. Ensure a lead record exists for this student ──
    const leadId = r.sid ? `lead_${String(r.sid).trim()}` : (r.mobile ? `lead_m${r.mobile}` : null);
    if (leadId && !seenLeads.has(leadId)) {
      seenLeads.add(leadId);
      const exists = one(`SELECT lead_id FROM leads WHERE lead_id=?`, [leadId]);
      if (!exists) {
        runNoPersist(`
          INSERT INTO leads (lead_id, phone_normalized, crm_id, email, name, source, campaign_id, state, category, assigned_bd_id, assigned_date, status, temperature, last_call_date, last_crm_update, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(lead_id) DO NOTHING
        `, [
          leadId, r.mobile || null, String(r.sid || ''), r.email || null, r.Student || null,
          r.source || 'Unknown', null, null, 'Fresh', bdId, r.signUpDate || r.TxnOn || new Date().toISOString(),
          'Converted', 'Warm', r.TxnOn || null, r.TxnOn || null, r.signUpDate || r.TxnOn || new Date().toISOString(),
        ]);
        leadsCreated++;
      }
    }

    // ── 3. Map the transaction into `sales` ──
    const orderId = r.TxnId ? `txn_${r.TxnId}` : null;
    if (!orderId) continue; // skip rows with no transaction id

    const gross = parseFloat(r.Amount) || 0;
    const net = r.netAmount !== undefined && r.netAmount !== null ? parseFloat(r.netAmount) : gross;
    const waiver = Math.max(0, gross - net);
    const refundAmt = parseFloat(r.refund) || 0;
    const paid = parseFloat(r.paidAmount) || 0;

    let status = 'Confirmed';
    if (refundAmt > 0 || (r.status && /refund/i.test(r.status))) status = 'Refunded';
    else if (r.status && /hold|pending/i.test(r.status)) status = 'On Hold';

    // payment_type: emiId blank => paid in full at once ('Full'),
    // unless paidAmount < netAmount (then 'Partial'). emiId present => 'EMI'.
    let paymentType = 'Full';
    const emiId = (r.emiId || '').toString().trim();
    if (emiId) paymentType = 'EMI';
    else if (paid > 0 && paid < net) paymentType = 'Partial';

    runNoPersist(`
      INSERT INTO sales (order_id, lead_id, bd_id, course_id, gross_amount, waiver_amount, net_amount, sale_date, payment_type, status)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(order_id) DO UPDATE SET
        gross_amount=excluded.gross_amount, waiver_amount=excluded.waiver_amount,
        net_amount=excluded.net_amount, status=excluded.status,
        payment_type=excluded.payment_type
    `, [
      orderId, leadId, bdId, r.goalId ? String(r.goalId) : (r.product || null),
      gross, waiver, net,
      r.TxnOn || r.date || new Date().toISOString(),
      paymentType, status,
    ]);
    upserted++;

    // ── 4. Collections row (paidAmount vs netAmount) ──
    runNoPersist(`
      INSERT INTO collections (collection_id, order_id, amount_due, amount_collected, due_date, payment_date, status)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(collection_id) DO UPDATE SET
        amount_collected=excluded.amount_collected, status=excluded.status, payment_date=excluded.payment_date
    `, [
      `coll_${orderId}`, orderId, net, paid,
      (r.TxnOn || r.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
      paid >= net ? (r.TxnOn || r.date || '').slice(0, 10) : null,
      paid >= net ? 'Paid' : (paid > 0 ? 'Partial' : 'Overdue'),
    ]);
  }

  persist();

  const newExtra = { ...extra, last_sync: new Date().toISOString(), last_row_count: rows.length };
  run(`UPDATE api_settings SET extra_config=? WHERE connector_key='sales_api'`, [JSON.stringify(newExtra)]);

  return { rows_received: rows.length, transactions_upserted: upserted, bds_created: bdsCreated, leads_created: leadsCreated };
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
