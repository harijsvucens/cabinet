import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  KB_AUTH_COOKIE,
  expectedToken,
  isAuthEnabled,
  timingSafeEqualHex,
} from "@/lib/auth/kb-auth";

// ---------------------------------------------------------------------------
// Cabinet Cloud gate (CABINET_CLOUD=1)
// ---------------------------------------------------------------------------
// In the hosted, multi-tenant edition each tenant is a container fronted by a
// host agent that already authorizes requests. This gate is defense-in-depth:
// the app ITSELF verifies the Supabase access token the panel issued, so a
// request that somehow reaches the container without a valid session is denied
// here too. Verification is a signature check against the Supabase JWKS
// (ES256), so no shared secret lives in the container.
//
// This path is entirely separate from the local/desktop KB_PASSWORD gate below
// and only runs when CABINET_CLOUD === "1"; every other deployment keeps the
// existing behavior untouched.

/** Cookie the panel sets on `.runcabinet.com` (Supabase ES256 access token). */
const CABINET_JWT_COOKIE = "cabinet_jwt";

// A remote JWK set caches keys and rate-limits refetches internally, so build
// it ONCE per JWKS URL and reuse it across requests (rebuilding per request
// would defeat jose's caching and hammer the auth server). Memoized on the URL
// so an env change (e.g. in tests) still rebuilds.
let jwksMemo: {
  url: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
} | null = null;

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksMemo && jwksMemo.url === url) return jwksMemo.jwks;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksMemo = { url, jwks };
  return jwks;
}

/**
 * Verify the `cabinet_jwt` cookie and return the token subject (the Supabase
 * user id), or null when the token is missing/invalid/expired or the gate is
 * misconfigured (no JWKS URL). Pinning `algorithms: ["ES256"]` blocks
 * algorithm-confusion attacks (`alg: none`, HS256-with-public-key). jose also
 * enforces `exp`/`nbf`, so expired sessions fail closed here.
 */
async function cloudUserSub(req: NextRequest): Promise<string | null> {
  const jwksUrl = process.env.CABINET_JWT_JWKS_URL;
  if (!jwksUrl) return null; // Not configured -> deny (fail closed).

  const token = req.cookies.get(CABINET_JWT_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
      algorithms: ["ES256"],
    });
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

async function cloudProxy(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // Liveness/readiness probes must answer without a user session so the host
  // agent / orchestrator can tell a booting container from a dead one.
  if (pathname.startsWith("/api/health")) {
    return NextResponse.next();
  }

  const sub = await cloudUserSub(req);

  if (!sub) {
    // API routes get a machine-readable 401.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Pages bounce to the panel's login (a different origin). Resolve relative
    // to the request so a relative override still works; fail closed with a 401
    // if no login URL is configured rather than looping or leaking the app.
    const loginUrl = process.env.CABINET_CLOUD_LOGIN_URL;
    if (loginUrl) {
      return NextResponse.redirect(new URL(loginUrl, req.url));
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated: hand the verified subject to downstream handlers. Build the
  // forwarded headers from the incoming ones and OVERWRITE any client-supplied
  // `x-cabinet-user` (Headers.set replaces), so the value can only ever come
  // from a verified token — never spoofed by the caller.
  const headers = new Headers(req.headers);
  headers.set("x-cabinet-user", sub);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(req: NextRequest) {
  // Hosted edition: Supabase-JWT gate, independent of the KB_PASSWORD path.
  if (process.env.CABINET_CLOUD === "1") {
    return cloudProxy(req);
  }

  // Auth disabled — no password set
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // Allow login page and login API
  if (pathname === "/login" || pathname === "/api/auth/login" || pathname === "/api/auth/check") {
    return NextResponse.next();
  }

  // Allow health check
  if (pathname.startsWith("/api/health")) {
    return NextResponse.next();
  }

  // Check auth cookie (constant-time; expected token is memoized so this is
  // O(1) per request — PBKDF2 runs once per process, not per request).
  const token = req.cookies.get(KB_AUTH_COOKIE)?.value ?? "";
  const expected = await expectedToken();

  if (!timingSafeEqualHex(token, expected)) {
    // API routes return 401
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Pages redirect to login
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect all routes except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
