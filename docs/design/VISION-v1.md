# Beads for Obsidian — v1 Vision

*The dream is a second brain that knows what you owe it. The shipping product is a
pane, a checkbox, one text field, and a code block. This doc is the argument that
those four things ARE the dream.*

---

## North star

**A heads-up display for `bd`, mounted where you think.** The plugin answers one
question — *"what can I do right now?"* — beside your notes, lets you finish work
with one tap, and capture new work without leaving the sentence you're typing.
`bd` is the engine; the plugin is glass. It never computes, never edits state it
doesn't have to, never stores anything. If the plugin vanished tomorrow, your
tracker would be untouched — that's the design goal, not a limitation.

## The daily loop

You open your vault in the morning. The Beads pane shows three short stacks:
**In progress (1) · Ready (4) · Blocked (3)**. You don't decide what to do — bd
already computed what *can* be done; you pick the top Ready item and start
writing in the note next to it. Your project note has a ` ```beads``` ` block at
the top, so the issues for *this* project sit inside the page where you're
thinking about them.

Mid-paragraph, a follow-up task occurs to you. Hotkey → one text field → Enter.
The thought is out of your head and into the tracker; a toast shows the new id;
your cursor never left the note.

An hour later you finish the task and tick its checkbox. The row fades — and a
beat later, an item slides up from Blocked into Ready, because closing your work
just unblocked it. **That slide is the product.** No other Obsidian task plugin
can do it, because no other one has a dependency graph underneath.

See → do → finish → watch the graph unblock → capture what emerged. That's the
whole loop, and every v1 feature exists to serve exactly one arc of it.

## v1 — the vital few

### 1. Ready-first pane *(upgrade of shipped MVP list)*

The pane stops being a flat `bd list` and becomes three groups, in this order:
**In progress**, **Ready**, **Blocked** (each priority-sorted, closed hidden by
default). Two calls: `bd ready --json` + `bd list --json`; the plugin partitions
by set membership — bd computed readiness, the plugin only displays it. Blocked
rows show their `dependency_count` as a small "⛓ n" hint.

*Why it earns its place:* dependency-awareness is bd's entire reason to exist; a
flat list actively hides it. This one change turns "an issue list in a sidebar"
into "the answer to *what now?*". It is the single most important delta from MVP.

### 2. One-tap close *(shipped MVP — keep)*

Checkbox on every row (pane *and* embeds) → `bd close <id> -r "Done from
Obsidian"` → refresh. The refresh is where the magic pays off: newly-unblocked
work visibly moves into Ready.

*Why:* closing is the one mutation in the daily loop's hot path. Everything else
can be a CLI trip; this can't.

### 3. Detail modal that answers "why" *(shipped MVP + one upgrade)*

`bd show <id> --json` as today (inert-text fields, description in a `<pre>`),
plus `bd dep list <id>` rendered as two plain lists: **Blocked by** and
**Blocks**. Each entry clickable → opens that bead's modal. Close/reopen button.

*Why:* the second question of the daily loop is "why can't I do X, and what does
finishing X unlock?" Two read-only lists answer it. No graph rendering, no
canvas — bd's own `graph --html` exists for the rare deep dive.

### 4. Quick capture *(new)*

Command "Beads: capture" (hotkeyable, plus pane header "+" button). A modal with
exactly one text field. **Enter** → `bd create "<title>" --json` → toast with the
new id. **Cmd/Ctrl+Enter** → same, plus insert the id as plain text at the cursor
if a note is open. No type picker, no priority dropdown, no description box —
triage later with the CLI (`bd update`) or not at all.

*Why:* capture friction is the number-one way side-tasks die. One field keeps
the plugin honest: Obsidian is the capture surface, bd is the triage surface.

### 5. `beads` code block — live queries inside notes *(new)*

`registerMarkdownCodeBlockProcessor("beads", …)`. Whitelisted three-key config,
nothing else:

````
```beads
ready
```
````
````
```beads
query: label=obsidian AND status!=closed
limit: 10
```
````

