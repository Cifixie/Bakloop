# bakloop

A local, backlog-driven agent loop that turns raw [Backlog.md](https://github.com/MrLesk/Backlog.md)
tickets into reviewed, branch-isolated pull requests — running entirely against a
local model.

This is a pnpm-workspace monorepo with three packages:

- **`packages/engine/`** — the bakloop orchestrator (full details below)
- **`packages/web/`** — Next.js web app (placeholder scaffold)
- **`packages/shared/`** — shared types/utilities (placeholder)
- **`wiki/`** — repo-wide: decisions, gotchas, current work

## Quick start

```bash
pnpm install                # install all workspace packages
pnpm --filter engine start <project>   # run the orchestrator
pnpm --filter web dev       # start the web app
```

See `packages/engine/README.md` for the full engine README (how it works, safety model,
setup, running, observability).
