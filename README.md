# Beads for Obsidian

A tiny, desktop-only Obsidian plugin that renders a **live, clickable pane** for the
[Beads (`bd`)](https://github.com/gastownhall/beads) issue tracker — and does *real*
integration: **close an issue straight from a checkbox.**

> Status: early development. Endgame is the Obsidian community-plugin registry.

## What it does

- Configure a project root (a directory containing a `.beads/` database).
- Shell out to `bd list --json` (via Node's `child_process`, desktop-only) and render
  the issues into a custom `WorkspaceLeaf` pane.
- Refresh on an interval and/or when the `.beads` directory changes.
- Click a checkbox → `bd close <id> "Done from Obsidian"`.
- Click an issue → detail via `bd show <id> --json`.

## Why it's desktop-only

It uses Node's `child_process` to invoke the `bd` binary, which is unavailable on
Obsidian mobile — the same constraint the [Shell commands
plugin](https://github.com/Taitava/obsidian-shellcommands) documents. `isDesktopOnly`
is set in `manifest.json`.

## Security notes

- The plugin runs the `bd` binary you configure (default: resolved from `PATH`)
  in the project root you configure — the same trust model as the Shell commands
  plugin. Point it only at a `bd` you trust.
- Commands are invoked with `execFile` and an **argument array** — never a shell
  string — so issue IDs and other values can't inject shell metacharacters.
- Issue titles and descriptions are rendered as plain text (never HTML), so a
  bead authored elsewhere and synced in can't inject markup into the pane.

## Prior art (inspiration)

No Obsidian + Beads plugin exists yet (checked the community registry and the Beads
integrations/community-tools pages) — this fills a real gap. Study these for craft
(use GitHub stars as an engineering-quality signal):

- **Taitava/obsidian-shellcommands** — the canonical desktop-only `child_process` pattern.
- Beads docs: `PLUGIN.md`, the Integrations and Community Tools pages, and `bd --help`
  (`bd list --json`, `bd show --json`, `bd close`).
- High-star Obsidian pane/view plugins (Kanban, Tasks, Dataview) for `ItemView` and
  workspace-leaf conventions.

## Development

Standard Obsidian plugin toolchain (TypeScript + esbuild). Build docs land here as the
plugin takes shape.

## License

MIT © Rome-1