Maps to `bd ready --json` / `bd query "<expr>" --json` / `bd list --json`, and
renders **the exact same row component as the pane** — checkbox, badge, click
for detail. The query expression passes as a single argv element (execFile array
form — no shell, no injection); bd parses its own expression language, the
plugin never does.

*Why it survives the razor:* it's the Obsidian-native move — project notes become
project dashboards, beads live next to the thinking that produced them. And it's
almost free: ~a screen of code reusing the existing wrapper and row renderer.
Dataview normalized the pattern, so reviewers read it as idiomatic, not as scope.
This is the highest-leverage-per-line feature in the plugin.

### 6. Zero-config root detection *(new, tiny)*

On load, if `projectRoot` is unset, probe the vault folder for `.beads/` and use
it. One `existsSync`. Settings shrink to: project root (auto-filled when
possible), bd path (defaults to `bd`), refresh interval, show-closed. The "Test"
button stays.

*Why:* near-zero setup is a registry virtue and a first-run kindness. The common
case should require touching zero settings.

**Explicitly kept from MVP unchanged:** execFile array-form `bd.ts` wrapper,
inert-text rendering everywhere, interval + debounced `fs.watch(.beads)`
refresh, ribbon + commands, desktop-only flag.

## v-next — earned later

Only after v1 sits in the registry and real users ask:

- **Row context menu: mark in-progress / bump priority** — `bd update <id>`; the first write beyond close that people will actually want.
- **Comment from the detail modal** — `bd comment <id> "<text>"`; one field, same one-field rule.
- **Filter box in the pane** — client-side title filter first; `bd search` only if that proves insufficient.
- **Multiple project roots** — a small registry + pane switcher, once someone with two trackers asks.
- **Status-bar ready count** — `bd status --json` → "● 4 ready"; ambient awareness for pane-closed users.
- **Copy bead reference from a row** — right-click → copy `id` for pasting into notes.

## The kill list

Rejected deliberately — each would cost more than it pays:

- **Dependency graph visualization** — `bd graph --html` already does it better; an embedded webview is reviewer bait.
- **Kanban / board / drag-and-drop** — huge surface, zero new information; Obsidian's board plugins own this.
- **In-plugin editing forms** (priority, labels, assignee, description) — a form is never faster than the CLI; forms are where scope and bugs breed.
- **Two-way markdown↔bead sync** (vault tasks mirroring beads) — sync is a correctness tarpit with ownership ambiguity; the embed gives live views with bd as sole owner.
- **Auto-linkifying bead IDs across all notes** — regex over the whole vault, false positives, render-time cost; the code block is the sanctioned "beads in notes" surface.
- **Rendering descriptions as rich markdown/HTML** — breaks the inert-text security posture for a cosmetic win; a `<pre>` is legible.
- **Mobile support / reading the Dolt DB directly** — reimplements the engine; violates the prime constraint.
- **Stale-bead reminders / notifications** — Obsidian is not a daemon; `bd stale` exists.
- **Burndown, lead-time, analytics dashboards** — `bd status` prints the numbers; dashboards are a different product.
- **Create-issue wizard** (type/priority/deps pickers) — capture must stay one field or it stops being capture.

## Simplicity guardrails

1. **bd computes; the plugin displays.** If a feature requires the plugin to
   compute readiness, walk dependencies, or model state bd already knows, either
   call bd or drop the feature. No local caches, no local state files, ever.
2. **The one-field rule for writes.** Every mutation is at most one tap or one
   text field. The moment a second field feels necessary, the answer is "that's
   the CLI's job."
3. **One required setting, trending to zero.** Project root is the only required
   config, and it auto-detects when it can. A feature that adds a required
   setting is misdesigned — redesign or reject it.
4. **One row component for every surface.** Pane, embeds, and anything future
   render the identical row. A feature demanding a new visual vocabulary is a
   different plugin.
5. **Inert text, argv arrays — non-negotiable.** No bead-derived HTML, no shell
   strings, bounded timeout and buffer on every call. The security posture is a
   design constraint, not a chore to revisit.
6. **If bd or Obsidian already does it, point at it.** The plugin's job is the
   ten-times-a-day motions; everything monthly belongs to the CLI.
