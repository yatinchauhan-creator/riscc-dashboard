// ════════════════════════════════════════════════════════════════
// routes/sync.js — connector sync jobs (Postgres async version)
//
// POST /api/sync/:connector  — triggers a manual sync
// GET  /api/sync/status      — last sync time per connector
// ════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { one, run, all, runNoPersist, persist } = require('../db');
const { refreshAll } = require('../db/refresh');

router.get('/status', async (req, res) => {
  try {
    const rows = await all(`SELECT connector_key, label, enabled, updated_at FROM api_settings`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:connector', async (req, res) => {
  const { connector } = req.params;
  try {
    const setting = await one(`SELECT * FROM api_settings WHERE connector_key=?`, [connector]);
    if (!setting) return res.status(404).json({ error: 'Unknown connector' });
    if (!setting.enabled || !setting.api_key) {
      return res.status(400).json({ error: `${setting.label} is not configured/enabled. Add a key in Settings first.` });
    }

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
    const refreshed = await refreshAll();
    res.json({ ok: true, connector, result, refreshed });
  } catch (err) {
    console.error(`[sync:${connector}]`, err.response?.data || err.message);
    res.status(502).json({ error: 'Sync failed', detail: err.response?.data || err.message });
  }
});

// ────────────────────────────────────────────────────────────────
// OCRM — Testbook Redash query (lead-level snapshot incl. aggregated
// calling stats: Lead_id, Emp_id, assign_BD, sources, Assign_Date,
// assignOn, lead_Mobile, lead_name, lead_email, Lead_Category, State,
// currentStatus, lastCallStatus, stage, Open_Closed, Sale_Number,
// Sale_Date, Sale_Amount, calls, followUpCalls, Chase, Today_Call,
// callDurationAmeyo, Duration, CallDuration, assign_expOn, team_name,
// employeeEmail, source_tag)
//
// IMPORTANT — lead-level feed, not a per-call log. Each row = one lead
// with aggregated call counts/duration. Writes ONE SYNTHETIC `calls`
// ROW PER LEAD representing the totals. Duration fields are in HOURS
// -> converted to seconds via *3600 (callDurationAmeyo, then Duration,
// then CallDuration).
//
// payment_type (sales sync) logic:
//   emiId present/non-empty -> 'EMI'
//   emiId blank + paidAmount < netAmount -> 'Partial'
//   emiId blank + paidAmount >= netAmount -> 'Full'
// ────────────────────────────────────────────────────────────────
async function syncOcrm(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');

  const url = setting.base_url.includes('api_key=')
    ? setting.base_url
    : `${setting.base_url}${setting.base_url.includes('?') ? '&' : '?'}api_key=${setting.api_key}`;

  const resp = await axios.get(url, { timeout: 60000 });

  const rows = resp.data?.query_result?.data?.rows
    || resp.data?.rows
    || resp.data
    || [];

  let leadsUpserted = 0;
  let callsUpserted = 0;
  let followupsUpserted = 0;

  // Helper: truncate to column limit
  const t = (val, max) => val ? String(val).slice(0, max) : null;

  for (const r of rows) {
    const leadId = r.Lead_id ? `lead_${String(r.Lead_id).trim()}` : null;
    if (!leadId) continue;

    const bdId = (r.Emp_id || r.assign_BD)
      ? `bd_${String(r.Emp_id || r.assign_BD).trim()}`
      : null;

    // ── Team Leader: derive from team_name ──
    let tlId = null;
    if (r.team_name) {
      let tlName = String(r.team_name).trim()
        .replace(/^Team\s+/, '')
        .replace(/\s*(ATL\s*)?\((Select|AGM|ASM)\)\s*$/, '')
        .trim();
      if (tlName) {
        tlId = t(`tl_${tlName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`, 50);
        const tlExists = await one(`SELECT tl_id FROM team_leaders WHERE tl_id=?`, [tlId]);
        if (!tlExists) {
          await runNoPersist(
            `INSERT INTO team_leaders (tl_id, name) VALUES (?, ?) ON CONFLICT(tl_id) DO NOTHING`,
            [tlId, t(tlName, 100)]
          );
        }
      }
    }

    // ── Ensure BD exists ──
    if (bdId) {
      const exists = await one(`SELECT bd_id, team_leader_id FROM bds WHERE bd_id=?`, [bdId]);
      if (!exists) {
        await runNoPersist(`
          INSERT INTO bds (bd_id, name, team_leader_id, team_id, join_date, status, monthly_target_revenue, monthly_target_sales)
          VALUES (?, ?, ?, ?, CURRENT_DATE, 'Active', 0, 0)
          ON CONFLICT(bd_id) DO NOTHING
        `, [bdId, t(r.Agent || r.employeeEmail || bdId, 100), tlId, t(r.team_name ? `team_${r.team_name}` : null, 50)]);
      } else if (tlId && !exists.team_leader_id) {
        await runNoPersist(`UPDATE bds SET team_leader_id=? WHERE bd_id=?`, [tlId, bdId]);
      }
    }

    // ── source: first entry of sources JSON array, fallback source_tag ──
    let source = t(r.source_tag || 'Unknown', 50);
    if (r.sources) {
      try {
        const arr = JSON.parse(r.sources);
        if (Array.isArray(arr) && arr.length) source = t(arr[0], 50);
      } catch (e) {}
    }

    // ── status ──
    const stage = (r.stage || '').trim();
    const openClosed = (r.Open_Closed || '').trim();
    let status = 'Open';
    if (r.Sale_Number) {
      status = 'Converted';
    } else if (openClosed === 'Closed') {
      status = 'Lost';
    } else if (/follow.?up required|interested|promise.?to.?pay|high intent|sales.?done/i.test(stage) || /^Interested$/i.test(r.currentStatus || '')) {
      status = 'Interested';
    } else if (r.Sale_Amount) {
      status = 'Proposal';
    }

    // ── temperature ──
    const stg = stage.toLowerCase();
    const cur = (r.currentStatus || '').toLowerCase();
    let temperature = 'Cold';
    if (/promise.?to.?pay|high intent|interested|sales.?done/.test(stg) || /promise.?to.?pay|high intent|interested/.test(cur)) {
      temperature = 'Hot';
    } else if (/follow.?up required|call back later/.test(stg)) {
      temperature = 'Warm';
    }

    // ── upsert lead ──
    await runNoPersist(`
      INSERT INTO leads (lead_id, phone_normalized, crm_id, email, name, source, campaign_id, state, category, assigned_bd_id, assigned_date, status, temperature, last_call_date, last_crm_update, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(lead_id) DO UPDATE SET
        status=excluded.status, temperature=excluded.temperature,
        assigned_bd_id=excluded.assigned_bd_id,
        last_call_date=excluded.last_call_date, last_crm_update=excluded.last_crm_update,
        category=excluded.category, state=excluded.state
    `, [
      leadId,
      t(r.lead_Mobile, 15),
      t(String(r.Lead_id || ''), 50),
      t(r.lead_email, 100),
      t(r.lead_name, 100),
      source,
      null,
      t(r.State, 50),
      t(r.Lead_Category || 'Fresh', 50),
      bdId,
      r.Assign_Date || r.assignOn || new Date().toISOString(),
      status,
      temperature,
      r.assignOn || null,
      r.assignOn || new Date().toISOString(),
      r.Assign_Date || r.assignOn || new Date().toISOString(),
    ]);
    leadsUpserted++;

    // ── synthetic calls row ──
    const totalCalls = parseInt(r.calls, 10) || 0;
    if (totalCalls > 0 && bdId) {
      const durHours = parseFloat(r.callDurationAmeyo) || parseFloat(r.Duration) || parseFloat(r.CallDuration) || 0;
      const durationSeconds = Math.round(durHours * 3600);
      const outcome = t(r.lastCallStatus || r.currentStatus || 'Unknown', 50);

      await runNoPersist(`
        INSERT INTO calls (call_id, lead_id, bd_id, call_timestamp, duration_seconds, outcome, recording_url, crm_logged, crm_log_time)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(call_id) DO UPDATE SET
          duration_seconds=excluded.duration_seconds, outcome=excluded.outcome,
          call_timestamp=excluded.call_timestamp, crm_log_time=excluded.crm_log_time
      `, [
        `call_${String(r.Lead_id).trim()}_agg`,
        leadId, bdId,
        r.assignOn || r.Assign_Date || new Date().toISOString(),
        durationSeconds, outcome, null, 1,
        r.assignOn || new Date().toISOString(),
      ]);
      callsUpserted++;
    }

    // ── followups row ──
    if (bdId) {
      const needsChase = (parseInt(r.Chase, 10) || 0) > 0;
      const fuStatus = (status === 'Converted' || status === 'Lost') ? 'Done' : (needsChase ? 'Pending' : 'Done');
      await runNoPersist(`
        INSERT INTO followups (followup_id, lead_id, bd_id, scheduled_date, actual_followup_date, gap_hours, status)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(followup_id) DO UPDATE SET
          scheduled_date=excluded.scheduled_date, status=excluded.status,
          actual_followup_date=excluded.actual_followup_date, gap_hours=excluded.gap_hours
      `, [
        `fu_${String(r.Lead_id).trim()}`,
        leadId, bdId,
        r.assign_expOn || r.assignOn || r.Assign_Date || new Date().toISOString(),
        fuStatus === 'Done' ? (r.assignOn || null) : null,
        null, fuStatus,
      ]);
      followupsUpserted++;
    }
  }

  persist();

  const newExtra = { ...extra, last_sync: new Date().toISOString(), last_row_count: rows.length };
  await run(`UPDATE api_settings SET extra_config=? WHERE connector_key='ocrm'`, [JSON.stringify(newExtra)]);

  return {
    rows_received: rows.length,
    leads_upserted: leadsUpserted,
    calls_upserted: callsUpserted,
    followups_upserted: followupsUpserted,
    note: 'Synthetic per-lead call aggregates — manipulation scoring needs a true per-call log to be accurate.',
  };
}

async function syncSalesApi(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');

  const url = setting.base_url.includes('api_key=')
    ? setting.base_url
    : `${setting.base_url}${setting.base_url.includes('?') ? '&' : '?'}api_key=${setting.api_key}`;

  const resp = await axios.get(url, { timeout: 60000 });

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
    const bdId = r.AgentEmpId ? `bd_${String(r.AgentEmpId).trim()}` : null;
    if (bdId && !seenBds.has(bdId)) {
      seenBds.add(bdId);
      const exists = await one(`SELECT bd_id FROM bds WHERE bd_id=?`, [bdId]);
      if (!exists) {
        await runNoPersist(`
          INSERT INTO bds (bd_id, name, team_leader_id, team_id, join_date, status, monthly_target_revenue, monthly_target_sales)
          VALUES (?, ?, NULL, ?, CURRENT_DATE, 'Active', 0, 0)
          ON CONFLICT(bd_id) DO NOTHING
        `, [bdId, r.Agent || bdId, r.Team ? `team_${r.Team}` : null]);
        bdsCreated++;
      }
    }

    const leadId = r.sid ? `lead_${String(r.sid).trim()}` : (r.mobile ? `lead_m${r.mobile}` : null);
    if (leadId && !seenLeads.has(leadId)) {
      seenLeads.add(leadId);
      const exists = await one(`SELECT lead_id FROM leads WHERE lead_id=?`, [leadId]);
      if (!exists) {
        await runNoPersist(`
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

    const orderId = r.TxnId ? `txn_${r.TxnId}` : null;
    if (!orderId) continue;

    const gross = parseFloat(r.Amount) || 0;
    const net = r.netAmount !== undefined && r.netAmount !== null ? parseFloat(r.netAmount) : gross;
    const waiver = Math.max(0, gross - net);
    const refundAmt = parseFloat(r.refund) || 0;
    const paid = parseFloat(r.paidAmount) || 0;

    let status = 'Confirmed';
    if (refundAmt > 0 || (r.status && /refund/i.test(r.status))) status = 'Refunded';
    else if (r.status && /hold|pending/i.test(r.status)) status = 'On Hold';

    // payment_type: emiId blank => 'Full' (unless paidAmount < netAmount -> 'Partial'). emiId present => 'EMI'.
    let paymentType = 'Full';
    const emiId = (r.emiId || '').toString().trim();
    if (emiId) paymentType = 'EMI';
    else if (paid > 0 && paid < net) paymentType = 'Partial';

    await runNoPersist(`
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

    await runNoPersist(`
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
  await run(`UPDATE api_settings SET extra_config=? WHERE connector_key='sales_api'`, [JSON.stringify(newExtra)]);

  return { rows_received: rows.length, transactions_upserted: upserted, bds_created: bdsCreated, leads_created: leadsCreated };
}

// ────────────────────────────────────────────────────────────────
// Google Sheets — generic CSV-style import
// ────────────────────────────────────────────────────────────────
async function syncGoogleSheets(setting) {
  const extra = JSON.parse(setting.extra_config || '{}');
  if (!extra.sheet_id) throw new Error('extra_config.sheet_id is not set');

  const url = `https://docs.google.com/spreadsheets/d/${extra.sheet_id}/export?format=csv`;
  const resp = await axios.get(url, { timeout: 30000 });

  const rows = resp.data.split('\n').map(r => r.split(','));
  const header = rows[0];
  let updated = 0;
  if (header[0]?.trim().toLowerCase() === 'key' && header[1]?.trim().toLowerCase() === 'value') {
    for (let i = 1; i < rows.length; i++) {
      const [key, value] = rows[i];
      if (!key) continue;
      await run(`INSERT INTO config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key.trim(), (value || '').trim()]);
      updated++;
    }
  }

  return { rows_read: rows.length - 1, config_updated: updated };
}

module.exports = router;
