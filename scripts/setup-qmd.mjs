import { createStore } from "@tobilu/qmd";
import path from "path";
import { homedir } from "os";

const DATA_DIR = "/home/likkmrl/cabinet/data";
const DB_PATH =
  process.env.QMD_DB_PATH ||
  path.join(
    process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"),
    "qmd",
    "index.sqlite"
  );

console.log("QMD DB path:", DB_PATH);
console.log("Data dir:", DATA_DIR);

console.log("\nCreating store...");
const store = await createStore({
  dbPath: DB_PATH,
  config: {
    collections: {
      cabinet: { path: DATA_DIR, pattern: "**/*.md" },
    },
  },
});

console.log("Store created. Getting status...");
let status = await store.getStatus();
console.log("Status:", JSON.stringify(status, null, 2));

console.log("\nUpdating index (scanning files)...");
const updateResult = await store.update();
console.log("Update result:", JSON.stringify(updateResult, null, 2));

status = await store.getStatus();
console.log("\nStatus after update:", JSON.stringify(status, null, 2));

if (updateResult.needsEmbedding > 0) {
  console.log("\nGenerating embeddings...");
  const embedResult = await store.embed({ collection: "cabinet" });
  console.log("Embed result:", JSON.stringify(embedResult, null, 2));
} else {
  console.log("\nNo embeddings needed");
}

status = await store.getStatus();
console.log("\nFinal status:", JSON.stringify(status, null, 2));

const results = await store.search({ query: "getting started", limit: 3 });
console.log("\nSearch results:", results.length);
for (const r of results) {
  console.log(`  - ${r.title} (${r.file}) score=${r.score.toFixed(3)}`);
}

await store.close();
console.log("\nDone!");
