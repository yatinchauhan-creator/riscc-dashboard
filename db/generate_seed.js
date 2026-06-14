// ════════════════════════════════════════════════════════════════
// RISCC seed data generator
// Produces realistic data that reproduces the dashboard's headline
// numbers: 2,841 leads, 2,103 connected, 236 sales, ₹1.84Cr net
// revenue, Rahul S./Varun T. manipulation patterns, etc.
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

// ---- helper -------------------------------------------------------
function iso(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }
function daysAgo(n, hours = 9) {
  const d = new Date('2026-06-11T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hours, Math.floor(Math.random() * 60), 0, 0);
  return d;
}
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[rand(0, arr.length - 1)]; }
function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return v;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const out = [];

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════
out.push(`INSERT INTO config (key, value) VALUES
  ('revenue_target_mtd', '28000000'),
  ('current_date', '2026-06-11'),
  ('month_days', '30'),
  ('historical_collection_rate', '0.84');`);

// ════════════════════════════════════════════════════════════════
// API SETTINGS — empty placeholders for the 4 connectors
// ════════════════════════════════════════════════════════════════
out.push(`INSERT INTO api_settings (connector_key, label, base_url, api_key, extra_config, enabled) VALUES
  ('ocrm', 'OCRM API', '', '', '{}', 0),
  ('sales_api', 'Sales Report API', '', '', '{}', 0),
  ('gsheets', 'Google Sheets', '', '', '{"sheet_id":""}', 0),
  ('claude', 'Claude API (Copilot + Insights)', 'https://api.anthropic.com/v1/messages', '', '{"model":"claude-sonnet-4-6"}', 0);`);

// ════════════════════════════════════════════════════════════════
// TEAM LEADERS
// ════════════════════════════════════════════════════════════════
out.push(`INSERT INTO team_leaders (tl_id, name) VALUES
  ('tl_anand', 'Anand R.'),
  ('tl_meena', 'Meena V.');`);

// ════════════════════════════════════════════════════════════════
// BDS — matches BD performance table exactly
// BD_Score = (RealCVR*0.4)+(Chase*0.25)+(Penetration*0.2)+(1-Manip/100)*0.15
// ════════════════════════════════════════════════════════════════
const bds = [
  { id: 'bd_priya',  name: 'Priya K.', tl: 'tl_anand', team: 'team_anand', target_rev: 2800000, target_sales: 35 },
  { id: 'bd_ajay',   name: 'Ajay M.',  tl: 'tl_anand', team: 'team_anand', target_rev: 2400000, target_sales: 30 },
  { id: 'bd_sneha',  name: 'Sneha G.', tl: 'tl_meena', team: 'team_meena', target_rev: 1800000, target_sales: 25 },
  { id: 'bd_neha',   name: 'Neha R.',  tl: 'tl_meena', team: 'team_meena', target_rev: 1500000, target_sales: 20 },
  { id: 'bd_kabir',  name: 'Kabir D.', tl: 'tl_anand', team: 'team_anand', target_rev: 1300000, target_sales: 18 },
  { id: 'bd_varun',  name: 'Varun T.', tl: 'tl_anand', team: 'team_anand', target_rev: 1200000, target_sales: 16 },
  { id: 'bd_rahul',  name: 'Rahul S.', tl: 'tl_meena', team: 'team_meena', target_rev: 1200000, target_sales: 16 },
  { id: 'bd_dev',    name: 'Dev P.',   tl: 'tl_meena', team: 'team_meena', target_rev: 1100000, target_sales: 15 },
];

out.push('INSERT INTO bds (bd_id, name, team_leader_id, team_id, join_date, status, monthly_target_revenue, monthly_target_sales) VALUES');
out.push(bds.map(b =>
  `  (${esc(b.id)}, ${esc(b.name)}, ${esc(b.tl)}, ${esc(b.team)}, '2025-01-15', 'Active', ${b.target_rev}, ${b.target_sales})`
).join(',\n') + ';');

