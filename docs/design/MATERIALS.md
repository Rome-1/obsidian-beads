# Design materials — raw surface & constraints (facts, no opinions)

Grounding for the feature-design pass. This is *what exists*, not *what we should build*.

## Current plugin (shipped MVP, v0.0.1)

- Right-sidebar `ItemView` pane renders `bd list --json`: priority badge, type, status, title.
- Checkbox per row → `bd close <id> "Done from Obsidian"` → refresh.
- Click row → Modal from `bd show <id> --json` (+ Close action).
- Settings: project root (dir with `.beads/`), `bd` path, refresh interval, show-closed.
- Refresh: interval timer + debounced `fs.watch(.beads)`.
- Arch: `bd.ts` (execFile array-form wrapper), `view.ts`, `detail.ts`, `settings.ts`, `main.ts`.

## Per-issue data available (from `bd list/show/ready --json`)

`id`, `title`, `description`, `status` (open/in_progress/blocked/deferred/closed),
`priority` (0–4), `issue_type` (bug/feature/task/epic/chore/decision), `owner`,
`assignee`, `created_at`, `updated_at`, `created_by`, `labels`,
`dependency_count`, `dependent_count`, `comment_count`.

## bd READ commands (safe, JSON where noted)

- `bd list --json` — filters: `--all`, `--assignee`, `--label`/`--label-any`, `--limit`,
  `--no-parent`, `--priority` (via query), sort/tree.
- `bd ready --json` — unblocked, actionable work (deps satisfied). **The "what can I do now" view.**
- `bd blocked` — issues blocked by unsatisfied deps (these still show `status=open`).
- `bd show <id> --json` — single issue detail.
- `bd status --json` — DB summary (open/closed/ready/blocked/in_progress counts, lead time).
- `bd query "<expr>" --json` — compound filters: `status`, `priority`, `type`, `assignee`,
  `owner`, `label`, `title`, `description`, `notes`; `AND`/`OR`/`NOT`/`()`; date-relative.
- `bd search <text>` — full-text.
- `bd dep list|tree`, `bd graph` (has `--dot`, `--html`, `--compact`) — dependency structure.
- `bd comments <id>`, `bd history <id>`, `bd count`, `bd stale`.

## bd MUTATING commands (write — treat with care)

- `bd close <id> -r <reason>` / `bd reopen <id>`
- `bd create "<title>" -t <type> -p <n> -d <desc> [--json]` (also `bd q` = quick, returns id)
- `bd update <id>` — priority, status, assignee, labels, etc.
- `bd comment <id> "<text>"` / `bd note <id> "<text>"`
- `bd assign`, `bd priority`, `bd label`/`bd tag`, `bd dep add/remove`
- `bd delete` (destructive), `bd link`.

## Obsidian API surface a plugin can use (relevant, still-simple options)

- `ItemView` pane (have it), `Modal` (have it), `PluginSettingTab` (have it), `Notice`, ribbon, commands.
- `registerMarkdownCodeBlockProcessor("beads", …)` — **embed a live beads query INSIDE any note**
  (Dataview-style). Big Obsidian-native lever; still a thin `bd query → render` call.
- Editor API — insert text at cursor (e.g. a bead reference / link into a note).
- `registerEvent(vault/metadata)`, workspace events; `setInterval` via `registerInterval`.
- Desktop-only: `child_process` (have it) — the whole reason for `isDesktopOnly`.

## Hard constraints / non-negotiables

- **Desktop-only**, shells out to `bd` (no reimplementing bd; the CLI is the engine).
- **Security posture already set**: `execFile` array-form only (no shell), inert-text render (no HTML injection), bounded timeout+buffer. Any new feature must preserve this.
- **Endgame is the Obsidian community registry** — reviewers reward *small, focused, obvious* plugins. Scope creep is a submission risk, not just a taste issue.
- One binary dependency the user must have installed (`bd`). Keep setup near-zero.
