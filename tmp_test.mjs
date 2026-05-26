import fs from "fs";
const token = fs.readFileSync("/home/likkmrl/cabinet/data/.agents/.runtime/daemon-token", "utf8").trim();
const url = "http://127.0.0.1:4100/search-qmd?q=cure+temperature&rerank=true&limit=5&intent=hardware+engineering";

try {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  console.log("STATUS:", resp.status);
  console.log("RESULT:", text.slice(0, 1000));
} catch (e) {
  console.error("ERROR:", e.message);
}
