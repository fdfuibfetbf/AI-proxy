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
 * On write: debounced save of the blob back to Postgres
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
  // On Vercel, we load WASM from CDN into memory directly
  const wasmBinary = await downloadWasm();
  SQL = await initSqlJs({ wasmBinary });
  return SQL;
}

function getNeonSql() {
  // Lazy import to avoid bundling issues when not on Vercel
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("[DB][vercel-pg] No POSTGRES_URL or DATABASE_URL env var");
  // We use raw fetch for simple HTTP queries to Neon's SQL-over-HTTP
  return url;
}

/**
 * Execute a simple SQL query against Neon via their serverless driver.
 */
async function neonQuery(connUrl, query, params = []) {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(connUrl);
  return sql(query, params);
}

/**
 * Ensure the blob storage table exists in Postgres.
 */
async function ensureBlobTable(connUrl) {
  await neonQuery(connUrl, `
    CREATE TABLE IF NOT EXISTS _sqljs_blob (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CHECK (id = 1)
    )
  `);
}

/**
 * Load the SQLite database blob from Postgres.
 * Returns null if no blob exists yet (fresh database).
 */
async function loadBlob(connUrl) {
  try {
    const rows = await neonQuery(connUrl, `SELECT data FROM _sqljs_blob WHERE id = 1`);
    if (rows.length > 0 && rows[0].data) {
      // Neon returns bytea as a hex string prefixed with \x
      const hex = rows[0].data;
      if (typeof hex === "string" && hex.startsWith("\\x")) {
        return Buffer.from(hex.slice(2), "hex");
      }
      // Could also be a Buffer/Uint8Array directly
      return Buffer.from(hex);
    }
  } catch (e) {
    // Table might not exist yet on first run
    if (!e.message?.includes("does not exist")) throw e;
  }
  return null;
}

/**
 * Save the SQLite database blob to Postgres.
 */
async function saveBlob(connUrl, data) {
  const hexStr = "\\x" + Buffer.from(data).toString("hex");
  await neonQuery(connUrl, `
    INSERT INTO _sqljs_blob (id, data, updated_at) VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
  `, [hexStr]);
}

export async function createVercelPgAdapter() {
  const connUrl = getNeonSql();
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

  // --- Debounced persistence to Postgres ---
  let dirty = false;
  let saveTimer = null;
  let savePromise = null;
  const SAVE_DEBOUNCE_MS = 500; // Slightly longer debounce for network saves

  async function persist() {
    try {
      const data = db.export();
      await saveBlob(connUrl, data);
      dirty = false;
      console.log("[DB][vercel-pg] Persisted to Postgres");
    } catch (e) {
      console.error("[DB][vercel-pg] Persist failed:", e.message);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        savePromise = persist().finally(() => { savePromise = null; });
      }
    }, SAVE_DEBOUNCE_MS);
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
      scheduleSave();
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
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    // Final sync persist before close
    if (dirty) {
      const data = db.export();
      // Fire-and-forget async save (best effort on shutdown)
      saveBlob(connUrl, data).catch(() => {});
    }
    db.close();
  }

  // Flush on shutdown
  const flush = () => {
    if (dirty) {
      try {
        const data = db.export();
        saveBlob(connUrl, data).catch(() => {});
      } catch {}
    }
  };
  process.on("beforeExit", flush);

  return { driver: "vercel-pg (sql.js→neon)", run, get, all, exec, transaction, close };
}
