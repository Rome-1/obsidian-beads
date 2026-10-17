import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildLineage,
	layoutLineage,
	foldKey,
	fitViewBox,
	zoomViewBox,
	edgePath,
	truncateLabel,
	DEFAULT_LINEAGE_OPTIONS,
	type DepDirection,
	type LineageOptions,
} from "../src/lineage.ts";
import type { BeadIssue } from "../src/types.ts";

/**
 * A tiny in-memory bd: `deps` lists [dependent, prerequisite, type] edges,
 * exactly what `bd dep add <dependent> <prerequisite> --type <type>` stores.
 * fetch(id, "down") returns prerequisites; fetch(id, "up") returns dependents.
 */
function fakeBd(
	deps: [string, string, string?][],
	extra: Record<string, Partial<BeadIssue>> = {},
) {
	const issue = (id: string): BeadIssue => ({
		id,
		title: `title ${id}`,
		status: "open",
		priority: 2,
		issue_type: "task",
		...extra[id],
	});
	const calls: string[] = [];
	const fetch = async (id: string, dir: DepDirection): Promise<BeadIssue[]> => {
		calls.push(`${id}:${dir}`);
		return deps
			.filter(([dependent, prereq]) => (dir === "down" ? dependent === id : prereq === id))
			.map(([dependent, prereq, type]) => ({
				...issue(dir === "down" ? prereq : dependent),
				dependency_type: type ?? "blocks",
			}));
	};
	return { issue, fetch, calls };
}

const opts = (o: Partial<LineageOptions> = {}): LineageOptions => ({
	...DEFAULT_LINEAGE_OPTIONS,
	...o,
});

const edgeSet = (edges: { from: string; to: string; type: string }[]) =>
	new Set(edges.map((e) => `${e.from}->${e.to}:${e.type}`));

// The real TC-LIFE-05 shape: compare needs legacy+target, target needs
// fixture/plan/approve, and the epic needs compare.
const SBS: [string, string, string?][] = [
	["compare", "legacy"],
	["compare", "target"],
	["target", "fixture"],
	["target", "plan"],
	["target", "approve"],
	["epic", "compare"],
];

test("walks prerequisites left and dependents right, edges oriented prereq -> dependent", async () => {
	const bd = fakeBd(SBS);
	const g = await buildLineage(bd.issue("compare"), bd.fetch, opts());
	const side = Object.fromEntries(g.nodes.map((n) => [n.id, n.side]));
	assert.deepEqual(side, {
		compare: "focus",
		legacy: "before",
		target: "before",
		fixture: "before",
		plan: "before",
		approve: "before",
		epic: "after",
	});
	assert.deepEqual(
		edgeSet(g.edges),
		new Set([
			"legacy->compare:blocks",
			"target->compare:blocks",
			"fixture->target:blocks",
			"plan->target:blocks",
			"approve->target:blocks",
			"compare->epic:blocks",
		]),
	);
	assert.equal(g.truncated, false);
});

test("excludes siblings: dependents of a prerequisite are not walked", async () => {
	// `fixture` also blocks another case's target; that one is not in compare's lineage.
	const bd = fakeBd([...SBS, ["other-target", "fixture"]]);
	const g = await buildLineage(bd.issue("compare"), bd.fetch, opts());
	assert.ok(!g.nodes.some((n) => n.id === "other-target"));
});

test("keeps every edge of a diamond (bd dep tree drops these)", async () => {
	const bd = fakeBd([
		["d", "b"],
		["d", "c"],
		["b", "a"],
		["c", "a"],
	]);
	const g = await buildLineage(bd.issue("d"), bd.fetch, opts());
	assert.equal(g.nodes.length, 4);
	assert.deepEqual(
		edgeSet(g.edges),
		new Set(["b->d:blocks", "c->d:blocks", "a->b:blocks", "a->c:blocks"]),
	);
	// `a` is reached twice but only expanded once.
	assert.equal(bd.calls.filter((c) => c === "a:down").length, 1);
});

