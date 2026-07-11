import type { AgentProvider } from "./provider-interface";

// Which of a provider's installSteps is the "install" step vs the "log in" step.
// We drive "Install for me" / "Log in" buttons off these instead of making the
// user copy-paste the command, so the picking has to be reliable — and the
// install command has to be something safe to run unattended server-side.

export interface SetupCommand {
  title: string;
  command: string;
}

// Only run a step as "install" if its command starts with a recognised package
// manager / installer. installSteps are hardcoded in-repo (trusted), so this is
// defense-in-depth against a step like `rm`/`curl … | sh` slipping into the
// unattended path — anything unrecognised falls back to copy-paste in the UI.
const INSTALL_PREFIX =
  /^(npm|npx|pnpm|yarn|corepack|brew|pip|pip3|curl|wget)\b/;

function stepByTitle(
  provider: AgentProvider,
  re: RegExp,
): SetupCommand | null {
  const step = provider.installSteps?.find(
    (s) => s.command && re.test(s.title),
  );
  return step?.command ? { title: step.title, command: step.command } : null;
}

/** The install command Cabinet can run for the user, or null if it isn't safe to automate. */
export function installCommandFor(provider: AgentProvider): SetupCommand | null {
  const step = stepByTitle(provider, /install/i);
  if (!step) return null;
  return INSTALL_PREFIX.test(step.command.trim()) ? step : null;
}

/** The interactive login command (e.g. `claude auth login`), or null if the provider auths by API key. */
export function loginCommandFor(provider: AgentProvider): SetupCommand | null {
  // Match "Log in" / "Login" but not "Verify login".
  return stepByTitle(provider, /^log\s?in$/i);
}