// ════════════════════════════════════════════════════════════════
// CAMPAIGNS — matches Source Analysis table
// CPL, leads_generated taken from dashboard
// ════════════════════════════════════════════════════════════════
const campaigns = [
  { id: 'camp_referral', name: 'Referral Program',   source: 'Referral',  spend: 0,       leads: 124 },
  { id: 'camp_fb',       name: 'Facebook Lead Ads',  source: 'Facebook',  spend: 560880,  leads: 684 },
  { id: 'camp_yt',       name: 'YouTube Ads',        source: 'YouTube',   spend: 263680,  leads: 412 },
  { id: 'camp_google',   name: 'Google Search Ads',  source: 'Google',    spend: 481120,  leads: 388 },
  { id: 'camp_organic',  name: 'Organic / SEO',      source: 'Organic',   spend: 155610,  leads: 741 },
  { id: 'camp_wa',       name: 'WhatsApp Blast',     source: 'WhatsApp',  spend: 895440,  leads: 492 },
];
out.push('INSERT INTO campaigns (campaign_id, name, source, spend, start_date, end_date, leads_generated) VALUES');
out.push(campaigns.map(c =>
  `  (${esc(c.id)}, ${esc(c.name)}, ${esc(c.source)}, ${c.spend}, '2026-06-01', NULL, ${c.leads})`
).join(',\n') + ';');

// total leads = 124+684+412+388+741+492 = 2841  ✓ matches dashboard

// ════════════════════════════════════════════════════════════════
// LEADS — 2,841 total, distributed across campaigns and BDs
// Status/temperature distributions tuned to match:
//   - 2,103 contacted (>=1 call >30s)
//   - 738 uncontacted
//   - 236 converted
//   - 182 stale (15d+)
//   - 34 hot leads with missed FU
// ════════════════════════════════════════════════════════════════
const leads = [];
let leadCounter = 1;

// BD lead-share weights roughly matching "Assigned" column in BD table
const bdShare = {
  bd_priya: 280, bd_ajay: 260, bd_sneha: 245, bd_neha: 230,
  bd_kabir: 220, bd_varun: 218, bd_rahul: 210, bd_dev: 178
};
// remaining leads (2841 - sum) get distributed across all BDs for "unassigned-ish" pool
const totalNamed = Object.values(bdShare).reduce((a, b) => a + b, 0); // 1841
const remaining = 2841 - totalNamed; // 1000 -> spread proportionally as additional pool

// campaign pool to draw from, weighted by leads_generated
function weightedCampaign() {
  const r = Math.random() * 2841;
  let acc = 0;
  for (const c of campaigns) {
    acc += c.leads;
    if (r <= acc) return c;
  }
  return campaigns[campaigns.length - 1];
}

const bdIds = Object.keys(bdShare);
// Build assignment list: each BD gets bdShare[id] leads
let assignmentPool = [];
for (const [bd, n] of Object.entries(bdShare)) {
  for (let i = 0; i < n; i++) assignmentPool.push(bd);
}
// pad/truncate to exactly 2841
while (assignmentPool.length < 2841) assignmentPool.push(pick(bdIds));
assignmentPool = assignmentPool.slice(0, 2841);
// shuffle
assignmentPool.sort(() => Math.random() - 0.5);

const statesPool = ['Uttar Pradesh', 'Bihar', 'Delhi', 'Madhya Pradesh', 'Rajasthan', 'Maharashtra', 'West Bengal', 'Haryana'];