test("depth limits each direction independently", async () => {
	const bd = fakeBd([
		["b", "a"],
		["c", "b"],
		["d", "c"],
		["e", "d"],
	]);
	const g = await buildLineage(bd.issue("c"), bd.fetch, opts({ depthBefore: 1, depthAfter: 2 }));
	assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["b", "c", "d", "e"]);
	assert.equal(g.nodes.find((n) => n.id === "e")?.depth, 2);
});

test("folds fan-out past the limit, keeping open and high-priority beads", async () => {
	const deps: [string, string][] = [];
	for (let i = 0; i < 10; i++) deps.push([`dep${i}`, "fixture"]);
	const bd = fakeBd(deps, {
		dep9: { priority: 0 },
		dep0: { status: "closed" },
	});
	const g = await buildLineage(bd.issue("fixture"), bd.fetch, opts({ fanout: 3 }));
	const after = g.nodes.filter((n) => n.side === "after").map((n) => n.id);
	assert.equal(after.length, 3);
	assert.equal(after[0], "dep9"); // P0 first
	assert.ok(!after.includes("dep0")); // closed last
	assert.deepEqual(g.folds, [
		{ key: foldKey("fixture", "up"), anchor: "fixture", dir: "up", count: 7 },
	]);
});

test("an expanded fold shows every neighbour", async () => {
	const deps: [string, string][] = [];
	for (let i = 0; i < 10; i++) deps.push([`dep${i}`, "fixture"]);
	const bd = fakeBd(deps);
	const g = await buildLineage(
		bd.issue("fixture"),
		bd.fetch,
		opts({ fanout: 3, expanded: new Set([foldKey("fixture", "up")]) }),
	);
	assert.equal(g.nodes.length, 11);
	assert.deepEqual(g.folds, []);
});

