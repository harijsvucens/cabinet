import test from "node:test";
import assert from "node:assert/strict";
import type { AgentProvider } from "./provider-interface";
import { installCommandFor, loginCommandFor } from "./provider-setup";

const mk = (steps: AgentProvider["installSteps"]): AgentProvider =>
  ({ id: "x", name: "X", type: "cli", installSteps: steps } as AgentProvider);

test("installCommandFor / loginCommandFor pick the right steps and reject the wrong ones", () => {
  // Real Claude shape: install is npm, login is `claude auth login`, and the
  // "Verify login" step must NOT be mistaken for the login step.
  const claude = mk([
    { title: "Install Claude Code", detail: "", command: "npm install -g @anthropic-ai/claude-code" },
    { title: "Log in", detail: "", command: "claude auth login" },
    { title: "Verify login", detail: "", command: "claude auth status" },
  ]);
  assert.equal(installCommandFor(claude)?.command, "npm install -g @anthropic-ai/claude-code");
  assert.equal(loginCommandFor(claude)?.command, "claude auth login");

  // Unsafe/unknown install command → not automatable (UI falls back to copy-paste).
  const sketchy = mk([{ title: "Install thing", detail: "", command: "rm -rf / ; make" }]);
  assert.equal(installCommandFor(sketchy), null);

  // curl-based installer (cursor) is allowed.
  const cursor = mk([{ title: "Install Cursor CLI", detail: "", command: "curl https://cursor.com/install -fsSL | bash" }]);
  assert.ok(installCommandFor(cursor));

  // API-key provider with no interactive login command → null.
  const grok = mk([{ title: "Install", detail: "", command: "npm install -g @vibe-kit/grok-cli" }]);
  assert.equal(loginCommandFor(grok), null);

  // No install steps at all → both null, no throw.
  const empty = mk([]);
  assert.equal(installCommandFor(empty), null);
  assert.equal(loginCommandFor(empty), null);
});
