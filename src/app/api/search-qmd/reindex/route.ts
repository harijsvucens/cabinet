import { NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";

export async function POST() {
  try {
    const token = await getOrCreateDaemonToken();
    const res = await fetch(`${getDaemonUrl()}/search-qmd/reindex`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Re-index request failed" }, { status: 503 });
  }
}
