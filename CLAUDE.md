# bakloop — monorepo

This repo is a pnpm-workspace monorepo with three packages:

| Package | Location | What |
|---|---|---|
| **engine** | `packages/engine/` | The bakloop orchestrator — moves Backlog.md tickets through a role pipeline into reviewed PRs. See `packages/engine/CLAUDE.md` for its hard constraints, working rules, and internal map. |
| **web** | `packages/web/` | Next.js app (App Router, TypeScript). Placeholder scaffold — real UI work deferred. |
| **shared** | `packages/shared/` | Placeholder for engine↔web shared code. Currently empty; wired as a dependency once `web` has a real need. |

Also repo-wide: a `wiki/` covering all packages — decisions, gotchas, current work.

To run anything: `pnpm --filter engine <script>` or `pnpm --filter web <script>`.
Root `package.json` is private — no scripts or dependencies live here.

Read `packages/engine/CLAUDE.md` for the full engine context (hard constraints, decisions, gotchas).