test("maxNodes caps the graph and flags truncation, with no dangling edges", async () => {
	const deps: [string, string][] = [];
	for (let i = 0; i < 20; i++) deps.push(["focus", `p${i}`]);
	const bd = fakeBd(deps);
	const g = await buildLineage(bd.issue("focus"), bd.fetch, opts({ fanout: 50, maxNodes: 5 }));
	assert.equal(g.nodes.length, 5);
	assert.equal(g.truncated, true);
	const ids = new Set(g.nodes.map((n) => n.id));
	for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from}->${e.to}`);
});

test("keeps dependency types (parent-child, related)", async () => {
	const bd = fakeBd([
		["step", "mol-root", "parent-child"],
		["step", "note", "related"],
	]);
	const g = await buildLineage(bd.issue("step"), bd.fetch, opts());
	assert.deepEqual(
		edgeSet(g.edges),
		new Set(["mol-root->step:parent-child", "note->step:related"]),
	);
});

test("layout places prerequisites left of the focus and dependents right", async () => {
	const bd = fakeBd(SBS);
	const g = await buildLineage(bd.issue("compare"), bd.fetch, opts());
	const l = layoutLineage(g);
	const x = Object.fromEntries(l.nodes.map((n) => [n.id, n.x]));
	assert.ok(x.fixture < x.target && x.target < x.compare && x.compare < x.epic);
	assert.equal(l.nodes.length, g.nodes.length);
	assert.equal(l.edges.length, g.edges.length);
	for (const e of l.edges) assert.ok(e.points.length >= 2);
	assert.ok(l.width > 0 && l.height > 0);
});

test("layout includes fold nodes wired to their anchor", async () => {
	const deps: [string, string][] = [];
	for (let i = 0; i < 5; i++) deps.push([`dep${i}`, "fixture"]);
	const bd = fakeBd(deps);
	const g = await buildLineage(bd.issue("fixture"), bd.fetch, opts({ fanout: 2 }));
	const l = layoutLineage(g);
	const fold = l.nodes.find((n) => n.kind === "fold");
	assert.ok(fold);
	assert.equal(fold.fold?.count, 3);
	assert.ok(l.edges.some((e) => e.type === "fold" && e.from === "fixture" && e.to === fold.id));
});

// --- view geometry ---------------------------------------------------------

test("fitViewBox centres a large graph and scales it down to fit", () => {
	const vb = fitViewBox(2000, 500, 1000, 500);
	// Width-bound: scale 0.5, so the viewBox is twice the viewport.
	assert.deepEqual(vb, { x: 0, y: -250, w: 2000, h: 1000 });
});

test("fitViewBox never enlarges a small graph past 1:1", () => {
	const vb = fitViewBox(200, 100, 1000, 500);
	assert.equal(vb.w, 1000);
	assert.equal(vb.h, 500);
	assert.equal(vb.x, -400); // centred
	assert.equal(vb.y, -200);
});

test("fitViewBox stays finite for a hidden (0×0) viewport and an empty graph", () => {
	for (const vb of [fitViewBox(1000, 500, 0, 0), fitViewBox(0, 0, 800, 600)]) {
		for (const v of Object.values(vb)) assert.ok(Number.isFinite(v));
		assert.ok(vb.w > 0 && vb.h > 0);
	}
});

test("zoomViewBox keeps the point under the cursor fixed", () => {
	const vb = { x: 100, y: 50, w: 400, h: 200 };
	const fx = 0.25;
	const fy = 0.75;
	const before = { x: vb.x + fx * vb.w, y: vb.y + fy * vb.h };
	const z = zoomViewBox(vb, 0.5, fx, fy, 10, 10_000);
	assert.equal(z.w, 200);
	assert.equal(z.h, 100);
	assert.deepEqual({ x: z.x + fx * z.w, y: z.y + fy * z.h }, before);
});

test("zoomViewBox clamps to the zoom range and keeps the aspect ratio", () => {
	const vb = { x: 0, y: 0, w: 400, h: 200 };
	const zin = zoomViewBox(vb, 0.01, 0.5, 0.5, 120, 40_000);
	assert.equal(zin.w, 120);
	assert.equal(zin.h, 60);
	const zout = zoomViewBox(vb, 1_000, 0.5, 0.5, 120, 1_000);
	assert.equal(zout.w, 1_000);
	assert.equal(zout.h, 500);
});

test("edgePath: straight for two points, smoothed through bends, empty for none", () => {
	assert.equal(edgePath([]), "");
	assert.equal(edgePath([{ x: 0, y: 0 }, { x: 10, y: 5 }]), "M0,0 L10,5");
	assert.equal(
		edgePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }]),
		"M0,0 Q10,0 15,5 L20,10",
	);
});

test("truncateLabel collapses whitespace/newlines and cuts with an ellipsis", () => {
	assert.equal(truncateLabel("We are i\nn the  UI", 50), "We are i n the UI");
	assert.equal(truncateLabel("abcdefghij", 5), "abcd…");
	assert.equal(truncateLabel("abcde", 5), "abcde");
});

test("a fold's count excludes nothing it shouldn't: fold + shown = all neighbours", async () => {
	const deps: [string, string][] = [];
	for (let i = 0; i < 12; i++) deps.push(["focus", `p${i}`]);
	const bd = fakeBd(deps);
	const g = await buildLineage(bd.issue("focus"), bd.fetch, opts({ fanout: 5 }));
	const shown = g.nodes.filter((n) => n.side === "before").length;
	assert.equal(shown + g.folds[0].count, 12);
});

test("depth 0 in a direction skips that walk entirely (no bd calls)", async () => {
	const bd = fakeBd(SBS);
	const g = await buildLineage(bd.issue("compare"), bd.fetch, opts({ depthBefore: 0, depthAfter: 0 }));
	assert.deepEqual(g.nodes.map((n) => n.id), ["compare"]);
	assert.deepEqual(bd.calls, []);
});
