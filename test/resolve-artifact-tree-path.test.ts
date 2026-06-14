import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveArtifactTreePath,
  artifactPathToTreePath,
} from "@/lib/ui/page-type-icons";

// Regression: agents run with cwd DATA_DIR/<cabinetPath>, so the artifact
// paths they report are relative to that cwd. Tree nodes / the /room/<path>
// URL scheme are rooted at data/, so the cwd must be prepended — otherwise the
// first segment is mistaken for a top-level room and the page 404s to a
// "create page" prompt (the reported bug).

const CWD = "hilas-home/cabinet-data/Development/dev";

test("re-roots a cwd-relative artifact path under the task's cabinetPath", () => {
  assert.equal(
    resolveArtifactTreePath("feedback-tracker/github/contributors.md", CWD),
    "hilas-home/cabinet-data/Development/dev/feedback-tracker/github/contributors"
  );
});

test("strips index.md / .md while re-rooting", () => {
  assert.equal(
    resolveArtifactTreePath("feedback-tracker/github/index.md", CWD),
    "hilas-home/cabinet-data/Development/dev/feedback-tracker/github"
  );
});

test("strips a leading data/ prefix before re-rooting", () => {
  assert.equal(
    resolveArtifactTreePath("data/notes/today.md", CWD),
    "hilas-home/cabinet-data/Development/dev/notes/today"
  );
});

test("is idempotent — never double-prefixes an already cabinet-rooted path", () => {
  const full = `${CWD}/feedback-tracker/github/contributors`;
  assert.equal(resolveArtifactTreePath(full, CWD), full);
  // ...and applying it twice is stable.
  assert.equal(
    resolveArtifactTreePath(resolveArtifactTreePath(full, CWD), CWD),
    full
  );
});

test("no-ops when cabinetPath is absent, empty, or the root cabinet", () => {
  const rel = "notes/today.md";
  const tree = artifactPathToTreePath(rel);
  assert.equal(resolveArtifactTreePath(rel), tree);
  assert.equal(resolveArtifactTreePath(rel, ""), tree);
  assert.equal(resolveArtifactTreePath(rel, undefined), tree);
  assert.equal(resolveArtifactTreePath(rel, "."), tree);
});

test("tolerates surrounding slashes on the cabinetPath", () => {
  assert.equal(
    resolveArtifactTreePath("a/b.md", "/room-x/"),
    "room-x/a/b"
  );
});

test("empty artifact path stays empty", () => {
  assert.equal(resolveArtifactTreePath("", CWD), "");
});
