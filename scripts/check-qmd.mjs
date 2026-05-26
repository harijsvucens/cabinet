import { createStore } from "@tobilu/qmd";
import path from "path";
import { homedir, hostname } from "os";
import fs from "fs";
import { execSync } from "child_process";

const DIVIDER = "─".repeat(72);
const QMD_DB = process.env.QMD_DB_PATH || path.join(
  process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
  "qmd", "index.sqlite"
);

function section(title) {
  console.log(`\n${DIVIDER}\n${title}\n${DIVIDER}`);
}

async function main() {
  /* ── 1. Environment ── */
  section("1. Environment");
  console.log(`Hostname:  ${hostname()}`);
  console.log(`Platform:  ${process.platform}`);
  console.log(`Node:      ${process.version}`);
  console.log(`Arch:      ${process.arch}`);
  console.log(`CWD:       ${process.cwd()}`);
  console.log(`Home:      ${homedir()}`);
  try {
    const qmdPath = execSync("which qmd 2>/dev/null || command -v qmd", { encoding: "utf8" }).trim();
    console.log(`qmd CLI:   ${qmdPath || "(not found)"}`);
  } catch {
    console.log("qmd CLI:   (not found on PATH)");
  }
  try {
    const ver = execSync("qmd --version 2>/dev/null", { encoding: "utf8" }).trim();
    console.log(`qmd ver:   ${ver}`);
  } catch {
    console.log("qmd ver:   (could not detect)");
  }
  console.log(`PATH:      ${process.env.PATH || "(not set)"}`);
  console.log(`DB path:   ${QMD_DB}`);
  console.log(`DB exists: ${fs.existsSync(QMD_DB)}`);
  if (fs.existsSync(QMD_DB)) {
    const stat = fs.statSync(QMD_DB);
    console.log(`DB size:   ${(stat.size / 1024).toFixed(1)} KB`);
  }

  /* ── 2. Data directory ── */
  section("2. Data Directory");
  const dataDir = "/home/likkmrl/cabinet/data";
  console.log(`Data dir:  ${dataDir}`);
  console.log(`Exists:    ${fs.existsSync(dataDir)}`);
  if (fs.existsSync(dataDir)) {
    const mdFiles = execSync(`find "${dataDir}" -name "*.md" -not -path "*/.git/*" 2>/dev/null | wc -l`, { encoding: "utf8" }).trim();
    console.log(`.md files: ${mdFiles}`);
    const dirs = execSync(`ls -1d "${dataDir}"/*/ 2>/dev/null | wc -l`, { encoding: "utf8" }).trim();
    console.log(`Subdirs:   ${dirs}`);
  }

  /* ── 3. SDK Initialization ── */
  section("3. QMD SDK Init");
  let store;
  try {
    store = await createStore({ dbPath: QMD_DB });
    console.log("createStore: OK");
  } catch (err) {
    console.log("createStore: FAILED");
    console.log(`  ${err.message}`);
    process.exit(1);
  }

  /* ── 4. Index Status ── */
  section("4. Index Status");
  try {
    const status = await store.getStatus();
    console.log(`Total docs:  ${status.totalDocuments}`);
    console.log(`Vectors:     ${status.hasVectorIndex ? status.totalDocuments + " (embedded)" : "none"}`);
    console.log(`Needs embed: ${status.needsEmbedding}`);
    console.log(`Collections: ${status.collections.length}`);
    for (const c of status.collections) {
      console.log(`  ${c.name}`);
      console.log(`    path:    ${c.path}`);
      console.log(`    pattern: ${c.pattern}`);
      console.log(`    docs:    ${c.documents}`);
      console.log(`    updated: ${c.lastUpdated || "never"}`);
    }
  } catch (err) {
    console.log("getStatus: FAILED");
    console.log(`  ${err.message}`);
  }

  /* ── 5. Search Tests ── */
  section("5. Search Tests");
  const queries = ["getting started", "agents", "authentication", "editor", "sandbox"];
  for (const q of queries) {
    try {
      const results = await store.search({ query: q, collection: "cabinet", limit: 3 });
      console.log(`Query "${q}": ${results.length} result(s)`);
      for (const r of results) {
        console.log(`  [${(r.score * 100).toFixed(0)}%] ${r.title || "(untitled)"}`);
        console.log(`        ${r.file}`);
      }
    } catch (err) {
      console.log(`Query "${q}": ERROR — ${err.message}`);
    }
  }

  /* ── 6. Rerank Test (deep search) ── */
  section("6. Deep Search (Rerank)");
  try {
    const start = Date.now();
    const results = await store.search({ query: "how do agents delegate work", collection: "cabinet", limit: 3, rerank: true });
    const elapsed = Date.now() - start;
    console.log(`Rerank query: ${results.length} result(s) in ${elapsed}ms`);
    for (const r of results) {
      console.log(`  [${(r.score * 100).toFixed(0)}%] ${r.title || "(untitled)"}`);
      console.log(`        ${r.file}`);
    }
  } catch (err) {
    console.log(`Rerank: ERROR — ${err.message}`);
  }

  /* ── 7. Daemon Connectivity ── */
  section("7. Daemon Connectivity");
  const daemonPorts = [4100];
  for (const port of daemonPorts) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        console.log(`Daemon :${port}: RUNNING`);
        console.log(`  qmd:   ${data.qmd?.available ? "available" : "unavailable"}`);
        console.log(`  pty:   ${data.ptySessions} sessions`);
        console.log(`  jobs:  ${data.scheduledJobs} scheduled`);
      } else {
        console.log(`Daemon :${port}: HEALTH CHECK FAILED (${res.status})`);
      }
    } catch {
      console.log(`Daemon :${port}: NOT RUNNING`);
    }
  }

  /* ── 8. File Watcher Status ── */
  section("8. File Coverage");
  try {
    const allFiles = execSync(`find "${dataDir}" -name "*.md" -not -path "*/.git/*" 2>/dev/null`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    console.log(`Total .md files in data/: ${allFiles.length}`);
    const status = await store.getStatus();
    const cabinetCol = status.collections.find(c => c.name === "cabinet");
    const indexed = cabinetCol ? cabinetCol.documents : 0;
    console.log(`Indexed by QMD:     ${indexed}`);
    console.log(`Coverage:           ${indexed > 0 ? ((indexed / allFiles.length) * 100).toFixed(1) : 0}%`);
    if (indexed < allFiles.length) {
      console.log(`\nFiles NOT yet indexed (sample):`);
      const indexedSet = new Set();
      if (fs.existsSync(QMD_DB)) {
        const raw = execSync(`find "${dataDir}" -name "*.md" -not -path "*/.git/*" 2>/dev/null`, { encoding: "utf8" }).trim();
        console.log(`  (run 'qmd update' to re-index)`);
      }
    }
  } catch (err) {
    console.log(`Coverage check: ${err.message}`);
  }

  /* ── 9. Claude Config (MCP) ── */
  section("9. MCP Config (Agent Integration)");
  const claudeConfigPath = path.join(homedir(), ".claude.json");
  console.log(`Claude config: ${claudeConfigPath}`);
  console.log(`Exists:        ${fs.existsSync(claudeConfigPath)}`);
  if (fs.existsSync(claudeConfigPath)) {
    try {
      const raw = fs.readFileSync(claudeConfigPath, "utf8");
      const cfg = JSON.parse(raw);
      const mcpServers = cfg.mcpServers || {};
      const qmdEntry = mcpServers["cabinet-qmd"];
      if (qmdEntry) {
        console.log("cabinet-qmd:  CONNECTED");
        console.log(`  command: ${qmdEntry.command}`);
        console.log(`  args:    ${JSON.stringify(qmdEntry.args)}`);
      } else {
        console.log("cabinet-qmd:  NOT CONNECTED (use Settings → Integrations to connect)");
      }
    } catch {
      console.log("cabinet-qmd:  (config unreadable)");
    }
  }

  /* ── 10. MCP Server Test ── */
  section("10. MCP Server Smoke Test");
  try {
    const result = execSync('echo \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\' | qmd mcp 2>&1', {
      encoding: "utf8",
      timeout: 10000,
    });
    const lines = result.trim().split("\n");
    const last = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last);
      if (parsed.result?.tools) {
        console.log(`MCP server: RESPONDING (${parsed.result.tools.length} tools)`);
        for (const t of parsed.result.tools) {
          console.log(`  - ${t.name}: ${t.description || "(no description)"}`);
        }
      } else {
        console.log("MCP server: UNEXPECTED RESPONSE");
        console.log(`  ${last}`);
      }
    } catch {
      console.log("MCP server: OUTPUT (non-JSON)");
      console.log(`  ${last}`);
    }
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    if (msg.includes("command not found") || msg.includes("not found")) {
      console.log("MCP server: qmd CLI not available");
    } else if (msg.includes("EACCES")) {
      console.log("MCP server: Permission denied (Windows WSL binary issue?)");
    } else {
      console.log(`MCP server: ERROR`);
      console.log(`  ${msg.slice(0, 200)}`);
    }
  }

  /* ── Cleanup ── */
  await store.close();
  console.log(`\n${DIVIDER}`);
  console.log("Diagnostic complete.");
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
