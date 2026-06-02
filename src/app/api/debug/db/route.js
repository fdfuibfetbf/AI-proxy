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
    neonTest: { error: null, step: null },
  };

  // Test Neon adapter directly to see what fails
  try {
    info.neonTest.step = "importing neonPgAdapter";
    const { createVercelPgAdapter } = await import("@/lib/db/adapters/neonPgAdapter.js");
    
    info.neonTest.step = "calling createVercelPgAdapter";
    const adapter = await createVercelPgAdapter();
    
    info.neonTest.step = "adapter created";
    info.neonTest.driver = adapter.driver;
    
    // Test write to neon
    info.neonTest.step = "testing write";
    adapter.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["_debug", "neon_test", JSON.stringify({ ts: Date.now() })]
    );
    
    info.neonTest.step = "flushing";
    if (adapter.flush) await adapter.flush();
    
    info.neonTest.step = "testing read";
    const row = adapter.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, ["_debug", "neon_test"]);
    info.neonTest.readResult = row ? row.value : "NO ROW";
    
    info.neonTest.step = "all done - SUCCESS";
  } catch (e) {
    info.neonTest.error = `${e.message}\n${e.stack?.split("\n").slice(0, 5).join("\n")}`;
  }

  // Also show current adapter
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    info.db.driver = adapter.driver;
  } catch (e) {
    info.db.error = e.message;
  }

  return NextResponse.json(info, { status: 200 });
}
