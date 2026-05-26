import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQmdResults } from "../server/search/qmd-normalize";
import type { HybridQueryResult } from "@tobilu/qmd";

function makeQmdResult(overrides: Partial<HybridQueryResult> & { file: string }): HybridQueryResult {
  return {
    docid: overrides.file.replace("/", "-"),
    title: overrides.file.split("/").pop() || overrides.file,
    body: overrides.body || "some content body text",
    bestChunk: overrides.bestChunk,
    score: overrides.score ?? 0.85,
    ...overrides,
  } as HybridQueryResult;
}

test("normalizeQmdResults converts QMD results to PageHit[]", () => {
  const results = [
    makeQmdResult({
      file: "docs/getting-started.md",
      bestChunk: "Getting started with Cabinet is easy. First install the CLI.",
      score: 0.92,
    }),
    makeQmdResult({
      file: "docs/auth.md",
      bestChunk: "Authentication uses OAuth2 tokens.",
      score: 0.78,
    }),
  ];

  const { pages } = normalizeQmdResults(results, "getting started");

  assert.equal(pages.length, 2);
  assert.equal(pages[0].kind, "page");
  assert.equal(pages[0].path, "docs/getting-started.md");
  assert.equal(pages[0].title, "getting-started.md");
  assert.equal(pages[0].matchCount, 1);
  assert.ok(pages[0].matches[0].context.toLowerCase().includes("getting started"));
  assert.equal(pages[0].score, 0.92);
  assert.equal(pages[1].score, 0.78);
});

test("normalizeQmdResults filters by room prefix", () => {
  const results = [
    makeQmdResult({ file: "room-alpha/getting-started.md" }),
    makeQmdResult({ file: "room-beta/auth.md" }),
  ];

  const { pages } = normalizeQmdResults(results, "test", "room-alpha");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].path, "room-alpha/getting-started.md");
});

test("normalizeQmdResults no room prefix shows all results", () => {
  const results = [
    makeQmdResult({ file: "room-alpha/getting-started.md" }),
    makeQmdResult({ file: "room-beta/auth.md" }),
  ];

  const { pages } = normalizeQmdResults(results, "test");
  assert.equal(pages.length, 2);
});

test("normalizeQmdResults handles empty results", () => {
  const { pages } = normalizeQmdResults([], "test");
  assert.equal(pages.length, 0);
});

test("normalizeQmdResults uses bestChunk over body for snippet", () => {
  const results = [
    makeQmdResult({
      file: "docs/test.md",
      bestChunk: "This is the best matching chunk.",
      body: "This is the full body text which is longer.",
    }),
  ];

  const { pages } = normalizeQmdResults(results, "matching");
  assert.ok(pages[0].matches[0].context.includes("best matching chunk"));
});

test("normalizeQmdResults falls back to body when bestChunk is empty", () => {
  const results = [
    makeQmdResult({
      file: "docs/test.md",
      bestChunk: undefined,
      body: "Fallback body text for matching.",
    }),
  ];

  const { pages } = normalizeQmdResults(results, "fallback");
  assert.ok(pages[0].matches[0].context.includes("Fallback body"));
});

test("normalizeQmdResults creates match with column offset", () => {
  const results = [
    makeQmdResult({
      file: "doc.md",
      bestChunk: "AAA query BBB",
      score: 0.95,
    }),
  ];

  const { pages } = normalizeQmdResults(results, "query");
  assert.equal(pages[0].matches[0].column, 5);
  assert.equal(pages[0].matches[0].length, "query".length);
});

test("normalizeQmdResults creates fallback match when query not in snippet", () => {
  const results = [
    makeQmdResult({
      file: "doc.md",
      bestChunk: "Completely unrelated text here.",
      score: 0.5,
    }),
  ];

  const { pages } = normalizeQmdResults(results, "nonexistent");
  assert.equal(pages[0].matches[0].column, 1);
  assert.equal(pages[0].matches[0].length, 1);
});

test("normalizeQmdResults tags and icon are defaults", () => {
  const results = [makeQmdResult({ file: "doc.md" })];
  const { pages } = normalizeQmdResults(results, "test");
  assert.deepEqual(pages[0].tags, []);
  assert.equal(pages[0].icon, undefined);
  assert.equal(pages[0].modified, undefined);
});