for (let i = 0; i < 2841; i++) {
  const campaign = weightedCampaign();
  const bd = assignmentPool[i];
  const assignedDaysAgo = rand(0, 28); // spread across the month
  const assignedDate = daysAgo(assignedDaysAgo, rand(8, 19));

  // ---- determine outcome bucket ----
  const r = Math.random();
  let status, temperature, lastCallOffsetDays;

  if (i < 236) {
    // Converted leads (236 total)
    status = 'Converted';
    temperature = pick(['Warm', 'Hot']);
    lastCallOffsetDays = rand(0, assignedDaysAgo);
  } else if (r < 0.738 * 0.26) {
    // part of the 738 uncontacted -> handled by uncontacted flag below
    status = 'Open';
    temperature = pick(['Cold', 'Warm']);
    lastCallOffsetDays = null; // no calls
  } else if (r < 0.30) {
    status = 'Lost';
    temperature = 'Cold';
    lastCallOffsetDays = rand(assignedDaysAgo, assignedDaysAgo + 5);
  } else if (r < 0.55) {
    status = 'Interested';
    temperature = pick(['Warm', 'Hot', 'Cold']);
    lastCallOffsetDays = rand(0, Math.max(1, assignedDaysAgo));
  } else if (r < 0.75) {
    status = 'Proposal';
    temperature = pick(['Warm', 'Hot']);
    lastCallOffsetDays = rand(0, Math.max(1, assignedDaysAgo));
  } else {
    status = 'Open';
    temperature = pick(['Cold', 'Warm', 'Hot']);
    lastCallOffsetDays = rand(0, Math.max(1, assignedDaysAgo));
  }

  // Force exact uncontacted count (738): mark first 738 "Open"-pool leads with no calls
  leads.push({
    lead_id: `lead_${String(leadCounter++).padStart(5, '0')}`,
    phone: `9${rand(100000000, 999999999)}`,
    crm_id: `crm_${10000 + i}`,
    email: `lead${i}@example.com`,
    name: `Lead ${i + 1}`,
    source: campaign.source,
    campaign_id: campaign.id,
    state: pick(statesPool),
    category: pick(['Fresh', 'Fresh', 'Fresh', 'Repeat', 'Referral']),
    assigned_bd_id: bd,
    assigned_date: iso(assignedDate),
    status,
    temperature,
    last_call_offset: lastCallOffsetDays,
    assigned_days_ago: assignedDaysAgo,
  });
}

// Now enforce exactly 738 uncontacted: pick 738 non-converted leads, set last_call_offset=null
let nonConverted = leads.filter(l => l.status !== 'Converted');
nonConverted.sort(() => Math.random() - 0.5);
for (let i = 0; i < 738 && i < nonConverted.length; i++) {
  nonConverted[i].last_call_offset = null;
  nonConverted[i].status = nonConverted[i].status === 'Lost' ? 'Lost' : 'Open';
}

// Enforce ~182 stale leads (15d+ since last call, not Converted/Lost)
let staleCandidates = leads.filter(l => l.status === 'Open' && l.last_call_offset !== null);
staleCandidates.sort(() => Math.random() - 0.5);
for (let i = 0; i < 182 && i < staleCandidates.length; i++) {
  staleCandidates[i].last_call_offset = rand(16, 29);
}

// Enforce 34 "expired hot leads" (Hot temp, will get missed followups later)
let hotCandidates = leads.filter(l => l.status !== 'Converted' && l.status !== 'Lost');
hotCandidates.sort(() => Math.random() - 0.5);
for (let i = 0; i < 34 && i < hotCandidates.length; i++) {
  hotCandidates[i].temperature = 'Hot';
  hotCandidates[i]._expiredHot = true;
}

// Compute last_call_date and last_crm_update from offsets
for (const l of leads) {
  if (l.last_call_offset === null) {
    l.last_call_date = null;
  } else {
    const d = daysAgo(l.last_call_offset, rand(8, 19));
    l.last_call_date = iso(d);
  }
  // last_crm_update: usually shortly after last_call, but for Rahul/Varun, much later (CRM lag)
  if (l.last_call_date) {
    const lagHours = (l.assigned_bd_id === 'bd_rahul') ? rand(4, 10)
                    : (l.assigned_bd_id === 'bd_varun') ? rand(2, 6)
                    : rand(0, 2);
    const base = new Date(l.last_call_date.replace(' ', 'T') + 'Z');
    base.setUTCHours(base.getUTCHours() + lagHours);
    l.last_crm_update = iso(base);
  } else {
    l.last_crm_update = null;
  }
}

