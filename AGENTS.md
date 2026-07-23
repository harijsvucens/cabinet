# AGENTS.md — Cabinet

## Identity

Cabinet is an AI-first knowledge base. Three processes: **Next.js app** (port 4000), **Daemon** (port 4100), **Electron shell**. All content lives as markdown files on disk in `data/`. The repo is a direct clone of `https://github.com/cabinetai/cabinet.git` (source-custom install). See `CLAUDE.md` and `docs/CLAUDE.md` for the full subsystem ruleset.

---

## CRITICAL: File Safety Partition

```
SAFE (gitignored, survives all upstream pulls)     UNSAFE (tracked, DESTROYED on pull)
─────────────────────────────────────────────       ────────────────────────────────────
data/              ← KB content, agents, DB        src/           ← Next.js app code
.env.local         ← runtime config                server/        ← daemon code
.cabinet.env       ← auth salt                     electron/      ← desktop shell
.cabinet-install.json ← install metadata            cabinetai/     ← CLI package
skills-lock.json   ← skill bundle lock              cli/           ← create-cabinet
.agents/skills/    ← installed skills               scripts/       ← build/dev scripts
.claude/           ← Claude config                  package.json   ← dependencies
.audit-shots/      ← screenshots                    package-lock.json ← lockfile
data/.cabinet/     ← home manifest + AGENTS backup  tsconfig.json  ← TS config
                                                    next.config.ts ← Next config
                                                    docs/          ← tracked docs
                                                    CLAUDE.md      ← this file's cousin
                                                    PROGRESS.md    ← changelog
```

**Rule 0: NEVER create or edit files in the UNSAFE column unless you are prepared to lose them.**

---

## Mandatory: PROGRESS.md

After every change to this project, **append** an entry to `PROGRESS.md`:

```
[YYYY-MM-DD] Brief description of what changed in 1-3 sentences. What was verified.
```

This is non-negotiable. Existing entries are detailed — match that style. Add at the end of the file.

---

## Safe Editing — What You CAN Do

| Action | Safe? | Notes |
|--------|-------|-------|
| Create/edit files in `data/` | Yes | This is the whole point |
| Edit `.env.local` | Yes | Runtime config only |
| Append to `PROGRESS.md` | Yes | Append-only, resolve conflicts by keeping both sides |
| Append to `CLAUDE.md` | Yes | But keep it short; re-apply after pull if needed |
| Create new files in `data/.cabinet/` | Yes | Gitignored, perfect for persistent agent state |
| `npm install` (after pull) | Yes | Required after every upstream update |
| `npm run dev:all` / `npm run dev` | Yes | Start the app |
| Read any file | Yes | Reading is always safe |
| Create new files in `docs/` | Conditional | New files don't conflict UNLESS upstream adds the same file. Low risk, but not zero. |

## Forbidden Editing — NEVER Do This

| Action | Why |
|--------|-----|
| Edit `src/`, `server/`, `electron/` | Destroyed on next `git pull`. Contribute upstream instead. |
| Edit `scripts/` | Same. If you need custom scripts, put them in `data/.cabinet/scripts/`. |
| Edit `package.json` | Dependency changes vanish on pull. |
| Edit `tsconfig.json`, `next.config.ts` | Build config vanishes on pull. |
| Edit tracked docs in `docs/` | Core docs (CLAUDE.md, PRD.md, etc.) belong to upstream. |
| Run `git push` without explicit user instruction | Never push to origin. |
| Delete anything in `data/` without user approval | KB content is sacred. |
| Run `npm install` that changes `package-lock.json` | Only do this after a pull when upstream changed dependencies. |

---

## Upstream Update Workflow (CRITICAL)

When updating to the latest upstream version, follow this EXACT sequence. Do not improvise.

