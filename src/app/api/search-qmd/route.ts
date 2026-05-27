import { NextRequest, NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import type { SearchResponse } from "../../../../server/search/types";
import { cleanQuery, rewriteQuery } from "../../../../server/search/query-rewrite";

const DAEMON_HINT = "Search is unavailable. Start the daemon: npm run dev:daemon";

function emptyResponse(q: string): SearchResponse {
  return {
    query: q,
    scope: "all",
    pages: [],
    agents: [],
    tasks: [],
    tookMs: 0,
    indexReady: false,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rawQ = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const q = cleanQuery(rawQ);
  const collection = req.nextUrl.searchParams.get("collection") || "cabinet";
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "10", 10);
  const minScore = parseFloat(req.nextUrl.searchParams.get("minScore") || "0");
  const explain = req.nextUrl.searchParams.get("explain") === "true";
  const rerank = req.nextUrl.searchParams.get("rerank") === "true";
  const cabinet = req.nextUrl.searchParams.get("cabinet") ?? "";

  if (!q) {
    return NextResponse.json({ mode: "qmd", ...emptyResponse(q) });
  }

  try {
    const token = await getOrCreateDaemonToken();
    const daemonUrl = new URL(`${getDaemonUrl()}/search-qmd`);
    daemonUrl.searchParams.set("q", q);
    daemonUrl.searchParams.set("collection", collection);
    daemonUrl.searchParams.set("limit", String(limit));
    daemonUrl.searchParams.set("minScore", String(minScore));
    if (explain) daemonUrl.searchParams.set("explain", "true");
    if (rerank) daemonUrl.searchParams.set("rerank", "true");
    if (cabinet) daemonUrl.searchParams.set("cabinet", cabinet);

    const response = await fetch(daemonUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { mode: "qmd", ...emptyResponse(q), error: `Daemon returned ${response.status}`, hint: DAEMON_HINT },
        { status: 503 }
      );
    }

    const data = await response.json();

    // QMD unavailable — fall back to FlexSearch via /api/search
    if (data.available === false) {
      const fallbackUrl = new URL(`${getDaemonUrl()}/search`);
      fallbackUrl.searchParams.set("q", q);
      fallbackUrl.searchParams.set("scope", "all");
      fallbackUrl.searchParams.set("limit", String(limit));
      if (cabinet) fallbackUrl.searchParams.set("cabinet", cabinet);

      const fallbackResponse = await fetch(fallbackUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });

      if (!fallbackResponse.ok) {
        return NextResponse.json(
          { mode: "flexsearch-fallback", ...emptyResponse(q), error: `Fallback daemon returned ${fallbackResponse.status}`, hint: DAEMON_HINT },
          { status: 503 }
        );
      }

      const fallbackData = await fallbackResponse.json() as SearchResponse;
      return NextResponse.json({ mode: "flexsearch-fallback", available: false, ...fallbackData });
    }

    // Fallback: try query rewrite if no page results
    const pageCount = Array.isArray(data.pages) ? data.pages.length : 0;
    if (pageCount === 0) {
      const rewritten = rewriteQuery(q);
      if (rewritten && rewritten !== q) {
        const retryUrl = new URL(`${getDaemonUrl()}/search-qmd`);
        retryUrl.searchParams.set("q", rewritten);
        retryUrl.searchParams.set("collection", collection);
        retryUrl.searchParams.set("limit", String(limit));
        retryUrl.searchParams.set("minScore", String(minScore));
        if (explain) retryUrl.searchParams.set("explain", "true");
        if (rerank) retryUrl.searchParams.set("rerank", "true");
        if (cabinet) retryUrl.searchParams.set("cabinet", cabinet);

        const retryResponse = await fetch(retryUrl.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });

        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          const retryPageCount = Array.isArray(retryData.pages) ? retryData.pages.length : 0;
          if (retryPageCount > 0) {
            return NextResponse.json({ mode: "qmd+rewritten", rewritten: true, ...retryData });
          }
        }
      }
    }

    return NextResponse.json({ mode: "qmd", ...data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json(
      { mode: "qmd", ...emptyResponse(q), error: message, hint: DAEMON_HINT },
      { status: 503 }
    );
  }
}
