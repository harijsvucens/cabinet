/**
 * Inbound message routing for the Telegram remote-control gateway (PRD
 * docs/TELEGRAM_REMOTE_CONTROL_PRD.md §6–§8).
 *
 * Security gates run in order: DM-only → allowlist (fail-closed) → optional
 * TELEGRAM_CHAT_ID scope → rate limit (10/60s rolling). Only then is the
 * message routed to a command or an agent run.
 *
 * Run model: first message starts a conversation (startConversationRun),
 * later messages continue it (continueConversationRun). `@slug` is a one-shot
 * side conversation that never touches the chat's main pointer. Completion is
 * detected by the gateway's own poll loop with an explicit week-long deadline
 * — never the runner's onComplete (15-min hard cap upstream).
 */

import path from "path";
import {
  buildManualConversationPrompt,
  startConversationRun,
  continueConversationRun,
} from "../../src/lib/agents/conversation-runner";
import {
  extractAgentTurnContent,
  readConversationMeta,
  readConversationTurns,
} from "../../src/lib/agents/conversation-store";
import {
  getDaemonSessionOutput,
  listDaemonSessions,
  pollDaemonSessionUntilDone,
  stopDaemonSession,
} from "../../src/lib/agents/daemon-client";
import {
  listPersonas,
  readPersona,
  type AgentPersona,
} from "../../src/lib/agents/persona-manager";
import { listRooms } from "../../src/lib/cabinets/rooms";
import { DATA_DIR } from "../../src/lib/storage/path-utils";
import { runSearch, type SearchSources } from "../search/search-service";
import { stripAnsi } from "../pty/ansi";
import { parseAtMention } from "./parse";
import { BotApi, type TgMessage } from "./bot-api";
import type { TelegramGatewayConfig } from "./config";
import {
  chunkText,
  previewText,
  renderMarkdownV2,
  TELEGRAM_MESSAGE_LIMIT,
} from "./format";
import {
  checkAndRecordRate,
  getChatState,
  resetConversation,
  switchRoom,
  type ChatState,
} from "./session-store";

