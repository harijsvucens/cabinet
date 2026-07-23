# OpenCode + DeepSeek: Cache & Token Efficiency Plan

## Verdict

The cache token pipeline from DeepSeek → OpenCode → Cabinet **already works** (verified from opencode source, branch `dev`). Cabinet's `cachedInputTokens` tracks DeepSeek cache hits correctly. The work here is about **visibility, billing accuracy, and fallback robustness** -- not about fixing broken data flow.

### Cache token flow (confirmed from source)

```
DeepSeek API              OpenCode (openai-chat.ts)       JSON stream          Cabinet
──────────────────────────────────────────────────────────────────────────────────────
cached_tokens         →   cacheReadInputTokens       →   tokens.cache.read  →  cachedInputTokens ✓
prompt_tokens         →   inputTokens                →   tokens.input       →  inputTokens ✓
prompt_cache_hit      →   (NOT directly mapped,       →   ──                 →  ──
                          same value as cached_tokens)
```

**Key detail:** `tokens.input` in the JSON stream is **non-cached only** (opencode subtracts cached from total). So `totalInputTokens = inputTokens + cachedInputTokens`. This means Cabinet's `inputTokens` field represents fresh (cache-miss) tokens and `cachedInputTokens` represents cache-hit tokens. Both are correct for DeepSeek billing.

### DeepSeek KV cache semantics

- **Always on, no config required** -- every request automatically creates cache prefix units on SSD
- **Full prefix match from token 0** -- requires byte-identical prefixes (not substring overlap)
- **Minimum 64 tokens** to form a cache unit
- **Persists hours to days**, then auto-evicted
- **Pricing delta:** v4-flash: 50x cheaper on hit (0.0028 vs 0.14/M), v4-pro: 120x cheaper (0.0036 vs 0.435/M)
- In practice, multi-turn agents with stable system prompts see 90-95% cache hit rates

### What Cabinet already does well

- **Session resume** (`--session` flag) -- the #1 cache-hit driver for DeepSeek
- **Prefix-optimal system prompt** -- stable parts (persona, rules, epilogue) come first, dynamic user content last
- **`cachedInputTokens` tracking** -- reads `tokens.cache.read` from step_finish events correctly

---

## Phase 1: DeepSeek Fallback Models ✅ (implemented)

**File:** `src/lib/agents/providers/opencode.ts`

**Change:** Add `deepseek/deepseek-v4-pro` and `deepseek/deepseek-v4-flash` to `OPENCODE_FALLBACK_MODELS`.

**Why:** The static fallback list has OpenAI, Anthropic, Google, and xAI models but zero DeepSeek entries. When `opencode models` discovery fails (CLI cold start, network issue), the model picker shows misleading "offline defaults" from other providers. Adding DeepSeek ensures users always see realistic options. Aligned with DeepSeek's OpenCode integration guide and model documentation.

**Risk:** Zero. Two lines added to a const array used only as a fallback.

---

## Phase 2: Reasoning Token Separation ✅ (implemented)

**Files:**
- `src/lib/agents/adapters/types.ts` -- add `reasoningTokens` field to `AdapterUsageSummary`
- `src/lib/agents/adapters/opencode-stream.ts` -- stop merging reasoning into outputTokens; track separately
- `src/lib/agents/conversation-runner.ts` -- persist `reasoning` in conversation + turn tokens
- `src/lib/agents/daemon-client.ts` -- add `reasoningTokens` to daemon session output type
- `src/lib/agents/conversation-store.ts` -- add `reasoningTokens` to finalization input type
- `src/types/conversations.ts` -- add `reasoning` to `TurnTokens` and `ConversationTokens`

**Change:** OpenCode's JSON stream reports `tokens.reasoning` separately from `tokens.output`, but Cabinet's stream parser adds reasoning tokens into `outputTokens` (line 117-119), destroying the distinction. Add a `reasoningTokens` field to `AdapterUsageSummary` and track it independently.

**Why (DeepSeek):** DeepSeek v4 models support thinking mode with `reasoning_effort` parameter. Reasoning tokens are a distinct cost component. Even when billed at the same output rate, users need visibility into how much "thinking" each session consumed.

**Cost calculation:** DeepSeek bills reasoning tokens at the same output rate. Cabinet's cost calculations use `outputTokens + reasoningTokens` at the output rate. The UI should show reasoning as a separate line item with a tooltip: "Reasoning tokens represent the model's internal thinking steps and are invisible in the final text but billable at the output rate."

**Why (general):** All modern models with extended thinking (Claude, GPT-5, DeepSeek) report reasoning tokens separately. Having this field ready is forward-looking.

---

## Phase 3: Compaction via Config Injection (planned)

**File:** `src/lib/agents/adapters/opencode-local.ts`

**Change:** Replace the blanket `OPENCODE_DISABLE_PROJECT_CONFIG=true` env var with an injected `OPENCODE_CONFIG_CONTENT` that enables `compaction.prune` with conservative defaults.

**Important:** Verify the correct env var for disabling compaction. OpenCode supports `OPENCODE_DISABLE_AUTOCOMPACT` and `OPENCODE_DISABLE_PRUNE` as independent toggles. If only `OPENCODE_DISABLE_PROJECT_CONFIG` is set, compaction may still be active via global user config. Test which flags actually control compaction in practice and adjust accordingly.

**Why:** OpenCode's auto-compaction (via `SessionCompaction.isOverflow()`) removes stale tool outputs from context, keeping prompts lean. For DeepSeek's disk-based KV cache, shorter prompts mean:
- Faster prefill time (less to scan for cache misses)
- Cleaner cache prefix units (less noise bloat)
- Fewer cache-miss segments in long sessions

**Cache-aware pruning:** The injected config must preserve early, stable system prefixes (where DeepSeek's cache prefix units live) and primarily trim mid/tail tool outputs. Aggressive pruning of early tokens would destroy cache unit matches and reduce cache-hit rates. The config should be tested on representative DeepSeek agent workflows to confirm cache hit rates remain high and time-to-first-token improves.

---

## Future: Cache Write Tracking

**Files:** `types.ts`, `opencode-stream.ts`

**Change:** Track `tokens.cache.write` as `cacheWriteInputTokens` in `AdapterUsageSummary`.

**Why:** Shows how many tokens are being written to DeepSeek's disk cache (these become cache-hits on subsequent runs). Together with `cacheReadInputTokens`, enables computing an effective "cache ROI" metric per session (write cost vs. read savings).

**Pricing caveat:** Some providers charge differently for cache-write tokens or don't discount them at all. When wiring DeepSeek's cache-write equivalents, consult DeepSeek's latest pricing docs to ensure correct tier application.

---

## Implementation Plan

| Phase | Files | Lines | Risk | Value |
|-------|-------|-------|------|-------|
| P1: Fallback models | 1 | +3 | Zero | DeepSeek visible in picker when discovery fails |
| P2: Reasoning tokens | 3 | ~15 | Low | Correct billing for thinking mode sessions |
| P3: Config injection | 1 | ~10 | Medium | Auto-pruning for long sessions |
| P4: Cache write | 2 | ~8 | Low | Cache warming visibility (future) |

**Recommended PR scope:** Phase 1 + Phase 2 together. Phase 3 separately after testing compaction behavior on real DeepSeek sessions.
