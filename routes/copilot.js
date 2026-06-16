// ════════════════════════════════════════════════════════════════
// routes/copilot.js — Executive Copilot (Doc 4 §3)
//
// Pulls live KPI context from the DB, sends it + the user's question
// to Claude, and returns a direct-answer response per the Doc 4
// response format rules. The Anthropic API key is read from
// api_settings (server-side only) — never from the frontend.
// ════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { all, one } = require('../db');

async function buildContext() {
  const rev = await one(`
    SELECT COALESCE(SUM(gross_amount),0)::float AS gross,
           COALESCE(SUM(CASE WHEN status='Confirmed' THEN net_amount ELSE 0 END),0)::float AS net,
           COUNT(CASE WHEN status='Confirmed' THEN 1 END)::int AS sales
    FROM sales
  `);
  const leadsRow = await one(`SELECT COUNT(*)::int AS n FROM leads`);
  const leads = leadsRow.n;
  const contactedRow = await one(`SELECT COUNT(DISTINCT lead_id)::int AS n FROM calls WHERE duration_seconds>30`);
  const contacted = contactedRow.n;
  const targetRow = await one(`SELECT value FROM config WHERE key='revenue_target_mtd'`);
  const target = parseFloat(targetRow.value);

  const bdTop5 = await all(`
    SELECT b.name,
      COALESCE((SELECT SUM(net_amount) FROM sales WHERE bd_id=b.bd_id AND status='Confirmed'),0)::float AS revenue,
      (SELECT COUNT(*) FROM sales WHERE bd_id=b.bd_id AND status='Confirmed')::int AS sales
    FROM bds b WHERE b.status='Active'
    ORDER BY revenue DESC LIMIT 5
  `);

  const manipFlags = await all(`
    SELECT b.name,
      (SUM(CASE WHEN c.duration_seconds=0 THEN 1 ELSE 0 END)*1.0/COUNT(*)*100)::float AS zero_pct
    FROM bds b JOIN calls c ON c.bd_id=b.bd_id
    GROUP BY b.name HAVING (SUM(CASE WHEN c.duration_seconds=0 THEN 1 ELSE 0 END)*1.0/COUNT(*)*100) > 30
  `);

  const overdueFuRow = await one(`SELECT COUNT(*)::int AS n FROM followups WHERE status='Missed'`);
  const overdueFu = overdueFuRow.n;

  return {
    gross_revenue: rev.gross,
    net_revenue: rev.net,
    sales_count: rev.sales,
    target,
    pct_of_target: target ? +(rev.net / target * 100).toFixed(1) : 0,
    leads_assigned: leads,
    leads_contacted: contacted,
    uncontacted: leads - contacted,
    top5_bds_by_revenue: bdTop5,
    manipulation_flags: manipFlags,
    overdue_followups: overdueFu,
  };
}

router.post('/', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  try {
    const setting = await one(`SELECT * FROM api_settings WHERE connector_key='claude'`);
    if (!setting || !setting.api_key || !setting.enabled) {
      return res.json({
        answer: `Claude API is not configured yet. Go to Settings → API Keys, add your Anthropic API key, and enable the Claude connector to get live answers to: "${question}"`,
        configured: false,
      });
    }

    const extra = JSON.parse(setting.extra_config || '{}');
    const model = extra.model || 'claude-sonnet-4-6';
    const context = await buildContext();

    const systemPrompt = `You are RISCC, the Executive Copilot for Nirnay IAS / Testbook's revenue intelligence platform.
Follow these response rules (Doc 4 §3.2):
1. Lead with a direct answer — no "Based on the data..." preamble.
2. Show supporting numbers inline.
3. Offer to drill deeper or take action at the end.
4. Flag data quality issues if relevant.
Current dashboard data (JSON): ${JSON.stringify(context)}`;

    const response = await axios.post(
      setting.base_url || 'https://api.anthropic.com/v1/messages',
      {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      },
      {
        headers: {
          'x-api-key': setting.api_key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    );
    const answer = response.data.content?.[0]?.text || '(no response)';
    res.json({ answer, configured: true });
  } catch (err) {
    console.error('[copilot] error:', err.response?.data || err.message);
    res.status(502).json({
      error: 'Copilot request failed',
      detail: err.response?.data?.error?.message || err.message,
    });
  }
});

module.exports = router;