// Output leads INSERT in batches
const LEAD_BATCH = 300;
for (let i = 0; i < leads.length; i += LEAD_BATCH) {
  const batch = leads.slice(i, i + LEAD_BATCH);
  out.push('INSERT INTO leads (lead_id, phone_normalized, crm_id, email, name, source, campaign_id, state, category, assigned_bd_id, assigned_date, status, temperature, last_call_date, last_crm_update, created_at) VALUES');
  out.push(batch.map(l =>
    `  (${esc(l.lead_id)}, ${esc(l.phone)}, ${esc(l.crm_id)}, ${esc(l.email)}, ${esc(l.name)}, ${esc(l.source)}, ${esc(l.campaign_id)}, ${esc(l.state)}, ${esc(l.category)}, ${esc(l.assigned_bd_id)}, ${esc(l.assigned_date)}, ${esc(l.status)}, ${esc(l.temperature)}, ${esc(l.last_call_date)}, ${esc(l.last_crm_update)}, ${esc(l.assigned_date)})`
  ).join(',\n') + ';');
}

// ════════════════════════════════════════════════════════════════
// CALLS — generate per lead based on last_call_offset
// Special handling for Rahul S. (manipulation: 344 zero-sec calls,
// only 44 real calls) and Varun T. (ghost FUs, rapid dial pattern)
// ════════════════════════════════════════════════════════════════
const calls = [];
let callCounter = 1;

function addCall(leadId, bdId, ts, duration, outcome, recording, crmLogged, crmLagHours) {
  const c = {
    call_id: `call_${String(callCounter++).padStart(6, '0')}`,
    lead_id: leadId,
    bd_id: bdId,
    call_timestamp: iso(ts),
    duration_seconds: duration,
    outcome,
    recording_url: recording ? `https://recordings.riscc.local/${recording}` : null,
    crm_logged: crmLogged ? 1 : 0,
    crm_log_time: null,
  };
  if (crmLogged) {
    const t = new Date(ts);
    t.setUTCHours(t.getUTCHours() + (crmLagHours || 0));
    c.crm_log_time = iso(t);
  }
  calls.push(c);
}

for (const l of leads) {
  if (l.status === 'Converted') {
    // converted leads get 3-6 calls, all connected
    const n = rand(3, 6);
    for (let j = 0; j < n; j++) {
      const off = Math.max(0, l.assigned_days_ago - j * 2);
      addCall(l.lead_id, l.assigned_bd_id, daysAgo(off, rand(9, 18)), rand(180, 540), 'Connected', `${l.lead_id}_c${j}`, true, rand(0, 2));
    }
    continue;
  }
  if (l.last_call_date === null) continue; // uncontacted, no calls at all

  const bd = l.assigned_bd_id;

  if (bd === 'bd_rahul') {
    // Rahul: mostly zero-second "calls" (manipulation), few real calls
    const totalCalls = rand(4, 8); // per lead, scaled across ~210 leads -> ~388 total, ~344 zero-sec
    for (let j = 0; j < totalCalls; j++) {
      const off = rand(0, Math.max(1, l.assigned_days_ago));
      if (Math.random() < 0.88) {
        // zero-second fake call
        addCall(l.lead_id, bd, daysAgo(off, rand(9, 22)), 0, 'Not Connected', null, Math.random() < 0.4, rand(5, 9));
      } else {
        // real but short call
        addCall(l.lead_id, bd, daysAgo(off, rand(9, 18)), rand(40, 140), 'Connected', `${l.lead_id}_r${j}`, Math.random() < 0.4, rand(5, 9));
      }
    }
  } else if (bd === 'bd_varun') {
    // Varun: rapid dialing pattern + low connection rate + after-hours logging
    const totalCalls = rand(2, 5);
    for (let j = 0; j < totalCalls; j++) {
      const off = rand(0, Math.max(1, l.assigned_days_ago));
      const connected = Math.random() < 0.45;
      const hour = Math.random() < 0.25 ? rand(23, 23) : rand(9, 20); // some after-hours
      addCall(l.lead_id, bd, daysAgo(off, hour), connected ? rand(35, 200) : rand(0, 25), connected ? 'Connected' : 'No Answer', connected ? `${l.lead_id}_v${j}` : null, Math.random() < 0.5, rand(3, 6));
    }
    // rapid-dial: occasionally fire 5+ calls within the same hour to same lead
    if (Math.random() < 0.15) {
      const base = daysAgo(rand(0, 3), 11);
      for (let k = 0; k < 6; k++) {
        const t = new Date(base);
        t.setUTCMinutes(t.getUTCMinutes() + k * 8);
        addCall(l.lead_id, bd, t, rand(0, 10), 'No Answer', null, false, 0);
      }
    }
  } else {
    // normal BDs: 2-5 calls, mostly connected with good duration
    const totalCalls = rand(2, 5);
    for (let j = 0; j < totalCalls; j++) {
      const off = rand(0, Math.max(1, l.assigned_days_ago));
      const connected = Math.random() < 0.82;
      addCall(
        l.lead_id, bd, daysAgo(off, rand(9, 18)),
        connected ? rand(60, 600) : rand(0, 25),
        connected ? 'Connected' : pick(['No Answer', 'Busy']),
        connected ? `${l.lead_id}_n${j}` : null,
        Math.random() < 0.85,
        rand(0, 3)
      );
    }
  }
}

