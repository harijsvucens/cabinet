"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Check, X, ExternalLink, Copy, Terminal as TerminalIcon } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useLocale } from "@/i18n/use-locale";
import { WebTerminal } from "@/components/terminal/web-terminal";

// One dialog to get a provider from "not installed" to "ready" without the
// user touching a terminal: Install for me (streamed, transparent) → Log in
// (seamless per provider) → Verify. The terminal is only ever an *option*
// (the embedded login pane, or the "Open a terminal" escape hatch).

interface InstallStep {
  title: string;
  detail: string;
  command?: string;
  link?: { label: string; url: string };
}
interface ProviderInfo {
  id: string;
  name: string;
  installSteps?: InstallStep[];
}
interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
}

// Providers that authenticate with a single API key we can write to .cabinet.env
// inline. Anything else with no interactive login command falls back to the
// Settings → API Keys surface (which handles the multi-key providers).
const API_KEY_ENV: Record<string, string> = {
  "grok-cli": "XAI_API_KEY",
};

const findStep = (steps: InstallStep[] | undefined, re: RegExp) =>
  steps?.find((s) => s.command && re.test(s.title)) ?? null;

// #5: when a provider becomes ready and it's the ONLY ready one while the
// configured default isn't itself ready, point new agents at it so the user
// never has to pick. Read-modify-write the full settings payload — the PUT
// endpoint resets disabledProviderIds/migrations on a partial write.
async function promoteSoleReadyDefault(providerId: string): Promise<void> {
  try {
    const [provRes, statRes] = await Promise.all([
      fetch("/api/agents/providers", { cache: "no-store" }),
      fetch("/api/agents/providers/status", { cache: "no-store" }),
    ]);
    if (!provRes.ok || !statRes.ok) return;
    const prov = (await provRes.json()) as {
      providers: Array<{ id: string; enabled?: boolean }>;
      defaultProvider?: string;
      defaultModel?: string;
      defaultEffort?: string;
    };
    const stat = (await statRes.json()) as {
      providers: Array<{ id: string; available: boolean; authenticated: boolean }>;
    };
    const ready = stat.providers.filter((p) => p.available && p.authenticated).map((p) => p.id);
    if (ready.length !== 1 || ready[0] !== providerId) return; // not the sole ready provider
    if (prov.defaultProvider && ready.includes(prov.defaultProvider)) return; // default already works

    await fetch("/api/agents/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultProvider: providerId,
        defaultModel: prov.defaultModel,
        defaultEffort: prov.defaultEffort,
        // Preserve the user's disabled set (PUT clears it otherwise).
        disabledProviderIds: prov.providers.filter((p) => p.enabled === false).map((p) => p.id),
        migrations: [],
      }),
    });
  } catch { /* best-effort */ }
}

export function ProviderSetupDialog() {
  // Outer just watches the store; the panel is keyed by providerId so it
  // remounts fresh per provider (no stale info flash, no null-clearing effect).
  const providerId = useAppStore((s) => s.providerSetupId);
  if (!providerId) return null;
  return <ProviderSetupPanel key={providerId} providerId={providerId} />;
}

