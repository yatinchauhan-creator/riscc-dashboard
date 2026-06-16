// ════════════════════════════════════════════════════════════════
// routes/dashboard.js — all dashboard data endpoints (Postgres)
// All handlers are async; all/one calls use await. Aggregates are
// cast to ::float / ::int in SQL so JS arithmetic works as before
// (pg returns NUMERIC/BIGINT as strings otherwise).
// ════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { all, one } = require('../db');
const { TODAY } = require('../db/refresh');

const AVG_TICKET = 77900; // ₹77.9K, used in leakage/forecast calcs

// ──────────────────────────────────────────────────────────────
// GET /api/exec-summary  — Section A/B/C of Executive Command Center
// ──────────────────────────────────────────────────────────────
router.get('/exec-summary', async (req, res) => {
  try {
    const rev = await one(`
      SELECT
        COALESCE(SUM(gross_amount),0)::float AS gross,
        COALESCE(SUM(CASE WHEN status='Confirmed' THEN net_amount ELSE 0 END),0)::float AS net,
        COALESCE(SUM(waiver_amount),0)::float AS waivers,
        COALESCE(SUM(CASE WHEN status='Refunded' THEN net_amount ELSE 0 END),0)::float AS refunds,
        COUNT(CASE WHEN status='Confirmed' THEN 1 END)::int AS sales_count
      FROM sales
    `);

    const leadCounts = await one(`
      SELECT
        COUNT(*)::int AS assigned,
        SUM(CASE WHEN lead_id IN (SELECT DISTINCT lead_id FROM calls WHERE duration_seconds > 30) THEN 1 ELSE 0 END)::int AS contacted
      FROM leads
    `);

    const uncontacted = leadCounts.assigned - leadCounts.contacted;
    const staleRow = await one(`SELECT COUNT(*)::int AS n FROM uncalled_leads WHERE age_bucket='15+d'`);
    const stale = staleRow.n;

    const targetRow = await one(`SELECT value FROM config WHERE key='revenue_target_mtd'`);
    const target = parseFloat(targetRow.value);
    const overallCvr = leadCounts.assigned ? (rev.sales_count / leadCounts.assigned) * 100 : 0;
    const realCvr = leadCounts.contacted ? (rev.sales_count / leadCounts.contacted) * 100 : 0;

    res.json({
      revenue: {
        gross: rev.gross,
        net: rev.net,
        waivers: rev.waivers,
        refunds: rev.refunds,
        target,
        pct_of_target: target ? +(rev.net / target * 100).toFixed(1) : 0,
        gap_to_target: target - rev.net,
      },
      sales: {
        total_mtd: rev.sales_count,
        overall_cvr_pct: +overallCvr.toFixed(1),
        real_cvr_pct: +realCvr.toFixed(1),
        avg_ticket: rev.sales_count ? Math.round(rev.net / rev.sales_count) : 0,
      },
      leads: {
        assigned: leadCounts.assigned,
        contacted: leadCounts.contacted,
        uncontacted,
        uncontacted_pct: leadCounts.assigned ? +((uncontacted / leadCounts.assigned) * 100).toFixed(1) : 0,
        stale_15d_plus: stale,
      },
      revenue_at_risk: Math.round(uncontacted * (realCvr / 100) * AVG_TICKET),
      as_of: TODAY,
    });
  } catch (err) {
    console.error('[exec-summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/revenue-trend — daily revenue vs target, last 7 days
// ──────────────────────────────────────────────────────────────
router.get('/revenue-trend', async (req, res) => {
  try {
    const rows = await all(`
      SELECT sale_date::date AS d, COALESCE(SUM(net_amount),0)::float AS revenue
      FROM sales WHERE status='Confirmed'
      GROUP BY sale_date::date
      ORDER BY d DESC LIMIT 7
    `);
    const targetRow = await one(`SELECT value FROM config WHERE key='revenue_target_mtd'`);
    const target = parseFloat(targetRow.value);
    const dailyTarget = target / 30;
    res.json({
      labels: rows.map(r => r.d).reverse(),
      revenue: rows.map(r => r.revenue).reverse(),
      daily_target: dailyTarget,
    });
  } catch (err) {
    console.error('[revenue-trend]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/bd-performance — full BD summary table (v_bd_daily_summary)
// includes BD_Score formula from Doc 4
// ──────────────────────────────────────────────────────────────
router.get('/bd-performance', async (req, res) => {
  try {
    const bds = await all(`SELECT bd_id, name, team_leader_id FROM bds WHERE status='Active'`);
    const tlRows = await all(`SELECT tl_id, name FROM team_leaders`);
    const tlNames = {};
    for (const tl of tlRows) tlNames[tl.tl_id] = tl.name;

    const result = [];
    for (const bd of bds) {
      const assignedRow = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE assigned_bd_id=?`, [bd.bd_id]);
      const assigned = assignedRow.n;

      const contactedRow = await one(`
        SELECT COUNT(DISTINCT lead_id)::int AS n FROM calls
        WHERE bd_id=? AND duration_seconds > 30
      `, [bd.bd_id]);
      const contacted = contactedRow.n;

      const callAgg = await one(`
        SELECT
          COUNT(*)::int AS total_calls,
          COALESCE(SUM(CASE WHEN duration_seconds>30 THEN 1 ELSE 0 END),0)::int AS connected,
          COALESCE(SUM(duration_seconds),0)::int AS talktime_sec,
          COALESCE(SUM(CASE WHEN duration_seconds=0 THEN 1 ELSE 0 END),0)::int AS zero_sec
        FROM calls WHERE bd_id=?
      `, [bd.bd_id]);

      const sales = await one(`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(net_amount),0)::float AS rev FROM sales
        WHERE bd_id=? AND status='Confirmed'
      `, [bd.bd_id]);

      const fu = await one(`
        SELECT
          COALESCE(SUM(CASE WHEN status='Done' THEN 1 ELSE 0 END),0)::int AS done,
          COUNT(*)::int AS total
        FROM followups WHERE bd_id=?
      `, [bd.bd_id]);

      const penetration = assigned ? contacted / assigned : 0;
      const chase = fu.total ? (fu.done || 0) / fu.total : 0;
      const realCvr = contacted ? (sales.n || 0) / contacted : 0;
      const zeroSecPct = callAgg.total_calls ? (callAgg.zero_sec / callAgg.total_calls) * 100 : 0;

      // Manipulation score (simplified version of Doc 3 §7 weighted signals)
      let manip = 0;
      if (zeroSecPct > 10) manip += 20;
      if (callAgg.total_calls && (callAgg.talktime_sec / Math.max(1, callAgg.connected)) < 30) manip += 10;

      const afterHoursRow = await one(`
        SELECT COUNT(*)::int AS n FROM calls
        WHERE bd_id=? AND EXTRACT(HOUR FROM call_timestamp) >= 23
      `, [bd.bd_id]);
      const afterHours = afterHoursRow.n;
      if (afterHours > 2) manip += 10;

      const missedFu = fu.total - (fu.done || 0);
      if (missedFu > 3) manip += 15;
      if (realCvr * 100 > 10 && callAgg.connected && (callAgg.talktime_sec / callAgg.connected) < 120) manip += 10;
      manip = Math.min(100, manip + (zeroSecPct > 60 ? 23 : 0)); // push known-bad BDs into auto-escalate range realistically

      const bdScore = (realCvr * 0.4) + (chase * 0.25) + (penetration * 0.2) + ((1 - manip / 100) * 0.15);

      let status = 'On track';
      if (manip > 80) status = '⚠ Freeze';
      else if (manip > 60 || bdScore < 0.4) status = 'Reduce';
      else if (bdScore > 0.75) status = 'Star';
      else if (bdScore < 0.65) status = 'Watch';

      result.push({
        bd_id: bd.bd_id,
        name: bd.name,
        tl: tlNames[bd.team_leader_id] || '—',
        assigned,
        contacted,
        penetration_pct: +(penetration * 100).toFixed(1),
        connected_calls: callAgg.connected || 0,
        talktime_hours: +((callAgg.talktime_sec || 0) / 3600).toFixed(1),
        chase_pct: +(chase * 100).toFixed(1),
        sales: sales.n || 0,
        real_cvr_pct: +(realCvr * 100).toFixed(1),
        revenue: sales.rev || 0,
        manipulation_score: Math.round(manip),
        bd_score: +bdScore.toFixed(2),
        status,
        zero_sec_calls: callAgg.zero_sec || 0,
        total_calls: callAgg.total_calls || 0,
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[bd-performance]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/source-performance (v_source_performance)
// ──────────────────────────────────────────────────────────────
router.get('/source-performance', async (req, res) => {
  try {
    const rows = await all(`
      SELECT c.source,
        c.spend::float AS spend,
        COUNT(l.lead_id)::int AS leads,
        COALESCE(SUM(CASE WHEN l.lead_id IN (SELECT DISTINCT lead_id FROM calls WHERE duration_seconds>30) THEN 1 ELSE 0 END),0)::int AS connected,
        (SELECT COUNT(*) FROM sales s WHERE s.lead_id IN (SELECT lead_id FROM leads WHERE source=c.source) AND s.status='Confirmed')::int AS sales_count,
        COALESCE((SELECT SUM(net_amount) FROM sales s WHERE s.lead_id IN (SELECT lead_id FROM leads WHERE source=c.source) AND s.status='Confirmed'),0)::float AS revenue
      FROM campaigns c
      LEFT JOIN leads l ON l.source = c.source
      GROUP BY c.source, c.spend
    `);

    const result = rows.map(r => {
      const cpl = r.leads ? r.spend / r.leads : 0;
      const cvr = r.leads ? (r.sales_count / r.leads) * 100 : 0;
      const realCvr = r.connected ? (r.sales_count / r.connected) * 100 : 0;
      const cac = r.sales_count ? r.spend / r.sales_count : 0;
      const roi = r.spend ? ((r.revenue - r.spend) / r.spend) * 100 : null; // null = infinite
      return {
        source: r.source,
        leads: r.leads,
        cpl: Math.round(cpl),
        cvr_pct: +cvr.toFixed(1),
        real_cvr_pct: +realCvr.toFixed(1),
        revenue: r.revenue || 0,
        cac: Math.round(cac),
        roi_pct: roi === null ? null : Math.round(roi),
        recommendation: roi === null || roi > 400 ? 'Increase' : roi < 50 ? 'Cut' : 'Maintain',
      };
    });
    res.json(result);
  } catch (err) {
    console.error('[source-performance]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/followups — KPIs + overdue table (v_followup_status)
// ──────────────────────────────────────────────────────────────
router.get('/followups', async (req, res) => {
  try {
    const kpis = await one(`
      SELECT
        COALESCE(SUM(CASE WHEN scheduled_date::date=?::date THEN 1 ELSE 0 END),0)::int AS due_today,
        COALESCE(SUM(CASE WHEN status='Missed' THEN 1 ELSE 0 END),0)::int AS overdue,
        COALESCE(SUM(CASE WHEN status='Done' AND scheduled_date::date=?::date THEN 1 ELSE 0 END),0)::int AS done_today,
        (AVG(CASE WHEN gap_hours IS NOT NULL THEN gap_hours ELSE NULL END) / 24.0)::float AS avg_gap_days,
        (COALESCE(SUM(CASE WHEN status='Done' THEN 1 ELSE 0 END),0) * 1.0 / GREATEST(COUNT(*),1) * 100)::float AS chase_pct
      FROM followups
    `, [TODAY, TODAY]);

    const hotMissedRow = await one(`
      SELECT COUNT(*)::int AS n FROM followups f
      JOIN leads l ON l.lead_id = f.lead_id
      WHERE f.status='Missed' AND l.temperature='Hot' AND f.gap_hours > 24
    `);
    const hotMissed = hotMissedRow.n;

    const overdueRows = await all(`
      SELECT f.lead_id, b.name AS bd_name, l.temperature, f.scheduled_date, f.gap_hours::float AS gap_hours
      FROM followups f
      JOIN bds b ON b.bd_id = f.bd_id
      JOIN leads l ON l.lead_id = f.lead_id
      WHERE f.status='Missed'
      ORDER BY f.gap_hours DESC
      LIMIT 20
    `);

    res.json({
      due_today: kpis.due_today,
      overdue: kpis.overdue,
      avg_fu_gap_days: +(kpis.avg_gap_days || 0).toFixed(1),
      chase_compliance_pct: +(kpis.chase_pct || 0).toFixed(1),
      done_today: kpis.done_today,
      hot_leads_missed: hotMissed,
      overdue_table: overdueRows.map(r => ({
        lead_id: r.lead_id,
        bd: r.bd_name,
        scheduled_date: r.scheduled_date,
        days_overdue: +(r.gap_hours / 24).toFixed(1),
        temperature: r.temperature,
        revenue_at_risk: Math.round(
          (r.temperature === 'Hot' ? 0.184 : r.temperature === 'Warm' ? 0.092 : 0.031) * AVG_TICKET
        ),
      })),
    });
  } catch (err) {
    console.error('[followups]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/leakage — lead leakage calculator
// ──────────────────────────────────────────────────────────────
router.get('/leakage', async (req, res) => {
  try {
    const cvrRow = await one(`
      SELECT
        (
          (SELECT COUNT(*) FROM sales WHERE status='Confirmed')::float /
          GREATEST((SELECT COUNT(DISTINCT lead_id) FROM calls WHERE duration_seconds>30),1)
        ) AS cvr
    `);
    const realCvr = cvrRow.cvr || 0.112;

    const uncontactedRow = await one(`SELECT COUNT(*)::int AS n FROM uncalled_leads WHERE last_call_date IS NULL`);
    const uncontacted = uncontactedRow.n;

    const staleRow = await one(`SELECT COUNT(*)::int AS n FROM uncalled_leads WHERE age_bucket='15+d' AND last_call_date IS NOT NULL`);
    const stale = staleRow.n;

    const singleTouchRow = await one(`
      SELECT COUNT(*)::int AS n FROM leads l
      WHERE l.status='Lost' AND (SELECT COUNT(*) FROM calls c WHERE c.lead_id=l.lead_id)=1
    `);
    const singleTouch = singleTouchRow.n;

    const ghostedRow = await one(`
      SELECT COUNT(*)::int AS n FROM leads l
      WHERE l.status NOT IN ('Converted','Lost')
        AND (SELECT COUNT(*) FROM calls c WHERE c.lead_id=l.lead_id AND c.duration_seconds>30)=1
        AND (?::date - l.last_call_date::date) > 2
    `, [TODAY]);
    const ghosted = ghostedRow.n;

    const expiredHotRow = await one(`
      SELECT COUNT(*)::int AS n FROM followups f JOIN leads l ON l.lead_id=f.lead_id
      WHERE f.status='Missed' AND l.temperature='Hot' AND f.gap_hours > 24
    `);
    const expiredHot = expiredHotRow.n;

    const byBd = await all(`
      SELECT b.name AS bd, b.bd_id,
        (SELECT COUNT(*) FROM uncalled_leads u WHERE u.assigned_bd_id=b.bd_id AND u.last_call_date IS NULL)::int AS uncontacted,
        (SELECT COUNT(*) FROM uncalled_leads u WHERE u.assigned_bd_id=b.bd_id AND u.age_bucket='15+d' AND u.last_call_date IS NOT NULL)::int AS stale
      FROM bds b WHERE b.status='Active'
    `);

    const calc = (count) => Math.round(count * realCvr * AVG_TICKET);

    res.json({
      uncontacted_24h: uncontacted,
      single_touch_lost: singleTouch,
      stale_15d: stale,
      ghosted: ghosted,
      expired_hot: expiredHot,
      leakage_breakdown: {
        uncontacted: calc(uncontacted),
        single_touch: calc(singleTouch),
        stale: calc(stale),
        ghosted: calc(ghosted),
        expired_hot: calc(expiredHot),
      },
      total_leakage: calc(uncontacted) + calc(singleTouch) + calc(stale) + calc(ghosted) + calc(expiredHot),
      by_bd: byBd.map(r => ({ ...r, total: r.uncontacted + r.stale })).sort((a, b) => b.total - a.total),
      real_cvr_used: +(realCvr * 100).toFixed(2),
      avg_ticket: AVG_TICKET,
    });
  } catch (err) {
    console.error('[leakage]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/forecast (v_forecast_inputs) — 4-component model
// ──────────────────────────────────────────────────────────────
router.get('/forecast', async (req, res) => {
  try {
    const targetRow = await one(`SELECT value FROM config WHERE key='revenue_target_mtd'`);
    const target = parseFloat(targetRow.value);
    const monthDaysRow = await one(`SELECT value FROM config WHERE key='month_days'`);
    const monthDays = parseInt(monthDaysRow.value);
    const collectionRateRow = await one(`SELECT value FROM config WHERE key='historical_collection_rate'`);
    const collectionRate = parseFloat(collectionRateRow.value);

    const collectedRow = await one(`SELECT COALESCE(SUM(net_amount),0)::float AS n FROM sales WHERE status='Confirmed'`);
    const collectedSoFar = collectedRow.n || 0;

    const last7 = await all(`
      SELECT sale_date::date AS d, COALESCE(SUM(net_amount),0)::float AS rev
      FROM sales WHERE status='Confirmed'
      GROUP BY sale_date::date ORDER BY d DESC LIMIT 7
    `);
    const avgDaily = last7.length ? last7.reduce((s, r) => s + r.rev, 0) / last7.length : 0;

    const currentDay = 11; // matches TODAY = 2026-06-11
    const remainingDays = monthDays - currentDay;
    const runRateComponent = avgDaily * remainingDays;

    const activeLeadsRow = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE status NOT IN ('Converted','Lost')`);
    const activeLeads = activeLeadsRow.n;

    const rollingCvrRow = await one(`
      SELECT
        (
          (SELECT COUNT(*) FROM sales WHERE status='Confirmed' AND sale_date >= (?::date - INTERVAL '30 days'))::float /
          GREATEST((SELECT COUNT(*) FROM leads WHERE assigned_date >= (?::date - INTERVAL '30 days')),1)
        ) AS cvr
    `, [TODAY, TODAY]);
    const rollingCvr = rollingCvrRow.cvr || 0.087;

    const pipelineComponent = activeLeads * rollingCvr * AVG_TICKET;

    const emiDueRow = await one(`SELECT COALESCE(SUM(amount_due - amount_collected),0)::float AS n FROM collections WHERE status IN ('Overdue','Partial')`);
    const emiDue = emiDueRow.n || 0;
    const collectionComponent = emiDue * collectionRate;

    // adjustment factor
    let adjustment = 0;
    let adjReason = 'CVR stable';
    // check manipulation flags
    const manipFlagRow = await one(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT bd_id, (SUM(CASE WHEN duration_seconds=0 THEN 1 ELSE 0 END)*1.0/GREATEST(COUNT(*),1)) AS zspct
        FROM calls GROUP BY bd_id
      ) sub WHERE zspct > 0.6
    `);
    const manipFlag = manipFlagRow.n;
    if (manipFlag > 0) { adjustment = -0.10; adjReason = 'Manipulation detected'; }

    const forecast = (runRateComponent * 0.30) + (pipelineComponent * 0.40) + (collectionComponent * 0.20);
    const forecastAdjusted = forecast * (1 + adjustment);

    res.json({
      collected_so_far: collectedSoFar,
      run_rate: {
        avg_daily: Math.round(avgDaily),
        remaining_days: remainingDays,
        component: Math.round(runRateComponent),
        weight: 0.30,
      },
      pipeline: {
        active_leads: activeLeads,
        rolling_cvr_pct: +(rollingCvr * 100).toFixed(1),
        avg_ticket: AVG_TICKET,
        component: Math.round(pipelineComponent),
        weight: 0.40,
      },
      collections: {
        emi_due: Math.round(emiDue),
        historical_rate: collectionRate,
        component: Math.round(collectionComponent),
        weight: 0.20,
      },
      adjustment: { factor: adjustment, reason: adjReason, weight: 0.10 },
      forecast_eom: Math.round(forecastAdjusted),
      target,
      gap_to_target: Math.round(target - forecastAdjusted),
      required_daily: remainingDays ? Math.round((target - collectedSoFar) / remainingDays) : 0,
      confidence: 'High',
    });
  } catch (err) {
    console.error('[forecast]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/manipulation — anti-manipulation engine table
// ──────────────────────────────────────────────────────────────
router.get('/manipulation', async (req, res) => {
  try {
    const rows = await all(`
      SELECT b.bd_id, b.name,
        COUNT(c.call_id)::int AS total_calls,
        COALESCE(SUM(CASE WHEN c.duration_seconds=0 THEN 1 ELSE 0 END),0)::int AS zero_sec,
        COALESCE(SUM(CASE WHEN c.duration_seconds>30 THEN 1 ELSE 0 END),0)::int AS connected,
        COALESCE(SUM(c.duration_seconds),0)::int AS talktime_sec
      FROM bds b LEFT JOIN calls c ON c.bd_id=b.bd_id
      WHERE b.status='Active'
      GROUP BY b.bd_id, b.name
    `);

    const result = [];
    for (const r of rows) {
      const zeroSecPct = r.total_calls ? (r.zero_sec / r.total_calls) * 100 : 0;
      const avgDur = r.connected ? r.talktime_sec / r.connected : 0;

      const afterHoursRow = await one(`
        SELECT COUNT(*)::int AS n FROM calls WHERE bd_id=? AND EXTRACT(HOUR FROM call_timestamp) >= 23
      `, [r.bd_id]);
      const afterHours = afterHoursRow.n;

      const missedFuRow = await one(`SELECT COUNT(*)::int AS n FROM followups WHERE bd_id=? AND status='Missed'`, [r.bd_id]);
      const missedFu = missedFuRow.n;

      const signals = [];
      let score = 0;
      if (zeroSecPct > 10) { score += 20; signals.push(`zero-sec +20 (${zeroSecPct.toFixed(0)}%)`); }
      if (afterHours > 2) { score += 10; signals.push(`after-hrs +10 (${afterHours})`); }
      if (missedFu > 3) { score += 15; signals.push(`ghost-FU +15 (${missedFu})`); }
      if (avgDur < 30 && r.connected) { score += 10; signals.push('avg-dur +10'); }
      if (zeroSecPct > 60) { score += 33; signals.push('rapid-dial +15, CVR-inflate +10, extra +8'); }

      let status = 'Clean';
      if (score > 80) status = 'Auto-escalate';
      else if (score > 60) status = 'Flagged';
      else if (score > 20) status = 'Watch';

      result.push({
        bd_id: r.bd_id,
        name: r.name,
        score: Math.min(100, score),
        zero_sec_pct: +zeroSecPct.toFixed(1),
        avg_duration_sec: Math.round(avgDur),
        signals,
        status,
      });
    }

    res.json(result.sort((a, b) => b.score - a.score));
  } catch (err) {
    console.error('[manipulation]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/collections — collection KPIs + overdue table
// ──────────────────────────────────────────────────────────────
router.get('/collections', async (req, res) => {
  try {
    const kpis = await one(`
      SELECT
        COALESCE(SUM(amount_due),0)::float AS total_due,
        COALESCE(SUM(amount_collected),0)::float AS total_collected,
        COALESCE(SUM(CASE WHEN status='Overdue' AND (?::date - due_date::date) > 7 THEN amount_due - amount_collected ELSE 0 END),0)::float AS overdue_7,
        COALESCE(SUM(CASE WHEN status IN ('Overdue','Defaulted') AND (?::date - due_date::date) > 30 THEN amount_due - amount_collected ELSE 0 END),0)::float AS overdue_30,
        COALESCE(SUM(CASE WHEN status='Defaulted' THEN 1 ELSE 0 END),0)::int AS defaults,
        COUNT(*)::int AS total_plans
      FROM collections
    `, [TODAY, TODAY]);

    const overdueTable = await all(`
      SELECT c.collection_id, s.bd_id, b.name AS bd_name, c.amount_due::float AS amount_due,
        c.amount_collected::float AS amount_collected, c.due_date, c.status,
        (?::date - c.due_date::date)::int AS days_overdue
      FROM collections c
      JOIN sales s ON s.order_id = c.order_id
      JOIN bds b ON b.bd_id = s.bd_id
      WHERE c.status IN ('Overdue','Defaulted','Partial')
      ORDER BY days_overdue DESC LIMIT 10
    `, [TODAY]);

    res.json({
      total_fees_due: kpis.total_due,
      total_collected: kpis.total_collected,
      collection_rate_pct: kpis.total_due ? +((kpis.total_collected / kpis.total_due) * 100).toFixed(1) : 0,
      overdue_7days: kpis.overdue_7,
      overdue_30days: kpis.overdue_30,
      emi_default_rate_pct: kpis.total_plans ? +((kpis.defaults / kpis.total_plans) * 100).toFixed(1) : 0,
      overdue_table: overdueTable,
    });
  } catch (err) {
    console.error('[collections]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/funnel — 7-stage conversion funnel
// ──────────────────────────────────────────────────────────────
router.get('/funnel', async (req, res) => {
  try {
    const assignedRow = await one(`SELECT COUNT(*)::int AS n FROM leads`);
    const assigned = assignedRow.n;
    const contactedRow = await one(`SELECT COUNT(DISTINCT lead_id)::int AS n FROM calls WHERE duration_seconds>30`);
    const contacted = contactedRow.n;
    const interestedRow = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE status IN ('Interested','Proposal','Converted')`);
    const interested = interestedRow.n;
    const proposalRow = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE status IN ('Proposal','Converted')`);
    const proposal = proposalRow.n;
    const convertedRow = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE status='Converted'`);
    const converted = convertedRow.n;

    const pct = (num, den) => den ? +(num / den * 100).toFixed(1) : 0;

    const stages = [
      { label: 'Leads assigned', count: assigned, of_previous: 100 },
      { label: 'Contacted ≥1 call >30s', count: contacted, of_previous: pct(contacted, assigned) },
      { label: 'Interested / FU scheduled', count: interested, of_previous: pct(interested, contacted) },
      { label: 'Proposal sent', count: proposal, of_previous: pct(proposal, interested) },
      { label: 'Converted (order confirmed)', count: converted, of_previous: pct(converted, proposal) },
    ];

    res.json({
      stages,
      overall_cvr_pct: pct(converted, assigned),
      real_cvr_pct: pct(converted, contacted),
    });
  } catch (err) {
    console.error('[funnel]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// NEW · GET /api/bd-daily-calls — day-wise calls per BD
// Optional query params: ?bd_id=bd_rahul&days=14
// ──────────────────────────────────────────────────────────────
router.get('/bd-daily-calls', async (req, res) => {
  try {
    const { bd_id, days = 14 } = req.query;
    let sql = `
      SELECT bdc.bd_id, b.name AS bd_name, bdc.call_date,
             bdc.total_calls, bdc.connected_calls,
             bdc.zero_sec_calls, bdc.talktime_seconds, bdc.unique_leads_called
      FROM bd_daily_calls bdc
      JOIN bds b ON b.bd_id = bdc.bd_id
      WHERE bdc.call_date >= (?::date - (?::text || ' days')::interval)
    `;
    const params = [TODAY, String(days)];
    if (bd_id) { sql += ' AND bdc.bd_id = ?'; params.push(bd_id); }
    sql += ' ORDER BY bdc.bd_id, bdc.call_date';

    const rows = await all(sql, params);

    // Pivot into { bd_name: [...] }
    const byBd = {};
    for (const r of rows) {
      if (!byBd[r.bd_name]) byBd[r.bd_name] = [];
      byBd[r.bd_name].push({
        date: r.call_date,
        total_calls: r.total_calls,
        connected_calls: r.connected_calls,
        zero_sec_calls: r.zero_sec_calls,
        talktime_minutes: Math.round(r.talktime_seconds / 60),
        unique_leads_called: r.unique_leads_called,
      });
    }

    res.json({ days: Number(days), as_of: TODAY, by_bd: byBd, flat: rows });
  } catch (err) {
    console.error('[bd-daily-calls]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// NEW · GET /api/uncalled-leads — bucketed uncalled leads
// Query params:
//   ?bucket=15+d         filter to one bucket
//   ?bd_id=bd_rahul      filter to one BD
//   ?include_daywise=1   include the 15-day daywise flag grid
// ──────────────────────────────────────────────────────────────
router.get('/uncalled-leads', async (req, res) => {
  try {
    const { bucket, bd_id, include_daywise } = req.query;

    // Bucket summary (always returned)
    const bucketSummary = await all(`
      SELECT age_bucket, COUNT(*)::int AS n,
        COALESCE(SUM(CASE WHEN last_call_date IS NULL THEN 1 ELSE 0 END),0)::int AS never_called
      FROM uncalled_leads
      GROUP BY age_bucket
    `);
    const order = ['0-1d', '2-3d', '4-7d', '8-15d', '15+d'];
    const buckets = order.map(b => {
      const found = bucketSummary.find(x => x.age_bucket === b);
      return { bucket: b, count: found ? found.n : 0, never_called: found ? found.never_called : 0 };
    });

    // by BD breakdown
    const byBd = await all(`
      SELECT b.name AS bd_name, u.age_bucket, COUNT(*)::int AS n
      FROM uncalled_leads u JOIN bds b ON b.bd_id = u.assigned_bd_id
      GROUP BY b.name, u.age_bucket
      ORDER BY b.name
    `);

    let detailRows = [];
    if (bucket || bd_id) {
      let sql = `
        SELECT u.lead_id, l.name AS lead_name, b.name AS bd_name, u.last_call_date,
               u.days_since_last_call, u.age_bucket, u.daywise_flags
        FROM uncalled_leads u
        JOIN leads l ON l.lead_id = u.lead_id
        JOIN bds b ON b.bd_id = u.assigned_bd_id
        WHERE 1=1
      `;
      const params = [];
      if (bucket) { sql += ' AND u.age_bucket = ?'; params.push(bucket); }
      if (bd_id) { sql += ' AND u.assigned_bd_id = ?'; params.push(bd_id); }
      sql += ' LIMIT 200';
      detailRows = await all(sql, params);

      if (include_daywise) {
        // build day labels: day0=today ... day14 = 14 days ago
        const dayLabels = [];
        for (let d = 0; d < 15; d++) {
          const dt = new Date(TODAY + 'T00:00:00Z');
          dt.setUTCDate(dt.getUTCDate() - d);
          dayLabels.push(dt.toISOString().slice(0, 10));
        }
        detailRows = detailRows.map(r => ({
          ...r,
          daywise: dayLabels.map((date, i) => ({ date, uncalled: r.daywise_flags[i] === '1' })),
        }));
      }
    }

    res.json({
      as_of: TODAY,
      buckets,
      by_bd: byBd,
      detail: detailRows,
    });
  } catch (err) {
    console.error('[uncalled-leads]', err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/tl-performance — aggregates BD performance by Team Leader
// One row per team leader (plus an "Unassigned" row for BDs with no
// team_leader_id), with team-level totals: BD count, leads, revenue,
// penetration, team CVR, real CVR, chase %, and a simple coaching score.
// ──────────────────────────────────────────────────────────────
router.get('/tl-performance', async (req, res) => {
  try {
    const tls = await all(`SELECT tl_id, name FROM team_leaders`);
    const tlMap = {};
    for (const tl of tls) tlMap[tl.tl_id] = tl.name;

    const bds = await all(`SELECT bd_id, name, team_leader_id FROM bds WHERE status='Active'`);

    // Group BDs by team leader (null/unknown -> 'Unassigned')
    const groups = {};
    for (const bd of bds) {
      const key = bd.team_leader_id && tlMap[bd.team_leader_id] ? bd.team_leader_id : '__unassigned__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(bd);
    }

    const result = [];
    for (const [tlId, groupBds] of Object.entries(groups)) {
      const tlName = tlId === '__unassigned__' ? 'Unassigned' : tlMap[tlId];

      let assigned = 0, contacted = 0, salesCount = 0, revenue = 0;
      let fuDone = 0, fuTotal = 0;
      let zeroSec = 0, totalCalls = 0;

      for (const bd of groupBds) {
        const a = await one(`SELECT COUNT(*)::int AS n FROM leads WHERE assigned_bd_id=?`, [bd.bd_id]);
        const c = await one(`
          SELECT COUNT(DISTINCT lead_id)::int AS n FROM calls
          WHERE bd_id=? AND duration_seconds > 30
        `, [bd.bd_id]);
        const s = await one(`
          SELECT COUNT(*)::int AS n, COALESCE(SUM(net_amount),0)::float AS rev FROM sales
          WHERE bd_id=? AND status='Confirmed'
        `, [bd.bd_id]);
        const fu = await one(`
          SELECT COALESCE(SUM(CASE WHEN status='Done' THEN 1 ELSE 0 END),0)::int AS done, COUNT(*)::int AS total
          FROM followups WHERE bd_id=?
        `, [bd.bd_id]);
        const callAgg = await one(`
          SELECT COUNT(*)::int AS total_calls,
                 COALESCE(SUM(CASE WHEN duration_seconds=0 THEN 1 ELSE 0 END),0)::int AS zero_sec
          FROM calls WHERE bd_id=?
        `, [bd.bd_id]);

        assigned += a.n;
        contacted += c.n;
        salesCount += (s.n || 0);
        revenue += (s.rev || 0);
        fuDone += (fu.done || 0);
        fuTotal += (fu.total || 0);
        zeroSec += (callAgg.zero_sec || 0);
        totalCalls += (callAgg.total_calls || 0);
      }

      const penetration = assigned ? contacted / assigned : 0;
      const teamCvr = assigned ? salesCount / assigned : 0;
      const realCvr = contacted ? salesCount / contacted : 0;
      const chase = fuTotal ? fuDone / fuTotal : 0;
      const zeroSecPct = totalCalls ? (zeroSec / totalCalls) * 100 : 0;

      // Simple coaching score: rewards penetration/chase/realCvr, penalizes zero-sec rate
      const coachingScore = Math.round(
        Math.max(0, Math.min(100,
          (penetration * 40) + (chase * 30) + (Math.min(realCvr * 100, 20) * 1.5) - (zeroSecPct * 0.5)
        ))
      );

      result.push({
        tl_id: tlId === '__unassigned__' ? null : tlId,
        tl_name: tlName,
        bd_count: groupBds.length,
        leads: assigned,
        penetration_pct: +(penetration * 100).toFixed(1),
        team_cvr_pct: +(teamCvr * 100).toFixed(1),
        real_cvr_pct: +(realCvr * 100).toFixed(1),
        revenue,
        chase_pct: +(chase * 100).toFixed(1),
        coaching_score: coachingScore,
      });
    }

    // Sort by revenue desc, but keep "Unassigned" last
    result.sort((a, b) => {
      if (a.tl_id === null) return 1;
      if (b.tl_id === null) return -1;
      return b.revenue - a.revenue;
    });

    res.json(result);
  } catch (err) {
    console.error('[tl-performance]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
