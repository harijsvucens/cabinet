import { NextResponse } from "next/server";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";

export async function GET() {
  try {
    const token = await getOrCreateDaemonToken();
    const res = await fetch(`${getDaemonUrl()}/search-qmd/status`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ available: false });
  }
}