/** Effectively unbounded (one week) — the no-run-timeout decision, PRD §2. */
const GATEWAY_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;
const EDIT_THROTTLE_MS = 1500;
const TYPING_REFRESH_MS = 4000;
/** Telegram's getFile cap is 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface RouterContext {
  api: BotApi;
  cfg: TelegramGatewayConfig;
  botUsername: string;
  getSearchSources: () => Promise<SearchSources>;
  log: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleMessage(ctx: RouterContext, msg: TgMessage): Promise<void> {
  // DM-only (PRD §11): ignore groups/channels entirely — no reply, no log spam.
  if (msg.chat.type !== "private") return;

  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!userId || msg.from?.is_bot) return;

  const state = getChatState(chatId);

  // Allowlist, fail-closed. One refusal reply per chat, then silence.
  if (!ctx.cfg.allowedUserIds.includes(userId)) {
    ctx.log(`denied user ${hashId(userId)} (not on allowlist)`);
    if (!state.refusalSent) {
      state.refusalSent = true;
      await safeSend(ctx, chatId, "This bot is private. Your Telegram user id is not on its allowlist.");
    }
    return;
  }

  // Optional extra scoping to one chat.
  if (ctx.cfg.allowedChatId !== null && chatId !== ctx.cfg.allowedChatId) return;

  // Rolling rate limit (separate from the one-deep run queue).
  if (!checkAndRecordRate(state, Date.now())) {
    await safeSend(ctx, chatId, "⏳ Slow down a little — try again in a moment.");
    return;
  }

  // Files/photos stage for the next message (or run now when captioned).
  if (msg.document || (msg.photo && msg.photo.length > 0)) {
    await handleIncomingFile(ctx, state, msg);
    return;
  }

  const text = (msg.text ?? "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    await handleCommand(ctx, state, text);
    return;
  }

  const atMention = parseAtMention(text);
  await enqueueOrRun(ctx, state, atMention?.rest ?? text, atMention?.slug ?? null);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleCommand(ctx: RouterContext, state: ChatState, text: string): Promise<void> {
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@[a-z0-9_]+$/i, ""); // strip /cmd@botname
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start": {
      const orchestrator = await resolveOrchestrator(ctx, state);
      await safeSend(
        ctx,
        state.chatId,
        [
          `Connected to Cabinet via @${ctx.botUsername}.`,
          `Send a message and ${orchestrator} will handle it in ${roomLabel(state)}.`,
          `Prefix with @slug to target one agent once. /help lists everything.`,
        ].join("\n")
      );
      return;
    }
    case "/help": {
      const orchestrator = await resolveOrchestrator(ctx, state);
      await safeSend(
        ctx,
        state.chatId,
        [
          "Commands:",
          "/new — start a fresh conversation",
          "/status — active run, queue, room, verbosity",
          "/stop — cancel the active run",
          "/search <query> — search the knowledge base",
          "/agents — list agents you can @-target",
          "/room [<slug>] — show or switch the active room",
          "/verbose — toggle live output streaming",
          "",
          `Plain text runs ${orchestrator} in ${roomLabel(state)}.`,
          "@slug <text> runs one message against that agent.",
          "Send a file or photo to attach it to your next message.",
          "Sessions reset when the Cabinet daemon restarts.",
        ].join("\n")
      );
      return;
    }
    case "/new": {
      resetConversation(state);
      await safeSend(ctx, state.chatId, "🆕 Fresh conversation. What's next?");
      return;
    }
    case "/status": {
      const lines: string[] = [];
      if (state.activeRun) {
        const mins = Math.round((Date.now() - state.activeRun.startedAt) / 6000) / 10;
        lines.push(`▶️ Run active (${mins} min) in conversation ${state.activeRun.conversationId}.`);
      } else {
        lines.push("💤 No active run.");
      }
      if (state.queued) lines.push(`⏳ Queued: "${previewText(state.queued.text)}"`);
      if (state.stagedAttachments.length > 0) {
        lines.push(`📎 ${state.stagedAttachments.length} file(s) staged for the next message.`);
      }
      lines.push(`Room: ${roomLabel(state)} · Verbose: ${state.verbose ? "on" : "off"}`);
      await safeSend(ctx, state.chatId, lines.join("\n"));
      return;
    }
    case "/stop": {
      await stopActiveRun(ctx, state);
      return;
    }
    case "/search": {
      if (!arg) {
        await safeSend(ctx, state.chatId, "Usage: /search <query>");
        return;
      }
      await runSearchCommand(ctx, state, arg);
      return;
    }
    case "/agents": {
      await runAgentsCommand(ctx, state);
      return;
    }
    case "/room": {
      await runRoomCommand(ctx, state, arg);
      return;
    }
    case "/verbose": {
      state.verbose = !state.verbose;
      await safeSend(
        ctx,
        state.chatId,
        state.verbose
          ? "🔊 Verbose on — streaming live output."
          : "🔇 Verbose off — concise replies only."
      );
      return;
    }
    default:
      await safeSend(ctx, state.chatId, `Unknown command ${cmd} — try /help.`);
  }
}

function roomLabel(state: ChatState): string {
  return state.roomPath ? `room "${state.roomPath}"` : "the home cabinet";
}

async function runSearchCommand(ctx: RouterContext, state: ChatState, query: string): Promise<void> {
  const sources = await ctx.getSearchSources();
  const resp = runSearch(sources, query, "all", 5, state.roomPath ?? undefined);
  const lines: string[] = [];
  for (const p of resp.pages.slice(0, 5)) lines.push(`📄 ${p.title} — ${p.path}`);
  for (const a of resp.agents.slice(0, 3)) lines.push(`🤖 ${a.title}${a.role ? ` — ${a.role}` : ""}`);
  for (const t of resp.tasks.slice(0, 3)) lines.push(`✅ ${t.title}${t.agent ? ` (${t.agent})` : ""}`);
  await safeSend(
    ctx,
    state.chatId,
    lines.length > 0
      ? `Results for "${query}" in ${roomLabel(state)}:\n${lines.join("\n")}`
      : `No results for "${query}" in ${roomLabel(state)}.`
  );
}

async function runAgentsCommand(ctx: RouterContext, state: ChatState): Promise<void> {
  const personas = await listPersonas(state.roomPath ?? undefined);
  if (personas.length === 0) {
    await safeSend(ctx, state.chatId, `No agents in ${roomLabel(state)} yet.`);
    return;
  }
  const orchestrator = await resolveOrchestrator(ctx, state);
  const lines = personas.map((p) => {
    const mark = p.slug === orchestrator ? " ⭐ (orchestrator)" : "";
    return `@${p.slug} — ${p.role || p.name}${mark}`;
  });
  await safeSend(
    ctx,
    state.chatId,
    `Agents in ${roomLabel(state)} (prefix a message with @slug to target one):\n${lines.join("\n")}`
  );
}

async function runRoomCommand(ctx: RouterContext, state: ChatState, arg: string): Promise<void> {
  const rooms = await listRooms();
  if (!arg) {
    const list = rooms.length > 0 ? rooms.map((r) => `• ${r.path} — ${r.name}`).join("\n") : "(no rooms)";
    await safeSend(
      ctx,
      state.chatId,
      `Active: ${roomLabel(state)}.\nRooms:\n${list}\nSwitch with /room <slug>, or /room home.`
    );
    return;
  }
  if (arg === "home" || arg === "/") {
    switchRoom(state, null);
    await safeSend(ctx, state.chatId, "🏠 Switched to the home cabinet. Fresh conversation.");
    return;
  }
  const match = rooms.find((r) => r.path === arg);
  if (!match) {
    const list = rooms.map((r) => `• ${r.path}`).join("\n");
    await safeSend(ctx, state.chatId, `No room "${arg}". Available:\n${list || "(none)"}`);
    return;
  }
  switchRoom(state, match.path);
  await safeSend(ctx, state.chatId, `📂 Switched to room "${match.name}". Fresh conversation.`);
}

// ---------------------------------------------------------------------------
// Orchestrator resolution (PRD §7)
// ---------------------------------------------------------------------------

function personaCanDispatch(p: AgentPersona): boolean {
  if (typeof p.canDispatch === "boolean") return p.canDispatch;
  return p.type === "lead";
}

async function resolveOrchestrator(ctx: RouterContext, state: ChatState): Promise<string> {
  if (state.orchestratorSlug) return state.orchestratorSlug;
  const cabinetPath = state.roomPath ?? undefined;

  let slug: string | null = null;
  if (ctx.cfg.defaultAgent) {
    const persona = await readPersona(ctx.cfg.defaultAgent, cabinetPath);
    if (persona) slug = ctx.cfg.defaultAgent;
  }
  if (!slug) {
    const personas = await listPersonas(cabinetPath);
    slug = personas.find(personaCanDispatch)?.slug ?? null;
  }
  if (!slug) slug = "editor";

  state.orchestratorSlug = slug;
  return slug;
}

// ---------------------------------------------------------------------------
// Queue + run
// ---------------------------------------------------------------------------

async function enqueueOrRun(
  ctx: RouterContext,
  state: ChatState,
  text: string,
  atMention: string | null
): Promise<void> {
  if (state.busy) {
    if (state.queued) {
      await safeSend(ctx, state.chatId, "⏳ One message is already queued — try again after it runs.");
      return;
    }
    state.queued = { text, atMention, queuedAt: Date.now() };
    await safeSend(ctx, state.chatId, "⏳ Queued — will run when the current task finishes.");
    return;
  }
  state.busy = true; // claimed synchronously; released in runMessage's finally
  await runMessage(ctx, state, text, atMention);
}

async function runMessage(
  ctx: RouterContext,
  state: ChatState,
  text: string,
  atMention: string | null
): Promise<void> {
  const cabinetPath = state.roomPath ?? undefined;
  const staged = state.stagedAttachments.splice(0);

  // Resolve the target agent. Unknown @slug → orchestrator with a note.
  let note = "";
  let targetSlug: string;
  let oneShot = false;
  if (atMention) {
    const persona = await readPersona(atMention, cabinetPath);
    if (persona) {
      targetSlug = atMention;
      oneShot = true;
    } else {
      targetSlug = await resolveOrchestrator(ctx, state);
      note = `(no agent @${atMention} here — using ${targetSlug})\n`;
    }
  } else {
    targetSlug = await resolveOrchestrator(ctx, state);
  }

  const placeholder = await safeSend(ctx, state.chatId, `${note}🧠 thinking…`);
  if (!placeholder) return;

  const typingTimer = setInterval(() => {
    void ctx.api.sendChatAction(state.chatId, "typing").catch(() => {});
  }, TYPING_REFRESH_MS);
  void ctx.api.sendChatAction(state.chatId, "typing").catch(() => {});

  try {
    let conversationId: string;
    let runPromise: Promise<{ finalText: string; failed: boolean }>;

    // A deleted conversation (e.g. removed from the app's task board) falls
    // back to a fresh start instead of erroring at the user.
    if (
      state.conversationId !== null &&
      !(await conversationStillExists(state.conversationId, cabinetPath))
    ) {
      state.conversationId = null;
    }

    const continuing = !oneShot && state.conversationId !== null;
    if (continuing) {
      conversationId = state.conversationId!;
      runPromise = executeContinue(ctx, conversationId, cabinetPath, text, staged);
    } else {
      const built = await buildManualConversationPrompt({
        agentSlug: targetSlug,
        userMessage: text,
        cabinetPath,
      });
      const meta = await startConversationRun({
        agentSlug: targetSlug,
        title: built.title,
        trigger: "telegram",
        prompt: built.prompt,
        providerId: built.providerId,
        adapterType: built.adapterType,
        adapterConfig: built.adapterConfig,
        cwd: built.cwd,
        cabinetPath,
        attachmentPaths: staged.length > 0 ? staged : undefined,
      });
      conversationId = meta.id;
      if (!oneShot) state.conversationId = meta.id;
      runPromise = executeStart(meta.id);
    }

    state.activeRun = {
      conversationId,
      kind: continuing ? "continue" : "start",
      startedAt: Date.now(),
      stopRequested: false,
    };

    const result = await streamRunToChat(ctx, state, placeholder.message_id, conversationId, runPromise);
    await finalizeReply(ctx, state, placeholder.message_id, result.finalText, result.failed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Run failed to start.";
    await safeEdit(ctx, state.chatId, placeholder.message_id, `❌ ${message}`);
    ctx.log(`run error: ${message}`);
  } finally {
    clearInterval(typingTimer);
    state.activeRun = null;
    // One-deep queue drains as soon as the slot frees; `busy` stays claimed
    // across the drain so a new inbound message queues behind it.
    const next = state.queued;
    state.queued = null;
    if (next) {
      await runMessage(ctx, state, next.text, next.atMention);
    } else {
      state.busy = false;
    }
  }
}

/** First turn: the daemon session id IS the conversation id. */
async function executeStart(conversationId: string): Promise<{ finalText: string; failed: boolean }> {
  const result = await pollDaemonSessionUntilDone(conversationId, {
    intervalMs: 1000,
    deadlineMs: GATEWAY_DEADLINE_MS, // explicit — the helper's 15-min default throws
  });
  const raw = (result.output || "").trim();
  const finalText = raw ? extractAgentTurnContent(raw) || raw : "(no response)";
  return { finalText, failed: result.status !== "completed" };
}

