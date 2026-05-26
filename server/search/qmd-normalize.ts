import type { HybridQueryResult } from "@tobilu/qmd";
import type { PageHit, SearchMatch } from "./types";

const SNIPPET_RADIUS = 60;

const QMD_VIRTUAL_RE = /^qmd:\/\/[^/]+\//;

function toCabinetPath(qmdFile: string): string {
  return qmdFile.replace(QMD_VIRTUAL_RE, "");
}

function makeMatches(snippet: string, query: string): SearchMatch[] {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return [{ line: 1, column: 1, length: 1, context: snippet.slice(0, 200) }];
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(snippet.length, idx + query.length + SNIPPET_RADIUS);
  return [{
    line: 1,
    column: idx - start + 1,
    length: query.length,
    context: snippet.slice(start, end),
  }];
}

export function normalizeQmdResults(
  qmdResults: HybridQueryResult[],
  query: string,
  roomPrefix?: string,
): { pages: PageHit[] } {
  const pages: PageHit[] = [];

  for (const doc of qmdResults) {
    if (roomPrefix && !toCabinetPath(doc.file).startsWith(roomPrefix)) {
      continue;
    }

    const snippet = doc.bestChunk || doc.body || "";
    const matches: SearchMatch[] = makeMatches(snippet, query);
    pages.push({
      kind: "page",
      id: doc.docid || doc.file,
      title: doc.title || doc.file.split("/").pop() || doc.file,
      path: toCabinetPath(doc.file),
      tags: [],
      score: doc.score,
      matchCount: matches.length,
      matches,
      matchedFields: ["body"],
    });
  }

  return { pages };
}
