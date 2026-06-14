// ════════════════════════════════════════════════════════════════
// db/refresh.js — recomputes the "materialized" tables:
//   - bd_daily_calls   (day-wise calls per BD)
//   - uncalled_leads   (per-lead age bucket + day-wise uncalled flags)
//   - v_bd_daily_summary, v_manipulation_scores, v_source_performance,
//     v_forecast_inputs, v_followup_status are computed on-the-fly
//     in routes/*.js (cheap enough at this data volume).
//
// In production, call refreshAll() on a 15-min cron (see server.js).
// ════════════════════════════════════════════════════════════════
const { all, run, runNoPersist, persist } = require('./index');

const TODAY = '2026-06-11'; // matches dashboard's "current date"

function refreshBdDailyCalls() {
  run('DELETE FROM bd_daily_calls');

  const rows = all(`
    SELECT
      bd_id,
      DATE(call_timestamp) AS call_date,
      COUNT(*) AS total_calls,
      SUM(CASE WHEN duration_seconds > 30 THEN 1 ELSE 0 END) AS connected_calls,
      SUM(CASE WHEN duration_seconds = 0 THEN 1 ELSE 0 END) AS zero_sec_calls,
      SUM(duration_seconds) AS talktime_seconds,
      COUNT(DISTINCT lead_id) AS unique_leads_called
    FROM calls
    GROUP BY bd_id, DATE(call_timestamp)
  `);

  for (const r of rows) {
    runNoPersist(
      `INSERT INTO bd_daily_calls (bd_id, call_date, total_calls, connected_calls, zero_sec_calls, talktime_seconds, unique_leads_called)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.bd_id, r.call_date, r.total_calls, r.connected_calls, r.zero_sec_calls, r.talktime_seconds, r.unique_leads_called]
    );
  }
  persist();
  console.log(`[refresh] bd_daily_calls: ${rows.length} rows`);
  return rows.length;
}

function daysBetween(dateStr, todayStr) {
  const d1 = new Date(dateStr + (dateStr.includes('T') || dateStr.includes(' ') ? '' : 'T00:00:00') + 'Z');
  const d2 = new Date(todayStr + 'T00:00:00Z');
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function bucketFor(days) {
  if (days === null) return '15+d'; // never called = treat as fully stale
  if (days <= 1) return '0-1d';
  if (days <= 3) return '2-3d';
  if (days <= 7) return '4-7d';
  if (days <= 15) return '8-15d';
  return '15+d';
}

function refreshUncalledLeads() {
  run('DELETE FROM uncalled_leads');

  // For each lead not Converted/Lost, get last_call_date and assigned_date
  const leads = all(`
    SELECT lead_id, assigned_bd_id, assigned_date, last_call_date, status
    FROM leads
    WHERE status NOT IN ('Converted','Lost')
  `);

  // Get all call dates per lead (for daywise flags over last 15 days)
  const callDatesByLead = {};
  const callRows = all(`SELECT lead_id, DATE(call_timestamp) AS d FROM calls WHERE duration_seconds > 30`);
  for (const r of callRows) {
    if (!callDatesByLead[r.lead_id]) callDatesByLead[r.lead_id] = new Set();
    callDatesByLead[r.lead_id].add(r.d);
  }

  let inserted = 0;
  for (const l of leads) {
    const refDate = l.last_call_date ? l.last_call_date.slice(0, 10) : null;
    const daysSince = refDate ? daysBetween(refDate, TODAY) : daysBetween(l.assigned_date.slice(0, 10), TODAY);
    const bucket = l.last_call_date ? bucketFor(daysSince) : bucketFor(null);

    // Build 15-char daywise flag string: day0 = today, day14 = 14 days ago
    // 1 = uncalled (no connected call that day), 0 = called that day
    const calledDates = callDatesByLead[l.lead_id] || new Set();
    let flags = '';
    for (let d = 0; d < 15; d++) {
      const dt = new Date(TODAY + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() - d);
      const dStr = dt.toISOString().slice(0, 10);
      flags += calledDates.has(dStr) ? '0' : '1';
    }

    runNoPersist(
      `INSERT INTO uncalled_leads (lead_id, assigned_bd_id, last_call_date, days_since_last_call, age_bucket, daywise_flags)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [l.lead_id, l.assigned_bd_id, l.last_call_date, l.last_call_date ? daysSince : null, bucket, flags]
    );
    inserted++;
  }
  persist();
  console.log(`[refresh] uncalled_leads: ${inserted} rows`);
  return inserted;
}

function refreshAll() {
  const a = refreshBdDailyCalls();
  const b = refreshUncalledLeads();
  return { bd_daily_calls: a, uncalled_leads: b, refreshed_at: new Date().toISOString() };
}

module.exports = { refreshAll, refreshBdDailyCalls, refreshUncalledLeads, TODAY };
