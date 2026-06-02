import initSqlJs from "sql.js";
import https from "node:https";
import { PRAGMA_SQL } from "../schema.js";

/**
 * Vercel Postgres-backed sql.js adapter.
 * 
 * Uses sql.js (in-memory SQLite) for fast synchronous queries,
 * but persists the entire database blob to a Neon Postgres table
 * so data survives across serverless invocations.
 *
 * On init:  loads the blob from Postgres → hydrates sql.js
 * On write: persists IMMEDIATELY (no debounce) because Vercel
 *           serverless functions freeze after the response is sent,
 *           so setTimeout-based debounce never fires.
 *
 * Requires POSTGRES_URL or DATABASE_URL env var.
 */

let SQL = null;

async function downloadWasm() {
  const wasmUrl = "https://unpkg.com/sql.js@1.14.1/dist/sql-wasm.wasm";
  return new Promise((resolve, reject) => {
    https.get(wasmUrl, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`WASM download failed: ${res.statusCode}`));
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function loadSql() {
  if (SQL) return SQL;
  const wasmBinary = await downloadWasm();
  SQL = await initSqlJs({ wasmBinary });
  return SQL;
}

function getConnUrl() {
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("[DB][vercel-pg] No POSTGRES_URL or DATABASE_URL env var");
  return url;
}

// Cache the neon sql function so we don't re-import every call
let _neonSql = null;
async function getNeonSql(connUrl) {
  if (_neonSql) return _neonSql;
  const { neon } = await import("@neondatabase/serverless");
  _neonSql = neon(connUrl);
  return _neonSql;
}

async function neonQuery(connUrl, query, params = []) {
  const sql = await getNeonSql(connUrl);
  return sql(query, params);
}

/**
 * Ensure the blob storage table exists in Postgres.
 */
async function ensureBlobTable(connUrl) {
  await neonQuery(connUrl, `
    CREATE TABLE IF NOT EXISTS _sqljs_blob (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CHECK (id = 1)
    )
  `);
}

/**
 * Load the SQLite database blob from Postgres.
 * Stored as base64-encoded TEXT for reliable transport.
 * Returns null if no blob exists yet (fresh database).
 */
async function loadBlob(connUrl) {
  try {
    const rows = await neonQuery(connUrl, `SELECT data FROM _sqljs_blob WHERE id = 1`);
    if (rows.length > 0 && rows[0].data) {
      return Buffer.from(rows[0].data, "base64");
    }
  } catch (e) {
    if (!e.message?.includes("does not exist")) throw e;
  }
  return null;
}

/**
 * Save the SQLite database blob to Postgres as base64 TEXT.
 */
async function saveBlob(connUrl, data) {
  const b64 = Buffer.from(data).toString("base64");
  await neonQuery(connUrl, `
    INSERT INTO _sqljs_blob (id, data, updated_at) VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [b64]);
}

export async function createVercelPgAdapter() {
  const connUrl = getConnUrl();
  const SQLLib = await loadSql();

  // Ensure blob storage table
  await ensureBlobTable(connUrl);

  // Load existing blob or create fresh DB
  const existingBlob = await loadBlob(connUrl);
  const db = existingBlob
    ? new SQLLib.Database(new Uint8Array(existingBlob))
    : new SQLLib.Database();

  // Apply SQLite pragmas (WAL not useful in memory, but others are fine)
  try { db.exec(PRAGMA_SQL); } catch {}

  // --- Immediate persistence to Postgres ---
  // On Vercel serverless, setTimeout NEVER fires after the response is sent
  // (the function is frozen). We MUST persist synchronously-ish by tracking
  // a save promise and ensuring it completes before the response finishes.
  let dirty = false;
  let _savePromise = null;

  function persistNow() {
    if (!dirty) return;
    const data = db.export();
    dirty = false;
    _savePromise = saveBlob(connUrl, data)
      .then(() => console.log("[DB][vercel-pg] Persisted to Postgres"))
      .catch((e) => {
        console.error("[DB][vercel-pg] Persist failed:", e.message);
        dirty = true; // Mark dirty again so next write retries
      })
      .finally(() => { _savePromise = null; });
  }

  function markDirty() {
    dirty = true;
    // Persist immediately — don't debounce on serverless
    persistNow();
  }

  // --- Standard adapter interface (synchronous, matching SQLite adapters) ---

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      markDirty();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    markDirty();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      markDirty();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (dirty) persistNow();
    db.close();
  }

  /**
   * Wait for any in-flight save to complete.
   * API routes should call `await db.flush?.()` before returning the response
   * to ensure the blob is fully written to Postgres.
   */
  async function flush() {
    if (_savePromise) await _savePromise;
    // If still dirty after the last promise resolved, persist again
    if (dirty) {
      persistNow();
      if (_savePromise) await _savePromise;
    }
  }

  return { driver: "vercel-pg (sql.js→neon)", run, get, all, exec, transaction, close, flush };
}
