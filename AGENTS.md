# Cabinet

AI-first knowledge base and startup OS.

## Tech Stack
- Next.js 16.2 (App Router), TypeScript, Tailwind CSS v4, shadcn/ui
- Zustand (state), Tiptap (editor), xterm.js (terminal)
- better-sqlite3 (db), simple-git (versioning), node-cron (scheduler)
- node-pty (terminal), chokidar (file watcher)

## Project Structure
```
src/app/api/       -> Next.js API routes
src/components/    -> React components
src/stores/        -> Zustand stores
src/lib/           -> Storage, markdown, git, agents, jobs
server/            -> Daemon (WebSocket + scheduler + agent executor)
resources/         -> Seed content templates
data/              -> Runtime user data (git-backed, .gitignored)
```

## Key Commands
| Command | Description |
|---------|-------------|
| npm run dev | Next.js dev server (port 4000) |
| npm run dev:daemon | Daemon server (port 4100) |
| npm run dev:all | Both servers |
| npm run build | Production build |
| npm run start | Production mode |
| npm run lint | ESLint |
| npm test | Run tests |

## Dev Setup
- Node 22+, run from WSL at ~/cabinet
- cp .env.example .env.local
- npm ci to install
- npm run dev:all to start

## Notes
- Two servers: Next.js app (4000) + Daemon (4100)
- Resources/ gets seeded into data/ on first run
- data/ is git-backed and auto-indexed
- Run on Windows via Cabinet.bat desktop shortcut

## gstack Skills
gstack (https://github.com/garrytan/gstack) is installed at `C:\Users\likkmrl\.config\opencode\skills\gstack`. Available skills include: /investigate, /qa, /review, /ship, /land-and-deploy, /plan-ceo-review, /plan-eng-review, /office-hours, /autoplan, /context-save, /context-restore, /design-review, /health, /retro, /cso, /make-pdf, /setup-deploy, /setup-gbrain, and more.

## gstack Deploy Configuration
- Platform: self-hosted (Next.js app + daemon) + npm packages
- Production URL: not configured (local development only)
- Deploy workflow: manual (`npm run build` + `npm run start`) for web app; tag-triggered GitHub Actions for npm packages (`cabinetai`, `create-cabinet`)
- Deploy status command: not configured
- Merge method: squash
- Project type: web app + npm packages
