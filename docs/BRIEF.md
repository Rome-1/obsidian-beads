# Build brief — Beads for Obsidian

Canonical build brief for the `crockford` crew. (The origin request lives in hq as
`hq-wg0cq`, but this rig's `bd` is an isolated embedded DB — see Workflow — so this
file is the local source of truth.)

## Mission

A **desktop-only** Obsidian community plugin that shells out to the Beads (`bd`) CLI
via Node `child_process` and renders a **live, clickable beads pane**. The headline
feature is *real* integration: **close an issue straight from a checkbox.**

Endgame: shipped to the Obsidian community-plugin registry.

## Core loop (the MVP)

1. **Setting**: a configurable project root (a directory containing `.beads/`).
2. **Read**: shell out to `bd list --json` and parse it.
3. **Render**: draw the issues into a custom `WorkspaceLeaf` `ItemView` pane
   (register via `registerView` + a ribbon/command to open it).
4. **Refresh**: on an interval and/or when the `.beads` directory changes.
5. **Close**: a checkbox per issue → `bd close <id> "Done from Obsidian"` → re-render.
6. **Detail**: click an issue → `bd show <id> --json` → detail view.

**MVP acceptance:** the pane renders real `bd list` output, and ticking a checkbox
actually closes that issue (verify with `bd show`). Commit + push, then nudge mayor.

## Desktop-only

Uses Node `child_process` (unavailable on Obsidian mobile) — `isDesktopOnly: true`
is set in `manifest.json`. Same constraint the Shell commands plugin documents.

## Prior art — study it (use GitHub stars as an engineering-quality signal)

- **Taitava/obsidian-shellcommands** — canonical desktop-only `child_process` pattern;
  how to invoke a binary, handle stdout/stderr, and gate on desktop.
- **High-star pane plugins** — `obsidian-kanban`, `obsidian-tasks`, Dataview — for
  `ItemView` / `registerView` / workspace-leaf conventions and UI polish.
- **Beads docs** — `PLUGIN.md`, the Integrations + Community Tools pages, and
  `bd --help` (`bd list --json`, `bd show --json`, `bd close`).

No Obsidian + Beads plugin exists yet — this is a genuine gap.

## Engineering standard (Obsidian community bar)

TypeScript + esbuild; `package.json` / `tsconfig.json` / esbuild config; `main.ts`;
versioned releases (`manifest.json` + `versions.json`); README + MIT LICENSE (done).
Final step is submission to `obsidianmd/obsidian-releases` `community-plugins.json`
— **Rome flips the repo public and submits; do not publish yourself.**

## Workflow (important — this rig is embedded)

- Track your work in **this rig's local `bd`** (prefix `obp` — `bd create ...`). It's
  an **embedded** DB (isolated local Dolt), so it works but is NOT on the shared town
  server. `bd show hq-...` (hq beads) will NOT resolve from here — ignore hq ids.
- Cross-rig `gt mail` may be flaky from an embedded rig → **report progress with
  `gt nudge mayor "<update>"`** and by committing/pushing to the repo.
- There's a throwaway test bead (`obp-...`) you can close.
