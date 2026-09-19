# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Pi, …)
working in this repository. This is the canonical, harness-neutral instruction
file. Claude Code loads it via an `@AGENTS.md` import in `CLAUDE.md`; the other
harnesses read `AGENTS.md` natively.

## ⚠️ CRITICAL POLICIES

### Integrity Rule (ABSOLUTE)
- ❌ NO shortcuts - do the work properly or don't do it
- ❌ NO fake data - use real data, real tests, real results
- ❌ NO false claims - only report what actually works and is verified
- ✅ ALWAYS implement all code/tests with proper implementation
- ✅ ALWAYS verify before claiming success (build + load in a real vault against a real `bd`)
- ✅ ALWAYS run the real `bd` binary against a real `.beads/` database — never mock `bd` output
- ✅ ALWAYS run actual commands, not assume they pass

**We value the quality we deliver to our users.**

### Git Operations
- ❌ NEVER auto-commit/push without explicit user request
- ❌ NEVER add AI/assistant attribution to commits (no `Co-Authored-By`, no
  "Generated with …" trailers) — commits are authored solely by the user
- ❌ NEVER commit `.mcp.json` (it holds API keys) or `data.json` (local plugin settings)
- ✅ ALWAYS wait for: "commit this" or "push to main"

## Project Overview