/** Follow-up turn: continueConversationRun awaits the whole turn. */
async function executeContinue(
  ctx: RouterContext,
  conversationId: string,
  cabinetPath: string | undefined,
  text: string,
  staged: string[]
): Promise<{ finalText: string; failed: boolean }> {
  const meta = await continueConversationRun(conversationId, {
    userMessage: text,
    cabinetPath,
    attachmentPaths: staged.length > 0 ? staged : undefined,
    timeoutMs: GATEWAY_DEADLINE_MS, // explicit — defaults to 15 min upstream
  });
  if (!meta) return { finalText: "Conversation not found — /new to start fresh.", failed: true };
  const turns = await readConversationTurns(conversationId, cabinetPath);
  const lastAgent = [...turns].reverse().find((t) => t.role === "agent" && !t.pending);
  return {
    finalText: lastAgent?.content?.trim() || "(no response)",
    failed: !!lastAgent?.error || (lastAgent?.exitCode ?? 0) !== 0,
  };
}

/**
 * While the run promise is pending, poll the live daemon session and edit the
 * placeholder. Concise mode shows the parsed assistant text; verbose shows
 * the raw output tail. Edits are throttled and deduped.
 */
async function streamRunToChat(
  ctx: RouterContext,
  state: ChatState,
  placeholderId: number,
  conversationId: string,
  runPromise: Promise<{ finalText: string; failed: boolean }>
): Promise<{ finalText: string; failed: boolean }> {
  let settled = false;
  let lastEdited = "";
  const settle = runPromise.finally(() => {
    settled = true;
  });

  void (async () => {
    let sessionId: string | null = null;
    while (!settled) {
      await sleep(EDIT_THROTTLE_MS);
      if (settled) break;
      try {
        sessionId ??= await resolveLiveSessionId(conversationId);
        if (!sessionId) continue;
        const data = await getDaemonSessionOutput(sessionId);
        const raw = stripAnsi(data.output || "");
        const partial = state.verbose
          ? tail(raw, TELEGRAM_MESSAGE_LIMIT - 64)
          : previewStream(extractAgentTurnContent(raw) || "");
        if (partial && partial !== lastEdited) {
          lastEdited = partial;
          await safeEdit(ctx, state.chatId, placeholderId, `🧠 ${partial}`);
        }
      } catch {
        // transient — keep polling until the run settles
      }
    }
  })();

  return settle;
}

