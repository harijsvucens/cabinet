import test from "node:test";
import assert from "node:assert/strict";
import { cleanQuery, rewriteQuery } from "../server/search/query-rewrite";

test("cleanQuery strips question prefix 'who is'", () => {
  assert.equal(cleanQuery("who is Renate"), "Renate");
});

test("cleanQuery strips question prefix 'what did'", () => {
  assert.equal(cleanQuery("what did we pitch"), "we pitch");
});

test("cleanQuery strips question prefix 'where is'", () => {
  assert.equal(cleanQuery("where is the exhibition"), "the exhibition");
});

test("cleanQuery strips question prefix 'how to'", () => {
  assert.equal(cleanQuery("how to build a website"), "build a website");
});

test("cleanQuery strips question prefix case-insensitive", () => {
  assert.equal(cleanQuery("Who is Renate"), "Renate");
  assert.equal(cleanQuery("WHAT DID we do"), "we do");
});

test("cleanQuery strips trailing question fragments", () => {
  assert.equal(cleanQuery("Renate pitch to her"), "Renate pitch");
  assert.equal(cleanQuery("coffee cups to them"), "coffee cups");
});

test("cleanQuery normalizes diacritics", () => {
  assert.equal(cleanQuery("Renāte Lagzdiņa"), "Renate Lagzdina");
  assert.equal(cleanQuery("Kuldīga"), "Kuldiga");
  assert.equal(cleanQuery("café"), "cafe");
});

test("cleanQuery strips trailing punctuation", () => {
  assert.equal(cleanQuery("concrete villa?"), "concrete villa");
  assert.equal(cleanQuery("brand voice!"), "brand voice");
  assert.equal(cleanQuery("test query..."), "test query");
});

test("cleanQuery collapses whitespace", () => {
  assert.equal(cleanQuery("concrete   villa"), "concrete villa");
  assert.equal(cleanQuery("  test  query  "), "test query");
});

test("cleanQuery handles complex natural language question", () => {
  const result = cleanQuery("who is Renate and what did we pitch to her?");
  assert.equal(result, "Renate");
});

test("cleanQuery preserves normal queries unchanged", () => {
  assert.equal(cleanQuery("concrete villa"), "concrete villa");
  assert.equal(cleanQuery("coffee cups festival"), "coffee cups festival");
  assert.equal(cleanQuery("brand voice guidelines"), "brand voice guidelines");
});

test("cleanQuery does not strip prefix if it's part of a word", () => {
  assert.equal(cleanQuery("wholesale items"), "wholesale items");
  assert.equal(cleanQuery("whereabouts unknown"), "whereabouts unknown");
});

test("rewriteQuery fixes common typos", () => {
  assert.equal(rewriteQuery("exibishon kopenhagen"), "exhibition copenhagen");
  assert.equal(rewriteQuery("conkreet vila"), "concrete villa");
  assert.equal(rewriteQuery("skulpture ideas"), "sculpture ideas");
});

test("rewriteQuery fixes diacritics in names", () => {
  assert.equal(rewriteQuery("Renāte Lagzdiņa"), "Renate Lagzdina");
});

test("rewriteQuery returns null when no rewrite needed", () => {
  assert.equal(rewriteQuery("concrete villa"), null);
  assert.equal(rewriteQuery("coffee cups festival"), null);
  assert.equal(rewriteQuery("brand voice guidelines"), null);
});

test("rewriteQuery returns null for empty input", () => {
  assert.equal(rewriteQuery(""), null);
  assert.equal(rewriteQuery("   "), null);
});

test("rewriteQuery returns cleaned query when question was stripped", () => {
  const result = rewriteQuery("who is Renate");
  assert.equal(result, "Renate");
});

test("rewriteQuery combines question stripping and typo correction", () => {
  const result = rewriteQuery("who is Renāte and what did we pitch to her?");
  assert.ok(result !== null);
  assert.ok(result.toLowerCase().includes("renate"));
});

test("rewriteQuery handles mixed case typos", () => {
  assert.equal(rewriteQuery("Exibishon Kopenhagen"), "exhibition copenhagen");
});

test("rewriteQuery preserves unknown words", () => {
  assert.equal(rewriteQuery("exibishon xyz123"), "exhibition xyz123");
});
