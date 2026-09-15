# Split bakloop into a pnpm-workspace monorepo (engine / web / shared)

## Context

bakloop today is a single flat npm package: the orchestrator (`src/`, `prompts/`, `wiki/`,
`CLAUDE.md`, `README.md`) at the repo root. The user wants to add a web GUI next to it
without entangling the two, so the repo needs to become a monorepo with three packages:

- **`engine`** — the existing orchestrator, moved as-is under its own package. This is the
  "main" codebase; nothing about its behavior changes, only its location.
- **`web`** — a new, plain Next.js app (App Router, TypeScript). No real UI work now — this
  phase is scaffolding only, deferred to a later phase.
- **`shared`** — a placeholder package for code both `engine` and `web` will eventually
  import. Left empty/minimal in this phase; real extraction happens once `web` actually
  needs data from `engine` (per CLAUDE.md's "don't build for hypothetical future
  requirements").

Package manager: switching to **pnpm workspaces**. A `pnpm-workspace.yaml` already exists
in the repo (currently just an `allowBuilds` block, no `packages:` list — leftover from an
earlier abandoned attempt) alongside a stale `pnpm-lock.yaml`, while the repo is actually
installed and run via npm (`package-lock.json`, npm-managed `node_modules`). This migration
finishes that half-done switch: npm artifacts are removed, pnpm becomes the real, only
package manager.

Note: `src/spec.ts`, `src/routing.test.ts`, and `wiki/gotchas.md`/`wiki/current-work.md`
have uncommitted in-progress changes (an unrelated bug-fix session, per git status). These
must move with the rest of `src/`/`wiki/` intact — use plain file moves (`git mv`/`mv`),
never a checkout/reset that would discard them.

## Target layout

```
/ (repo root)
  package.json            — private root, no scripts/deps of its own
  pnpm-workspace.yaml      — packages: ["packages/*"]
  pnpm-lock.yaml           — regenerated
  .gitignore               — unchanged (already covers .next/, dist/, node_modules/)
  CLAUDE.md                — short monorepo map, points into packages/engine/CLAUDE.md
  README.md                — short monorepo overview + links to each package's README
  packages/
    engine/
      package.json         — name "engine", today's scripts/deps, unchanged behavior
      tsconfig.json         (as today)
      CLAUDE.md             (today's full content, path references adjusted)
      README.md             (today's full README, moved as-is)
      src/  prompts/  wiki/  (moved as-is)
    web/
      package.json         — name "web", plain `create-next-app`-equivalent scripts
      next.config.ts, tsconfig.json, app/layout.tsx, app/page.tsx
      (App Router, TypeScript, no styling/UI decisions — placeholder page only)
    shared/
      package.json         — name "shared", empty placeholder
      tsconfig.json
      src/index.ts          — placeholder export, nothing extracted from engine yet
```

`raw/` and `tmp/` are untracked/gitignored scratch dirs used by the orchestrator at
runtime — move them physically under `packages/engine/` too so relative paths the engine
code assumes (cwd-relative) keep working; verify by grepping `src/` for `"raw/"` and
`"tmp/"` path literals before moving, and fix any that assume repo-root cwd.

## Steps

1. **Create `packages/engine/` and move the orchestrator into it** with `git mv`:
   `src/`, `prompts/`, `wiki/`, `CLAUDE.md`, `README.md`, `tsconfig.json`. Move untracked
   `raw/`, `tmp/` with `mv`. Update `packages/engine/package.json` (moved from root) to
   `"name": "engine"`, keep its scripts/deps as-is (they're already relative to that
   directory once it's the package cwd).

2. **Grep for root-relative assumptions** now broken by the move: any `src/*.ts` code or
   `prompts/*.md` file that hardcodes a path like `"./raw"`, `"./tmp"`, `"./prompts"`,
   `process.cwd()` combined with a root-relative join, or references to `wiki/`,
   `CLAUDE.md`, `README.md` by absolute-from-repo-root path. Fix each to be relative to
   `packages/engine` (they mostly already will be, since the code presumably resolves
   paths relative to its own module directory or cwd — verify, don't assume).

3. **Fix internal doc cross-references.** `packages/engine/CLAUDE.md` and
   `packages/engine/README.md` reference `src/`, `wiki/`, `prompts/` — those stay correct
   since they're relative to the engine package itself. Add one line near the top of
   `packages/engine/CLAUDE.md` noting this is one package in a pnpm workspace (root
   `CLAUDE.md` is the entry point for repo layout).

4. **Write a new minimal root `CLAUDE.md`**: a short monorepo map (three packages, one
   line each on what they are) and a pointer to `packages/engine/CLAUDE.md` for the actual
   hard constraints and working rules — don't duplicate any of engine's content per
   CLAUDE.md's own "one fact, one home" rule.

5. **Write a new minimal root `README.md`**: what the repo is, the three packages, and
   how to install/run (`pnpm install` once at the root, `pnpm --filter engine <script>` /
   `pnpm --filter web dev` per package). Move the existing detailed README content into
   `packages/engine/README.md` (done in step 1) rather than keeping two copies.

6. **Scaffold `packages/web/`**: plain Next.js (App Router, TypeScript, no Tailwind/UI
   decisions since UI work is deferred) — `package.json` (name `web`, `dev`/`build`/
   `start`/`lint` scripts), `next.config.ts`, `tsconfig.json`, `app/layout.tsx` and
   `app/page.tsx` with placeholder content only.

7. **Scaffold `packages/shared/`**: `package.json` (name `shared`), `tsconfig.json`,
   `src/index.ts` exporting nothing real yet (a placeholder). Do not extract any types
   from `engine` in this phase — wire it as a workspace dependency of `web` only once
   `web` has a real need for it.

8. **Root workspace config**: new root `package.json` (`"private": true`, no
   `dependencies`/`scripts` of its own — each package owns its own), and
   `pnpm-workspace.yaml` updated to add `packages: ["packages/*"]` alongside the existing
   `allowBuilds` block.

9. **Remove stale npm artifacts**: delete root `package-lock.json` and root
   `node_modules/` (npm-managed leftover). Run `pnpm install` at the root to regenerate
   `pnpm-lock.yaml` and populate `node_modules` for all three packages.

10. **Verify**: `pnpm --filter engine run typecheck && pnpm --filter engine test` must
    pass exactly as before (same 36+ tests, no behavior change — this is a pure move).
    `pnpm --filter web run build` must succeed on the scaffolded Next.js app. Confirm
    `git status` shows the uncommitted `spec.ts`/`routing.test.ts`/`wiki/*.md` changes
    still present as modifications under their new `packages/engine/` paths (not lost,
    not reverted).

## Files/areas to touch

- Move (git mv): `src/**`, `prompts/**`, `wiki/**`, `CLAUDE.md`, `README.md`,
  `tsconfig.json` → `packages/engine/`
- Move (mv, untracked): `raw/`, `tmp/` → `packages/engine/`
- New: `packages/web/*` (Next.js scaffold), `packages/shared/*` (placeholder)
- Rewrite: root `package.json`, root `CLAUDE.md`, root `README.md`,
  `pnpm-workspace.yaml`
- Delete: root `package-lock.json`, root `node_modules/` (regenerated via `pnpm install`)
- Keep: `.gitignore` as-is (already covers `.next/`, `dist/`, `node_modules/`)
