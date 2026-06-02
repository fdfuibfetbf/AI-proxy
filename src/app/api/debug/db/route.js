import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const info = {
    timestamp: new Date().toISOString(),
    env: {
      VERCEL: !!process.env.VERCEL,
      POSTGRES_URL: process.env.POSTGRES_URL ? "SET (" + process.env.POSTGRES_URL.substring(0, 20) + "...)" : "NOT SET",
      DATABASE_URL: process.env.DATABASE_URL ? "SET (" + process.env.DATABASE_URL.substring(0, 20) + "...)" : "NOT SET",
    },
    db: { driver: null, error: null, testWrite: null, testRead: null },
  };

  try {
    const { getAdapter, flushDb } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    info.db.driver = adapter.driver;

    // Test write
    try {
      adapter.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        ["_debug", "test", JSON.stringify({ ts: Date.now() })]
      );
      if (adapter.flush) await adapter.flush();
      info.db.testWrite = "OK";
    } catch (e) {
      info.db.testWrite = `FAIL: ${e.message}`;
    }

    // Test read
    try {
      const row = adapter.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["_debug", "test"]);
      info.db.testRead = row ? `OK: ${row.value}` : "NO ROW";
    } catch (e) {
      info.db.testRead = `FAIL: ${e.message}`;
    }
  } catch (e) {
    info.db.error = e.message;
  }

  return NextResponse.json(info, { status: 200 });
}
