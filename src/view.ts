import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import { bdReady, bdBlocked, bdByStatus, bdStatusCounts, BdError, BdOptions } from "./bd";
import { renderIssueRow } from "./row";
import { BeadDetailModal } from "./detail";
import { BeadCaptureModal } from "./capture";

interface TabDef {
	key: string;
	label: string;
	countKey: string;
}

const TABS: TabDef[] = [
	{ key: "ready", label: "Ready", countKey: "ready_issues" },
	{ key: "in_progress", label: "In progress", countKey: "in_progress_issues" },
	{ key: "blocked", label: "Blocked", countKey: "blocked_issues" },
	{ key: "closed", label: "Closed", countKey: "closed_issues" },
];
const PAGE = 25;

interface TabState {
	issues: BeadIssue[];
	limit: number;
	hasMore: boolean;
	loaded: boolean;
	loading: boolean;
	error?: string;
}

function byPriority(issues: BeadIssue[]): BeadIssue[] {
	return issues
		.slice()
		.sort(
			(a, b) =>
				(a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id),
		);
}

/**
 * Tabbed, lazily-loaded pane. Only the active tab hits `bd` (plus one cheap
 * `bd status` for the tab counts), and each tab paginates with "Load more" —
 * so opening the pane is fast even with thousands of closed issues.
 */
export class BeadsView extends ItemView {
	private active = "ready";
	private counts: Record<string, number> = {};
	private tabs: Record<string, TabState> = {};
	private baseState: "ok" | "no-root" | "no-db" = "no-root";
	private loadSeq = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	private emptyTab(): TabState {
		return { issues: [], limit: PAGE, hasMore: false, loaded: false, loading: false };
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS;
	}
	getDisplayText(): string {
		return "Beads";
	}
	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	private resolveOpts(): BdOptions | null {
		const s = this.plugin.settings;
		if (!s.projectRoot) {
			this.baseState = "no-root";
			return null;
		}
		if (!existsSync(join(s.projectRoot, ".beads"))) {
			this.baseState = "no-db";
			return null;
		}
		this.baseState = "ok";
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	/** Full refresh: re-count and re-load the active tab; drop cached tabs. */
	async refresh(): Promise<void> {
		for (const t of TABS) {
			this.tabs[t.key].loaded = false;
			this.tabs[t.key].limit = PAGE;
		}
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const seq = ++this.loadSeq;
		try {
			this.counts = await bdStatusCounts(opts);
		} catch {
			/* counts are optional chrome */
		}
		if (seq !== this.loadSeq) return;
		await this.loadTab(this.active, seq);
	}

	private fetchTab(
		key: string,
		opts: BdOptions,
		limit: number,
	): Promise<BeadIssue[]> {
		switch (key) {
			case "ready":
				return bdReady(opts, limit);
			case "in_progress":
				return bdByStatus(opts, "in_progress", limit);
			case "closed":
				return bdByStatus(opts, "closed", limit);
			case "blocked":
				return bdBlocked(opts); // no server-side limit; paginated client-side
			default:
				return Promise.resolve([]);
		}
	}

	private async loadTab(key: string, seq?: number): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const mySeq = seq ?? ++this.loadSeq;
		const tab = this.tabs[key];
		tab.loading = true;
		tab.error = undefined;
		this.render();
		try {
			const fetched = await this.fetchTab(key, opts, tab.limit);
			if (mySeq !== this.loadSeq) return;
			const sorted = byPriority(fetched);
			if (key === "blocked") {
				tab.hasMore = sorted.length > tab.limit;
				tab.issues = sorted.slice(0, tab.limit);
			} else {
				tab.hasMore = fetched.length === tab.limit;
				tab.issues = sorted;
			}
			tab.loaded = true;
		} catch (e) {
			if (mySeq !== this.loadSeq) return;
			tab.error = e instanceof BdError ? e.message : String(e);
		} finally {
			if (mySeq === this.loadSeq) {
				tab.loading = false;
				this.render();
			}
		}
	}

	private async switchTab(key: string): Promise<void> {
		if (this.active === key) return;
		this.active = key;
		if (this.tabs[key].loaded) this.render(); // cached → instant
		else await this.loadTab(key);
	}

	private async loadMore(): Promise<void> {
		this.tabs[this.active].limit += PAGE;
		await this.loadTab(this.active);
	}

	private openBead(issue: BeadIssue): void {
		new BeadDetailModal(this.app, this.plugin, issue.id).open();
	}

	// --- render ---------------------------------------------------------

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-pane");

		// Header
		const header = root.createDiv({ cls: "beads-header" });
		header.createDiv({ cls: "beads-header-title", text: "Beads" });
		const actions = header.createDiv({ cls: "beads-header-actions" });
		const captureBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Capture a bead" },
		});
		setIcon(captureBtn, "plus");
		captureBtn.onclick = () => new BeadCaptureModal(this.app, this.plugin).open();
		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.toggleClass("beads-spin", this.tabs[this.active].loading);
		refreshBtn.onclick = () => void this.refresh();

		if (this.baseState === "no-root") {
			root.createDiv({
				cls: "beads-empty",
				text: "No project root set. Open Beads settings and point it at a directory containing .beads/.",
			});
			return;
		}
		if (this.baseState === "no-db") {
			root.createDiv({
				cls: "beads-empty",
				text: "No bd database here — this folder has no .beads/. Check the project root in Beads settings.",
			});
			return;
		}

		// Tab bar
		const tabBar = root.createDiv({ cls: "beads-tabs" });
		for (const t of TABS) {
			const btn = tabBar.createEl("button", { cls: "beads-tab" });
			btn.toggleClass("is-active", t.key === this.active);
			btn.createSpan({ text: t.label });
			const n = this.counts[t.countKey];
			if (typeof n === "number") {
				btn.createSpan({ cls: "beads-tab-count", text: String(n) });
			}
			btn.onclick = () => void this.switchTab(t.key);
		}

		// Active tab content
		const body = root.createDiv({ cls: "beads-tab-body" });
		const tab = this.tabs[this.active];

		if (tab.error) {
			body.createDiv({ cls: "beads-empty beads-error", text: tab.error });
			return;
		}
		if (tab.loading && tab.issues.length === 0) {
			body.createDiv({ cls: "beads-empty", text: "Loading…" });
			return;
		}
		if (tab.issues.length === 0) {
			body.createDiv({
				cls: "beads-empty",
				text: this.active === "ready" ? "Nothing ready 🎉" : "Nothing here.",
			});
			return;
		}

		const list = body.createDiv({ cls: "beads-list" });
		for (const issue of tab.issues) {
			renderIssueRow(list, issue, {
				onOpen: (i) => this.openBead(i),
				showDeps: this.active === "blocked",
			});
		}

		if (tab.hasMore) {
			const more = body.createEl("button", {
				cls: "beads-loadmore",
				text: tab.loading ? "Loading…" : "Load more",
			});
			more.disabled = tab.loading;
			more.onclick = () => void this.loadMore();
		}
	}
}
