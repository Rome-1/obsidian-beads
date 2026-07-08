# Beads for Obsidian — Design

*The dream is a second brain that knows what you owe it. The honest first
submission is one pane that answers one question. This doc draws a hard line
between them: everything in **v1** ships now; everything in **the roadmap** is
earned later. You can implement v1 from the v1 section alone.*

---

## North star

**A heads-up display for `bd`, mounted where you think.** The plugin answers one
question — *"what can I do right now?"* — beside your notes, and lets you finish
work with one tap. `bd` is the engine; the plugin is glass. It never computes
state bd already knows, never stores anything, never edits the tracker except the
one mutation on the hot path. If the plugin vanished tomorrow, your tracker would
be untouched — that's the design goal, not a limitation.

## The daily loop

You open your vault in the morning. The Beads pane shows three short stacks:
**In progress (1) · Ready (4) · Blocked (3)**. You don't decide what to do — bd
already computed what *can* be done; you pick the top Ready item and start
writing in the note beside it.

An hour later you finish the task and tick its checkbox. The row fades — and a
beat later, an item slides up from Blocked into Ready, because closing your work
just unblocked it. **That slide is the product.** No other Obsidian task plugin
can do it, because no other one has a dependency graph underneath.

See → do → finish → watch the graph unblock. That's the whole loop, and v1 is the
smallest thing that delivers it.

---

## v1 — ship this, nothing more

v1 is **the ready-first pane, plus a correctness guard, on top of the shipped
MVP.** No new commands, no new surfaces, no new settings. The pane pivot is the
one change that turns "an issue list in a sidebar" into "the answer to *what
now?*" — and it is the entire delta a reviewer needs to see.

### 1. The ready-first pane *(the one new thing)*

Replace the flat `bd list` render with **three explicit groups, in this order**:

| Group | Source command | Notes |
|---|---|---|
| **In progress** | `bd list --status in_progress --json` | what you're mid-flight on |
| **Ready** | `bd ready --json` | deps satisfied — the "what now" set |
| **Blocked** | `bd blocked --json` | waiting on unsatisfied deps |

Each group is priority-sorted; closed issues are not shown. Empty groups render
their header greyed or are hidden — pick one and stay consistent.

**Do NOT partition by "list minus ready."** Dependency-blocked issues keep
`status=open`, so subtracting the ready set from the full list over-includes
deferred/held items and mislabels them. bd owns the partition; call the three
sources and display what each returns. Do not recompute readiness or blockedness
in the plugin.

Blocked rows may show a `⛓ n` hint from `dependency_count` (already in the row
data — no extra call).

*Why it earns its place:* dependency-awareness is bd's entire reason to exist; a
flat list actively hides it. This is the single feature that delivers the north
star, and it's implementable with three read calls the plugin already knows how
to make.

### 2. Refresh correctness guard *(required in v1 — not optional polish)*

The pane has four refresh triggers that can overlap: the interval timer, the
`fs.watch(.beads)` callback, the manual button, and the post-close refresh. Today
an older `bd list` can complete *after* a newer one and clobber fresher state.
With three sources per refresh instead of one, the race window widens. Fix it:

- **One in-flight refresh per surface.** If a refresh is running, don't start a
  second — mark "refresh requested" and re-run once when the current one lands.
- **Monotonic request id.** Stamp each refresh with an incrementing id; when a
  refresh's three calls resolve, apply its results only if it's still the latest
  id. Stale completions are dropped, not rendered.
- **Debounced fs.watch stays.** `fs.watch` can fire mid-write while bd is still
  writing `.beads`; the existing ~400 ms debounce absorbs that. Keep it.

### 3. First-class empty & error states *(required in v1)*

- **bd not found** (`ENOENT`) → a clear "bd binary not found — set the path in
  Beads settings" state, not a stack trace. (Wrapper already produces this
  message; the pane must render it as a state.)
- **Project root set but no `.beads/`** → a distinct "no bd database here" empty
  state, not a generic error.
- **No project root** → the existing "point me at a directory containing
  .beads/" prompt.
- **All groups empty** → "No open issues 🎉".

### KEPT from the shipped MVP — unchanged, no rework

These already exist and stay exactly as-is. v1 does **not** touch them:

- **One-tap close.** Checkbox per row → `bd close <id> -r "Done from Obsidian"` →
  refresh. This is the only mutation on the hot path, and the refresh is where
  the unblock-slide pays off.
- **Detail modal.** Click a row → `bd show <id> --json`, inert-text fields,
  description in a `<pre>`, Close-issue action.
- **Settings.** Project root, bd path (defaults to `bd`), refresh interval,
  show-closed, and the "Test connection" button.
- **Refresh plumbing.** Interval timer + debounced `fs.watch(.beads)` + ribbon +
  commands + desktop-only flag.
- **Security posture.** `execFile` array-form wrapper (no shell), inert-text
  rendering everywhere, bounded timeout + buffer. Non-negotiable.