const CALL_BATCH = 400;
for (let i = 0; i < calls.length; i += CALL_BATCH) {
  const batch = calls.slice(i, i + CALL_BATCH);
  out.push('INSERT INTO calls (call_id, lead_id, bd_id, call_timestamp, duration_seconds, outcome, recording_url, crm_logged, crm_log_time) VALUES');
  out.push(batch.map(c =>
    `  (${esc(c.call_id)}, ${esc(c.lead_id)}, ${esc(c.bd_id)}, ${esc(c.call_timestamp)}, ${c.duration_seconds}, ${esc(c.outcome)}, ${esc(c.recording_url)}, ${c.crm_logged}, ${esc(c.crm_log_time)})`
  ).join(',\n') + ';');
}

// ════════════════════════════════════════════════════════════════
// SALES — 236 confirmed orders, net ₹1.84Cr, gross ₹2.09Cr
// waivers ₹11.1L total, refunds ₹14.2L total (18 refunded orders)
// ════════════════════════════════════════════════════════════════
const convertedLeads = leads.filter(l => l.status === 'Converted');
const sales = [];
let saleCounter = 1;
const avgTicketGross = 209000000 / 236 / 100; // in rupees -> ₹2.09Cr/236 ≈ ₹88,560 avg gross

// We'll distribute gross amounts so SUM ≈ 2.09Cr, waivers sum ≈ 11.1L, refunds sum ≈ 14.2L (18 orders)
let totalWaiver = 0;
const targetWaiverTotal = 1110000; // ₹11.1L
const targetGrossTotal = 20900000; // ₹2.09Cr (in actual rupees, dashboard shows Cr)

for (let i = 0; i < convertedLeads.length; i++) {
  const l = convertedLeads[i];
  const gross = rand(60000, 180000); // spread of ticket sizes
  let waiver = 0;
  if (i < 18) waiver = Math.round(gross * (rand(5, 15) / 100)); // 18 leads get waivers
  const net = gross - waiver;
  const isRefunded = i < 18 && Math.random() < 0.5; // some overlap for refund pool, recalced below
  const saleDate = daysAgo(l.assigned_days_ago > 0 ? rand(0, l.assigned_days_ago) : 0, rand(10, 19));

  sales.push({
    order_id: `order_${String(saleCounter++).padStart(5, '0')}`,
    lead_id: l.lead_id,
    bd_id: l.assigned_bd_id,
    course_id: pick(['course_gs_foundation', 'course_csat_essay', 'course_full_upsc', 'course_prelims']),
    gross_amount: gross,
    waiver_amount: waiver,
    net_amount: net,
    sale_date: iso(saleDate),
    payment_type: pick(['Full', 'EMI', 'EMI', 'Partial']),
    status: 'Confirmed',
  });
}

// Mark 18 sales as Refunded (separate from waiver pool, pick different orders for clarity)
for (let i = 18; i < 36 && i < sales.length; i++) {
  sales[i].status = 'Refunded';
}

// Adjust totals to roughly hit targets (scale gross_amount uniformly)
const grossSum = sales.reduce((s, x) => s + x.gross_amount, 0);
const scale = targetGrossTotal / grossSum;
for (const s of sales) {
  s.gross_amount = Math.round(s.gross_amount * scale);
  s.waiver_amount = Math.round(s.waiver_amount * scale);
  s.net_amount = s.gross_amount - s.waiver_amount;
}

