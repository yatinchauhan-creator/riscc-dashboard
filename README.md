# RISCC — Revenue Intelligence & Sales Command Center
## Full-stack build: Node/Express backend + live dashboard

This package contains a complete backend (Express + SQLite via sql.js)
and the dashboard frontend wired to it. Everything in the dashboard —
KPIs, BD performance, forecast, day-wise calls, uncalled leads — is now
**fetched live from your database**, not hardcoded.

---

## 1. What's in this folder

```
riscc-backend/
├── server.js              ← start here
├── package.json
├── .env.example            ← copy to .env before deploying
├── selftest.js             ← optional: verifies all endpoints work
├── db/
│   ├── schema.sql           7 core tables + api_settings + 2 new tables
│   ├── generate_seed.js      generates demo data (run once)
│   ├── seed.sql              generated seed data
│   ├── index.js              sql.js database wrapper
│   ├── refresh.js            recomputes "materialized view" tables
│   └── riscc.sqlite           created on first run (your live DB)
├── routes/
│   ├── dashboard.js          all KPI/table endpoints
│   ├── settings.js           API key management (masked)
│   ├── copilot.js            Claude-powered Executive Copilot
│   └── sync.js               OCRM/Sales/Sheets connector sync (placeholders)
└── public/
    └── index.html            the dashboard (this is what users see)
```

---

## 2. Quick start (local)

```bash
cd riscc-backend
npm install                    # installs express, sql.js, cors, dotenv, node-cron, axios
node db/generate_seed.js        # generates db/seed.sql (only needed once, already done)
node server.js
```

You should see:

```
RISCC backend running -> http://localhost:3000
Dashboard:            http://localhost:3000/
API health:           http://localhost:3000/api/health
Settings (API keys):  http://localhost:3000/api/settings
```

