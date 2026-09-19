import dagre from "@dagrejs/dagre";
import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import type { BeadIssue } from "./types";

/**
 * Bead lineage: everything a bead transitively depends on (its blockers,
 * parents, … — drawn to the LEFT) and everything that transitively depends on
 * it (its dependents — drawn to the RIGHT). Siblings are deliberately excluded:
 * this is the order a bead sits in, not its whole connected component.
 *
 * Pure: no Obsidian imports. The bd call is injected (`fetchDeps`) so the walk
 * is unit-testable and the view keeps bd.ts as the only place that spawns bd.
 *
 * Why not `bd dep tree --direction=both`? It de-duplicates nodes and drops the
 * edges that would revisit them (443 of 876 edges on a real epic), and in
 * "both" mode it doesn't say which way an edge points. `bd dep list` per node
 * is exact, typed, and directional.
 */

/** bd direction: "down" = what the bead depends on, "up" = what depends on it. */
export type DepDirection = "down" | "up";

export type FetchDeps = (id: string, dir: DepDirection) => Promise<BeadIssue[]>;

export type LineageSide = "focus" | "before" | "after";

export interface LineageNode {
	id: string;
	title: string;
	status: string;
	priority: number;
	issueType: string;
	side: LineageSide;
	/** Hops from the focus bead. */
	depth: number;
}

/** Always oriented prerequisite → dependent (blocker → blocked, parent → child). */
export interface LineageEdge {
	from: string;
	to: string;
	type: string;
}

/** A collapsed group of neighbours past the fan-out limit. */
export interface LineageFold {
	/** Stable key: `<anchor>|<dir>` — also what `expanded` holds. */
	key: string;
	anchor: string;
	dir: DepDirection;
	count: number;
}

export interface LineageGraph {
	focus: string;
	nodes: LineageNode[];
	edges: LineageEdge[];
	folds: LineageFold[];
	/** The node cap stopped the walk before it was complete. */
	truncated: boolean;
}

export interface LineageOptions {
	/** How many hops of prerequisites to follow (bd "down"). */
	depthBefore: number;
	/** How many hops of dependents to follow (bd "up"). */
	depthAfter: number;
	/** Neighbours shown per bead per direction before the rest fold. */
	fanout: number;
	/** Hard cap on beads in the graph (bounds bd calls and render size). */
	maxNodes: number;
	/** Fold keys (`<id>|<dir>`) the user expanded. */
	expanded?: ReadonlySet<string>;
}

export const DEFAULT_LINEAGE_OPTIONS: LineageOptions = {
	depthBefore: 3,
	depthAfter: 3,
	fanout: 8,
	maxNodes: 80,
};

export function foldKey(anchor: string, dir: DepDirection): string {
	return `${anchor}|${dir}`;
}

function toNode(issue: BeadIssue, side: LineageSide, depth: number): LineageNode {
	return {
		id: issue.id,
		title: issue.title ?? "",
		status: issue.status ?? "open",
		priority: issue.priority ?? 2,
		issueType: issue.issue_type ?? "task",
		side,
		depth,
	};
}

/** Open work first, then by priority, then id — so folding hides the least relevant. */
function relevance(a: BeadIssue, b: BeadIssue): number {
	const closed = (i: BeadIssue) => (i.status === "closed" ? 1 : 0);
	return (
		closed(a) - closed(b) ||
		(a.priority ?? 2) - (b.priority ?? 2) ||
		a.id.localeCompare(b.id)
	);
}

/** Walk the lineage of `focus` breadth-first in both directions. */
export async function buildLineage(
	focus: BeadIssue,
	fetchDeps: FetchDeps,
	opts: LineageOptions,
): Promise<LineageGraph> {
	const nodes = new Map<string, LineageNode>([[focus.id, toNode(focus, "focus", 0)]]);
	const edges = new Map<string, LineageEdge>();
	const folds: LineageFold[] = [];
	let truncated = false;

	const walk = async (dir: DepDirection, maxDepth: number): Promise<void> => {
		const side: LineageSide = dir === "down" ? "before" : "after";
		let frontier = [focus.id];
		const expandedHere = new Set<string>([focus.id]);
		for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
			const results = await Promise.all(
				frontier.map(async (id) => ({ id, rows: await fetchDeps(id, dir) })),
			);
			const next: string[] = [];
			for (const { id, rows } of results) {
				const sorted = [...rows].sort(relevance);
				const key = foldKey(id, dir);
				const limit = opts.expanded?.has(key) ? sorted.length : opts.fanout;
				const shown = sorted.slice(0, limit);
				if (sorted.length > shown.length) {
					folds.push({ key, anchor: id, dir, count: sorted.length - shown.length });
				}
				for (const row of shown) {
					if (!nodes.has(row.id)) {
						if (nodes.size >= opts.maxNodes) {
							truncated = true;
							continue;
						}
						nodes.set(row.id, toNode(row, side, depth));
					}
					const type = row.dependency_type ?? "blocks";
					// Edges always read prerequisite → dependent.
					const edge =
						dir === "down"
							? { from: row.id, to: id, type }
							: { from: id, to: row.id, type };
					edges.set(`${edge.from}|${edge.to}|${edge.type}`, edge);
					if (!expandedHere.has(row.id)) {
						expandedHere.add(row.id);
						next.push(row.id);
					}
				}
			}
			frontier = next;
		}
	};

	await walk("down", opts.depthBefore);
	await walk("up", opts.depthAfter);

	return {
		focus: focus.id,
		nodes: [...nodes.values()],
		edges: [...edges.values()],
		folds,
		truncated,
	};
}

