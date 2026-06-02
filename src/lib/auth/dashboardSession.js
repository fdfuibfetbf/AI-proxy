import { SignJWT, jwtVerify } from "jose";

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  
  // Skip fs on Edge / Vercel
  if (typeof process !== "undefined" && (process.env.NEXT_RUNTIME === "edge" || process.env.VERCEL)) {
    return "9router-default-jwt-secret-override-via-env";
  }

  try {
    // Dynamic require to prevent Edge bundle failures
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    
    // Instead of using os.homedir() which causes NFT bundling errors on Windows,
    // we use a relative path `.9router` in the project root, or `/tmp` on read-only systems.
    const dir = path.join(process.cwd(), ".9router");
    
    const file = path.join(dir, "jwt-secret");
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {}
    fs.mkdirSync(dir, { recursive: true });
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return generated;
  } catch {
    return "9router-default-jwt-secret-fallback";
  }
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}