function ProviderSetupPanel({ providerId }: { providerId: string }) {
  const { t } = useLocale();
  const close = useAppStore((s) => s.closeProviderSetup);
  const setSection = useAppStore((s) => s.setSection);
  const loadProviders = useAppStore((s) => s.loadProviders);

  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/agents/providers/status", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { providers: ProviderStatus[] };
      setStatus(data.providers.find((p) => p.id === providerId) ?? null);
    } catch { /* ignore */ }
  }, [providerId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/agents/providers", { cache: "no-store" });
        if (r.ok) {
          const data = (await r.json()) as { providers: ProviderInfo[] };
          if (alive) setInfo(data.providers.find((p) => p.id === providerId) ?? null);
        }
      } catch { /* ignore */ }
      await refreshStatus();
    })();
    return () => { alive = false; };
  }, [providerId, refreshStatus]);

  const installStep = findStep(info?.installSteps, /install/i);
  const loginStep = findStep(info?.installSteps, /^log\s?in$/i);
  const available = status?.available ?? false;
  const authed = status?.authenticated ?? false;
  const ready = available && authed;

  const onReady = async () => {
    // Push the fresh state to the rest of the app once this provider is usable.
    await refreshStatus();
    await loadProviders();
    await promoteSoleReadyDefault(providerId);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">
              {t("settings:providerSetup.title", { name: info?.name ?? providerId })}
            </h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                ready
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : available
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {ready
                ? t("settings:providerSetup.ready")
                : available
                  ? t("settings:providerSetup.notLoggedIn")
                  : t("settings:providerSetup.notInstalled")}
            </span>
          </div>
          <button
            onClick={close}
            aria-label={t("status:common.close")}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          {ready ? (
            <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <Check className="h-4 w-4" />
              {t("settings:providerSetup.allSet", { name: info?.name ?? providerId })}
            </p>
          ) : (
            <>
              {!available && (
                <InstallSection
                  providerId={providerId}
                  command={installStep?.command ?? null}
                  onDone={onReady}
                />
              )}
              {available && !authed && (
                <LoginSection
                  providerId={providerId}
                  loginCommand={loginStep?.command ?? null}
                  onDone={onReady}
                  goToApiKeys={() => { setSection({ type: "settings", slug: "providers" }); close(); }}
                />
              )}
              <VerifySection providerId={providerId} onVerified={onReady} />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          <button
            onClick={() => { setSection({ type: "settings", slug: "providers" }); close(); }}
            className="text-[11px] text-muted-foreground underline hover:text-foreground"
          >
            {t("settings:providerSetup.openSettings")}
          </button>
          <button
            onClick={close}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            {ready ? t("settings:providerSetup.done") : t("status:common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function InstallSection({ providerId, command, onDone }: { providerId: string; command: string | null; onDone: () => void }) {
  const { t } = useLocale();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [result, setResult] = useState<null | { ok: boolean }>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => { preRef.current?.scrollTo(0, preRef.current.scrollHeight); }, [log]);

  const run = async () => {
    setRunning(true); setLog(""); setResult(null);
    try {
      const res = await fetch(`/api/agents/providers/${providerId}/install`, { method: "POST" });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        setLog((err as { error?: string }).error ?? `Install failed (${res.status})`);
        setRunning(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.replace(/^data: /, "").trim();
          if (!line) continue;
          const msg = JSON.parse(line) as { type: string; command?: string; chunk?: string; ok?: boolean };
          if (msg.type === "command") setLog((l) => l + `$ ${msg.command}\n`);
          else if (msg.type === "output") setLog((l) => l + (msg.chunk ?? ""));
          else if (msg.type === "done") { setResult({ ok: !!msg.ok }); if (msg.ok) void onDone(); }
        }
      }
    } catch (e) {
      setLog((l) => l + `\n${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground/80">{t("settings:providerSetup.installTitle")}</h3>
      {command ? (
        <>
          {/* Transparent: the exact command, always visible before/while it runs. */}
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px]">
            <span className="flex-1 truncate">{command}</span>
            <CopyButton text={command} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={run}
              disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {running ? t("settings:providerSetup.installing") : t("settings:providerSetup.installForMe")}
            </button>
            {result && (
              <span className={`text-[11px] ${result.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                {result.ok ? t("settings:providerSetup.installOk") : t("settings:providerSetup.installFail")}
              </span>
            )}
          </div>
          {(running || log) && (
            <pre
              ref={preRef}
              className="max-h-40 overflow-auto rounded-md border border-border bg-black/90 p-2 font-mono text-[10.5px] leading-relaxed text-green-300"
            >
              {log || "…"}
            </pre>
          )}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">{t("settings:providerSetup.noAutoInstall")}</p>
      )}
    </section>
  );
}

function LoginSection({
  providerId, loginCommand, onDone, goToApiKeys,
}: { providerId: string; loginCommand: string | null; onDone: () => void; goToApiKeys: () => void }) {
  const { t } = useLocale();

  if (providerId === "claude-code") return <ClaudeLogin onDone={onDone} />;

  if (loginCommand) return <TerminalLogin command={loginCommand} onDone={onDone} />;

  const envVar = API_KEY_ENV[providerId];
  if (envVar) return <ApiKeyLogin envVar={envVar} onDone={onDone} />;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground/80">{t("settings:providerSetup.loginTitle")}</h3>
      <p className="text-[11px] text-muted-foreground">{t("settings:providerSetup.loginApiKeyHint")}</p>
      <button onClick={goToApiKeys} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted">
        {t("settings:providerSetup.addApiKey")}
      </button>
    </section>
  );
}

