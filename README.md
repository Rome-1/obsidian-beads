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

- 🗂️ **Ready-first pane** — a native `ItemView` in the sidebar that groups your work
  into **In progress · Ready · Blocked**, so you see *what you can do right now* (bd
  computes readiness from the dependency graph — the plugin just displays it). Blocked
  rows show a `⛓ n` hint; closing a blocker slides its dependent up into Ready.
- ✅ **Close from a checkbox** — tick a row and the plugin runs
  `bd close <id> "Done from Obsidian"`, then refreshes.
- 🔍 **Detail on click** — a modal from `bd show <id> --json` with **Blocked by** /
  **Blocks** dependency lists (click any to jump to it) and a one-click Close action.
- ⚡ **Quick capture** — the *Beads: Capture a bead* command opens a one-field box;
  type a title, press Enter, and it's in your tracker (`bd create`).
- 📄 **Live `beads` code blocks** — embed a query in any note (Dataview-style) and get
  the same clickable rows inline. See [Embedding queries](#embedding-queries-in-notes).
- 🔢 **Status-bar count** — an ambient `● N ready` even when the pane is closed.
- 🔄 **Auto-refresh** — on a configurable interval *and* whenever the `.beads`
  directory changes on disk (so external `bd` edits show up).
- ⚙️ **Near-zero setup** — if your vault folder itself contains a `.beads/`, the
  project root auto-fills on first load.

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
   `.beads/` database (auto-filled if your vault folder has one). Click **Test
   connection** to confirm `bd` is reachable.
2. Open the pane: click the **list-checks** ribbon icon, or run **"Beads: Open Beads
   pane"** from the command palette.
3. Tick a checkbox to close an issue; click a row for detail and its dependencies.
4. Capture new work anytime with **"Beads: Capture a bead"** (bind it to a hotkey).

## Embedding queries in notes

Put a fenced `beads` code block in any note to render a live, clickable list right
where you're thinking. One directive per line:

````markdown
```beads
ready
```
````

````markdown
```beads
query: status=open AND priority<=1
limit: 10
```
````

Accepted directives:

| Directive | Meaning |
| --- | --- |
| `ready` | Unblocked, actionable issues (`bd ready`). |
| `blocked` | Issues waiting on dependencies (`bd blocked`). |
| `list` | All open issues (`bd list`). |
| `query: <expr>` | A [bd query](https://github.com/gastownhall/beads) expression, e.g. `status=open AND priority<=1`. |
| `limit: <n>` | Max rows (clamped to 50). |

Embeds re-run when the note renders (and after you close an issue from one) — never on
a timer — and share a global read cache, so many blocks won't hammer `bd`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Project root | *(empty)* | Absolute path to the directory containing `.beads/`. |
| `bd` binary path | `bd` | Path to the `bd` executable, or `bd` to resolve via `PATH`. |
| Auto-refresh interval | `30` | Seconds between refreshes (`0` disables). |
| Show closed issues | off | Add a **Closed** group to the pane. |

## Security

- The plugin runs the `bd` binary you configure, in the project root you configure —
  the same trust model as the [Shell commands
  plugin](https://github.com/Taitava/obsidian-shellcommands). Point it only at a `bd`
  you trust.
- Commands are invoked with `execFile` and an **argument array** — never a shell
  string — so issue IDs and other values can't inject shell metacharacters.
- Issue titles and descriptions render as plain text (never HTML), so a bead authored
  elsewhere and synced in can't inject markup into the pane. Data-controlled values are
  also passed after a `--` sentinel (or as `--flag=value`) so they can't be reparsed as
  `bd` flags.
- The plugin runs `bd` against whatever `.beads/` your project root points at (including
  an auto-detected vault-local one). It never executes anything *from* the dataset — but
  that means you trust `bd`'s own parsing of that database, as with any `bd` invocation.

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