Open **http://localhost:3000** — that's the full dashboard, now reading
from `db/riscc.sqlite` (pre-seeded with realistic demo data matching all
the dashboard's headline numbers).

---

## 3. Adding your API keys (Settings tab)

1. In the dashboard sidebar, go to **Intelligence → Settings / API Keys**.
2. For each connector (OCRM, Sales Report API, Google Sheets, Claude):
   - Enter the **Base URL** (e.g. `https://your-ocrm.com/api/v1`)
   - Paste the **API Key**
   - Tick **Enabled**
   - Click **Save**
3. Keys are sent once to your backend and stored in `db/riscc.sqlite`
   (table `api_settings`). They are **never** written into `index.html`
   or sent back to the browser in full — only a masked preview like
   `sk-a••••••••wXyz` is ever shown again.

### Claude API (Copilot)
- Base URL: `https://api.anthropic.com/v1/messages` (pre-filled)
- API key: your Anthropic API key (`sk-ant-...`)
- Model: `claude-sonnet-4-6` (pre-filled, editable)
- Once saved + enabled, the **Executive Copilot** (⌘K or the floating
  button) will answer questions using live KPI data from your database.

### OCRM / Sales API / Google Sheets
These connectors are **placeholders** — the sync logic in
`routes/sync.js` has clearly marked `TODO` sections where you map your
actual API's response fields onto the `leads`, `calls`, `sales`,
`followups`, `collections` tables. Until you fill these in, the "Sync
now" buttons in Settings will run but won't change your data (or will
error if the base URL/key don't point to a real API yet).

To wire up a real connector:
1. Open `routes/sync.js`
2. Find `syncOcrm()` / `syncSalesApi()` / `syncGoogleSheets()`
3. Replace the example `axios.get(...)` call and field mapping with
   your actual API's endpoint + response shape
4. Save, restart the server, then click "Sync now" in Settings

---

## 4. Securing it before you deploy publicly

By default, `/api/settings` and `/api/sync` (where your API keys live)
are **open** — fine for local testing, **not fine for a public deploy**.

Before deploying:

1. Copy `.env.example` to `.env`
2. Generate a random token: `openssl rand -hex 32`
3. Set `ADMIN_TOKEN=<that random string>` in `.env`
4. Restart the server
5. In the dashboard's **Settings** tab, paste that same token into the
   **Admin token** field at the top and click "Save in this browser" —
   it's stored in your browser's localStorage and sent as a Bearer
   token automatically from then on.

Without the correct token, `/api/settings` and `/api/sync` will return
`401 Unauthorized` — so even if someone finds your deployed URL, they
can't read or change your API keys. All the *dashboard* read endpoints
(`/api/exec-summary`, `/api/bd-performance`, etc.) remain open since
they don't expose credentials — add your own auth layer in front if the
dashboard data itself is sensitive.

---

## 5. New pages added

### Day-wise Calls (Sales Ops)
Per-BD, per-day call activity: total calls, connected, zero-second
(manipulation signal), talktime, unique leads called. Filterable by BD
and date range (7/14/30 days), with a trend chart of connected calls.

Backend: `GET /api/bd-daily-calls?bd_id=<id>&days=<n>`
Computed from the `bd_daily_calls` table, refreshed every 15 minutes
(and on-demand via `/api/refresh`).

### Uncalled Leads (Sales Ops)
Buckets leads by time since last connected call: `0-1d`, `2-3d`,
`4-7d`, `8-15d`, `15+d` (including leads never called at all). Click a
bucket to filter the detail table, which shows each lead's last call
date, days since, and a 15-day color grid (red = uncalled that day,
green = had a connected call).

Backend: `GET /api/uncalled-leads?bucket=<bucket>&bd_id=<id>&include_daywise=1`
Computed from the `uncalled_leads` table, refreshed every 15 minutes.

### Settings / API Keys (Intelligence)
Described above — secure connector management.

---

## 6. How the 15-minute refresh works

Per Doc 5, materialized views should refresh every 15 minutes. This is
implemented as:
- `db/refresh.js` → `refreshAll()` recomputes `bd_daily_calls` and
  `uncalled_leads` from raw `calls`/`leads` data.
- `server.js` runs this once on boot, then on a `node-cron` schedule
  (`*/15 * * * *`).
- You can also trigger it manually: `GET /api/refresh` (behind
  `ADMIN_TOKEN` if set).
- After any connector sync (`POST /api/sync/:connector`), `refreshAll()`
  runs automatically.

The other "views" from Doc 5 (`v_bd_daily_summary`,
`v_source_performance`, `v_manipulation_scores`, `v_forecast_inputs`,
`v_followup_status`) are computed live as SQL queries inside
`routes/dashboard.js` — cheap enough at this data volume that a
separate materialized table isn't needed, but you can convert them the
same way `bd_daily_calls`/`uncalled_leads` were done if your data grows
large.

---

## 7. Regenerating demo data

If you want to reset to fresh demo data:

```bash
rm db/riscc.sqlite
node db/generate_seed.js   # only if you changed generate_seed.js
node server.js              # recreates riscc.sqlite from schema.sql + seed.sql
```

**Warning:** this wipes any real data and API keys you've added.
Back up `db/riscc.sqlite` first if you've started using real connectors.

---

## 8. Verifying everything works

```bash
node selftest.js
```

This boots the app in-process, hits every API endpoint, and prints the
JSON responses — useful for confirming the backend is healthy without
needing a browser.

---

## 9. Deploying

This is a standard Node/Express app — deploy it anywhere that runs
Node.js (Render, Railway, Fly.io, a VPS, etc.):

1. Push this folder to your host
2. Set `ADMIN_TOKEN` (and any other secrets) as environment variables
3. Run `npm install && node server.js` (or use a process manager like
   `pm2`)
4. The dashboard is served at `/` — no separate frontend deploy needed
5. `db/riscc.sqlite` is a file — make sure your host has persistent
   storage, or it'll reset on every redeploy. For serious production
   use, consider migrating to Postgres (see notes at the bottom of
   `db/schema.sql`).