**That is the whole of v1.** If it isn't in the three sections above, it isn't in
the first submission.

---

## The roadmap — earned later

Only after v1 sits in the registry and real users ask. Each item lists its **real
command(s)** and the **one guardrail** that keeps it simple.

### Quick capture

Command "Beads: capture" (hotkeyable) + a one-field modal. Enter →
`bd create "<title>" --json` and **parse `.id` from the returned JSON object**
(or use `bd create --silent`, which prints id-only — do *not* assume plain
`--json` emits a bare id). Cmd/Ctrl+Enter also inserts the id at the cursor.
**Guardrail:** exactly one text field — no type/priority/description pickers.
Capture is Obsidian's job; triage is the CLI's.

### Detail-modal dependency lists

Add "Blocked by" / "Blocks" to the detail modal via **two calls, one per
direction**: `bd dep list <id> --json` (blockers / down) and
`bd dep list <id> --direction=up --json` (dependents / up). Honest caveat: these
return dependency *records*, not issue rows — titles require a lookup per id, so
this is more than "render two lists." **Guardrail:** read-only, clickable to open
each bead's modal; no graph canvas — `bd graph --html` owns visualization.

### The `beads` code block

`registerMarkdownCodeBlockProcessor("beads", …)` — a live query embedded in a
note (Dataview-style), rendering the same row component as the pane. Maps a
whitelisted 3-key config to `bd ready` / `bd query "<expr>"` / `bd list`, passing
any expression as a single argv element (array form — no shell).

**It is NOT almost-free.** Multiple blocks in a note spawn multiple bd processes
per render *and* re-render — a process storm. If built, it MUST carry:

- a **single global read queue** — max 1 concurrent bd read across all blocks;
- a **short TTL cache** keyed on `cwd + args` (~5 s) so re-renders reuse results;
- a **hard `limit` clamp** (≤ 50), ignoring larger user values;
- **stale / error render states** instead of re-spawning on every paint.

**Guardrail:** ship the queue + cache + clamp, or don't ship the block.

### Project-root auto-detect

On load, if `projectRoot` is unset, probe the vault folder for `.beads/` and use
it (one `existsSync`). **Guardrail:** never overwrite a root the user set by
hand; auto-fill only the empty case.

### Status-bar ready count

`bd status --json` → `● 4 ready` in the status bar for ambient awareness when the
pane is closed. **Guardrail:** read-only, refreshed on the same timer as the
pane — no independent polling loop.

---

## The kill list

Rejected deliberately — each would cost more than it pays:

- **Dependency graph visualization** — `bd graph --html` already does it better; an embedded webview is reviewer bait.
- **Kanban / board / drag-and-drop** — huge surface, zero new information; Obsidian's board plugins own this.
- **In-plugin editing forms** (priority, labels, assignee, description) — a form is never faster than the CLI; forms are where scope and bugs breed.
- **Two-way markdown↔bead sync** (vault tasks mirroring beads) — sync is a correctness tarpit with ownership ambiguity; the code block gives live views with bd as sole owner.
- **Auto-linkifying bead IDs across all notes** — regex over the whole vault, false positives, render-time cost; the code block is the sanctioned "beads in notes" surface.
- **Rendering descriptions as rich markdown/HTML** — breaks the inert-text security posture for a cosmetic win; a `<pre>` is legible.
- **Mobile support / reading the Dolt DB directly** — reimplements the engine; violates the prime constraint.
- **Stale-bead reminders / notifications** — Obsidian is not a daemon; `bd stale` exists.
- **Burndown, lead-time, analytics dashboards** — `bd status` prints the numbers; dashboards are a different product.
- **Create-issue wizard** (type/priority/deps pickers) — capture must stay one field or it stops being capture.

## Simplicity guardrails

1. **bd owns the partition — don't recompute readiness/blocked locally.** Ready,
   Blocked, and In-progress each come from their own bd command. Never derive one
   group by subtracting another; the status field lies about blockedness by
   design.
2. **bd computes; the plugin displays.** If a feature needs the plugin to compute
   state bd already knows, either call bd or drop the feature. No local caches
   (except the roadmap code-block's explicit TTL), no local state files, ever.
3. **The one-field rule for writes.** Every mutation is at most one tap or one
   text field. The moment a second field feels necessary, that's the CLI's job.
4. **One required setting, trending to zero.** Project root is the only required
   config. A feature that adds a required setting is misdesigned.
5. **One row component for every surface.** Pane and any future embed render the
   identical row. A feature demanding new visual vocabulary is a different plugin.
6. **Inert text, argv arrays — non-negotiable.** No bead-derived HTML, no shell
   strings, bounded timeout and buffer on every call.
7. **If bd or Obsidian already does it, point at it.** The plugin owns the
   ten-times-a-day motions; everything monthly belongs to the CLI.