/**
 * Find the pollable daemon session for a conversation: the conversation id
 * itself (turn 1) or the newest `${id}::t…` continuation run.
 */
async function resolveLiveSessionId(conversationId: string): Promise<string | null> {
  try {
    const sessions = await listDaemonSessions();
    const candidates = sessions
      .filter((s) => !s.exited && (s.id === conversationId || s.id.startsWith(`${conversationId}::t`)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return candidates[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function finalizeReply(
  ctx: RouterContext,
  state: ChatState,
  placeholderId: number,
  finalText: string,
  failed: boolean
): Promise<void> {
  if (state.activeRun?.stopRequested) {
    await safeEdit(ctx, state.chatId, placeholderId, "🛑 Stopped.");
    return;
  }
  const body = failed ? `❌ ${finalText}` : finalText;
  const chunks = chunkText(body);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await sendRich(ctx, state.chatId, chunks[i], placeholderId);
    } else {
      await sendRich(ctx, state.chatId, chunks[i], null);
    }
  }
}

/** MarkdownV2 first; on rejection resend the same text plain (PRD §8). */
async function sendRich(
  ctx: RouterContext,
  chatId: number,
  text: string,
  editMessageId: number | null
): Promise<void> {
  const rendered = renderMarkdownV2(text);
  try {
    if (editMessageId !== null) {
      await ctx.api.editMessageText(chatId, editMessageId, rendered, { parseMode: "MarkdownV2" });
    } else {
      await ctx.api.sendMessage(chatId, rendered, { parseMode: "MarkdownV2" });
    }
  } catch {
    try {
      if (editMessageId !== null) {
        await ctx.api.editMessageText(chatId, editMessageId, text);
      } else {
        await ctx.api.sendMessage(chatId, text);
      }
    } catch (err) {
      ctx.log(`reply failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function stopActiveRun(ctx: RouterContext, state: ChatState): Promise<void> {
  const run = state.activeRun;
  if (!run) {
    await safeSend(ctx, state.chatId, "Nothing is running.");
    return;
  }
  run.stopRequested = true;
  const sessionId = await resolveLiveSessionId(run.conversationId);
  const stopped = sessionId ? await stopDaemonSession(sessionId).catch(() => false) : false;
  await safeSend(
    ctx,
    state.chatId,
    stopped ? "🛑 Stopping the run…" : "Couldn't reach the run — it may already be finishing."
  );
}

// ---------------------------------------------------------------------------
// Files (PRD §6: attach to next message)
// ---------------------------------------------------------------------------

async function handleIncomingFile(ctx: RouterContext, state: ChatState, msg: TgMessage): Promise<void> {
  const doc = msg.document;
  const photo = msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined;
  const fileId = doc?.file_id ?? photo?.file_id;
  const size = doc?.file_size ?? photo?.file_size ?? 0;
  if (!fileId) return;

  if (size > MAX_FILE_BYTES) {
    await safeSend(ctx, state.chatId, "That file is over Telegram's 20 MB bot limit — try a smaller one.");
    return;
  }

  try {
    const info = await ctx.api.getFile(fileId);
    if (!info.file_path) throw new Error("Telegram returned no file path.");
    const baseName = sanitizeFileName(doc?.file_name ?? `photo-${msg.date}.jpg`);
    const relDir = path.posix.join(state.roomPath ?? "", ".agents", "telegram", "files");
    const virtualPath = path.posix.join(relDir, `${Date.now()}-${baseName}`);
    await ctx.api.downloadFile(info.file_path, path.join(DATA_DIR, virtualPath));
    state.stagedAttachments.push(virtualPath);

    const caption = (msg.caption ?? "").trim();
    if (caption) {
      // Captioned upload = "here's the file AND what to do with it" — run now.
      const atMention = parseAtMention(caption);
      await enqueueOrRun(ctx, state, atMention?.rest ?? caption, atMention?.slug ?? null);
    } else {
      await safeSend(ctx, state.chatId, "📎 Attached — what should I do with it?");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "download failed";
    await safeSend(ctx, state.chatId, `Couldn't fetch that file (${message}).`);
  }
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
  return base.length > 0 && base !== "." && base !== ".." ? base.slice(0, 120) : "file";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function safeSend(ctx: RouterContext, chatId: number, text: string): Promise<TgMessage | null> {
  try {
    return await ctx.api.sendMessage(chatId, text);
  } catch (err) {
    ctx.log(`send failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function safeEdit(ctx: RouterContext, chatId: number, messageId: number, text: string): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text.slice(0, TELEGRAM_MESSAGE_LIMIT));
  } catch {
    // "message is not modified" and transient edit failures are non-fatal
  }
}

function previewStream(text: string): string {
  return tail(text.trim(), TELEGRAM_MESSAGE_LIMIT - 64);
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Telemetry-grade pseudonym — never log raw Telegram user ids. */
function hashId(id: number): string {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(16)}`;
}

async function conversationStillExists(
  conversationId: string,
  cabinetPath: string | undefined
): Promise<boolean> {
  try {
    return (await readConversationMeta(conversationId, cabinetPath)) !== null;
  } catch {
    return false;
  }
}
