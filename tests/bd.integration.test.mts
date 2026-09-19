/**
 * Integration tests against the REAL `bd` binary and a throwaway database —
 * no mocks (see AGENTS.md). They pin the bd behaviour the plugin relies on:
 * text-field flags round-trip, "" clears a field, `dep list` directions and
 * types, and the lineage walk over real `bd dep list` output.
 *
 * Skipped when `bd` isn't on PATH (set BD_BIN to point at another binary).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bdAssigneeNames,
	bdBlocked,
	bdByStatus,
	bdComments,
	bdCount,
	bdCreate,
	bdDepList,
	bdLabelNames,
	bdReady,
	bdShow,
	bdReadyCount,
	bdTypeNames,
	bdUpdate,
	type BdOptions,
} from "../src/bd.ts";
import { buildLineage, DEFAULT_LINEAGE_OPTIONS } from "../src/lineage.ts";
import {
	EMPTY_FILTER,
	NO_ASSIGNEE,
	filterArgs,
	matchesFilter,
	tabCounts,
	type PaneFilter,
} from "../src/filter.ts";

const BD = process.env.BD_BIN ?? "bd";
const hasBd = (() => {
	try {
		execFileSync(BD, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const skip = hasBd ? false : `bd binary "${BD}" not found`;

let dir = "";
let opts: BdOptions;

/** Run bd directly in the test database (for setup the plugin never does). */
function bd(...args: string[]): string {
	return execFileSync(BD, args, { cwd: dir, encoding: "utf8" });
}

before(() => {
	if (!hasBd) return;
	dir = mkdtempSync(join(tmpdir(), "obsidian-beads-it-"));
	// BEADS_DIR only for init (no git repo here); every later call finds the
	// database from its cwd, exactly like the plugin does with the project root.
	execFileSync(BD, ["init", "--quiet", "--stealth", "--skip-agents", "--prefix", "it"], {
		cwd: dir,
		env: { ...process.env, BEADS_DIR: join(dir, ".beads") },
		stdio: "ignore",
	});
	opts = { bdPath: BD, cwd: dir, timeoutMs: 30_000 };
});

