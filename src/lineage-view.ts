import { ItemView, Keymap, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { VIEW_TYPE_BEADS_LINEAGE } from "./types";
import { BdError, BdOptions, bdDepList, bdShow } from "./bd";
import {
	BLOCKING_TYPES,
	DEFAULT_LINEAGE_OPTIONS,
	LineageLayout,
	LineageOptions,
	PlacedNode,
	ViewBox,
	buildLineage,
	edgePath,
	fitViewBox,
	layoutLineage,
	truncateLabel,
	zoomViewBox,
} from "./lineage";

const MAX_DEPTH = 8;
const TITLE_CHARS = 34;
const MIN_ZOOM_W = 120; // smallest viewBox width (max zoom-in), in graph units
const MAX_ZOOM_W = 40_000; // largest viewBox width (max zoom-out)

interface LineageState {
	id?: string;
}

let markerSeq = 0;

/**
 * Navigable lineage graph for one bead: prerequisites to the left, dependents
 * to the right. Click a bead to re-centre on it, click the centre bead (or
 * Cmd/Ctrl-click any bead) to open it in the editor, click "+N more" to expand
 * a folded fan-out. Drag to pan, wheel to zoom.
 *
 * SECURITY: the SVG is built node-by-node with the DOM API and bead text is set
 * via textContent — no markup strings, no innerHTML, no Mermaid (which Obsidian
 * gates behind a per-vault trust prompt). Refreshes only on demand: a lineage
 * walk is one bd call per bead, too heavy for the auto-refresh timer.
 */
export class BeadLineageView extends ItemView {
	private focusId: string | null = null;
	private history: string[] = [];
	private opts: LineageOptions = { ...DEFAULT_LINEAGE_OPTIONS };
	private expanded = new Set<string>();
	private loadSeq = 0;

	private backBtn: HTMLButtonElement | null = null;
	private focusLabelEl: HTMLElement | null = null;
	private beforeVal: HTMLElement | null = null;
	private afterVal: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private canvas: HTMLElement | null = null;
	private svg: SVGSVGElement | null = null;
	private layout: LineageLayout | null = null;
	private vb: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
	private drag: { x: number; y: number; vb: ViewBox; moved: boolean } | null = null;
	/** The user panned or zoomed — stop auto-fitting on resize. */
	private userMoved = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS_LINEAGE;
	}
	getIcon(): string {
		return "git-fork";
	}
	getDisplayText(): string {
		return this.focusId ? `Lineage · ${this.focusId}` : "Bead lineage";
	}

	getState(): Record<string, unknown> {
		return { id: this.focusId ?? undefined };
	}

	async setState(state: LineageState, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		if (state && typeof state.id === "string" && state.id !== this.focusId) {
			this.focus(state.id, true);
		}
	}

	async onOpen(): Promise<void> {
		this.buildShell();
		if (this.focusId) await this.reload();
		else this.showMessage("Open a bead and choose “Show lineage”.");
	}

	onResize(): void {
		// A view drawn while hidden measured 0×0; refit once it has a size.
		if (!this.userMoved) this.fit();
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}

	/** Re-centre on a bead. `push` records the current one for Back. */
	focus(id: string, push: boolean): void {
		if (id === this.focusId) return;
		if (push && this.focusId) this.history.push(this.focusId);
		this.focusId = id;
		this.expanded.clear();
		this.updateHeader();
		// Retitle the tab — only once the view is open (its header exists).
		if (this.canvas) {
			const leaf = this.leaf as unknown as { updateHeader?: () => void };
			leaf.updateHeader?.();
		}
		void this.reload();
	}

	// --- shell -----------------------------------------------------------

	private buildShell(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-lineage");

		const bar = root.createDiv({ cls: "beads-ln-bar" });
		this.backBtn = this.iconButton(bar, "arrow-left", "Back", () => {
			const prev = this.history.pop();
			if (prev) this.focus(prev, false);
		});
		this.focusLabelEl = bar.createDiv({ cls: "beads-ln-title" });

		const controls = bar.createDiv({ cls: "beads-ln-controls" });
		this.beforeVal = this.stepper(controls, "Before", "depthBefore");
		this.afterVal = this.stepper(controls, "After", "depthAfter");
		this.iconButton(controls, "maximize", "Fit to view", () => {
			this.userMoved = false;
			this.fit();
		});
		this.iconButton(controls, "refresh-cw", "Refresh", () => void this.reload());
		this.iconButton(controls, "file-text", "Open bead", () => {
			if (this.focusId) void this.plugin.openBead(this.focusId);
		});

		this.statusEl = root.createDiv({ cls: "beads-ln-status" });
		this.canvas = root.createDiv({ cls: "beads-ln-canvas" });
		this.registerCanvasEvents(this.canvas);
		this.updateHeader();
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": label },
		});
		setIcon(btn, icon);
		btn.onclick = onClick;
		return btn;
	}

	/** A "Before − n +" depth control bound to one option. */
	private stepper(
		parent: HTMLElement,
		label: string,
		key: "depthBefore" | "depthAfter",
	): HTMLElement {
		const wrap = parent.createDiv({ cls: "beads-ln-stepper" });
		wrap.createSpan({ cls: "beads-ln-stepper-label", text: label });
		const change = (delta: number) => {
			const next = Math.max(0, Math.min(MAX_DEPTH, this.opts[key] + delta));
			if (next === this.opts[key]) return;
			this.opts[key] = next;
			val.setText(String(next));
			void this.reload();
		};
		this.iconButton(wrap, "minus", `Fewer ${label.toLowerCase()} levels`, () => change(-1));
		const val = wrap.createSpan({ cls: "beads-ln-stepper-val", text: String(this.opts[key]) });
		this.iconButton(wrap, "plus", `More ${label.toLowerCase()} levels`, () => change(1));
		return val;
	}

	private updateHeader(): void {
		this.focusLabelEl?.setText(this.focusId ?? "");
		if (this.backBtn) this.backBtn.disabled = this.history.length === 0;
		this.beforeVal?.setText(String(this.opts.depthBefore));
		this.afterVal?.setText(String(this.opts.depthAfter));
	}

	private showMessage(text: string, isError = false): void {
		if (!this.canvas) return;
		this.canvas.empty();
		this.svg = null;
		this.layout = null;
		this.canvas.createDiv({
			cls: isError ? "beads-empty beads-error" : "beads-empty",
			text,
		});
		this.statusEl?.setText("");
	}

	// --- load ------------------------------------------------------------

	private resolveOpts(): BdOptions | null {
		const s = this.plugin.settings;
		if (!s.projectRoot) return null;
		if (!existsSync(join(s.projectRoot, ".beads"))) return null;
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	async reload(): Promise<void> {
		const id = this.focusId;
		if (!id || !this.canvas) return;
		const bd = this.resolveOpts();
		if (!bd) {
			this.showMessage("Set a project root that contains a .beads/ database in Beads settings.");
			return;
		}
		const seq = ++this.loadSeq;
		this.statusEl?.setText("Loading lineage…");
		try {
			const issue = await bdShow(bd, id);
			if (seq !== this.loadSeq) return;
			if (!issue) {
				this.showMessage(`No issue found for ${id}.`, true);
				return;
			}
			const graph = await buildLineage(issue, (bid, dir) => bdDepList(bd, bid, dir), {
				...this.opts,
				expanded: this.expanded,
			});
			if (seq !== this.loadSeq) return;
			this.draw(layoutLineage(graph));
			const bits = [`${graph.nodes.length} beads`, `${graph.edges.length} links`];
			if (graph.folds.length) bits.push(`${graph.folds.length} folded`);
			if (graph.truncated) bits.push(`capped at ${this.opts.maxNodes} beads`);
			this.statusEl?.setText(bits.join(" · "));
		} catch (e) {
			if (seq !== this.loadSeq) return;
			this.showMessage(e instanceof BdError ? e.message : String(e), true);
		}
	}

	// --- draw ------------------------------------------------------------

	private draw(layout: LineageLayout): void {
		const canvas = this.canvas;
		if (!canvas) return;
		canvas.empty();
		this.layout = layout;
		this.userMoved = false;

		const svg = canvas.createSvg("svg", { cls: "beads-ln-svg" });
		this.svg = svg;
		const markerId = `beads-ln-arrow-${++markerSeq}`;
		const marker = svg.createSvg("defs").createSvg("marker", {
			attr: {
				id: markerId,
				viewBox: "0 0 10 10",
				refX: "10",
				refY: "5",
				markerWidth: "7",
				markerHeight: "7",
				orient: "auto-start-reverse",
			},
		});
		marker.createSvg("path", { cls: "beads-ln-arrow", attr: { d: "M0,0 L10,5 L0,10 z" } });

		const edgeLayer = svg.createSvg("g", { cls: "beads-ln-edges" });
		for (const e of layout.edges) {
			const kind =
				e.type === "fold" ? "is-fold" : BLOCKING_TYPES.has(e.type) ? "is-blocking" : "is-soft";
			edgeLayer.createSvg("path", {
				cls: ["beads-ln-edge", kind],
				attr: { d: edgePath(e.points), "marker-end": `url(#${markerId})` },
			});
			if (e.type !== "blocks" && e.type !== "fold" && e.points.length) {
				const mid = e.points[Math.floor(e.points.length / 2)];
				const t = edgeLayer.createSvg("text", {
					cls: "beads-ln-edge-label",
					attr: { x: String(mid.x), y: String(mid.y - 4), "text-anchor": "middle" },
				});
				t.textContent = e.type;
			}
		}

		const nodeLayer = svg.createSvg("g", { cls: "beads-ln-nodes" });
		for (const n of layout.nodes) {
			if (n.kind === "fold") this.drawFold(nodeLayer, n);
			else this.drawBead(nodeLayer, n);
		}
		this.fit();
	}

	private drawBead(layer: SVGElement, n: PlacedNode): void {
		const b = n.bead;
		if (!b) return;
		const status = b.status.replace(/[^a-z_]/gi, "");
		const cls = ["beads-ln-node", `is-${status}`];
		if (b.side === "focus") cls.push("is-focus");
		const g = layer.createSvg("g", {
			cls,
			attr: { transform: `translate(${n.x},${n.y})`, "data-bead": b.id },
		});
		g.createSvg("title").textContent = `${b.id} · ${b.status} · P${b.priority} ${b.issueType}\n${b.title}`;
		g.createSvg("rect", { cls: "beads-ln-box", attr: { width: String(n.w), height: String(n.h), rx: "7" } });
		g.createSvg("circle", {
			cls: ["beads-ln-dot", `beads-ln-p${Math.max(0, Math.min(4, b.priority))}`],
			attr: { cx: "13", cy: "16", r: "4" },
		});
		const id = g.createSvg("text", { cls: "beads-ln-id", attr: { x: "23", y: "20" } });
		id.textContent = `${b.id}  ·  ${b.status}`;
		const title = g.createSvg("text", { cls: "beads-ln-label", attr: { x: "10", y: "39" } });
		title.textContent = truncateLabel(b.title, TITLE_CHARS);
	}

	private drawFold(layer: SVGElement, n: PlacedNode): void {
		const f = n.fold;
		if (!f) return;
		const g = layer.createSvg("g", {
			cls: "beads-ln-fold",
			attr: { transform: `translate(${n.x},${n.y})`, "data-fold": f.key },
		});
		g.createSvg("title").textContent = `Show all ${f.dir === "down" ? "prerequisites" : "dependents"} of ${f.anchor}`;
		g.createSvg("rect", { cls: "beads-ln-box", attr: { width: String(n.w), height: String(n.h), rx: "15" } });
		const t = g.createSvg("text", {
			cls: "beads-ln-label",
			attr: { x: String(n.w / 2), y: String(n.h / 2 + 4), "text-anchor": "middle" },
		});
		t.textContent = `+${f.count} more ${f.dir === "down" ? "before" : "after"}`;
	}

	// --- pan / zoom / click ----------------------------------------------

	private setViewBox(vb: ViewBox): void {
		this.vb = vb;
		this.svg?.setAttr("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
	}

	/** Fit the whole graph, but never blow a small graph up past 1:1. */
	private fit(): void {
		const svg = this.svg;
		const layout = this.layout;
		if (!svg || !layout) return;
		this.setViewBox(fitViewBox(layout.width, layout.height, svg.clientWidth, svg.clientHeight));
	}

	/** Graph units per screen pixel at the current zoom. */
	private unitsPerPx(): number {
		const svg = this.svg;
		if (!svg) return 1;
		return Math.max(this.vb.w / Math.max(1, svg.clientWidth), this.vb.h / Math.max(1, svg.clientHeight));
	}

	private registerCanvasEvents(canvas: HTMLElement): void {
		this.registerDomEvent(
			canvas,
			"wheel",
			(e: WheelEvent) => {
				const svg = this.svg;
				if (!svg) return;
				e.preventDefault();
				const rect = svg.getBoundingClientRect();
				this.userMoved = true;
				this.setViewBox(
					zoomViewBox(
						this.vb,
						Math.exp(e.deltaY * 0.0015),
						(e.clientX - rect.left) / Math.max(1, rect.width),
						(e.clientY - rect.top) / Math.max(1, rect.height),
						MIN_ZOOM_W,
						MAX_ZOOM_W,
					),
				);
			},
			{ passive: false },
		);
		this.registerDomEvent(canvas, "pointerdown", (e: PointerEvent) => {
			if (!this.svg || e.button !== 0) return;
			this.drag = { x: e.clientX, y: e.clientY, vb: { ...this.vb }, moved: false };
		});
		this.registerDomEvent(window, "pointermove", (e: PointerEvent) => {
			const d = this.drag;
			if (!d) return;
			const dx = e.clientX - d.x;
			const dy = e.clientY - d.y;
			if (!d.moved && Math.hypot(dx, dy) < 4) return;
			if (!d.moved) canvas.addClass("is-panning");
			d.moved = true;
			this.userMoved = true;
			const u = this.unitsPerPx();
			this.setViewBox({ ...d.vb, x: d.vb.x - dx * u, y: d.vb.y - dy * u });
		});
		this.registerDomEvent(window, "pointerup", () => {
			if (!this.drag) return;
			canvas.removeClass("is-panning");
			// Leave `drag` set until the click handler has seen `moved`.
			const d = this.drag;
			window.setTimeout(() => {
				if (this.drag === d) this.drag = null;
			}, 0);
		});
		this.registerDomEvent(canvas, "click", (e: MouseEvent) => {
			if (this.drag?.moved) return; // end of a pan, not a click
			const target = e.target as Element;
			const fold = target.closest("[data-fold]");
			if (fold) {
				const key = fold.getAttribute("data-fold");
				if (key) {
					this.expanded.add(key);
					void this.reload();
				}
				return;
			}
			const node = target.closest("[data-bead]");
			const id = node?.getAttribute("data-bead");
			if (!id) return;
			if (id === this.focusId || Keymap.isModEvent(e)) void this.plugin.openBead(id);
			else this.focus(id, true);
		});
	}
}