// --- layout --------------------------------------------------------------

export const NODE_W = 230;
export const NODE_H = 50;
export const FOLD_W = 150;
export const FOLD_H = 30;

export interface Point {
	x: number;
	y: number;
}

export interface PlacedNode {
	/** Bead id, or the fold key for a fold node. */
	id: string;
	kind: "bead" | "fold";
	/** Top-left corner. */
	x: number;
	y: number;
	w: number;
	h: number;
	bead?: LineageNode;
	fold?: LineageFold;
}

export interface PlacedEdge {
	from: string;
	to: string;
	type: string;
	points: Point[];
}

export interface LineageLayout {
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
}

/** Dependency types that gate readiness — drawn solid; the rest dashed. */
export const BLOCKING_TYPES = new Set([
	"blocks",
	"parent-child",
	"conditional-blocks",
	"waits-for",
]);

/**
 * Lay the graph out left→right (prerequisites left, dependents right) with
 * dagre's layered DAG layout. Fold nodes sit next to the bead they belong to.
 */
export function layoutLineage(graph: LineageGraph): LineageLayout {
	const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
	g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 70, marginx: 24, marginy: 24 });
	g.setDefaultEdgeLabel(() => ({}));

	for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
	for (const f of graph.folds) g.setNode(f.key, { width: FOLD_W, height: FOLD_H });
	graph.edges.forEach((e, i) => {
		// Weight blocking edges higher so the main order reads straight.
		g.setEdge(e.from, e.to, { weight: BLOCKING_TYPES.has(e.type) ? 2 : 1 }, `e${i}`);
	});
	graph.folds.forEach((f, i) => {
		const [from, to] = f.dir === "down" ? [f.key, f.anchor] : [f.anchor, f.key];
		g.setEdge(from, to, { weight: 1 }, `f${i}`);
	});

	dagre.layout(g);

	const beads = new Map(graph.nodes.map((n) => [n.id, n]));
	const foldsByKey = new Map(graph.folds.map((f) => [f.key, f]));
	const nodes: PlacedNode[] = g.nodes().map((id) => {
		const l = g.node(id);
		const fold = foldsByKey.get(id);
		return {
			id,
			kind: fold ? "fold" : "bead",
			x: (l.x ?? 0) - l.width / 2,
			y: (l.y ?? 0) - l.height / 2,
			w: l.width,
			h: l.height,
			bead: beads.get(id),
			fold,
		};
	});
	const edges: PlacedEdge[] = g.edges().map((ref) => {
		const isFold = ref.name?.startsWith("f") ?? false;
		const src = isFold ? undefined : graph.edges[Number(ref.name?.slice(1))];
		return {
			from: ref.v,
			to: ref.w,
			type: src?.type ?? "fold",
			points: (g.edge(ref).points ?? []).map((p) => ({ x: p.x, y: p.y })),
		};
	});
	const size = g.graph();
	return { width: size.width ?? 0, height: size.height ?? 0, nodes, edges };
}

// --- view geometry (pure, so the SVG view's math is unit-testable) ------

export interface ViewBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * The viewBox that fits the whole graph into a `viewW`×`viewH` pixel viewport,
 * centred, never enlarging a small graph past 1:1. A hidden viewport (0 size)
 * is treated as 1px so the result stays finite; the view refits on resize.
 */
export function fitViewBox(
	graphW: number,
	graphH: number,
	viewW: number,
	viewH: number,
): ViewBox {
	const cw = Math.max(1, viewW);
	const ch = Math.max(1, viewH);
	const scale = Math.min(1, cw / Math.max(1, graphW), ch / Math.max(1, graphH));
	const w = cw / scale;
	const h = ch / scale;
	return { x: (graphW - w) / 2, y: (graphH - h) / 2, w, h };
}

/**
 * Zoom by `factor` (>1 zooms out) keeping the graph point under the cursor
 * fixed. `fx`/`fy` are the cursor's position as a 0–1 fraction of the viewport.
 * Width is clamped to [minW, maxW].
 */
export function zoomViewBox(
	vb: ViewBox,
	factor: number,
	fx: number,
	fy: number,
	minW: number,
	maxW: number,
): ViewBox {
	const w = Math.max(minW, Math.min(vb.w * factor, maxW));
	const k = w / vb.w;
	const px = vb.x + fx * vb.w;
	const py = vb.y + fy * vb.h;
	return { x: px - (px - vb.x) * k, y: py - (py - vb.y) * k, w, h: vb.h * k };
}

/** SVG path through dagre's edge points, smoothed with quadratic segments. */
export function edgePath(points: Point[]): string {
	if (!points.length) return "";
	const [first, ...rest] = points;
	if (rest.length < 2) {
		return [`M${first.x},${first.y}`, ...rest.map((p) => `L${p.x},${p.y}`)].join(" ");
	}
	let d = `M${first.x},${first.y}`;
	for (let i = 0; i < rest.length - 1; i++) {
		const p = rest[i];
		const next = rest[i + 1];
		d += ` Q${p.x},${p.y} ${(p.x + next.x) / 2},${(p.y + next.y) / 2}`;
	}
	const last = rest[rest.length - 1];
	return `${d} L${last.x},${last.y}`;
}

/** Collapse whitespace (titles can contain newlines) and cut to `max` chars with "…". */
export function truncateLabel(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
