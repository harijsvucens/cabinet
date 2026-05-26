import { spawn, execSync } from "child_process";
import { readFileSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";

export const dynamic = "force-dynamic";

function isWSL(): boolean {
  try {
    const contents = readFileSync("/proc/version", "utf-8");
    return /Microsoft|WSL|microsoft/i.test(contents);
  } catch {
    return false;
  }
}

function getOpenCommand(targetPath: string, reveal?: boolean): { command: string; args: string[] } {
  // On WSL, convert Linux path to Windows path and use explorer.exe
  if (process.platform === "linux" && isWSL()) {
    try {
      const winPath = execSync(`wslpath -w "${targetPath}"`, { encoding: "utf-8" }).trim();
      return reveal
        ? { command: "explorer.exe", args: ["/select,", winPath] }
        : { command: "explorer.exe", args: [winPath] };
    } catch {
      // wslpath not available — fall through to xdg-open
    }
  }

  switch (process.platform) {
    case "darwin":
      return reveal
        ? { command: "open", args: ["-R", targetPath] }
        : { command: "open", args: [targetPath] };
    case "win32":
      return reveal
        ? { command: "explorer.exe", args: ["/select,", targetPath] }
        : { command: "explorer.exe", args: [targetPath] };
    default:
      return { command: "xdg-open", args: [targetPath] };
  }
}

export async function POST(request: Request) {
  try {
    let targetPath = DATA_DIR;

    // Optional subpath to open a specific item
    const body = await request.json().catch(() => null);
    if (body?.subpath) {
      let resolved = path.resolve(DATA_DIR, body.subpath);
      if (!resolved.startsWith(DATA_DIR)) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }

      // Tree-builder strips .md from node.path for markdown files, so try
      // the .md variant when the bare path doesn't exist.
      try {
        await fs.access(resolved);
      } catch {
        const mdCandidate = `${resolved}.md`;
        try {
          await fs.access(mdCandidate);
          resolved = mdCandidate;
        } catch {
          // Neither exists — keep the original path
        }
      }

      targetPath = resolved;
    }

    // Reveal in Finder when opening a specific subpath
    const { command, args } = getOpenCommand(targetPath, !!body?.subpath);

    // Fire-and-forget: the shell shows an error if the path is invalid,
    // no need to wait and surface it ourselves.
    spawn(command, args, { stdio: "ignore", detached: true }).unref();

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
