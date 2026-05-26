# QMD + Cabinet Integration Plan

> Integrate [QMD](https://github.com/tobi/qmd) — a local hybrid search engine (BM25 + vector + LLM reranking) — into Cabinet as both an MCP tool for agents and a server-side search API for the UI.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Phase 0: Prerequisites](#phase-0-prerequisites)
- [Phase 1: MCP Catalog Entry](#phase-1-mcp-catalog-entry)
- [Phase 2: QMD Search Service in Daemon](#phase-2-qmd-search-service-in-daemon)
- [Phase 3: API Route for UI Search](#phase-3-api-route-for-ui-search)
- [Phase 4: Frontend Wiring](#phase-4-frontend-wiring)
- [Phase 5: Automation & Polish](#phase-5-automation--polish)
- [File Manifest](#file-manifest)
- [Decision Log](#decision-log)
- [Risks & Mitigations](#risks--mitigations)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Cabinet + QMD                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Browser (UI Search)                                  Agent (Claude Code)  │
│       │                                                   │                 │
│       ▼                                                   │                 │
│  ┌──────────┐                                             │                 │
│  │  Next.js │   ── HTTP ──►  ┌─────────────────┐         │                 │
│  │ (Port 4000)│              │    Daemon        │         │                 │
│  └──────────┘               │  (Port 4100)     │         │                 │
│       │                      │                  │         │                 │
│       │                      │  ┌────────────┐  │         │                 │
│       └──► /api/search-qmd  ──►  │ QMD Store   │  │         │                 │
│                                │  │  (SDK)      │  │         │                 │
│                                │  └────────────┘  │         │                 │
│                                │  ┌────────────┐  │         │                 │
│                                │  │ FlexSearch  │  │  (fallback)             │
│                                │  └────────────┘  │         │                 │
│                                └─────────────────┘         │                 │
│                                                             │                 │
│                                ┌─────────────────┐         │                 │
│                                │  ~/.claude.json  │         │                 │
│                                │  mcpServers:     │         │                 │
│                                │   cabinet-qmd:   ├── MCP ──┤                 │
│                                │    command: qmd  │         │                 │
│                                │    args: [mcp]   │         │                 │
│                                └────────┬────────┘         │                 │
│                                         │                  │                 │
│                                          └► qmd mcp ────────┘                │
│                                              (stdio)                          │
│                                         ▲                                     │
│                                         │                                     │
│                                ┌────────┴────────┐                           │
│                                │  ~/.cache/qmd/  │                           │
│                                │  index.sqlite   │                           │
│                                │  (FTS5 + vec)   │                           │
│                                └─────────────────┘                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Two integration paths:**

1. **Agent tooling (MCP)** — QMD's MCP server (`qmd mcp`) connected to CLI configs. Agents get native tools: `query`, `get`, `multi_get`, `status`.
2. **UI search (API)** — QMD's Node.js SDK embedded in the daemon process, proxied through Next.js API routes. The Cabinet search UI gets semantic + reranked results.

---

## Phase 0: Prerequisites

### 0.1 Install QMD

```bash
# Install globally via npm (works regardless of bun PATH)
npm install -g @tobilu/qmd

# Verify
qmd --version
```

**Why npm vs bun:** QMD was previously installed via bun (`~/.bun/bin/qmd`), but the wrapper script requires bun on PATH. Installing via npm avoids this dependency since `pkg/bin` entry points are self-contained Node.js scripts.

If npm global install is problematic, add `~/.bun/bin` to PATH in `.cabinet.env`:
```
PATH=/home/likkmrl/.bun/bin:$PATH
```

### 0.2 Index Cabinet's Data

```bash
# Add the full data/ directory as a QMD collection
qmd collection add ~/cabinet/data --name cabinet --mask "**/*.md"

# Add context so results carry meaningful metadata
qmd context add qmd://cabinet "Cabinet knowledge base — user notes, documentation, agent configs, conversations"
qmd context add qmd://cabinet/.global-agents "Global agent persona definitions"
qmd context add qmd://cabinet/.agents "Per-cabinet agent configs and conversations"
qmd context add qmd://cabinet/.home "Home/dashboard pages"

# Generate vector embeddings (auto-downloads GGUF models)
qmd embed

# Verify
qmd status
qmd search "getting started" -n 3
```

### 0.3 Verify MCP Server Works

```bash
# Quick smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | qmd mcp

# OR start HTTP mode and test
qmd mcp --http --port 8181 &
curl -X POST http://localhost:8181/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
kill %1
```

Expected response includes tools: `query`, `get`, `multi_get`, `status`.

### 0.4 Add QMD to PATH in Daemon Spawn Env

The daemon spawns CLIs as subprocesses. If `qmd` isn't on the subprocess PATH, the MCP server won't launch. Ensure `qmd` is accessible in the daemon's spawn environment:

**File: `src/lib/runtime/cabinet-env.ts`**
- Option A: Add `PATH` entry pointing to npm global bin dir
- Option B: Use full path in MCP entry (`/home/likkmrl/.npm-global/bin/qmd` or `which qmd`)

Check: `which qmd` should output a path. Use that in the catalog entry `command` field if not in default PATH.

---

## Phase 1: MCP Catalog Entry

### Overview

Add QMD as a `CatalogEntry` in Cabinet's MCP catalog, following the same pattern as Slack, Google Workspace, and Discord. When a user "connects" QMD in Settings → Integrations, Cabinet writes a `cabinet-qmd` server entry into the selected CLI configs (`~/.claude.json`, etc.). When an agent runs, the CLI auto-connects to QMD's stdio MCP server, giving the agent four search tools.

### 1.1 Add `"none"` Auth Backend (Schema Change)

QMD is a local tool with no authentication. The current `AuthBackend` type doesn't support a no-auth option — `"token"` implies a credential input in the UI. We need to add `"none"`:

**File: `src/lib/agents/mcp-catalog.ts`**

```diff
- export type AuthBackend = "cli-pkce" | "user-app" | "token" | "cabinet-broker";
+ export type AuthBackend = "cli-pkce" | "user-app" | "token" | "cabinet-broker" | "none";
```

Then update the config writer and UI to handle `"none"`:
- `mcp-config-writer.ts`: `buildServerEntry()` should not inject `serverEnv` for `"none"` auth (there are no secrets)
- The Settings → Integrations UI should show "Connected" without requiring credential input

### 1.2 Add QMD CatalogEntry

**File: `src/lib/agents/mcp-catalog.ts`**

Add to the `MCP_CATALOG` array:

```typescript
const QMD: CatalogEntry = {
  id: "qmd",
  label: "QMD Search",
  blurb: "Semantic + keyword search across your local knowledge base with LLM reranking.",
  iconSlug: "search",
  bgImage: "/integrations/qmd-bg.webp",
  logo: "/integrations/qmd-logo.png",
  sourceUrl: "https://github.com/tobi/qmd",
  trustTier: "community",
  authBackend: "none",
  transport: "stdio",
  mcpServerName: "cabinet-qmd",
  command: "qmd",
  args: ["mcp"],
  credentials: [],
  actions: [
    "Hybrid search (BM25 + vector + LLM reranking) across indexed documents",
    "Retrieve a single document by path or docid with fuzzy-match suggestions",
    "Batch retrieve documents by glob pattern or docid list",
    "Check index health and collection status",
  ],
  setupSteps: [
    {
      title: "Install QMD",
      body: "Run `npm install -g @tobilu/qmd` to install the on-device search engine.",
      href: "https://github.com/tobi/qmd",
    },
    {
      title: "Index your knowledge base",
      body: "Run `qmd collection add ~/cabinet/data --name cabinet --mask \"**/*.md\"` then `qmd embed` to generate vector embeddings for semantic search.",
    },
    {
      title: "Verify it works",
      body: "Run `qmd search \"getting started\" -n 3` to confirm your index is live.",
    },
  ],
};
```

Then export it:

```diff
- export const MCP_CATALOG: CatalogEntry[] = [SLACK, GOOGLE_WORKSPACE, DISCORD];
+ export const MCP_CATALOG: CatalogEntry[] = [SLACK, GOOGLE_WORKSPACE, DISCORD, QMD];
```

### 1.3 Handle `"none"` in Config Writer

**File: `src/lib/agents/mcp-config-writer.ts`**

The `buildServerEntry()` function should work fine for stdio without env vars — it just produces `{ command: "qmd", args: ["mcp"] }`. No `env` block needed.

For the Connect UI flow: when `authBackend === "none"`, the connect button should skip credential collection and write the entry directly. Check the integration UI component for how it handles credential steps.

### 1.4 Integration UI Assets

Create or source:
- `public/integrations/qmd-bg.webp` — banner background (dark gradient or abstract search-themed)
- `public/integrations/qmd-logo.svg` or `.png` — QMD logo (the GitHub repo uses a simple "QMD" text logo; could use `lucide` search icon as fallback)

Since QMD doesn't have official branding assets, use a generic search-themed graphic. The `iconSlug: "search"` points to a lucide icon as UI fallback.

### 1.5 Config Writer for QMD

No changes needed to `mcp-config-writer.ts` for the basic case. The existing `writeEntry()` handles:
- stdio transport → `writeServerEntry` with `command` + `args`
- `"none"` auth → no env vars to inject
- Atomic write to CLI configs

However, the UI's "Connect" flow may need a tweak:

**Files:**
- `src/components/settings/integrations-hub-section.tsx` — update `needsCreds` check (line ~412):
  ```diff
  - const needsCreds = item.authBackend === "token" || item.authBackend === "user-app";
  + const needsCreds = item.authBackend === "token" || item.authBackend === "user-app";
  + const skipCreds = item.authBackend === "none";
  ```
  When `skipCreds` is true: don't show credential input fields, change Connect button to say "Connect" (not "Connect & sign in"), and on click call the connect endpoint with empty credentials.
- `src/app/api/agents/config/mcp-catalog/connect/route.ts` — in the POST handler, when `authBackend === "none"`, skip credential validation and persist step, call `writeEntry()` directly.
- `src/app/api/agents/config/mcp-catalog/test/route.ts` — for `"none"` backends, return `{ ok: true, status: "no-auth" }` instead of calling service-specific test logic.

### Verification

```bash
# After connecting in the UI, check the config
cat ~/.claude.json
# Should contain:
# "mcpServers": {
#   "cabinet-qmd": {
#     "command": "qmd",
#     "args": ["mcp"]
#   }
# }

# Start an agent conversation — the CLI should connect to QMD automatically
# Try asking: "search the knowledge base for authentication patterns"
```

---

## Phase 2: QMD Search Service in Daemon

### Overview

Embed the QMD SDK (`@tobilu/qmd`) in Cabinet's daemon process so the server-side can perform searches without spawning a subprocess. This powers the UI search upgrade.

### 2.1 Create QMD Store Wrapper

**New file: `server/search/qmd-search.ts`**

An eagerly-initialized singleton that wraps QMD's `createStore()`. Initialized once at daemon startup — all callers check the store synchronously (no async, no race condition):

```typescript
import { createStore, type QMDStore, type SearchOptions, type HybridQueryResult } from "@tobilu/qmd";
import path from "path";
import { homedir } from "os";

const QMD_DB_PATH = path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
  "qmd",
  "index.sqlite"
);

let store: QMDStore | null = null;

export async function initQmdStore(): Promise<boolean> {
  try {
    store = await createStore({ dbPath: QMD_DB_PATH });
    return true;
  } catch (err) {
    console.warn("[qmd] Failed to open store:", err);
    store = null;
    return false;
  }
}

export function getQmdStore(): QMDStore | null {
  return store;
}

export async function searchQmd(opts: {
  query: string;
  collection?: string;
  limit?: number;
  minScore?: number;
  explain?: boolean;
  // LLM reranking is opt-in — adds 2-5s latency
  rerank?: boolean;
}): Promise<HybridQueryResult[] | { error: string }> {
  if (!store) return { error: "QMD store not available" };

  return store.search({
    query: opts.query,
    collection: opts.collection,
    limit: opts.limit ?? 10,
    minScore: opts.minScore ?? 0,
    rerank: opts.rerank ?? false,
    explain: opts.explain,
  });
}

export async function getQmdDocument(pathOrId: string) {
  if (!store) return { error: "QMD store not available" };
  return store.get(pathOrId);
}

export async function multiGetQmd(pattern: string, options?: { maxBytes?: number }) {
  if (!store) return { error: "QMD store not available" };
  return store.multiGet(pattern, options);
}

export async function closeQmdStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}
```

### 2.2 Wire QMD Search in Daemon

The daemon imports the functional API from `qmd-search.ts` directly. No class needed — the existing `runSearch()` function in `search-service.ts` is also a standalone function, so this maintains consistency.

**Imports in `server/cabinet-daemon.ts`:**

```typescript
import { searchQmd, initQmdStore, getQmdStore, closeQmdStore } from "./search/qmd-search";
```

### 2.3 Daemon Endpoint

**File: `server/cabinet-daemon.ts`**

Add a new HTTP endpoint:

```
GET /search-qmd?q=...&mode=query&collection=cabinet&limit=10&minScore=0.3&explain=true
```

Response:

```json
{
  "available": true,
  "results": [
    {
      "path": "docs/auth.md",
      "title": "Authentication Guide",
      "docid": "#a1b2c3",
      "score": 0.87,
      "snippet": "...",
      "context": "Cabinet knowledge base"
    }
  ],
  "total": 15
}
```

If QMD store isn't available, return `{ "available": false, "fallback": "flexsearch" }` so the API route can fall through to the existing FlexSearch endpoint.

The daemon uses raw `http.createServer()` with manual routing. The new endpoints follow the existing pattern at lines ~1796-1836:

```typescript
// In the HTTP request handler, after existing search route:
// GET /search-qmd
if (pathname === "/search-qmd") {
  const q = parsedUrl.query?.q || "";
  const collection = (parsedUrl.query?.collection as string) || "cabinet";
  const limit = parseInt(parsedUrl.query?.limit as string) || 10;
  const minScore = parseFloat(parsedUrl.query?.minScore as string) || 0;
  const explain = parsedUrl.query?.explain === "true";
  const rerank = parsedUrl.query?.rerank === "true";

  if (!q) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
    return;
  }

  try {
    const results = await searchQmd({ query: q, collection, limit, minScore, explain, rerank });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      available: true,
      results,
    }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
  return;
}

// GET /search-qmd/status
if (pathname === "/search-qmd/status") {
  const store = getQmdStore();
  if (store) {
    const status = await store.getStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: true, ...status }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: false }));
  }
  return;
}

