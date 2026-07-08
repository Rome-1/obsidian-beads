# Beads for Obsidian

A tiny, **desktop-only** Obsidian plugin that renders a **live, clickable pane** for the
[Beads (`bd`)](https://github.com/gastownhall/beads) issue tracker — and does *real*
integration: **close an issue straight from a checkbox.**

No Obsidian + Beads plugin existed before this one — it fills a genuine gap for anyone
who tracks work in `bd` and lives in Obsidian.

<!-- Demo GIF — record a short loop (open pane → tick a checkbox → issue closes) and
     drop it at assets/demo.gif. See docs/RELEASE.md. -->
![Beads pane demo](assets/demo.gif)

## Features

- 🗂️ **Live pane** — renders `bd list --json` into a native `ItemView` in the sidebar,
  with a priority badge, issue type, and status per row.
- ✅ **Close from a checkbox** — tick a row and the plugin runs
  `bd close <id> "Done from Obsidian"`, then refreshes.
- 🔍 **Detail on click** — click an issue to open a modal populated from
  `bd show <id> --json`, with a one-click Close action.
- 🔄 **Auto-refresh** — on a configurable interval *and* whenever the `.beads`
  directory changes on disk (so external `bd` edits show up).
- ⚙️ **Simple setup** — point it at a project root containing a `.beads/` database;
  optionally set a custom `bd` binary path.

## Requirements

- **Obsidian desktop** — the plugin shells out to a local binary via Node's
  `child_process`, which is unavailable on mobile. `isDesktopOnly` is set.
- **The `bd` CLI** — install [Beads](https://github.com/gastownhall/beads) and make
  sure `bd` is on your `PATH` (or set an explicit path in settings).

## Installation

### Community plugins (once accepted)

Settings → Community plugins → Browse → search **"Beads"** → Install → Enable.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   [release](https://github.com/Rome-1/obsidian-beads/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/beads-pane/`.
3. Reload Obsidian and enable **Beads** under Community plugins.

## Usage

1. Open **Settings → Beads** and set **Project root** to a directory that contains a
   `.beads/` database. Click **Test connection** to confirm `bd` is reachable.
2. Open the pane: click the **list-checks** ribbon icon, or run the command
   **"Beads: Open Beads pane"** from the command palette.
3. Tick a checkbox to close an issue; click a row to see its detail.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Project root | *(empty)* | Absolute path to the directory containing `.beads/`. |
| `bd` binary path | `bd` | Path to the `bd` executable, or `bd` to resolve via `PATH`. |
| Auto-refresh interval | `30` | Seconds between refreshes (`0` disables). |
| Show closed issues | off | Include closed issues (`bd list --all`). |

## Security

- The plugin runs the `bd` binary you configure, in the project root you configure —
  the same trust model as the [Shell commands
  plugin](https://github.com/Taitava/obsidian-shellcommands). Point it only at a `bd`
  you trust.
- Commands are invoked with `execFile` and an **argument array** — never a shell
  string — so issue IDs and other values can't inject shell metacharacters.
- Issue titles and descriptions render as plain text (never HTML), so a bead authored
  elsewhere and synced in can't inject markup into the pane.

## Development

```bash
npm install
npm run dev     # esbuild watch → main.js
npm run build   # typecheck + production bundle
```

To test against a real vault, symlink or copy `main.js`, `manifest.json`, and
`styles.css` into `<vault>/.obsidian/plugins/beads-pane/`.

## Prior art (inspiration)

- **[Taitava/obsidian-shellcommands](https://github.com/Taitava/obsidian-shellcommands)**
  — the canonical desktop-only `child_process` pattern.
- **Beads** — `bd --help`, `bd list --json`, `bd show --json`, `bd close`.
- High-star pane/view plugins (Kanban, Tasks, Dataview) for `ItemView` and
  workspace-leaf conventions.

## License

MIT © Rome-1
