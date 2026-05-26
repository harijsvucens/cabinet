import { NextRequest, NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import type { PageHit, SearchResponse } from "../../../../../server/search/types";

type SearchMode = "semantic" | "keyword" | "hybrid";
type OutputFormat = "json" | "markdown" | "md";

interface PageHitWithScore extends PageHit {
  snippet?: string;
}

const RRF_K = 60;

interface KBSearchParams {
  q: string;
  mode: SearchMode;
  format: OutputFormat;
  topK: number;
  rerank: boolean;
  cabinet: string;
  intent: string;
}

function parseParams(req: NextRequest): KBSearchParams {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const mode = (req.nextUrl.searchParams.get("mode") ?? "hybrid") as SearchMode;
  const format = (req.nextUrl.searchParams.get("format") ?? "json") as OutputFormat;
  const topK = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("topK") || "10", 10) || 10, 1), 50);
  const rerank = req.nextUrl.searchParams.get("rerank") !== "false";
  const cabinet = req.nextUrl.searchParams.get("cabinet") ?? "";
  const intent = req.nextUrl.searchParams.get("intent") ?? "";
  return { q, mode, format, topK, rerank, cabinet, intent };
}

async function daemonFetch(path: string, params: Record<string, string>, timeoutMs = 15_000): Promise<Response> {
  const token = await getOrCreateDaemonToken();
  const url = new URL(`${getDaemonUrl()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  return fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function searchSemantic(params: KBSearchParams): Promise<{ pages: PageHitWithScore[]; tookMs: number; mode: string }> {
  try {
    const res = await daemonFetch("/search-qmd", {
      q: params.q,
      collection: "cabinet",
      limit: String(params.topK),
      rerank: String(params.rerank),
      cabinet: params.cabinet,
      intent: params.intent,
    });
    if (!res.ok) throw new Error(`Daemon returned ${res.status}`);
    const data = await res.json();

    if (data.available === false || data.error) {
      throw new Error(data.error || "QMD unavailable");
    }

    return {
      pages: data.pages || [],
      tookMs: data.tookMs || 0,
      mode: "semantic",
    };
  } catch {
    return { pages: [], tookMs: 0, mode: "semantic" };
  }
}

async function searchKeyword(params: KBSearchParams): Promise<{ pages: PageHitWithScore[]; tookMs: number; mode: string }> {
  try {
    const res = await daemonFetch("/search", {
      q: params.q,
      scope: "pages",
      limit: String(params.topK),
      cabinet: params.cabinet,
    }, 5_000);
    if (!res.ok) throw new Error(`Daemon returned ${res.status}`);
    const data = (await res.json()) as SearchResponse;
    return {
      pages: data.pages || [],
      tookMs: data.tookMs || 0,
      mode: "keyword",
    };
  } catch {
    return { pages: [], tookMs: 0, mode: "keyword" };
  }
}

function rrfScore(rank: number, k: number = RRF_K): number {
  return 1 / (k + rank);
}

async function searchHybrid(params: KBSearchParams): Promise<{ pages: PageHitWithScore[]; tookMs: number; mode: string }> {
  const fetchCount = Math.min(params.topK * 3, 50);

  const [semantic, keyword] = await Promise.all([
    searchSemantic({ ...params, topK: fetchCount }),
    searchKeyword({ ...params, topK: fetchCount }),
  ]);

  const semanticPages = semantic.pages;
  const keywordPages = keyword.pages;

  const rrf = new Map<string, { page: PageHitWithScore; score: number }>();

  for (let i = 0; i < semanticPages.length; i++) {
    const p = semanticPages[i];
    if (!rrf.has(p.path)) {
      rrf.set(p.path, { page: p, score: 0 });
    }
    rrf.get(p.path)!.score += rrfScore(i);
  }

  for (let i = 0; i < keywordPages.length; i++) {
    const p = keywordPages[i];
    if (!rrf.has(p.path)) {
      rrf.set(p.path, { page: p, score: 0 });
    }
    rrf.get(p.path)!.score += rrfScore(i);
  }

  const merged = Array.from(rrf.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, params.topK)
    .map((entry) => {
      entry.page.score = entry.score;
      return entry.page;
    });

  return {
    pages: merged,
    tookMs: semantic.tookMs + keyword.tookMs,
    mode: "hybrid",
  };
}

function formatMarkdown(pages: PageHitWithScore[], query: string, mode: string, tookMs: number): string {
  const lines: string[] = [
    `## KB Search: "${query}"`,
    `**Mode**: ${mode} | **Results**: ${pages.length} | **Time**: ${tookMs}ms`,
    "",
  ];

  if (pages.length === 0) {
    lines.push("_No results found._");
    lines.push("");
    lines.push("Try rephrasing your query or using broader terms. You may also want to:");
    lines.push("- Check the file tree for relevant directories");
    lines.push("- Use `grep` for exact string matches");
    lines.push("- Browse `/data` to explore the knowledge base structure");
    return lines.join("\n");
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const idx = i + 1;
    lines.push(`### ${idx}. ${page.title}`);
    lines.push(`**Path**: \`${page.path}\`${page.score != null ? ` | **Score**: ${page.score.toFixed(3)}` : ""}${page.modified ? ` | **Modified**: ${page.modified}` : ""}`);
    if (page.tags && page.tags.length > 0) {
      lines.push(`**Tags**: ${page.tags.join(", ")}`);
    }

    const snippet = page.snippet || (page.matches?.[0]?.context || "");
    if (snippet) {
      lines.push("");
      lines.push(`> ${snippet.replace(/\n/g, " ").slice(0, 300)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = parseParams(req);

  if (!params.q) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }

  let result: { pages: PageHitWithScore[]; tookMs: number; mode: string };

  switch (params.mode) {
    case "semantic":
      result = await searchSemantic(params);
      break;
    case "keyword":
      result = await searchKeyword(params);
      break;
    case "hybrid":
    default:
      result = await searchHybrid(params);
      break;
  }

  // Auto-retry with default intent when results are weak and no intent was specified
  if (!params.intent) {
    const topScore = result.pages[0]?.score ?? 0;
    const weakResults = result.pages.length === 0
      || (params.mode === "semantic" && topScore > 0 && topScore < 0.3);

    if (weakResults) {
      const retryResult = params.mode === "keyword"
        ? result
        : await (params.mode === "semantic"
          ? searchSemantic({ ...params, intent: "hardware+engineering+failure+modes" })
          : searchHybrid({ ...params, intent: "hardware+engineering+failure+modes" }));

      if (retryResult.pages.length > result.pages.length) {
        result = retryResult;
      }
    }
  }

  if (params.format === "markdown" || params.format === "md") {
    const md = formatMarkdown(result.pages, params.q, result.mode, result.tookMs);
    return new NextResponse(md, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json({
    query: params.q,
    mode: result.mode,
    resultCount: result.pages.length,
    tookMs: result.tookMs,
    results: result.pages.map((p) => ({
      title: p.title,
      path: p.path,
      score: p.score,
      tags: p.tags,
      modified: p.modified,
      snippet: p.snippet || p.matches?.[0]?.context || "",
    })),
  });
}