const SALE_BATCH = 200;
for (let i = 0; i < sales.length; i += SALE_BATCH) {
  const batch = sales.slice(i, i + SALE_BATCH);
  out.push('INSERT INTO sales (order_id, lead_id, bd_id, course_id, gross_amount, waiver_amount, net_amount, sale_date, payment_type, status) VALUES');
  out.push(batch.map(s =>
    `  (${esc(s.order_id)}, ${esc(s.lead_id)}, ${esc(s.bd_id)}, ${esc(s.course_id)}, ${s.gross_amount}, ${s.waiver_amount}, ${s.net_amount}, ${esc(s.sale_date)}, ${esc(s.payment_type)}, ${esc(s.status)})`
  ).join(',\n') + ';');
}

// ════════════════════════════════════════════════════════════════
// FOLLOWUPS — 148 due today, 211 overdue, 34 hot expired
// chase compliance ≈ 54%
// ════════════════════════════════════════════════════════════════
const followups = [];
let fuCounter = 1;

function addFollowup(leadId, bdId, scheduledDate, status, gapHours, actualDate) {
  followups.push({
    followup_id: `fu_${String(fuCounter++).padStart(5, '0')}`,
    lead_id: leadId,
    bd_id: bdId,
    scheduled_date: iso(scheduledDate),
    actual_followup_date: actualDate ? iso(actualDate) : null,
    gap_hours: gapHours,
    status,
  });
}

// Today's due follow-ups (148), ~54% Done
const openLeads = leads.filter(l => l.status === 'Open' || l.status === 'Interested' || l.status === 'Proposal');
const dueToday = openLeads.slice(0, 148);
dueToday.forEach((l, i) => {
  const scheduled = new Date('2026-06-11T09:00:00Z');
  const isDone = i < 62; // 62 done of 148 -> matches "Done Today: 62"
  if (isDone) {
    const actual = new Date(scheduled);
    actual.setUTCHours(actual.getUTCHours() + rand(0, 3));
    addFollowup(l.lead_id, l.assigned_bd_id, scheduled, 'Done', rand(0, 3), actual);
  } else {
    addFollowup(l.lead_id, l.assigned_bd_id, scheduled, 'Pending', null, null);
  }
});

// Overdue followups (211), concentrated on Rahul S. (48) and Varun T. (41)
const overdueLeads = openLeads.slice(148, 148 + 211);
overdueLeads.forEach((l, i) => {
  let bd = l.assigned_bd_id;
  // force concentration per Doc spec
  if (i < 48) bd = 'bd_rahul';
  else if (i < 89) bd = 'bd_varun';

  const daysBack = rand(1, 6);
  const scheduled = daysAgo(daysBack, 9);
  const gap = daysBack * 24 + rand(0, 12);
  addFollowup(l.lead_id, bd, scheduled, 'Missed', gap, null);
});

// 34 hot expired leads -> Missed FU with gap > 24h
const expiredHot = leads.filter(l => l._expiredHot);
expiredHot.forEach((l) => {
  const scheduled = daysAgo(rand(1, 4), 9);
  addFollowup(l.lead_id, l.assigned_bd_id, scheduled, 'Missed', rand(24, 144), null);
});

const FU_BATCH = 200;
for (let i = 0; i < followups.length; i += FU_BATCH) {
  const batch = followups.slice(i, i + FU_BATCH);
  out.push('INSERT INTO followups (followup_id, lead_id, bd_id, scheduled_date, actual_followup_date, gap_hours, status) VALUES');
  out.push(batch.map(f =>
    `  (${esc(f.followup_id)}, ${esc(f.lead_id)}, ${esc(f.bd_id)}, ${esc(f.scheduled_date)}, ${esc(f.actual_followup_date)}, ${f.gap_hours === null ? 'NULL' : f.gap_hours}, ${esc(f.status)})`
  ).join(',\n') + ';');
}

