import { spawn } from "child_process";
import { providerRegistry } from "@/lib/agents/provider-registry";
import { withAdapterRuntimeEnv } from "@/lib/agents/adapters/utils";
import { installCommandFor } from "@/lib/agents/provider-setup";

// "Install for me": run the provider's install command server-side and stream
// its output to the browser as Server-Sent Events, so the UI can show exactly
// what's running (transparent) and surface failures without a terminal. The
// terminal stays an *option* — this is the default, no-terminal path.
//
// Events (each `data:` line is JSON):
//   { type: "command", command }        - the exact command, sent first
//   { type: "output", chunk }           - stdout/stderr as it arrives
//   { type: "done", ok, exitCode, available }  - terminal, then the stream closes

export const dynamic = "force-dynamic";

// npm -g installs can be slow on a cold cache; give them room but bound it.
const TIMEOUT_MS = 180_000;

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const provider = providerRegistry.get(id);
  if (!provider) {
    return Response.json({ error: `Unknown provider: ${id}` }, { status: 404 });
  }
  const install = installCommandFor(provider);
  if (!install) {
    return Response.json(
      { error: `Provider ${id} has no automatable install command — install it manually.` },
      { status: 400 },
    );
  }
  const command = install.command;

  const encoder = new TextEncoder();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  // Held so cancel() can kill the child if the browser disconnects mid-install
  // (closing the dialog) — otherwise a 3-minute npm install keeps running detached.
  let child: ReturnType<typeof spawn> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send(controller, { type: "command", command });

      // withAdapterRuntimeEnv merges .cabinet.env + sets PATH like the verify
      // route; Windows has no /bin/sh so run through the shell (#130).
      const env = withAdapterRuntimeEnv(process.env);
      const proc =
        process.platform === "win32"
          ? spawn(command, { env, shell: true, stdio: ["ignore", "pipe", "pipe"] })
          : spawn("/bin/sh", ["-c", command], { env, stdio: ["ignore", "pipe", "pipe"] });
      child = proc;

      let settled = false;
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      }, TIMEOUT_MS);

      const onChunk = (chunk: Buffer) =>
        send(controller, { type: "output", chunk: chunk.toString() });
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);

      const finish = async (exitCode: number | null, spawnError: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (spawnError) send(controller, { type: "output", chunk: `\n${spawnError}\n` });
        // Re-probe availability rather than trusting the exit code: a curl|bash
        // installer can exit 0 while the binary still isn't on PATH.
        let available = false;
        try {
          available = (await provider.healthCheck()).available;
        } catch { /* treat as unavailable */ }
        const ok = available && !spawnError;
        send(controller, { type: "done", ok, exitCode, available });
        controller.close();
      };

      proc.on("error", (err) => void finish(null, err instanceof Error ? err.message : String(err)));
      proc.on("close", (code) => void finish(code, null));
    },
    cancel() {
      try { child?.kill("SIGTERM"); } catch { /* already gone */ }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
