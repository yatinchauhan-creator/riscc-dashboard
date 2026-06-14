// ════════════════════════════════════════════════════════════════
// db/index.js — sql.js (WASM SQLite) wrapper
// Loads schema + seed on first run, persists to db/riscc.sqlite
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_FILE = path.join(__dirname, 'riscc.sqlite');
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const SEED_FILE = path.join(__dirname, 'seed.sql');

let SQL = null;
let db = null;

async function init() {
  SQL = await initSqlJs({
    // sql.js needs to locate its .wasm file
    locateFile: file => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
    console.log('[db] loaded existing riscc.sqlite');
  } else {
    db = new SQL.Database();
    console.log('[db] creating new database from schema.sql + seed.sql');
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    db.run(schema);
    if (fs.existsSync(SEED_FILE)) {
      const seed = fs.readFileSync(SEED_FILE, 'utf8');
      db.run(seed);
    }
    persist();
  }
  return db;
}

// Persist in-memory DB to disk (call after any write)
function persist() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// Run a query, return array of row objects
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Run a query, return first row object or null
function one(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

// Run a write statement (INSERT/UPDATE/DELETE), persists automatically
function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

// Run a write statement WITHOUT persisting to disk (for bulk loops).
// Call persist() once manually after the loop.
function runNoPersist(sql, params = []) {
  db.run(sql, params);
}

module.exports = { init, all, one, run, runNoPersist, persist, getDb: () => db };