**obsidian-beads** (plugin id `beads-pane`, display name **Beads**) is a
**desktop-only Obsidian plugin** that shows the [Beads (`bd`)](https://github.com/gastownhall/beads)
issue tracker inside Obsidian. It **shells out to the `bd` CLI**. It never reads
the Beads database directly.

- **Pane** (`ItemView`): Ready · In progress · Blocked · Closed tabs, each with a live count and paged with **Load more**
- **Editor tab**: opens a bead like a note, with YAML frontmatter for the fields and a markdown body for the description. Save runs `bd update` with only the changed fields
- **Quick capture**: `bd create` from a modal or the `+` button
- **`beads` code blocks**: live query embeds inside notes (`ready`, `blocked`, `list`, `query: <expr>`, `limit: <n>`)
- **Status bar** `● N ready`, auto-refresh on a timer, and a `fs.watch` on `.beads/`

Upstream: `https://github.com/Rome-1/obsidian-beads` (MIT). User docs: `README.md`.

## Repository Structure

```
obsidian-beads/
├── src/
│   ├── main.ts        # Plugin entry: commands, ribbon, status bar, .beads watcher, root auto-detect
│   ├── bd.ts          # ONLY place that spawns bd (execFile + argv, concurrency cap, code-block cache)
│   ├── view.ts        # The tabbed pane (ItemView, VIEW_TYPE_BEADS)
│   ├── editor.ts      # Bead editor tab (title, property controls, markdown text fields, deps, comments)
│   ├── mdfield.ts     # Markdown text field: rendered preview, click to edit (description/design/notes/acceptance)
│   ├── mdtext.ts      # Pure text helpers (escape `<placeholder>` outside code before rendering)
│   ├── editmodel.ts   # Pure editor model: bead → editable snapshot → minimal `bd update` diff
│   ├── filter.ts      # Pure pane filter: assignee/labels/type → bd flags, local match for `bd blocked`, assignee suggestions
│   ├── assignee-suggest.ts # Assignee box popup (AbstractInputSuggest): typed / Unassigned / saved (× to forget) / bd
│   ├── lineage.ts     # Pure lineage walk (bd dep list up/down, fan-out folding, caps) + dagre layout
│   ├── lineage-view.ts # Lineage graph ItemView: DOM-built SVG, pan/zoom, click to re-centre / open
│   ├── codeblock.ts   # ```beads``` code-block processor
│   ├── row.ts         # Shared row component (pane + code block render the same row)
│   ├── settings.ts    # Settings + tab (projectRoot, bdPath, refreshIntervalSec)
│   └── types.ts       # BeadIssue shape, issue types, priorities, editable statuses
├── tests/             # node --test: unit tests + real-bd integration tests
├── styles.css         # Plugin styles (shipped as-is)
├── manifest.json      # Obsidian manifest (id, version, minAppVersion, isDesktopOnly)
├── versions.json      # version → minAppVersion map
├── esbuild.config.mjs # Bundles src/main.ts → main.js (CJS, es2018)
├── eslint.config.mjs  # eslint + eslint-plugin-obsidianmd (Obsidian review rules)
├── version-bump.mjs   # npm version hook
├── docs/
│   ├── RELEASE.md     # Release + community-directory submission checklist
│   └── design/        # DESIGN.md (v1 scope, guardrails, kill list), VISION, MATERIALS
└── assets/            # demo.gif
```

`main.js` is build output (gitignored). It is only published as a release asset.

## Build Commands

Use `npm` (lockfile is `package-lock.json`). Node 20+.

```bash
npm install            # deps (esbuild, obsidian typings, eslint)
npm run dev            # esbuild watch → main.js (inline sourcemaps, unminified)
npm run build          # tsc typecheck + minified production main.js
npm run lint           # eslint src/ (includes Obsidian review rules)
npm test               # unit + integration tests (node --test tests/*.test.mts)
npm run test:coverage  # same, with a per-file coverage table
```

- **Test layout**: tests live in `tests/*.test.mts` and use `node:test` + `node:assert/strict`. There's no test framework; Node 22.6+ strips TS types natively
- **Unit tests** cover pure modules only, i.e. modules that never import `obsidian`:
  - `mdtext.ts`, `editmodel.ts`, `filter.ts`, `lineage.ts` (the walk, the layout and the view geometry)
  - `buildUpdateArgs` and the JSON parsers (`parse*`) in `bd.ts`
  - Keep logic testable by moving it into pure modules. The views should only wire DOM to it
- **Integration tests** (`tests/bd.integration.test.mts`) run the **real `bd`** against a throwaway database in the OS temp dir. They skip when `bd` isn't on `PATH`; set `BD_BIN` to use another binary
- **Rules for test-imported modules**:
  - use `import type` for type-only imports (Node can't strip a value import of an interface)
  - no TS-only runtime syntax such as constructor parameter properties or enums
- **UI** (`mdfield.ts`, `lineage-view.ts`, `editor.ts`, `main.ts`) still needs a manual check in a real vault (see below). `obsidian eval code=…` can drive the views and inspect the DOM
- Known lint warning: `settings.ts` doesn't implement `getSettingDefinitions()` (declarative settings API, Obsidian 1.13+)

## Installing the Local Copy into Obsidian (dev loop)

Obsidian loads a plugin from `<vault>/.obsidian/plugins/<id>/` and reads
`manifest.json`, `main.js`, and `styles.css`. The folder name **must** be the
manifest id: `beads-pane`.

### 1. Link the repo into a vault (recommended)

```bash
VAULT="$HOME/Obsidian/ObsidianNotes"                # any vault; a throwaway one is safer
mkdir -p "$VAULT/.obsidian/plugins"
# If a released copy is installed, move it aside first (it has the same id)
[ -e "$VAULT/.obsidian/plugins/beads-pane" ] && mv "$VAULT/.obsidian/plugins/beads-pane" /tmp/beads-pane.bak
ln -s "$PWD" "$VAULT/.obsidian/plugins/beads-pane"
npm run build                                        # or: npm run dev (watch)
```

- Then in Obsidian: **Settings → Community plugins**, turn off Restricted mode, and enable **Beads**
- Obsidian writes the settings to `<repo>/data.json` through the symlink. That file is gitignored
- Alternative without a symlink: copy just `main.js`, `manifest.json`, and `styles.css` into the plugin folder after each build

### 2. Iterate

```bash
npm run dev                                          # terminal 1: rebuilds main.js on save
obsidian plugin:reload id=beads-pane                 # reload after a rebuild (Obsidian CLI, app must be running)
obsidian dev:console level=error                     # read the captured console errors
obsidian vault=<name> plugin:reload id=beads-pane    # target a specific vault
```

- The `obsidian` CLI comes with the app (`/Applications/Obsidian.app/Contents/MacOS/obsidian`). Enable it in Obsidian's settings if it isn't already
- Another option is the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin. It auto-reloads any plugin folder that contains `.git`, and the symlinked repo does
- Without either: Command palette → **Reload app without saving**, or toggle the plugin off and on
- DevTools: `Cmd+Opt+I`. Dev builds include inline sourcemaps, so the TypeScript sources show up there

### 3. Point the plugin at a beads database

- **Settings → Beads → Project root** must be a folder that contains `.beads/`. It auto-fills if the vault root contains `.beads/`
- **bd binary path**: GUI-launched Obsidian often doesn't inherit the shell `PATH`, so use the full path (`which bd`, e.g. `/opt/homebrew/bin/bd`)
- Click **Test connection**. It runs `bd --version`
- Throwaway test database (no git needed):

```bash
mkdir -p /tmp/bd-play && cd /tmp/bd-play
BEADS_DIR=/tmp/bd-play/.beads bd init --quiet --stealth --skip-agents
bd create "Epic A" -t epic -p 1          # → <prefix>-xxx
bd create "Child" --parent <epic-id> -p 2
bd create "Blocker" -p 0
bd dep add <child-id> <blocker-id>      # child now appears under Blocked
bd comments add <blocker-id> "hello **md**"
```

## Beads (`bd`) Basics

Beads is a **distributed, dependency-aware issue tracker for AI agents**,
written in Go and backed by **Dolt**, a version-controlled SQL database. A local
source checkout is at `~/Dev/Helixoid/pmsynapse-side-examples/beads`. Docs are
in its `docs/` folder and at https://beads.gascity.com/. Installed here: `bd
1.2.2` (Homebrew, `/opt/homebrew/bin/bd`).

### Storage

- `bd init` creates `.beads/` in the project. Commands find it by walking up from the cwd, or from `$BEADS_DIR`. The plugin sets `cwd` = project root
- **Embedded mode (default)**: Dolt runs in-process and the data lives in `.beads/embeddeddolt/`. There is a **single writer** (`.lock`)
- **Server mode**: `bd init --server` connects to a `dolt sql-server`, and the data lives in `.beads/dolt/`
- Other files: `config.yaml`, `metadata.json`, `interactions.jsonl`, `last-touched`
- `.beads/issues.jsonl` is only an export for viewers. **It is not the source of truth.** Don't parse it. Always go through `bd`
- Sync between machines: `bd dolt push` / `bd dolt pull`
- `--stealth` means no git operations or hooks

### Issue model

- **ID**: hash-based `<prefix>-<hash>` (e.g. `bd-a1b2`). Children are hierarchical: `bd-a3f8.1`, `bd-a3f8.1.1`
- **Types**: `bug`, `feature`, `task`, `epic`, `chore`, `decision` (also `gate`, `message`, and other special types)
- **Priority**: `0` critical · `1` high · `2` medium (default) · `3` low · `4` backlog
- **Status** (stored): `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`
- ⚠️ **Dependency-blocked issues keep `status=open`.** Only `bd blocked` finds them. `bd ready` means open with no open blocking deps. Never compute ready or blocked by subtracting one list from another
- **Other fields**: `title`, `description`, `notes`, `assignee`, `owner`, `labels[]`, `created_at` / `updated_at` / `closed_at`, `created_by`, and comments (a separate thread)

### Dependencies

- `bd dep add <child> <blocker>`: `<child>` depends on `<blocker>`. Default type is `blocks`
- **Blocking types** (they affect `bd ready`): `blocks`, `parent-child`, `conditional-blocks`, `waits-for`
- **Non-blocking types**: `related`, `tracks`, `discovered-from`, `caused-by`, `validates`, `supersedes`
- `bd dep list <id>`: what this issue depends on. Add `--direction=up` for what depends on it
- Related commands: `bd dep tree`, `bd graph`, `bd dep cycles`. Cycles are rejected when a dependency is written
- **Gates** are issues of type `gate` that wait on an external condition (`gh:pr`, `gh:run`, `timer`, `bead`, `human`)

### Core commands (everything supports `--json`)

| Command | Purpose |
| --- | --- |
| `bd ready [--limit n]` | Unblocked, actionable work |
| `bd blocked` | Issues waiting on deps (includes `blocked_by[]`, `blocked_by_count`) |
| `bd list --status <s> [--limit n] --no-pager` | List by stored status |
| `bd query "<expr>" [--limit n] [-a]` | Query language, e.g. `status=open AND priority<=1`, `updated>7d`, `label=x OR type=bug`, `NOT status=closed`. Excludes closed unless `-a` |
| `bd show <id>` | One issue (JSON is an array) |
| `bd create --title=… --type=… --priority=… [--description=…] [--parent <id>] [--labels=a,b]` | New issue, returns `{id,…}` |
| `bd update <id> --title/--description/--priority/--type/--status/--assignee/--add-label/--remove-label/--claim` | Edit fields (`--claim` sets you as assignee and status `in_progress`) |
| `bd close <id> --reason "…"` | Close (refused while open blockers remain) |
| `bd comments <id>` / `bd comments add <id> "text"` | Comment thread |
| `bd status` | Counts: `summary.{ready_issues, blocked_issues, open_issues, …}`. ⚠️ `ready_issues` undercounts (see Pane filters); the plugin doesn't use it |
| `bd prime` / `bd remember "…"` | Agent workflow context and persistent project memory |

### JSON shapes the plugin relies on (verified with bd 1.2.2)

- `list` / `ready` / `query` rows: `id, title, status, priority, issue_type, owner, assignee?, created_at, created_by, updated_at, dependency_count, dependent_count, comment_count, labels?`
- `blocked` rows: the same fields plus `blocked_by[]` and `blocked_by_count`
- `dep list` rows: full issue records plus `dependency_type`
- `comments` rows: `id, issue_id, author, text, created_at`
- Type field name is `issue_type`, **not** `type`. Unknown extra fields must be tolerated (`BeadIssue` in `src/types.ts`)

## Architecture & Guardrails

Full design rationale is in `docs/design/DESIGN.md`. The code has since grown
past the v1 kill list (the editor tab, multi-field capture, and markdown
comments now exist), but these rules still hold:

- **All `bd` calls go through `src/bd.ts`**, using `execFile` with an **argv array**. Never use `exec` or a shell string
- **Data-controlled values** go after a `--` sentinel or in `--flag=value` form, so they can't be read as flags (CWE-88)
- **Every call is bounded**: a 15 s timeout, a 16 MB buffer, and at most 4 concurrent `bd` processes
- **Parse bd JSON only through `parseJson` in `bd.ts`**. It unwraps bd's v2 envelope (`{"schema_version", "data"}`), which becomes the default in bd 2.0 and can already be switched on with `BD_JSON_ENVELOPE=1`
  - Never call `JSON.parse` on bd output anywhere else
  - The integration suite runs every call in both formats
- **`bd` computes and the plugin displays.** Ready, Blocked, and In-progress each come from their own `bd` command. There are no local state files and no caches, except the code-block read cache (4 s TTL, one read at a time, limit clamped to 50, cleared on every mutation)
- **Pane filters** (`filter.ts`) are passed to bd as flags: `bd ready` / `bd list` / `bd count` take `--assignee`, repeated `--label` (AND) and `--type`
  - The unassigned flag is `--unassigned` for `ready` but `--no-assignee` for `list` / `count`
  - **Only exception**: `bd blocked` has no filter flags, so the Blocked tab filters its output with `matchesFilter`. An integration test checks that rule gives the same results as bd's own flags
  - **Tab counts always come from the same command as the tab's list** (`tabCounts` in `filter.ts`): `bd ready --limit 0`, `bd count --status`, and the length of `bd blocked`. The status bar's ready count does the same
  - Never use `bd status` for counts: its `ready_issues` is `open − blocked`, and "blocked" also includes blocked *deferred* and *in_progress* beads, so it undercounts (Govini showed 1 ready while `bd ready` listed 4). The integration suite reproduces this
  - Dropdown choices load on demand, never on the auto-refresh timer
  - Saved assignee names (`settings.savedAssignees`, at most 50, most recent first) and hidden patterns (`settings.hiddenAssignees`, exact names or `*` globs) are the one exception to the "no local state" rule. They're lists the user curates, stored in the plugin settings, and bd stays the source of truth for assignees
  - Hidden patterns only affect the suggestions. They never stop a typed name from filtering
- **Pane rendering** (`view.ts`): build the header, filter bar and tab bar **once** and update them in place (`render()` → `ensureShell()`)
  - Only the bead list (`renderBody`) is rebuilt on each load
  - The filter bar is rebuilt only when `filterBarKey` changes (the filter, or the option list loading)
  - Never go back to `contentEl.empty()` on every render: it destroys focus, typed text and open dropdowns
- **Inert text**: titles in the pane render as text, never HTML
- Description, design, notes, acceptance criteria and comments render only through Obsidian's `MarkdownRenderer`. bd treats all of them as markdown
- `<…>` outside code is escaped first (`mdtext.ts`), so CLI-style placeholders like `<this-id>` show literally, as they do in `bd show`
- **One row component** (`row.ts`) serves both the pane and code blocks
- **Lineage graph** (`docs/design/LINEAGE-GRAPH.md`):
  - Build the graph from `bd dep list` in both directions, never from `bd dep tree` (it drops edges and loses direction) or `bd graph --json` (it returns the whole component)
  - Build the SVG with `createSvg` and `textContent`. No Mermaid: Obsidian gates it behind a trust prompt
  - Refresh on demand only
- **Obsidian gotchas**:
  - Don't name `ItemView` fields `titleEl`, `headerEl`, `contentEl`, etc. They shadow Obsidian's own fields and break view loading
  - `createSvg`'s `cls` option needs an array for multiple classes
- **Desktop only**: this is required because of `child_process` and `fs.watch` (`isDesktopOnly: true`)
- The only required setting is the project root, and it should trend toward zero required settings

## Development Conventions

- **TypeScript strict**, tabs for indentation, following the style of the existing modules. Keep files under ~600 lines (`editor.ts` is ~660 and next in line to be split)
- **Never save working files or notes in the repo root.** Docs go in `docs/` and scripts in `scripts/`
- Run `npm run lint` before handing work back. `eslint-plugin-obsidianmd` mirrors the automated review rules of Obsidian's community directory, so a lint error can block a release
- Use Obsidian APIs (`requestUrl`, `normalizePath`, `registerEvent`, `register*`) so everything is cleaned up in `onunload`
- **TODO annotations**: `TODO(0)` never merge · `TODO(1)` high · `TODO(2)` medium · `TODO(3)` low · `TODO(4)` question · `PERF`

## Release

See `docs/RELEASE.md`.

- Bump `manifest.json`, `package.json`, and `versions.json`, then run `npm run build`
- Run `gh release create <ver> main.js manifest.json styles.css`. The tag has **no `v` prefix**
- Obsidian's developer dashboard re-scans each release automatically
- Only on explicit user request

## Development Workflow

- This repo uses the **IDLC (Intent-Driven LifeCycle)** workflow
- The skills are in `.claude/skills/` (local and gitignored): `/create-plan`, `/implement-plan`, `/commit`, `/describe-pr`, …
- For bigger changes: spec → plan → implement → verify the build and lint, then check in a real vault