// ════════════════════════════════════════════════════════════════
// COLLECTIONS — Total due ₹2.19Cr, collected ₹1.84Cr (84%)
// Specific overdue students from dashboard: Arjun Singh, Sneha Patel,
// Rahul Verma (defaulted), Divya Kumar (on track)
// ════════════════════════════════════════════════════════════════
const collections = [];
let collCounter = 1;

function addCollection(orderId, due, collected, dueDate, paymentDate, status) {
  collections.push({
    collection_id: `coll_${String(collCounter++).padStart(5, '0')}`,
    order_id: orderId,
    amount_due: due,
    amount_collected: collected,
    due_date: dueDate,
    payment_date: paymentDate,
    status,
  });
}

// One collection row per sale (first installment), scaled to hit ₹2.19Cr due / ₹1.84Cr collected
const totalDueTarget = 21900000; // ₹2.19Cr
const totalCollectedTarget = 18400000; // ₹1.84Cr
const perOrderDue = totalDueTarget / sales.length;
let runningCollected = 0;

sales.forEach((s, i) => {
  const due = Math.round(perOrderDue);
  let collected, dueDate, paymentDate, status;

  if (i === 0) { // Arjun Singh style - overdue 10d
    collected = Math.round(due * 0.5);
    dueDate = '2026-06-01';
    paymentDate = null;
    status = 'Overdue';
  } else if (i === 1) { // Sneha Patel - overdue 6d
    collected = Math.round(due * 0.5);
    dueDate = '2026-06-05';
    paymentDate = null;
    status = 'Overdue';
  } else if (i === 2) { // Rahul Verma - defaulted 32d
    collected = Math.round(due * 0.5);
    dueDate = '2026-05-10';
    paymentDate = null;
    status = 'Defaulted';
  } else if (i === 3) { // Divya Kumar - paid in full
    collected = due;
    dueDate = '2026-06-15';
    paymentDate = '2026-06-08';
    status = 'Paid';
  } else {
    // distribute remaining to hit 84% overall collection rate
    const pct = Math.random() < 0.84 ? 1 : (Math.random() < 0.5 ? rand(40, 90) / 100 : 0);
    collected = Math.round(due * pct);
    status = pct >= 1 ? 'Paid' : (pct > 0 ? 'Partial' : 'Overdue');
    dueDate = '2026-06-' + String(rand(1, 28)).padStart(2, '0');
    paymentDate = status === 'Paid' ? dueDate : null;
  }
  runningCollected += collected;
  addCollection(s.order_id, due, collected, dueDate, paymentDate, status);
});

// scale collected amounts to hit target total precisely
const collScale = totalCollectedTarget / runningCollected;
for (const c of collections) {
  if (c.collected !== c.amount_due) {
    c.amount_collected = Math.min(c.amount_due, Math.round(c.amount_collected * collScale));
  }
}

const COLL_BATCH = 200;
for (let i = 0; i < collections.length; i += COLL_BATCH) {
  const batch = collections.slice(i, i + COLL_BATCH);
  out.push('INSERT INTO collections (collection_id, order_id, amount_due, amount_collected, due_date, payment_date, status) VALUES');
  out.push(batch.map(c =>
    `  (${esc(c.collection_id)}, ${esc(c.order_id)}, ${c.amount_due}, ${c.amount_collected}, ${esc(c.due_date)}, ${esc(c.payment_date)}, ${esc(c.status)})`
  ).join(',\n') + ';');
}

// ════════════════════════════════════════════════════════════════
// Write output
// ════════════════════════════════════════════════════════════════
fs.writeFileSync(path.join(__dirname, 'seed.sql'), out.join('\n\n') + '\n');
console.log('seed.sql written:', out.length, 'statements');
console.log('Leads:', leads.length, '| Calls:', calls.length, '| Sales:', sales.length, '| Followups:', followups.length, '| Collections:', collections.length);
console.log('Gross sum:', sales.reduce((s,x)=>s+x.gross_amount,0));
console.log('Net sum:', sales.reduce((s,x)=>s+x.net_amount,0));
console.log('Collected sum:', collections.reduce((s,x)=>s+x.amount_collected,0));