// POST /search-qmd/reindex — use SDK methods, not execSync (non-blocking)
if (pathname === "/search-qmd/reindex" && req.method === "POST") {
  if (isEmbedding) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Re-index already in progress" }));
    return;
  }
  isEmbedding = true;
  // Run in background — don't await
  (async () => {
    try {
      const store = getQmdStore();
      if (store) {
        const result = await store.update({ collections: ["cabinet"] });
        if (result.needsEmbedding > 0) {
          await store.embed({ collection: "cabinet" });
        }
      }
    } finally {
      isEmbedding = false;
    }
  })();
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "started" }));
  return;
}
```

### 2.4 Daemon Lifecycle

**File: `server/cabinet-daemon.ts`**

On daemon startup, init QMD store eagerly (not lazy — avoids race conditions):

```typescript
// During daemon startup, after bootstrapSearchIndex():
import { initQmdStore, getQmdStore, closeQmdStore } from "./search/qmd-search";

// Eager init — fail fast, callers check store synchronously
const qmdReady = await initQmdStore();
if (qmdReady) {
  const store = getQmdStore()!;
  console.log("[qmd] Store initialized");
} else {
  console.warn("[qmd] Store not available — QMD search disabled");
}

// On daemon shutdown
process.on("SIGTERM", async () => {
  await closeQmdStore();
  // ...
});
```

### 2.5 Add `@tobilu/qmd` Dependency

```bash
# In the Cabinet project root
npm install @tobilu/qmd
```

Note: `@tobilu/qmd` pulls in `node-llama-cpp` as a transitive dependency, which downloads GGUF models on first use. This adds ~2GB of downloads. Consider making it an optional dependency so `npm install` doesn't fail if the user opts out.

**File: `package.json`**

```json
{
  "optionalDependencies": {
    "@tobilu/qmd": "^2.5.2"
  }
}
```

### 2.6 Environment Variable for GPU Control

Add to `.env.local` (or `.cabinet.env`):

```
# QMD: Force CPU mode (disable GPU for llama.cpp)
QMD_FORCE_CPU=true

