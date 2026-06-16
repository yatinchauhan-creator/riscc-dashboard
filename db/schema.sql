// ════════════════════════════════════════════════════════════════
// db/index.js — Postgres (via `pg`) wrapper
//
// Same all()/one()/run()/runNoPersist()/persist() API as before, so
// routes/*.js and db/refresh.js need NO changes to their query calls.
// Internally converts '?' placeholders to Postgres '$1, $2, ...'.
//
// Requires DATABASE_URL env var (set this in Render's Environment tab,
// pointing at your Render Postgres instance's Internal Database URL).
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

let pool = null;

// Convert '?' placeholders (in order) to Postgres '$1,$2,...'
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add it in Render -> your service -> Environment.');
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
  });

  // Check if schema already applied (e.g. 'leads' table exists)
  const check = await pool.query(`SELECT to_regclass('public.leads') AS exists`);
  if (!check.rows[0].exists) {
    console.log('[db] no schema found — applying schema.sql');
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await pool.query(schema);
    console.log('[db] schema applied');
  } else {
    console.log('[db] schema already present');
  }

  return pool;
}

// No-op: Postgres writes are durable immediately. Kept for API
// compatibility with code that calls persist() after bulk loops.
function persist() {}

// Run a query, return array of row objects
async function all(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows;
}

// Run a query, return first row object or null
async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows.length ? rows[0] : null;
}

// Run a write statement (INSERT/UPDATE/DELETE)
async function run(sql, params = []) {
  await pool.query(toPgQuery(sql), params);
}

// Same as run() — Postgres has no separate "no persist" mode, but kept
// for API compatibility with bulk-loop code in sync.js
async function runNoPersist(sql, params = []) {
  await pool.query(toPgQuery(sql), params);
}

module.exports = { init, all, one, run, runNoPersist, persist, getPool: () => pool };
