import type { QMDStore, SearchOptions, HybridQueryResult, DocumentResult, DocumentNotFound, UpdateResult, EmbedResult, IndexStatus } from "@tobilu/qmd";
import path from "path";
import { homedir } from "os";

type QmdModule = typeof import("@tobilu/qmd");

const DEFAULT_QMD_DB = path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
  "qmd",
  "index.sqlite"
);

let store: QMDStore | null = null;
let qmdModule: QmdModule | null = null;

async function ensureModule(): Promise<QmdModule> {
  if (!qmdModule) {
    qmdModule = await import("@tobilu/qmd") as QmdModule;
  }
  return qmdModule;
}

export async function initQmdStore(): Promise<boolean> {
  try {
    const mod = await ensureModule();
    const dbPath = process.env.QMD_DB_PATH || DEFAULT_QMD_DB;
    console.log(`[qmd] Initializing store (dbPath=${dbPath})`);
    console.log(`[qmd] Env: QMD_LLAMA_GPU=${process.env.QMD_LLAMA_GPU || "not set"}, CI=${process.env.CI || "not set"}`);
    console.log(`[qmd] Env: QMD_GENERATE_MODEL=${process.env.QMD_GENERATE_MODEL || "not set (using default)"}`);
    console.log(`[qmd] Env: QMD_EMBED_MODEL=${process.env.QMD_EMBED_MODEL || "not set (using default)"}`);
    console.log(`[qmd] Env: QMD_RERANK_MODEL=${process.env.QMD_RERANK_MODEL || "not set (using default)"}`);
    store = await mod.createStore({ dbPath });
    console.log(`[qmd] Store initialized successfully`);
    return true;
  } catch (err) {
    console.warn("[qmd] QMD store not available:", err instanceof Error ? err.message : err);
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
  rerank?: boolean;
  explain?: boolean;
  intent?: string;
}): Promise<HybridQueryResult[] | { error: string }> {
  if (!store) {
    console.warn(`[qmd] searchQmd skipped — store not available`);
    return { error: "QMD store not available" };
  }

  const searchOpts: SearchOptions = {
    query: opts.query,
    collection: opts.collection,
    limit: opts.limit ?? 10,
    minScore: opts.minScore ?? 0,
    rerank: opts.rerank ?? false,
    explain: opts.explain,
    intent: opts.intent,
  };

  const start = Date.now();
  console.log(`[qmd] searchQmd: query="${opts.query.slice(0, 80)}" rerank=${opts.rerank} limit=${opts.limit} collection=${opts.collection}`);
  try {
    const results = await store.search(searchOpts);
    const elapsed = Date.now() - start;
    console.log(`[qmd] searchQmd: returned ${results.length} results in ${elapsed}ms`);
    if (results.length === 0) {
      console.log(`[qmd] searchQmd: WARNING — empty result set for "${opts.query}"`);
    }
    return results;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error(`[qmd] searchQmd: ERROR after ${elapsed}ms:`, err instanceof Error ? err.message : String(err));
    return { error: String(err) };
  }
}

export async function getQmdDocument(pathOrId: string): Promise<DocumentResult | DocumentNotFound | { error: string }> {
  if (!store) return { error: "QMD store not available" };
  return store.get(pathOrId);
}

export async function multiGetQmd(pattern: string, options?: { maxBytes?: number }) {
  if (!store) return { error: "QMD store not available" };
  return store.multiGet(pattern, options);
}

export async function updateQmdIndex(options?: { collections?: string[] }): Promise<UpdateResult | { error: string }> {
  if (!store) return { error: "QMD store not available" };
  return store.update(options);
}

export async function embedQmd(options?: { collection?: string; force?: boolean }): Promise<EmbedResult | { error: string }> {
  if (!store) return { error: "QMD store not available" };
  return store.embed(options);
}

export async function getQmdStatus(): Promise<IndexStatus | { error: string }> {
  if (!store) return { error: "QMD store not available" };
  return store.getStatus();
}

export async function closeQmdStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}