# Or specify GPU backend
# QMD_LLAMA_GPU=metal    # macOS
# QMD_LLAMA_GPU=cuda     # NVIDIA
# QMD_LLAMA_GPU=vulkan   # Cross-platform
```

---

## Phase 3: API Route for UI Search

### Overview

A Next.js API route that proxies search requests from the browser to the daemon's QMD search endpoint, with the existing FlexSearch as fallback.

### 3.1 Create API Route

**New file: `src/app/api/search-qmd/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-client";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  const collection = searchParams.get("collection") || "cabinet";
  const limit = parseInt(searchParams.get("limit") || "10", 10);
  const minScore = parseFloat(searchParams.get("minScore") || "0");
  const explain = searchParams.get("explain") === "true";
  const rerank = searchParams.get("rerank") === "true";

  if (!q) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }

  try {
    const daemonUrl = new URL(`${getDaemonUrl()}/search-qmd`);
    daemonUrl.searchParams.set("q", q);
    daemonUrl.searchParams.set("collection", collection);
    daemonUrl.searchParams.set("limit", String(limit));
    daemonUrl.searchParams.set("minScore", String(minScore));
    if (explain) daemonUrl.searchParams.set("explain", "true");
    if (rerank) daemonUrl.searchParams.set("rerank", "true");

    const token = await getOrCreateDaemonToken();
    const response = await fetch(daemonUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();

    // If QMD is not available, fall back to FlexSearch
    if (data.available === false) {
      const fallbackUrl = new URL(`${getDaemonUrl()}/search`);
      fallbackUrl.searchParams.set("q", q);
      fallbackUrl.searchParams.set("scope", collection);
      fallbackUrl.searchParams.set("limit", String(limit));
      const fallbackResponse = await fetch(fallbackUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      const fallbackData = await fallbackResponse.json();
      return NextResponse.json({ mode: "flexsearch-fallback", ...fallbackData });
    }

    return NextResponse.json({ mode: "qmd", ...data });
  } catch (err) {
    return NextResponse.json(
      { error: "Search service unavailable", detail: String(err) },
      { status: 503 }
    );
  }
}
```

**Why proxy via daemon:** The Next.js dev server (port 4000) restarts frequently. Loading QMD models in the Next.js process would cause repeated model loading/unloading. The daemon is long-lived, so models stay loaded.

### 3.3 Result Normalization Layer

**New file: `server/search/qmd-normalize.ts`**

QMD returns `HybridQueryResult[]` (document paths, scores, snippets). The existing UI expects `SearchResponse` with `PageHit[]`, `AgentHit[]`, `TaskHit[]`. This layer converts QMD results to the existing shape.

- QMD only searches files (pages) — agents and tasks stay on FlexSearch
- Both result sets merge into one `SearchResponse` so the frontend sees a single shape
- Room scoping: filter QMD results by path prefix matching the active room/cabinet

```typescript
import type { HybridQueryResult } from "@tobilu/qmd";
import type { SearchResponse, PageHit, SearchMatch } from "./types";

const SNIPPET_RADIUS = 60;

export function normalizeQmdResults(
  qmdResults: HybridQueryResult[],
  query: string,
  roomPrefix?: string,
): Pick<SearchResponse, "pages" | "tookMs"> {
  const pages: PageHit[] = [];

  for (const doc of qmdResults) {
    // Room scoping: skip results outside the active room
    if (roomPrefix && !doc.path.startsWith(roomPrefix)) {
      continue;
    }

    const matches: SearchMatch[] = makeMatches(doc.snippet || "", query, doc.score);
    pages.push({
      id: doc.docid || doc.path,
      title: doc.title || doc.path.split("/").pop() || doc.path,
      path: doc.path,
      icon: undefined,
      tags: [],
      modified: undefined,
      matchCount: matches.length,
      matches,
      matchedFields: ["body"],
    });
  }

  return { pages, tookMs: 0 };
}

function makeMatches(snippet: string, query: string, score: number): SearchMatch[] {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return [{ line: 1, column: 1, length: 1, context: snippet.slice(0, 200), score }];
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(snippet.length, idx + query.length + SNIPPET_RADIUS);
  return [{
    line: 1,
    column: idx - start + 1,
    length: query.length,
    context: snippet.slice(start, end),
    score,
  }];
}
```

### 3.4 Merge with FlexSearch Results

In the daemon's `/search-qmd` endpoint (or a new `/api/search-qmd` handler), after getting QMD results for pages, also fetch FlexSearch results for agents and tasks:

```typescript
// In the daemon endpoint handler:
const qmdResults = await searchQmd({ query: q, collection });
const { pages } = normalizeQmdResults(qmdResults.results, q, activeCabinet);

// Get agents + tasks from FlexSearch
const flexSearchResults = runSearch(sources, q, "all", limit, activeCabinet);

return {
  available: true,
  results: {
    pages,        // from QMD
    agents: flexSearchResults.agents,  // from FlexSearch
    tasks: flexSearchResults.tasks,    // from FlexSearch
  },
  total: pages.length + flexSearchResults.pages.length,
};
```

---

## Phase 4: Frontend Wiring

### 4.1 Search Mode Toggle

In the search component, add a mode selector:

```
┌────────────┬──────────────┬─────────┐
│  Keyword   │  Semantic    │  Deep   │
│  (instant) │  (<500ms)    │  (2-5s) │
└────────────┴──────────────┴─────────┘
```

- **Keyword Search**: Uses existing `/api/search` → FlexSearch (instant, <50ms, no models)
- **Semantic Search (QMD)**: Uses `/api/search-qmd` → QMD hybrid search (`rerank=false`, <500ms, BM25 + vector)
- **Deep Search (QMD)**: Uses `/api/search-qmd?rerank=true` → QMD hybrid + LLM reranking (2-5s, best quality)
- Default: Keyword Search (fast), with a toggle to switch to semantic/deep

### 4.2 Index Health Indicator

Show in the search UI footer or as a tooltip:

```
QMD: 142 docs · 3 collections · Indexed 2 days ago
[Re-index] [Manage collections]
```

### 4.3 Re-index Button

Calls a daemon endpoint (non-blocking, uses SDK methods):

```
POST /search-qmd/reindex
```

The daemon endpoint calls `store.update()` and then `store.embed()` via the SDK (not shell exec):
- Returns `202 Accepted` immediately (re-index runs in background)
- If a re-index is already in progress, returns `409 Conflict`
- Uses an `isEmbedding` concurrency guard flag
- See Phase 2.3 endpoint code for the full handler

Progress feedback is optional but recommended: stream progress via WebSocket using `store.update({ onProgress })` and `store.embed({ onProgress })` callbacks.

### 4.4 Search Settings Section

Add a new settings section for QMD configuration (separate from the Integrations Hub):

**New file or section in `src/components/settings/`**

```
┌─────────────────────────────────────────┐
│  Search                                 │
│                                         │
│  Default search mode: [Keyword ▼]       │
│  Enable deep search (reranking)  [☐]    │
│  GPU backend: [Auto ▼]                  │
│  ┌─────────────────────────────────┐    │
│  │ QMD: 142 docs · 3 collections   │    │
│  │ Indexed 2 days ago              │    │
│  │ [Re-index]                      │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

This is separate from the Integrations Hub (which handles agent MCP tooling). The settings section handles user-facing search configuration.

### 4.5 Integrations Page Updates

The existing Settings → Integrations page (`src/components/integrations/`) should:
- Show QMD in the integrations list (already happens automatically from `MCP_CATALOG`)
- "Connect" button writes the MCP entry to CLI configs
- "Disconnect" button removes it
- Status indicator: "Connected" when `~/.claude.json` has `cabinet-qmd` entry

Check: `connectedProvidersForEntry()` in `mcp-config-writer.ts` handles this already.

---

## Phase 5: Automation & Polish

### 5.1 Auto Re-index on File Changes

**File: `server/search/watcher.ts`**

Extend the existing chokidar file watcher to also trigger QMD re-index:

```typescript
// In the daemon, after the chokidar watcher callback:
let debounceTimer: NodeJS.Timeout | null = null;
let isEmbedding = false;

watcher.on("change", async (filePath) => {
  // Existing FlexSearch update...
  
  // Debounce QMD re-index (30s)
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const store = getQmdStore();
    if (!store) return;

    // Skip embed if one is already running (concurrency guard)
    if (isEmbedding) return;
    isEmbedding = true;

    try {
      const result = await store.update({ collections: ["cabinet"] });
      // Only embed if there are documents needing vector generation
      if (result.needsEmbedding > 0) {
        await store.embed({ collection: "cabinet" });
      }
    } finally {
      isEmbedding = false;
    }
  }, 30_000);
});
```

**Batching**: 30-second debounce prevents re-indexing on every keystroke. Embed runs only when `needsEmbedding > 0`. Concurrency guard (`isEmbedding`) prevents overlapping embed runs.

### 5.2 CLI One-liner for Setup

A Cabinet CLI command or script to automate Phase 0:

```bash
# scripts/setup-qmd.sh
#!/bin/bash
npm install -g @tobilu/qmd
qmd collection add ~/cabinet/data --name cabinet --mask "**/*.md"
qmd context add qmd://cabinet "Cabinet knowledge base"
qmd embed
echo "QMD setup complete."
```

### 5.3 Health Check in Daemon

The daemon's `/health` endpoint should include QMD status:

```json
{
  "status": "ok",
  "qmd": {
    "available": true,
    "collections": 1,
    "documents": 142,
    "lastIndexed": "2026-05-24T12:00:00Z"
  }
}
```

### 5.4 MCP HTTP Mode Option

For advanced setups, offer HTTP MCP mode to share model loading across multiple CLI instances:

```bash
# Start QMD as a long-lived HTTP MCP server alongside the daemon
qmd mcp --http --port 8181 --daemon

# Point CLI config at the shared server
# ~/.claude.json:
# "mcpServers": {
#   "cabinet-qmd": {
#     "type": "http",
#     "url": "http://localhost:8181/mcp"
#   }
# }
```

This is an advanced option — not needed for the basic setup, but useful for power users running multiple agents simultaneously (avoids loading models N times).

---

## File Manifest

| # | File | Action | Status | Description |
|---|------|--------|--------|-------------|
| 1 | `src/lib/agents/mcp-catalog.ts` | Modify | **DONE** | Add `"none"` to `AuthBackend` type, add QMD CatalogEntry |
| 2 | `src/lib/agents/mcp-config-writer.ts` | Verify | **DONE** (no changes needed) | `"none"` auth already handled (no env injection for undefined serverEnv) |
| 3 | `src/components/settings/integrations-hub-section.tsx` | Modify | **DONE** | Update `CatalogItem.authBackend` type to include `"none"` |
| 4 | `src/app/api/agents/config/mcp-catalog/test/route.ts` | Modify | **DONE** | Early return for `"none"` auth backends |
| 5 | `server/search/qmd-search.ts` | **Create** | **DONE** | QMD SDK wrapper (eager init, hybrid-only API, ESM imports) |
| 6 | `server/search/qmd-normalize.ts` | **Create** | **DONE** | Result normalization layer: QMD → `PageHit[]` with room scoping |
| 7 | `server/cabinet-daemon.ts` | Modify | **DONE** | Add `/search-qmd`, `/search-qmd/status`, `/search-qmd/reindex` endpoints; QMD lifecycle hooks (eager init, shutdown); health check |
| 8 | `src/app/api/search-qmd/route.ts` | **Create** | **PENDING** | API route proxying to daemon (uses `getDaemonUrl()` + auth token), with FlexSearch fallback |
| 9 | `public/integrations/qmd-bg.webp` | **Create** | **PENDING** | Banner image for integrations page |
| 10 | `public/integrations/qmd-logo.svg` | **Create** | **PENDING** | Logo for integrations page |
| 11 | `package.json` | Modify | **DONE** | Add `@tobilu/qmd` as optional dependency |
| 12 | `server/search/watcher.ts` | Modify | **PENDING** | Add QMD re-index on file changes (30s debounced update + conditional embed, concurrency guard) |
| 13 | `scripts/setup-qmd.sh` | **Create** | **PENDING** | One-liner setup script |
| 14 | `src/components/search/search-palette.tsx` | Modify | **PENDING** | Add QMD search mode toggle (keyword/semantic/deep) + rerank opt-in |
| 15 | `src/stores/search-store.ts` | Modify | **PENDING** | Add QMD search state and API call alongside existing FlexSearch |
| 16 | `src/components/settings/` | **Create** (new section) | **PENDING** | Add search settings section (semantic toggle, rerank toggle, GPU control) |
| 17 | `test/qmd-search.test.ts` | **Create** | **PENDING** | Full test suite: store init, search, fallback, API route, auth flow |

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-25 | MCP catalog entry as primary agent integration | Fits existing `mcp-catalog.ts` → `mcp-config-writer.ts` pattern. Agents get native tools without shell commands. |
| 2026-05-25 | QMD SDK in daemon (not Next.js) for search API | Models load once in the long-lived daemon. Next.js dev server restarts would cause repeated model loading. |
| 2026-05-25 | `"none"` auth backend type for local tools | QMD is local-only, no OAuth or tokens. Existing `AuthBackend` types all imply some credential flow. |
| 2026-05-25 | Index full `data/` directory | Maximum search coverage. Users can narrow results by collection when searching. |
| 2026-05-25 | Optional dependency | QMD's GGUF model downloads (~2GB) shouldn't be mandatory. Users opt in by running the setup. |
| 2026-05-25 | FlexSearch as fallback | QMD may not be installed. The existing search should keep working. |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| QMD not installed on new machines | High | Agents and UI can't use QMD | FlexSearch fallback; clear setup instructions in catalog entry; optional dependency |
| GGUF model downloads fail or are slow | Medium | `qmd embed` fails | Users can pre-download models; `QMD_FORCE_CPU` fallback; error messages guide users |
| `node-llama-cpp` native compilation fails on WSL | Medium | QMD install fails | Use `--ignore-scripts` or install pre-built binaries; fall back to CPU mode |
| QMD MCP process crashes in CLI subprocess | Low | Agent loses search tools | CLI auto-restarts MCP processes; agents detect tool failure and retry |
| QMD index out of sync with `data/` | Medium | Stale search results | Auto re-index via chokidar watcher (debounced); manual "Re-index" button |
| VRAM contention (QMD models + LLM models) | Low | OOM on GPU | QMD models are small (~2GB total). Use `QMD_FORCE_CPU=true` to run on CPU. |
| `"none"` auth backend breaks existing UI flows | Medium | Integration page errors | Test the connect/disconnect flow for `"none"` credentials. The connect endpoint needs a code path that skips credential validation. |
| QMD SDK `createStore()` throws at daemon startup | Low | Daemon fails to start | Lazy init with try/catch; daemon starts without QMD; graceful fallback |

### Environment-Specific Notes

**WSL (Windows Subsystem for Linux):**
- `node-llama-cpp` GPU support on WSL uses CUDA via the Windows GPU. If `nvidia-smi` is available, GPU should work.
- CPU mode (`QMD_FORCE_CPU=1`) is more reliable on WSL if GPU passthrough is not configured.
- QMD file paths need to use WSL paths (e.g., `/home/likkmrl/cabinet/data/`), not Windows paths.
- The MCP subprocess runs inside WSL, so `qmd mcp` uses WSL's filesystem and PATH.

**macOS:**
- GPU via Metal works out of the box (`QMD_LLAMA_GPU=metal`).
- QMD's `brew install sqlite` may be needed for FTS5 extension support.

**Linux (native):**
- GPU via CUDA or Vulkan.
- Standard Linux dependencies.

---

## Implementation Order

### Phase Ordering

```
Lane A (UI)                     Lane B (Server)
──────                         ──────
Phase 1: MCP catalog + auth   Phase 2: QMD SDK + daemon
↓                              ↓
  [wait for Lane B Phase 3]   Phase 3: API route + normalization
↓                              ↓
Phase 4: Frontend wiring       Phase 5: Automation
```

**Progress as of 2026-05-25:**

1. ~~**Phase 1.1–1.2** — Add `"none"` auth + QMD catalog entry + UI flow~~ **DONE**
2. ~~**Phase 2.1–2.4** — QMD SDK wrapper + daemon endpoints + normalization~~ **DONE**
3. **[NEXT] Phase 3.1, 3.3–3.4** — API route + normalization + FlexSearch merge (code change, ~30 min)
4. **[AFTER] Phase 0.1–0.2** — Install QMD, index data (manual, 5 min) — can also be done now
5. **[AFTER] Phase 0.3** — Verify MCP works with an agent conversation (test, ~10 min)
6. **[AFTER] Phase 4.1–4.4** — Frontend wiring (search toggle, health indicator, re-index button, search settings) (code change, ~30 min)
7. **[AFTER] Phase 5.1–5.4** — Automation (auto re-index, setup script, health check) (code change, ~30 min)
8. **[AFTER] T10** — Test suite (test/qmd-search.test.ts) (code change, ~30 min)

**Remaining estimated time: ~1.5 hours**

### Debug Logging Added (2026-05-25)

| # | File | What it logs |
|---|------|-------------|
| L1 | `server/search/qmd-search.ts:24` | DB path, all `QMD_*` env vars (GPU, model overrides), store init success/fail |
| L2 | `server/search/qmd-search.ts:47` | Search query (truncated 80 chars), rerank flag, limit, collection, timing, result count, warning if empty |
| L3 | `server/cabinet-daemon.ts:1861` | Incoming `/search-qmd` request, QMD vs fallback decision, raw vs normalized counts, sample QMD file paths if all filtered by roomPrefix |
| L4 | `node_modules/@tobilu/qmd/dist/llm.js:406` | LlamaCpp constructor: embed/generate/rerank model URIs, cache dir, context size, CUDA env |
| L5 | `node_modules/@tobilu/qmd/dist/llm.js:748` | `ensureGenerateModel()`: URI resolution + download timing, model load timing, GPU status |
| L6 | `node_modules/@tobilu/qmd/dist/llm.js:1127` | `expandQuery()` catch: error message, generate model URI, stack trace (first 2 lines) |

All logs use `[qmd]`, `[qmd-daemon]`, or `[qmd-llm]` prefixes for easy grep filtering.

---

## Learnings (from implementation)

| # | Learning | Context |
|---|----------|---------|
| 1 | **QMD global CLI is a Windows binary** | On WSL, `which qmd` points to `/mnt/c/Users/.../npm/qmd` which is a Windows PE binary (`invalid ELF header` when it tries to load `better_sqlite3.node`). The Node.js SDK (`@tobilu/qmd`) imported directly in the daemon works fine — the SDK's `createStore()` loads its own native module from `node_modules/better-sqlite3/build/Release/better_sqlite3.node` which is the Linux build. |
| 2 | **`available: false` signal was swallowed** | The API route (`/api/search-qmd`) called the daemon, got `available: false`, fell back to FlexSearch, but returned `{ mode: "flexsearch-fallback", ...fallbackData }` **without** `available: false`. The frontend `performSearch()` checks `data.available === false` in its setQmdAvailable logic, so it never learned QMD was down — all QMD-unavailable signals were silently converted to "QMD is fine" responses. |
| 3 | **No proactive QMD health check existed** | `qmdAvailable` in the search store defaults to `false` and was only ever set to `true` after a successful QMD search. There was no `checkQmdAvailability()` call on palette open or mode switch — the user had to submit a query first. Fixed by adding a `__status_check__` query via `useEffect` on mount/mode change. |
| 4 | **QMD result paths are virtual (`qmd://` scheme)** | QMD returns `file` as `qmd://cabinet/onlyonly-studio/.../index.md`. The frontend's `selectPage(path)` expects cabinet-relative paths like `onlyonly-studio/.../index.md`. The normalize function now strips the `qmd://{collection}/` prefix via `toCabinetPath()`. |
| 5 | **Index persists in SQLite — no config needed at daemon init** | QMD collections are stored in `index.sqlite` at `~/.cache/qmd/`. Once created via a setup script, the daemon's `createStore({ dbPath })` (without passing `config.collections`) reopens the existing database and the collections + documents are all still there. No need to pass config on restart. |
| 6 | **SDK `createStore()` does not download models** | GGUF models are only downloaded lazily on the first `store.embed()` call. `createStore()` just opens the SQLite file (fast, <50ms). `store.update()` scans files and writes chunks (fast, <500ms for 26 files). `store.embed()` is the slow step (minutes, including model download). Suitable for eager init at daemon startup. |
| 7 | **FlexSearch fallback must return `indexReady`** | The `SearchResponse` type includes `indexReady` which the frontend uses to show/hide an "Indexing…" spinner. The fallback response in the API route needed to include this field to avoid a persistent spinner. |
| 8 | **Health endpoint returned `available: true` before data was indexed** | The daemon's init logs `QMD search: available` as long as `createStore()` succeeds — even if the database has 0 documents. Added `getQmdStatus()` call after init to surface `totalDocuments`, `hasVectorIndex`, and `needsEmbedding` in the startup output. |
| 9 | **Daemon auth applies to all non-health endpoints** | The daemon requires a bearer token for all routes except `/health`. The Next.js API route uses `getOrCreateDaemonToken()` to get the token and passes it via `Authorization: Bearer ${token}` header. Direct curl to `/search-qmd` fails with `401 Unauthorized`. |
| 10 | **Room scope filtering uses path prefix** | The daemon's QMD handler accepts a `cabinet` query param (room slug). This is used as a path-prefix filter in `normalizeQmdResults()` — results whose `file` doesn't start with the prefix are dropped. Works because QMD file paths start with the collection name (room slug). |
| 11 | **WSL dual-install: Windows PE binary shadows Linux build** | `npm install -g @tobilu/qmd` from Windows puts a PE binary at `C:/Users/.../npm/qmd`. Inside WSL, `which qmd` resolves to this Windows binary, causing `invalid ELF header` when it tries to load `better_sqlite3.node`. The WSL-native install (`npm install -g @tobilu/qmd` run inside WSL) puts the Linux ELF at `/home/likkmrl/.npm-global/bin/qmd`. The daemon's SDK path (`node_modules/@tobilu/qmd`) is the Linux build because it was `npm ci`'d from WSL. **Fix:** Run `npm install -g @tobilu/qmd` inside WSL, and ensure `/home/likkmrl/.npm-global/bin` is on PATH before any Windows-mounted paths. |
| 12 | **WSL npm global bin not on default PATH** | WSL's npm installs global bins to `~/.npm-global/bin/` which is not in the default WSL `$PATH`. Adding `export PATH="$HOME/.npm-global/bin:$PATH"` to `~/.bashrc` (or `.cabinet.env`) ensures `qmd` resolves to the Linux binary. The MCP catalog entry's `command: "qmd"` depends on this — otherwise agents can't launch the MCP server. |
| 13 | **Collection path must match filesystem** | QMD on Windows tried `C:/Users/likkmrl/cabinet/data` which doesn't exist (the cabinet data lives in WSL at `/home/likkmrl/cabinet/data`). The `qmd collection add` using a WSL-native QMD with WSL path works. The daemon's SDK init reopens the existing SQLite database — collections persist from setup. |
| 14 | **T5 (API route) and T7 (frontend toggle) already implemented** | `src/app/api/search-qmd/route.ts` exists with full daemon proxy + FlexSearch fallback. `search-palette.tsx` already has the 3-mode toggle (keyword/semantic/deep) with QMD availability indicator. These were listed as PENDING in the plan but are actually done. |
| 15 | **Comprehensive diagnostic script added** | `scripts/check-qmd.mjs` was rewritten from a basic SDK test into a comprehensive diagnostic that tests: environment, data dir, SDK init, index status, 5 search queries, rerank, daemon connectivity, file coverage, MCP config, and MCP server smoke test. Run with `wsl -d Ubuntu -- node scripts/check-qmd.mjs`. |
| 16 | **WSL bashrc early-return guard skips bottom-of-file PATH additions** | `~/.bashrc` has `case $- in *i*) ;; *) return;; esac` at the top that returns early for non-interactive shells. Any `export PATH=...` added at the end of the file is NEVER executed except in fully interactive sessions. The fix is to add PATH/exports BEFORE this guard. In this session, the npm-global and bun PATH lines were moved from line 120 (after the guard) to line 5-7 (before the guard). |
| 17 | **Daemon subprocesses use `ADAPTER_RUNTIME_PATH`, not bashrc** | The function `withAdapterRuntimeEnv()` in `src/lib/agents/adapters/utils.ts` overrides `PATH` with `ADAPTER_RUNTIME_PATH` for every daemon-spawned subprocess (agent adapters, PTY manager). The bashrc fix only helps manual CLI usage. To fix daemon-spawned agents, `~/.npm-global/bin` must be added to the `ADAPTER_RUNTIME_PATH` array directly. |
| 18 | **MCP server confirmed working with 4 tools** | `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | qmd mcp` returns `query` (hybrid BM25+vector+rerank), `get` (single doc), `multi_get` (glob batch), and `status` (index health). Exit code 0. The `query` tool has a rich schema supporting `lex`, `vec`, and `hyde` sub-query types with `collections`, `limit`, `minScore`, `rerank`, `candidateLimit`, and `intent` parameters. |
| 19 | **PowerShell quoting makes WSL shell tests error-prone** | When testing WSL commands from Windows PowerShell, `bash -c "..."` requires careful quote escaping (PowerShell's backtick `\`` doesn't help with nested quotes). Bash heredocs (`cat > script << 'EOF'`) also get mangled by PowerShell's parsing before reaching WSL. **Workaround:** Write test scripts to the WSL filesystem using the `write` tool, then execute them via `wsl -d Ubuntu -- bash -i -c "bash /path/to/script.sh"`. |
| 20 | **`bash -c` is non-interactive — doesn't source `~/.bashrc`** | Testing PATH changes with `wsl -d Ubuntu -- bash -c "which qmd"` shows the old PATH because `-c` is non-interactive and doesn't source bashrc at all. Must use `bash -i -c` (interactive) to test bashrc-sourced PATH changes. For daemon subprocess PATH fixes (`ADAPTER_RUNTIME_PATH`), test by inspecting the code or running a subprocess through the daemon — not via bash. |
| 21 | **`loadCabinetEnv()` skips keys already in `process.env` — can't override PATH** | Adding `PATH` to `.cabinet.env` won't work for fixing the daemon's PATH because `loadCabinetEnv()` has `if (typeof process.env[key] === "string" && process.env[key] !== "") continue;` — PATH is always set. The correct fix for daemon subprocesses is `ADAPTER_RUNTIME_PATH` in `utils.ts`, not `.cabinet.env`. |
| 22 | **`daemon never reads .env.local` — needs `.cabinet.env` for LLM config** | Next.js reads `.env.local` (next dev auto-loads it), but the daemon is a standalone Node.js process. GPU env vars (`QMD_LLAMA_GPU=cuda`, `NODE_LLAMA_CPP_GPU=cuda`) set in `.env.local` are invisible to the daemon. The daemon loads `.cabinet.env` via `loadCabinetEnv()` at startup. Any QMD LLM config must go in `.cabinet.env`, not `.env.local`. This is why GPU was never used despite being "configured". |
| 23 | **Room prefix filter silently dropped all results** | `server/search/qmd-normalize.ts:35` had `doc.file.startsWith(roomPrefix)` — but QMD file paths are `qmd://cabinet/...` virtual paths, not cabinet-relative paths. The fix: `toCabinetPath(doc.file).startsWith(roomPrefix)` strips the `qmd://{collection}/` prefix first. Without this, every room-scoped search returned 0 results while showing `available: true`, which was deeply confusing. |
| 24 | **`node-llama-cpp` LlamaGrammar `context: null` error crashes query expansion** | The `expandQuery()` function in `node_modules/@tobilu/qmd/dist/llm.js` calls `llama.createGrammar()` before having a valid model context, which throws `LlamaGrammar: context can't be null`. The call stack: `expandQuery()` → `ensureLlama()` (success) → `ensureGenerateModel()` (success) → `llama.createGrammar()` (uses a different API context) → crash. This is an upstream bug in `@tobilu/qmd` v2.5.x. Workaround: moved all setup code into the existing try/catch so the function gracefully falls back to the raw query. |
| 25 | **QMD's default generation model is 1.7B Q4_K_M — reasonable for GPU** | `DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf"` — 1.7B params at Q4_K_M quantization. LFM2-1.2B is smaller (~30% fewer params) with a different architecture (hybrid LFM not transformer). Both fit on RTX 3060 12GB VRAM easily alongside other models. |
| 26 | **`store.search()` hits expandQuery even for simple query — can't skip** | The QMD SDK's `hybridQuery()` in `store.js:3533` calls `expandQuery()` on every search call. Even with `rerank: false`, the expand call happens (unless BM25 has a "strong signal"). Query expansion may fail, but the error is caught and the search proceeds with the raw query. The embedding model path (BM25 + vector) doesn't need the generation model — only `rerank: true` and query expansion do. |
| 27 | **`ensureGenerateModel()` logs model resolution timing — critical for debugging** | Model loading is lazy (on first use). The default 1.7B GGUF model download is ~1.2GB over Hugging Face. Resolution (download) can take 10-60s on first call. Added logging in `llm.js:ensureGenerateModel()` to show: URI resolution, local path, download timing, model load timing, and GPU status. |
| 28 | **LFM2-1.2B model does NOT dodge the LlamaGrammar bug — same error, different message** | Switching from the default 1.7B model to LFM2-1.2B changed the error from `LlamaGrammar: context can't be null` to `The LlamaGrammar used by passed to this function was created with a different Llama instance than the one used by this sequence's model`. Both are the same root cause: `ensureLlama()` lacks a concurrency guard, allowing two concurrent calls to create separate `Llama` instances. The model gets loaded by instance A, but `this.llama` is overwritten with instance B, causing `grammar._llama !== model._llama`. LFM2 does not help. Reverted to default model. |
| 29 | **Three layers of fallback protect QMD search from failure** | Pipeline: (1) `searchQmd()` in qmd-search.ts catches errors and returns `{ error }` object (not throw). (2) Daemon `/search-qmd` handler checks `"error" in qmdResults` and falls back to FlexSearch. (3) The API route passes `available: false` signal to frontend. Each layer degrades gracefully without crashing. |
| 30 | **`ensureEmbedModel()` and `ensureGenerateModel()` are dimensioned for GPU parallel contexts** | The embed model creates up to 8 parallel contexts (25% of free VRAM, capped at 8). CPU mode uses half of math cores with at least 4 threads per context. The generation model creates a single bounded context (`expandContextSize`, default 2048 tokens). Reranker creates contexts of `RERANK_TARGET_DOCS_PER_CONTEXT` chunks. VRAM config is auto-computed from `getVramState()`. |
| 31 | **Debug logging is now comprehensive across the pipeline** | Added `[qmd]`, `[qmd-daemon]`, `[qmd-llm]` prefix logging at every stage: store init (env vars, db path, success/fail), search calls (query, rerank flag, timing, result count), daemon handler (QMD vs fallback decision, raw vs normalized count, sample file paths if filtered), LlamaCpp constructor (all 3 model URIs, cache dir, context size, GPU mode), model loading (URI, path, timing, GPU status), query expansion errors (model URI, error message, stack trace). |
| 32 | **Root cause: `ensureLlama()` race condition causes LlamaGrammar mismatch** | `expandQuery()` calls `const llama = await this.ensureLlama()` and then `llama.createGrammar()`. But `ensureLlama()` has no concurrency guard — two simultaneous calls can each resolve to a different `Llama` instance, and `this.llama` gets overwritten with the second one. Meanwhile, `ensureGenerateModel()` uses the first instance to load the model. Result: `grammar._llama !== this.generateModel._llama` — JavaScript object reference identity mismatch. Fixed by: (1) adding `llamaLoadPromise` concurrency guard to `ensureLlama()`, same pattern as `generateModelLoadPromise`, and (2) creating the grammar from `this.generateModel._llama` instead of `this.llama` so the grammar always matches the model regardless of any race. |
| 33 | **`.cabinet.env` must be at project root, not `data/`** | `loadCabinetEnv()` in `src/lib/runtime/cabinet-env.ts` resolves `.cabinet.env` from `PROJECT_ROOT` (`/home/likkmrl/cabinet/.cabinet.env`), not from `data/`. The `data/.cabinet.env` file we created earlier was never read by the daemon. `QMD_LLAMA_GPU=cuda` appeared to work because it was set in the root `.cabinet.env` file (from previous setup), but `QMD_GENERATE_MODEL` was only in `data/.cabinet.env` and was silently ignored. Moved all QMD env vars to the root file and deleted `data/.cabinet.env`. |
 
---

## Reference: QMD MCP Tool Surface

These are the tools that agents will see once QMD MCP is connected:

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `query` | Hybrid search (BM25 + vector + LLM reranking) | `query`, `collection`, `limit`, `minScore` |
| `get` | Retrieve a single document | `path` (fuzzy match), `fromLine`, `maxLines` |
| `multi_get` | Batch retrieve by glob or comma list | `pattern`, `maxBytes` |
| `status` | Index health and collection info | — |

**How agents use these:**
```
query("quarterly planning process")
  → 142 indexed docs from 3 collections
  → best results: 2025-Q4-planning.md (87%), annual-review.md (72%)
```

```
get("docs/auth.md")
  → Full document body with metadata
```

The tools are discovered automatically by the CLI via MCP protocol. No additional configuration needed.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN | 15 issues, 2 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 (all 15 decisions resolved)

**VERDICT:** ENG REVIEW ISSUES OPEN — 15 findings addressed, 2 critical gaps (room scoping, result normalization) flagged and resolved.

## IMPLEMENTATION STATUS (2026-05-25)

**Phase 1 (MCP Catalog):** DONE — AuthBackend type, QMD CatalogEntry, integration UI handling
**Phase 2 (Server Search):** DONE — SDK wrapper, daemon endpoints, normalization layer, lifecycle hooks
**Phase 3 (API Route):** DONE — `/api/search-qmd` proxy with FlexSearch fallback, `/api/search-qmd/status`, `/api/search-qmd/reindex`
**Phase 4 (Frontend):** DONE — search palette 3-mode toggle (keyword/semantic/deep), QMD availability indicator, health check on mount
**Phase 5 (Automation):** PENDING — watcher.ts QMD auto-index, search settings section, full test suite

### Review Findings Summary

| # | Section | Finding | Resolution |
|---|---------|---------|------------|
| D1 | Architecture | Daemon endpoint uses Express-style code; codebase uses raw HTTP | Rewrite to raw HTTP style |
| D2 | Architecture | QMD Store singleton has race condition; failed init never retries | Eager init at startup with graceful fallback |
| D3 | Architecture | execSync for re-index blocks daemon event loop (30+ seconds) | Use SDK store.update() + store.embed() |
| D4 | Architecture | API route hardcodes localhost:4100; no auth token | Use getDaemonUrl() + getOrCreateDaemonToken() |
| D5 | Architecture | "none" auth needs explicit UI flow changes (not specified) | Add code changes to integrations-hub-section.tsx and connect endpoint |
| D6 | Architecture | Plan proposes SearchService class that doesn't exist | Use functional pattern — export qmdSearch() from qmd-search.ts |
| D7 | Code Quality | require("os") instead of ESM imports | Use import { homedir } from 'os' |
| D8 | Code Quality | Three search modes with different return types | Hybrid-only API (store.search()); FlexSearch handles keyword |
| D9 | Code Quality | Auto re-index calls update() but not embed(); vectors go stale | Smart debounced update + conditional embed |
| D10 | Tests | Zero test coverage for 22 code paths | Full test suite in test/qmd-search.test.ts |
| D11 | Performance | LLM reranking adds 2-5s latency per query | Default rerank: false; opt-in via query param |
| D12 | Performance | Auto embed() could consume CPU/GPU during active use | Background embed with concurrency guard |
| D13 | Outside Voice | Room scoping absent — QMD results cross room boundaries | Path-prefix filtering on results |
| D14 | Outside Voice | QMD result shape doesn't match SearchResponse; agent/task search lost | Normalization layer: QMD → PageHit[], FlexSearch for agents/tasks |
| D15 | Outside Voice | MCP catalog is wrong UI for local tool | Both: catalog entry for agent MCP + settings section for user config |

### Additional Design Notes (from outside voice)

- **Concurrent MCP processes:** Multiple agent sessions spawn multiple `qmd mcp` processes. Each loads embedding models (~2GB). Mitigated by QMD's lazy model loading and HTTP MCP mode (Phase 5.4) for power users.
- **2GB model download UX:** First `qmd embed` downloads GGUF models. Add progress indicator using embed()'s `onProgress` callback, streamed via WebSocket.
- **File path correction:** `src/lib/search/qmd-search.ts` → `server/search/qmd-search.ts` to match existing search code location.
- **data/ ignore rules:** Define which paths QMD should exclude (conversation transcripts, .jobs/ yaml, .agents/ configs). Use QMD collection `ignore` patterns.

### NOT in scope

- Per-room QMD collections (path-prefix filtering is sufficient)
- QMD search for agents/tasks (FlexSearch handles these entity types)
- Refactor of search-service.ts to a class (functional pattern is fine)
- QMD HTTP MCP mode as default (Phase 5.4 is advanced/optional)
- Unified search result ranking across FlexSearch + QMD (they run separately)

### What already exists

| Capability | Existing code | Plan reuses? |
|-----------|--------------|-------------|
| FlexSearch keyword search | `server/search/index-builder.ts` + `search-service.ts` | Yes — fallback for QMD unavailability + agent/task results |
| MCP catalog + config writer | `src/lib/agents/mcp-catalog.ts` + `mcp-config-writer.ts` | Yes — QMD added as catalog entry |
| Daemon HTTP routing | `server/cabinet-daemon.ts` (raw http.createServer) | Yes — new endpoint follows existing pattern |
| Search API proxy | `src/app/api/search/route.ts` | Yes — new route follows same daemonFetch pattern |
| File watcher | `server/search/watcher.ts` (chokidar) | Yes — extended with QMD re-index callback |
| Search UI palette | `src/components/search/search-palette.tsx` | Yes — extended with mode toggle + QMD display |
| Integration hub | `src/components/settings/integrations-hub-section.tsx` | Yes — QMD added with "none" auth flow |

### Failure modes

| Codepath | Failure mode | Test covers? | Error handling? | User sees? |
|----------|-------------|-------------|-----------------|-----------|
| QMD store init | SQLite DB locked / native module crash | Planned | try/catch → store=null | "QMD search unavailable" badge |
| QMD search | Store is null | Planned | Returns error object | FlexSearch fallback |
| QMD search | Query timeout (>10s) | Planned | AbortSignal timeout | Loading indicator → fallback |
| API route | Daemon unreachable | Planned | 503 with hint | "Start the daemon" message |
| Re-index embed | GPU OOM | No | try/catch, QMD_FORCE_CPU fallback | Error toast |
| Room scoping | Path-prefix filter misses edge case | No | None — open gap | Cross-room results (security) |
| MCP process | qmd not on PATH | No | CLI auto-restarts MCP | Agent loses search tools |
| Connect flow | "none" auth not handled by UI | Planned | Needs code change in UI | Connect button disabled or stuck |

**Critical gaps:** Room scoping (D13 resolved), result normalization (D14 resolved)

### Parallelization strategy

| Step | Modules touched | Status |
|------|----------------|--------|
| Phase 1: MCP catalog + auth | src/lib/agents/, src/components/settings/ | **DONE** |
| Phase 2: QMD SDK + daemon | server/search/, server/cabinet-daemon.ts | **DONE** |
| Phase 3: API route | src/app/api/ | **DONE** — all 3 routes exist |
| Phase 4: Frontend | src/components/search/, src/stores/ | **DONE** — toggle + health check |
| Phase 5: Automation | server/search/watcher.ts, scripts/ | **PENDING** |

All code phases are done. T12 (WSL PATH fix) also done. Remaining work is Phase 5 (auto-index, settings section, test suite, polish).

### Implementation Status

| Task | Status | Notes |
|------|--------|-------|
| Phase 0 (install QMD) | **DONE** (WSL) | `npm install -g @tobilu/qmd` run inside WSL at `/home/likkmrl/.npm-global/bin/qmd`. 26 docs indexed, 61 vectors embedded, daemon detects on startup. **CAUTION:** Windows npm global install shadows the Linux binary — run from WSL only. |
| T1 — mcp-catalog | **DONE** | Added `"none"` to AuthBackend, QMD CatalogEntry in `MCP_CATALOG` |
| T2 — integrations UI | **DONE** | Updated `CatalogItem.authBackend` type; test route handles `"none"` early return |
| T3 — server search | **DONE** | Created `server/search/qmd-search.ts` (eager init, hybrid-only API, graceful fallback) |
| T4 — daemon endpoints | **DONE** | Added `GET /search-qmd`, `GET /search-qmd/status`, `POST /search-qmd/reindex`; QMD lifecycle in startup/shutdown; health check integration |
| T5 — API route | **DONE** | `src/app/api/search-qmd/route.ts` — proxy to daemon with FlexSearch fallback. Status + reindex sub-routes also exist. |
| T6 — normalization | **DONE** | Created `server/search/qmd-normalize.ts` (QMD → PageHit[] with room scoping) |
| T7 — frontend search toggle | **DONE** | Search palette has 3-mode toggle (keyword/semantic/deep), QMD availability indicator, health check on mount/store switch |
| T8 — watcher | **PENDING** | Auto re-index on file changes (debounced 30s) — no QMD integration in `server/search/watcher.ts` yet |
| T9 — search settings | **PENDING** | Settings section for QMD config (default mode, rerank toggle, GPU control) |
| T10 — tests | **PENDING** | `test/qmd-search.test.ts` covers normalization only; need full coverage (store init, search, fallback, API route, auth flow) |
| T11 — polish | **PENDING** | `scripts/setup-qmd.sh` exists but may not handle WSL paths correctly. `public/integrations/qmd-bg.webp` missing. `scripts/check-qmd.mjs` rewritten as comprehensive diagnostic. |
| T12 — WSL PATH fix | **DONE** | Fixed WSL `~/.bashrc` to prepend `$HOME/.npm-global/bin` and `$BUN_INSTALL/bin` to PATH before the early-return guard. Added `~/.npm-global/bin` to `ADAPTER_RUNTIME_PATH` in `utils.ts` for daemon subprocesses. MCP server verified working with `qmd mcp`. |

### Implementation Tasks

- [x] **T1 (P1)** — mcp-catalog — Add "none" to AuthBackend type + QMD CatalogEntry
  - Files: src/lib/agents/mcp-catalog.ts
  - Verify: TypeScript compiles, MCP_CATALOG includes QMD entry
- [x] **T2 (P1)** — integrations UI — Handle "none" auth in connect/disconnect flow
  - Files: src/components/settings/integrations-hub-section.tsx, src/app/api/agents/config/mcp-catalog/test/route.ts
  - Note: connect/route.ts already handles "none" auth correctly (credential persistence guarded by "token"/"user-app" check)
- [x] **T3 (P1)** — server search — Create QMD SDK wrapper with eager init
  - Files: server/search/qmd-search.ts
  - Verify: Store inits at daemon startup, searchQmd() returns HybridQueryResult[], store=null on failure
- [x] **T4 (P1)** — daemon — Add /search-qmd and /search-qmd/status endpoints in raw HTTP style
  - Files: server/cabinet-daemon.ts
  - Also added: /search-qmd/reindex (POST, concurrency-guarded), health check integration, lifecycle hooks
- [x] **T5 (P1)** — API route — Create /api/search-qmd with daemon proxy + FlexSearch fallback
  - Files: src/app/api/search-qmd/route.ts (also status/+ reindex sub-routes)
  - Verify: API returns results, falls back to FlexSearch when QMD unavailable, 503 when daemon down
- [x] **T6 (P1)** — normalization — Create result mapping layer (QMD → SearchResponse) with room scoping
  - Files: server/search/qmd-normalize.ts
  - Verify: QMD results render in search palette with correct line matches, room-scoped
- [x] **T7 (P2)** — frontend — Search mode toggle + QMD display in search palette
  - Files: src/components/search/search-palette.tsx, src/stores/search-store.ts
  - Verify: Toggle switches between keyword/semantic/deep search, scores display correctly
- [ ] **T8 (P2)** — watcher — Smart debounced update+embed with concurrency guard
  - Files: server/search/watcher.ts
  - Verify: File changes trigger update+embed (debounced), concurrent embed calls are skipped
- [ ] **T9 (P2)** — settings — Add search settings section for QMD configuration
  - Files: src/components/settings/ (new section)
  - Verify: Search settings show semantic toggle, rerank toggle, GPU settings
- [ ] **T10 (P2)** — tests — Full test suite for QMD integration
  - Files: test/qmd-search.test.ts
  - Verify: npm test passes, covers store init, search, fallback, API route, auth flow
- [ ] **T11 (P3)** — polish — Health check, setup script, UI assets
  - Files: scripts/setup-qmd.sh, public/integrations/qmd-*
  - Note: Health check already done in T4
