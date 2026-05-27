import { NextRequest, NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import type { SearchResponse } from "../../../../server/search/types";
import { cleanQuery, rewriteQuery } from "../../../../server/search/query-rewrite";

const DAEMON_HINT = "Search is unavailable. Start the daemon: npm run dev:daemon";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rawQ = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const q = cleanQuery(rawQ);
  const scope = req.nextUrl.searchParams.get("scope") ?? "all";
  const limit = req.nextUrl.searchParams.get("limit") ?? "50";
  const cabinet = req.nextUrl.searchParams.get("cabinet") ?? "";

  const empty: SearchResponse = {
    query: q,
    scope: scope as SearchResponse["scope"],
    pages: [],
    agents: [],
    tasks: [],
    tookMs: 0,
    indexReady: false,
  };

  if (!q) {
    return NextResponse.json(empty);
  }

  try {
    const token = await getOrCreateDaemonToken();
    const cabinetParam = cabinet
      ? `&cabinet=${encodeURIComponent(cabinet)}`
      : "";
    const url = `${getDaemonUrl()}/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}&limit=${encodeURIComponent(limit)}${cabinetParam}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { ...empty, error: `Daemon returned ${res.status}`, hint: DAEMON_HINT },
        { status: 503 }
      );
    }

    const data = (await res.json()) as SearchResponse;

    // Fallback: try query rewrite if no page results
    if (data.pages.length === 0) {
      const rewritten = rewriteQuery(q);
      if (rewritten && rewritten !== q) {
        const retryUrl = `${getDaemonUrl()}/search?q=${encodeURIComponent(rewritten)}&scope=${encodeURIComponent(scope)}&limit=${encodeURIComponent(limit)}${cabinetParam}`;
        const retryRes = await fetch(retryUrl, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });

        if (retryRes.ok) {
          const retryData = (await retryRes.json()) as SearchResponse;
          if (retryData.pages.length > 0) {
            return NextResponse.json({ ...retryData, rewritten: true });
          }
        }
      }
    }

    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json(
      { ...empty, error: message, hint: DAEMON_HINT },
      { status: 503 }
    );
  }
}