```
# PHASE 1: PRE-FLIGHT
git status                          # Review: are any tracked files modified?
git diff HEAD --name-only           # Be explicit about what's dirty
                                    # If ONLY CLAUDE.md + PROGRESS.md are modified → safe
                                    # If src/server/scripts/etc are modified → user must decide

# PHASE 2: BACKUP
cp -r data/ ../cabinet-data-backup-$(date +%Y%m%d-%H%M)/
# Or, if data/ has its own git repo:
git -C data/ add -A; if ($?) { git -C data/ commit -m "pre-update-backup-$(date +%Y%m%d)" }

# PHASE 3: STASH & PULL
git stash push -m "pre-update-$(date +%Y%m%d-%H%M)" --include-untracked
git pull --ff-only origin main
# If --ff-only fails: STOP. The branch diverged. Report to user. Do NOT force.

# PHASE 4: RESTORE & CONFLICT RESOLUTION
git stash pop
# If conflicts:
#   data/ files → ALWAYS keep stash (your data)
#   PROGRESS.md → accept both sides
#   CLAUDE.md   → accept incoming, re-append your custom section
#   package-lock.json → accept incoming, then run npm install
#   All others → accept incoming, re-apply your changes manually

# PHASE 5: RESTORE PERMISSIONS (WSL/Windows)
# Git on Windows/WSL loses the executable bit on scripts:
git diff --name-only HEAD | where { $_ -match '^scripts/' } | foreach { chmod +x $_ }

# PHASE 6: INSTALL & VERIFY
npm install
npm run build 2>&1 | Select-Object -Last 10  # quick compile check
npm run dev:all                               # verify app starts
# Verify localhost:4000 loads and localhost:4000/api/health returns 200
```

**If anything fails in Phase 6:** Do NOT continue. Report the exact error to the user. Do not try to fix upstream source code.

---

## Emergency Recovery

### If data/ gets corrupted:
```
git -C data/ log --oneline -10           # find last good commit
git -C data/ checkout <hash> -- .        # restore to that commit
```

### If source is broken after a pull:
```
git stash                                # stash local changes
git reset --hard HEAD~1                  # undo the pull
npm install                              # restore dependencies
npm run dev:all                          # verify it works
```

### If AGENTS.md / CLAUDE.md get destroyed:
```
cp data/.agents/AGENTS.md ./AGENTS.md   # restore from gitignored backup
```

### If PROGRESS.md has merge conflicts:
Keep both sides. PROGRESS.md is an append-only log — no content is ever wrong.

---

## Script Permissions (WSL/Windows)

WSL and Windows lose the executable bit on shell scripts. After ANY git operation that touches `scripts/`, run:

```
chmod +x scripts/*.sh
```

Affected scripts: `cleanup-cabinet-app.sh`, `launch-chrome-debug.sh`, `release.sh`, `restart-onboarding.sh`, plus any `.mjs` scripts that need it.

---

## Project Links

| File | What It Contains |
|------|-----------------|
| `CLAUDE.md` | Entry-point rules (what this project is, PROGRESS.md mandate, update safety) |
| `docs/CLAUDE.md` | Full subsystem ruleset (19 rules, architecture diagram, AI editing behavior) |
| `docs/UPSTREAM_UPDATE_STRATEGY.md` | Three upgrade paths (source-managed, fork+rebase, stash-only) |
| `PROGRESS.md` | Running changelog — append to this after every change |
| `docs/deployment-packaging-versioning.md` | How releases, installs, and updates work mechanically |
| `docs/PRD.md` | Product requirements |
| `data/.agents/AGENTS.md` | Backup of this file (gitignored, survives upstream destruction) |

---

## Quick Reference

```
npm run dev:all      # Start both Next.js + Daemon (dev mode)
npm run dev          # Next.js only
npm run dev:daemon   # Daemon only
npm run build        # Production build
npm run lint         # ESLint
npm run debug:chrome # Chrome with CDP on :9222

# Health checks while running:
curl http://localhost:4000/api/health         # App health
curl http://localhost:4000/api/health/daemon  # Daemon bridge health
```

---

## Master Copy

**This file's permanent home is `data/.agents/AGENTS.md`** (gitignored, survives all upstream updates). The root `AGENTS.md` is a convenience copy. If the root copy is ever destroyed by an upstream pull, restore it:

```
cp data/.agents/AGENTS.md ./AGENTS.md
```
