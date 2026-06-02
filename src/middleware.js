import { NextResponse } from "next/server";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};

// Edge-compatible middleware for Vercel
export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Protect /api/ settings and sensitive routes by requiring JWT
  const PROTECTED_API = [
    "/api/settings", "/api/keys", "/api/providers", "/api/provider-nodes",
    "/api/proxy-pools", "/api/combos", "/api/usage", "/api/oauth", "/api/cloud",
    "/api/tunnel", "/api/mcp", "/api/cli-tools"
  ];

  if (PROTECTED_API.some(p => pathname.startsWith(p))) {
    const token = request.cookies.get("auth_token")?.value;
    if (!token || !(await verifyDashboardAuthToken(token))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Protect /dashboard
  if (pathname.startsWith("/dashboard")) {
    const token = request.cookies.get("auth_token")?.value;
    if (!token || !(await verifyDashboardAuthToken(token))) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  // Redirect / to /dashboard
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
