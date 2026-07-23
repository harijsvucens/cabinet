# CLAUDE.md

Cabinet is a self-hosted, AI-first knowledge base and "startup OS". Knowledge-base content lives as
markdown files on disk; AI agents (backed by local CLI providers) read and
write those files on schedules or on demand. Humans define intent, agents do the work

`docs/CLAUDE.md` holds a longer, feature-by-feature ruleset (skills, knowledge sources, registry,
editor). Read it when you touch those subsystems.

`AGENTS.md` is the **canonical instruction file** for AI agents working on this project. Read it
first. It covers file safety, update workflows, and emergency recovery. A gitignored backup lives
at `data/.agents/AGENTS.md` — restore from there if the root copy is ever destroyed.

Three processes and a data directory. Understanding the split is most of the battle.

**1. Next.js app
**2. Daemon
**3. Electron shell 

## PROGRESS.md

After every change to this project, append an entry to `PROGRESS.md`:

```
[YYYY-MM-DD] Brief description of what changed.
```

This is mandatory and is the project's running changelog. Existing entries are detailed (what changed,
why, what was verified) — match that.

## Upstream Update Safety (CRITICAL)

This is a **source-custom** install (git clone of `cabinetai/cabinet`). Upstream pulls overwrite
tracked source files. Read `AGENTS.md` for the full file safety partition and update workflow.

**What survives upstream updates:**
- `data/` (all KB content, agent configs, skills, conversations — gitignored)
- `.env.local`, `.cabinet.env`, `skills-lock.json`, `.agents/skills/` (all gitignored)

**What does NOT survive:**
- Any edit to tracked source files (src/, server/, electron/, scripts/, package.json, etc.)

**Before any git pull:**
- `git stash` your changes
- Backup `data/` (the update workflow in AGENTS.md has the exact commands)