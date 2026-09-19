# Bead lineage graph

Status: **prototype (v1) shipped in `src/lineage.ts` + `src/lineage-view.ts`** (2026-09-18).

## Problem

A poured bead (e.g. `pk-mol-0aoo`, a `compare` step of the `mol-sbs-test`
formula) reads as a standalone issue in the editor. It shows its direct
"Blocked by" and "Blocks" neighbours, but nothing about the chain it sits in:
what has to happen first, and what is waiting on it further along.

**Goal:** for any bead, show a navigable graph of its full lineage, up and down
the order, inside Obsidian.

## What pouring leaves in Dolt

Verified with bd 1.2.2 by pouring `mol-sbs-test` into a scratch database:

- **Molecule root**: `issue_type = molecule`. Its title and description are the formula's name and description.
- **Steps**:
  - one child bead per step, with IDs `<prefix>-mol-<hash>`
  - each step has a `parent` pointing at the root, plus a `parent-child` dependency edge
  - each formula `needs` becomes a `blocks` edge
- **Variables are not stored as data.** They exist only as text substituted into titles and descriptions. `metadata` stays `{}`, and nothing records the formula version.
- **The Govini harness deletes the root after pouring.** `backlog.sh` runs `bd delete <root> --force`, which removes the root, the `parent` link and all `parent-child` edges. The steps keep only their `blocks` edges.
  - For the beads poured on 2026-09-16, the root is also missing from Dolt history (`dolt_history_*`).
- **Still available**:
  - the full `blocks` graph
  - the `events` table (created, claimed, closed and reopened, with the actor for each)
  - fields that exist but are empty: `spec_id`, `external_ref`, `metadata`, `source_system`

## Where the data can come from

Measured on the Govini database (server mode, about 900 beads):

| Source | Result | Verdict |
| --- | --- | --- |
| `bd dep tree <id> --direction=both --json` | Flat list with `depth`, `parent_id`, `edge_from_parent`. 0.16s for a leaf, 2.4s for the `pk-oni` epic | ❌ **Drops edges**: each node is listed once, so later edges to it are lost (443 of 876 on `pk-oni`). `--show-all-paths` has no effect in JSON. In `both` mode, up and down edges look identical, and the `--format=mermaid` output has the same flaw |
| `bd graph <id> --json` | The whole connected component: 444 beads and 2.7 MB for `pk-mol-0aoo` via `pk-oni`, with a precomputed layered layout | ❌ Far too broad, edges are untyped, and it took 56s under harness load |
| `bd graph --html` | A standalone D3 page | ❌ Loads D3 from `d3js.org` at runtime and isn't navigable inside Obsidian |
| `bd sql` with a recursive CTE | Everything in one query | ❌ Server mode only, ties the plugin to bd's internal schema, and needs SQL strings instead of an argv array |
| **`bd dep list <id> [--direction=up] --json`** | Exact, typed (`dependency_type`), directional; about 0.13s per call | ✅ **Chosen.** Walk breadth-first from the focus bead |

## Rendering: what was considered

| Option | Verdict |
| --- | --- |
| Mermaid via `MarkdownRenderer` | ❌ Obsidian 1.13 gates Mermaid behind a per-vault trust prompt ("Display Mermaid diagrams in this vault?"). Calling `loadMermaid()` directly would bypass that prompt and would mean inserting SVG markup strings |
| Cytoscape.js | ❌ About 400 KB and doesn't look native |
| Writing a `.canvas` file | ❌ Writes stale files into the vault, and clicking a card doesn't open the bead |
| Obsidian's Graph view | ❌ Shows notes only, so beads would have to be mirrored as notes (on DESIGN.md's kill list) |
| **dagre layout + DOM-built SVG** | ✅ **Chosen.** dagre is about 48 KB minified. The view has full control over clicks and pan/zoom, and text is set via `textContent`, so there's no markup injection |

## v1 design (as built)

- **Scope: lineage, not the whole component.**
  - Follow prerequisites transitively (bd `down`) and dependents transitively (bd `up`).
  - Never walk sideways: a prerequisite's other dependents are not included.
- **Layout**: left to right. Prerequisites on the left, dependents on the right, and the focus bead highlighted.
  - Edges always point prerequisite → dependent.
  - Blocking types (`blocks`, `parent-child`, `conditional-blocks`, `waits-for`) are solid; the rest are dashed. Any type other than `blocks` gets a label.
- **Bounds**:
  - depth 3 in each direction (adjustable 0–8)
  - fan-out 8 per bead per direction; the rest collapse into a "+N more" node that expands when clicked
  - hard cap of 80 beads, flagged in the status line
  - Open beads come before closed ones, then by priority, so folding hides the least relevant.
- **Navigation**:
  - click a bead to re-centre on it; Back returns
  - click the centre bead, or Cmd/Ctrl-click any bead, to open it in the editor
  - drag to pan, scroll to zoom
- **Entry points**:
  - the git-fork button in the bead editor toolbar
  - the command "Beads: Show lineage of current bead"
  - the view re-uses one lineage tab, opened in a split
- **Refresh**: on demand only. A walk costs one `bd` call per bead, so it isn't tied to the pane's auto-refresh timer or the `.beads` watcher.
- **Code**:
  - `src/lineage.ts`: the pure walk and the dagre layout. The bd call is injected; covered by `tests/lineage.test.mts`.
  - `src/lineage-view.ts`: the `ItemView`, SVG drawing, pan/zoom and clicks.

Verified live on the Govini vault:

| Focus | Result |
| --- | --- |
| `pk-mol-0aoo` | 7 beads, 9 links. That's 3 more than `bd dep tree` reports, because `legacy` also depends on the fixture, plan and approve beads |
| `pk-oni` | 30 beads, 50 links, with "+123 more before" folded. Expanding the fold hits the 80-bead cap |

Back, zoom, pan, Cmd-click-to-open, the command and the editor button all work.

## Open questions / next steps

1. **Molecule grouping.** Draw a box around `parent-child` siblings. This only helps if the harness keeps molecule roots, or tags steps with `--set-metadata formula=… tc=…`.
2. **Cap behaviour on expand.** Expanding a 131-wide fold hits the 80-bead cap before deeper levels load. Options:
   - raise the cap only for expanded folds
   - page within a fold
3. **Provenance panel.** Show `events` (claimed, closed, reopened) and `metadata` / `spec_id` / `external_ref` in the editor.
4. **Performance under load.** Every hop is one `bd` process. On a busy Dolt server a single call took 22s and failed with `context canceled`. Options:
   - a longer timeout for lineage calls
   - a "stop" button
   - reusing edges already fetched while navigating
5. **Soft edges.** `related` / `discovered-from` / `supersedes` are walked like blocking edges. Consider a toggle.
6. **DESIGN.md kill list.** "Dependency graph visualization" was on it. This prototype reverses that decision, and the kill list and guardrails have been updated to say so.