function ClaudeLogin({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const [phase, setPhase] = useState<"idle" | "starting" | "await-code" | "submitting">("idle");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  const start = async () => {
    setPhase("starting"); setErr("");
    try {
      const r = await fetch("/api/agents/claude-login/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not start Claude login");
      setUrl(d.url); setPhase("await-code");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPhase("idle"); }
  };
  const submit = async () => {
    setPhase("submitting"); setErr("");
    try {
      const r = await fetch("/api/agents/claude-login/code", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not connect");
      void onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setPhase("await-code"); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground/80">{t("settings:providerSetup.loginTitle")}</h3>
      {phase === "idle" && (
        <button onClick={start} className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">
          {t("settings:providerSetup.connectClaude")}
        </button>
      )}
      {phase === "starting" && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("settings:providerSetup.preparingLink")}</p>
      )}
      {(phase === "await-code" || phase === "submitting") && (
        <div className="space-y-2">
          <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-accent hover:bg-muted">
            <ExternalLink className="h-3.5 w-3.5" />{t("settings:providerSetup.openClaudeLogin")}
          </a>
          <p className="text-[11px] text-muted-foreground">{t("settings:providerSetup.pasteCodeHint")}</p>
          <div className="flex items-center gap-1.5">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("settings:providerSetup.codePlaceholder")}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
            />
            <button
              onClick={submit}
              disabled={!code.trim() || phase === "submitting"}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {phase === "submitting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("settings:providerSetup.connect")}
            </button>
          </div>
        </div>
      )}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </section>
  );
}

function TerminalLogin({ command, onDone }: { command: string; onDone: () => void }) {
  const { t } = useLocale();
  const [sessionId] = useState(() => `provider-login-${Date.now()}`);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground/80">{t("settings:providerSetup.loginTitle")}</h3>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <TerminalIcon className="h-3.5 w-3.5" />
        {t("settings:providerSetup.terminalLoginHint", { command })}
      </p>
      <div className="h-56 overflow-hidden rounded-md border border-border">
        <WebTerminal
          sessionId={sessionId}
          adapterType="shell"
          initialInput={command}
          themeSurface="page"
          onClose={() => { /* session ended; user clicks re-check */ }}
        />
      </div>
      <button onClick={() => void onDone()} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted">
        {t("settings:providerSetup.recheck")}
      </button>
    </section>
  );
}

function ApiKeyLogin({ envVar, onDone }: { envVar: string; onDone: () => void }) {
  const { t } = useLocale();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const r = await fetch("/api/agents/config/cabinet-env", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envVar, value: key.trim() }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as { error?: string }).error || "Could not save key"); }
      setKey(""); void onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-foreground/80">{t("settings:providerSetup.loginTitle")}</h3>
      <p className="text-[11px] text-muted-foreground">{t("settings:providerSetup.apiKeyFieldHint", { envVar })}</p>
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={envVar}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
        />
        <button
          onClick={save}
          disabled={!key.trim() || saving}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("settings:providerSetup.saveKey")}
        </button>
      </div>
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </section>
  );
}

function VerifySection({ providerId, onVerified }: { providerId: string; onVerified: () => void }) {
  const { t } = useLocale();
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState<null | { status: string; hint?: string }>(null);

  const run = async () => {
    setRunning(true); setRes(null);
    try {
      const r = await fetch(`/api/agents/providers/${providerId}/verify`, { method: "POST" });
      const d = await r.json();
      setRes({ status: d.status, hint: d.hint });
      if (d.status === "pass") void onVerified();
    } catch (e) {
      setRes({ status: "other_error", hint: e instanceof Error ? e.message : String(e) });
    } finally { setRunning(false); }
  };

  const pass = res?.status === "pass";
  return (
    <section className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("settings:providerSetup.verify")}
        </button>
        {res && (
          <span className={`text-[11px] ${pass ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
            {pass ? t("settings:providerSetup.verifyPass") : (res.hint || res.status)}
          </span>
        )}
      </div>
    </section>
  );
}