after(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const create = (title: string) =>
	bdCreate(opts, { title, type: "task", priority: 2 });

test("text fields round-trip verbatim through bd update / bd show", { skip }, async () => {
	const id = await create("text fields");
	const text = {
		description: "stage: compare\n\nCLOSE: bd close <this-id>",
		design: "## Approach\n- use `bd dep list`",
		notes: "--status=closed is just text\nline 2",
		acceptance: "JSON parses & has <verdict>",
	};
	await bdUpdate(opts, id, text);
	const issue = await bdShow(opts, id);
	assert.ok(issue);
	assert.equal(issue.description, text.description);
	assert.equal(issue.design, text.design);
	assert.equal(issue.notes, text.notes);
	assert.equal(issue.acceptance_criteria, text.acceptance); // JSON key differs from the flag
	assert.equal(issue.status, "open", "a flag-looking value must not be parsed as a flag");
});

test('an empty string clears a text field', { skip }, async () => {
	const id = await create("clear fields");
	await bdUpdate(opts, id, { design: "d", notes: "n", acceptance: "a", description: "x" });
	await bdUpdate(opts, id, { design: "", notes: "", acceptance: "", description: "" });
	const issue = await bdShow(opts, id);
	assert.ok(issue);
	for (const key of ["design", "notes", "acceptance_criteria", "description"] as const) {
		assert.ok(!issue[key], `${key} should be cleared, got ${JSON.stringify(issue[key])}`);
	}
});

test("dep list: down = prerequisites, up = dependents, with dependency_type", { skip }, async () => {
	const epic = (JSON.parse(bd("create", "--title=epic", "--type=epic", "--json")) as { id: string }).id;
	const child = (JSON.parse(bd("create", "--title=child", `--parent=${epic}`, "--json")) as { id: string }).id;
	const blocker = await create("blocker");
	bd("dep", "add", child, blocker);

	const down = await bdDepList(opts, child, "down");
	const byId = Object.fromEntries(down.map((d) => [d.id, d.dependency_type]));
	assert.deepEqual(byId, { [epic]: "parent-child", [blocker]: "blocks" });

	const up = await bdDepList(opts, blocker, "up");
	assert.deepEqual(up.map((d) => [d.id, d.dependency_type]), [[child, "blocks"]]);
});

test("lineage over real bd keeps every edge of a diamond, oriented prerequisite -> dependent", { skip }, async () => {
	// a -> b -> d, a -> c -> d, d -> e   (x -> y: y depends on x)
	const [a, b, c, d, e] = await Promise.all(["a", "b", "c", "d", "e"].map((t) => create(`lineage ${t}`)));
	bd("dep", "add", b, a);
	bd("dep", "add", c, a);
	bd("dep", "add", d, b);
	bd("dep", "add", d, c);
	bd("dep", "add", e, d);
	const focus = await bdShow(opts, d);
	assert.ok(focus);

	const g = await buildLineage(focus, (id, dir) => bdDepList(opts, id, dir), DEFAULT_LINEAGE_OPTIONS);
	const edges = new Set(g.edges.map((x) => `${x.from}->${x.to}:${x.type}`));
	assert.deepEqual(
		edges,
		new Set([`${a}->${b}:blocks`, `${a}->${c}:blocks`, `${b}->${d}:blocks`, `${c}->${d}:blocks`, `${d}->${e}:blocks`]),
	);
	const side = Object.fromEntries(g.nodes.map((n) => [n.id, n.side]));
	assert.deepEqual(side, { [d]: "focus", [b]: "before", [c]: "before", [a]: "before", [e]: "after" });
});

// --- pane filters -----------------------------------------------------------

/** Seed beads covering every filter dimension (created once, used by the tests below). */
let seeded: Promise<void> | null = null;
function seedFilterData(): Promise<void> {
	seeded ??= (async () => {
		const mk = (title: string, type: string, assignee?: string, labels?: string[]) =>
			bdCreate(opts, { title, type, priority: 2, assignee, labels });
		await mk("f-alice-bug-xy", "bug", "alice", ["fx", "fy"]);
		await mk("f-bob-task-x", "task", "bob", ["fx"]);
		await mk("f-none-task-y", "task", undefined, ["fy"]);
		const blocker = await mk("f-none-feature", "feature");
		const blocked = await mk("f-alice-task-x-blocked", "task", "alice", ["fx"]);
		bd("dep", "add", blocked, blocker);
		const closed = await mk("f-alice-bug-x-closed", "bug", "alice", ["fx"]);
		bd("close", closed, "--reason", "done");
	})();
	return seeded;
}

const FILTERS: PaneFilter[] = [
	{ assignee: "", labels: [], type: "" },
	{ assignee: "alice", labels: [], type: "" },
	{ assignee: NO_ASSIGNEE, labels: [], type: "" },
	{ assignee: "", labels: ["fx"], type: "" },
	{ assignee: "", labels: ["fx", "fy"], type: "" },
	{ assignee: "", labels: [], type: "task" },
	{ assignee: "alice", labels: ["fx"], type: "task" },
	{ assignee: NO_ASSIGNEE, labels: ["fy"], type: "task" },
];
const ids = (issues: { id: string }[]) => issues.map((i) => i.id).sort();
const label = (f: PaneFilter) => JSON.stringify(f);

test("bd's filter flags and the local matchesFilter agree (list, ready, count)", { skip }, async () => {
	await seedFilterData();
	const allOpen = await bdByStatus(opts, "open", 0);
	const allReady = await bdReady(opts, 0);
	const allClosed = await bdByStatus(opts, "closed", 0);
	for (const f of FILTERS) {
		const listed = await bdByStatus(opts, "open", 0, filterArgs(f, "list"));
		assert.deepEqual(ids(listed), ids(allOpen.filter((i) => matchesFilter(i, f))), `list ${label(f)}`);

		const ready = await bdReady(opts, 0, filterArgs(f, "ready"));
		assert.deepEqual(ids(ready), ids(allReady.filter((i) => matchesFilter(i, f))), `ready ${label(f)}`);

		const closedCount = await bdCount(opts, "closed", filterArgs(f, "count"));
		assert.equal(closedCount, allClosed.filter((i) => matchesFilter(i, f)).length, `count ${label(f)}`);
	}
});

test("the Blocked tab's local filter selects exactly the blocked beads bd would list", { skip }, async () => {
	await seedFilterData();
	const blocked = await bdBlocked(opts);
	assert.ok(blocked.some((b) => b.title === "f-alice-task-x-blocked"), "seed bead is blocked");
	for (const f of FILTERS) {
		const local = blocked.filter((i) => matchesFilter(i, f));
		// Same beads bd itself returns for these flags, restricted to blocked ids.
		const blockedIds = new Set(blocked.map((b) => b.id));
		const viaBd = (await bdByStatus(opts, "open", 0, filterArgs(f, "list"))).filter((i) =>
			blockedIds.has(i.id),
		);
		assert.deepEqual(ids(local), ids(viaBd), `blocked ${label(f)}`);
	}
});

test("filter dropdown options come from real bd output", { skip }, async () => {
	await seedFilterData();
	const [assignees, labels, types] = await Promise.all([
		bdAssigneeNames(opts),
		bdLabelNames(opts),
		bdTypeNames(opts),
	]);
	assert.ok(assignees.includes("alice") && assignees.includes("bob"), assignees.join(","));
	assert.ok(!assignees.includes("(unassigned)"));
	assert.equal(assignees[0], "alice", "most-assigned first");
	assert.ok(labels.includes("fx") && labels.includes("fy"), labels.join(","));
	for (const t of ["task", "bug", "feature", "epic"]) assert.ok(types.includes(t), t);
});

// --- bd v2 JSON envelope -------------------------------------------------------

test("every bd call reads the same data with BD_JSON_ENVELOPE=1 (bd v2.0 default)", { skip }, async () => {
	await seedFilterData();
	const id = await create("envelope probe");
	bd("comments", "add", id, "hello");
	const snapshot = async () => ({
		created: typeof (await create("envelope create")) === "string",
		ready: ids(await bdReady(opts, 0)),
		open: ids(await bdByStatus(opts, "open", 0)),
		blocked: ids(await bdBlocked(opts)),
		show: (await bdShow(opts, id))?.id,
		deps: ids(await bdDepList(opts, id, "down")),
		comments: (await bdComments(opts, id)).map((c) => c.text),
		count: await bdCount(opts, "open"),
		readyCount: (await bdReadyCount(opts)) > 0,
		labels: (await bdLabelNames(opts)).sort(),
		assignees: (await bdAssigneeNames(opts)).sort(),
		types: await bdTypeNames(opts),
	});
	const legacy = await snapshot();
	const prev = process.env.BD_JSON_ENVELOPE;
	process.env.BD_JSON_ENVELOPE = "1"; // inherited by the bd child processes
	try {
		// The envelope really is on: raw output is wrapped.
		assert.ok("data" in (JSON.parse(bd("count", "--status", "open", "--json")) as object));
		const enveloped = await snapshot();
		// Each snapshot created one more bead, so compare everything but the moving counts.
		assert.deepEqual({ ...enveloped, open: [], ready: [], count: 0 }, { ...legacy, open: [], ready: [], count: 0 });
		assert.equal(enveloped.count, legacy.count + 1);
		assert.equal(enveloped.open.length, legacy.open.length + 1);
		assert.ok(legacy.comments.includes("hello") && legacy.readyCount && legacy.created);
	} finally {
		if (prev === undefined) delete process.env.BD_JSON_ENVELOPE;
		else process.env.BD_JSON_ENVELOPE = prev;
	}
});

// --- tab counts match the tab lists (bd status undercounts ready) ------------

test("tab counts equal list lengths, even with a blocked deferred bead (bd status undercounts)", { skip }, async () => {
	await seedFilterData();
	// The case that breaks `bd status`: a bead that is both blocked and deferred.
	const blocker = await create("count-blocker");
	const deferred = await create("count-deferred-blocked");
	bd("dep", "add", deferred, blocker);
	bd("update", deferred, "--status=deferred");

	const statusReady = (JSON.parse(bd("status", "--json")) as { summary: { ready_issues: number } }).summary
		.ready_issues;
	const readyList = await bdReady(opts, 0);
	// Pin the bd behaviour this change works around (update if bd fixes it).
	assert.ok(statusReady < readyList.length, `bd status ready=${statusReady}, bd ready lists ${readyList.length}`);

	const src = {
		ready: (args: string[]) => bdReady(opts, 0, args),
		count: (status: string, args: string[]) => bdCount(opts, status, args),
		blocked: () => bdBlocked(opts),
	};
	for (const f of [{ ...EMPTY_FILTER, labels: [] }, ...FILTERS]) {
		const counts = await tabCounts(f, src);
		assert.equal(counts.ready_issues, (await bdReady(opts, 0, filterArgs(f, "ready"))).length, `ready ${label(f)}`);
		assert.equal(
			counts.in_progress_issues,
			(await bdByStatus(opts, "in_progress", 0, filterArgs(f, "list"))).length,
			`in_progress ${label(f)}`,
		);
		assert.equal(
			counts.closed_issues,
			(await bdByStatus(opts, "closed", 0, filterArgs(f, "list"))).length,
			`closed ${label(f)}`,
		);
		assert.equal(
			counts.blocked_issues,
			(await bdBlocked(opts)).filter((i) => matchesFilter(i, f)).length,
			`blocked ${label(f)}`,
		);
	}
	// The status bar agrees with the Ready tab.
	assert.equal(await bdReadyCount(opts), readyList.length);
});
