import type { AgentProvider, ProviderStatus } from "../provider-interface";
import {
  checkCliProviderAvailable,
  execCli,
  resolveCliCommand,
} from "../provider-cli";

// Verified 2026-07-11 against xAI's Grok Build docs (x.ai/cli). grok-4.5 is
// the model that powers Grok Build and is xAI's current recommended default;
// the 4.x-fast line covers cost-sensitive high-volume use; Grok 3 has been
// retired from the recommended catalog so it's no longer listed here.
const GROK_MODELS = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "xAI's recommended default — powers Grok Build, most intelligent",
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    description: "Previous flagship — fast, intelligent (1M context)",
  },
  { id: "grok-4", name: "Grok 4", description: "Frontier reasoning workloads" },
  {
    id: "grok-4-fast",
    name: "Grok 4 Fast",
    description: "Fast, cost-efficient Grok 4 for high-volume use",
  },
  {
    id: "grok-4.1-fast",
    name: "Grok 4.1 Fast",
    description: "Cheapest Grok 4.x — high-throughput, low-latency",
  },
  {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    description: "Fast code-focused Grok model for agentic coding",
  },
] as const;

export const grokCliProvider: AgentProvider = {
  id: "grok-cli",
  name: "Grok CLI",
  type: "cli",
  icon: "grok",
  iconAsset: "/providers/grok.svg",
  installMessage:
    "Grok CLI not found. Install with: curl -fsSL https://x.ai/cli/install.sh | bash",
  installSteps: [
    {
      title: "Install Grok CLI",
      detail: "Install xAI's official Grok CLI (grok):",
      command: "curl -fsSL https://x.ai/cli/install.sh | bash",
      link: { label: "Grok CLI docs", url: "https://x.ai/cli" },
    },
    {
      title: "Get an xAI API key",
      detail:
        "On first launch grok opens a browser to sign in. For headless/agent runs Cabinet authenticates via XAI_API_KEY (or GROK_API_KEY) — create or retrieve one from the xAI Console.",
      link: { label: "Open xAI Console", url: "https://console.x.ai/" },
    },
    {
      title: "Export your API key",
      detail:
        "Add XAI_API_KEY to your shell (e.g. ~/.zshrc or ~/.bashrc) so agent runs can authenticate:",
      command: "export XAI_API_KEY=xai-...",
    },
    {
      title: "Verify setup",
      detail: "Confirm headless mode works:",
      command: "grok -p 'Reply with exactly OK'",
    },
  ],
  detachedPromptLaunchMode: "one-shot",
  models: GROK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    effortLevels: [],
  })),
  effortLevels: [],
  command: "grok",
  commandCandidates: [
    `${process.env.HOME || ""}/.local/bin/grok`,
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
    "grok",
  ],

  buildArgs(prompt: string, _workdir: string): string[] {
    return ["-p", prompt];
  },

  buildOneShotInvocation(prompt: string, workdir: string, opts) {
    const baseArgs = this.buildArgs ? this.buildArgs(prompt, workdir) : [];
    const args = [...baseArgs];
    if (opts?.model) {
      args.push("--model", opts.model);
    }
    return {
      command: this.command || "grok",
      args,
    };
  },

  async isAvailable(): Promise<boolean> {
    return checkCliProviderAvailable(this);
  },

  async healthCheck(): Promise<ProviderStatus> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        return {
          available: false,
          authenticated: false,
          error: this.installMessage,
        };
      }

      const hasKey =
        Boolean(process.env.XAI_API_KEY?.trim()) ||
        Boolean(process.env.GROK_API_KEY?.trim());

      try {
        const cmd = resolveCliCommand(this);
        const version = await execCli(cmd, ["--version"], { timeout: 5000 });

        if (hasKey) {
          return {
            available: true,
            authenticated: true,
            version: version ? `Grok CLI ${version}` : "Grok CLI installed",
          };
        }

        return {
          available: true,
          authenticated: false,
          error:
            "Grok CLI is installed but XAI_API_KEY (or GROK_API_KEY) is not set in the environment.",
          version: version ? `Grok CLI ${version}` : undefined,
        };
      } catch {
        return {
          available: true,
          authenticated: hasKey,
          error: hasKey
            ? undefined
            : "Grok CLI is installed but XAI_API_KEY is not set.",
        };
      }
    } catch (error) {
      return {
        available: false,
        authenticated: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
};
