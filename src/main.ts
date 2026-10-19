import { App, FileSystemAdapter, Plugin, SuggestModal, WorkspaceLeaf } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	DEFAULT_SETTINGS,
	BeadsSettingTab,
} from "./settings";
import { BeadsView } from "./view";
import { BeadEditorView } from "./editor";
import { BeadLineageView } from "./lineage-view";
import {
	VIEW_TYPE_BEADS,
	VIEW_TYPE_BEADS_EDITOR,
	VIEW_TYPE_BEADS_LINEAGE,
} from "./types";
import { BdOptions, bdReadyCount, invalidateReadCache } from "./bd";
import { registerBeadsCodeBlock } from "./codeblock";
import { BeadsFeed, FeedStatus } from "./feed";
import { JournalRecord, affectsCounts } from "./journal";
import { parsePatterns, parseSavedAssignees } from "./filter";
import { BeadsProject, migrateProjects, projectFor } from "./projects";

export default class BeadsPlugin extends Plugin {
	settings!: BeadsSettings;

	feed!: BeadsFeed;
	/**
	 * The status bar's ready count, from `bd ready --limit 0` — the same command
	 * the Ready tab lists, NOT `bd status` (its `ready_issues` undercounts; see
	 * `tabCounts` in filter.ts). null = not read yet, or the read failed.
	 *
	 * The pane's tab counts are per-view, because they follow that pane's
	 * filter. An unfiltered pane already lists the same set, so while one is
	 * open its count is used (`setReadyCount`) and this reads nothing.
	 */
	readyCount: number | null = null;
	/** Why the last count read failed (bd missing, broken store), if it did. */
	private countsError = "";

	private statusBarEl: HTMLElement | null = null;
	private countsTimer: number | null = null;
	private countsInFlight = false;
	private countsAgain = false;
	private restartTimer: number | null = null;
	private feedRoot = "";
	/** Last count-relevant state per bead id, to skip needless recounts. */
	private seen = new Map<string, string>();
	/** Re-render callbacks of the `beads` code blocks currently on screen. */
	readonly embeds = new Set<() => void>();
	private embedTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.detectRoot();

		this.registerView(
			VIEW_TYPE_BEADS,
			(leaf) => new BeadsView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_BEADS_EDITOR,
			(leaf) => new BeadEditorView(leaf, this),
		);

		this.registerView(
			VIEW_TYPE_BEADS_LINEAGE,
			(leaf) => new BeadLineageView(leaf, this),
		);

		this.addRibbonIcon("list-checks", "Open Beads pane", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-pane",
			name: "Open pane",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "new-bead",
			name: "New bead",
			callback: () => void this.newBead(),
		});

		this.addCommand({
			id: "show-lineage",
			name: "Show lineage of current bead",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(BeadEditorView);
				const id = view?.beadId;
				if (!id) return false;
				if (!checking) void this.openLineage(id);
				return true;
			},
		});

		this.addCommand({
			id: "switch-project",
			name: "Switch project",
			checkCallback: (checking) => {
				if (this.settings.projects.length < 2) return false;
				if (!checking) new ProjectSuggestModal(this.app, this).open();
				return true;
			},
		});

		this.addCommand({
			id: "refresh",
			name: "Refresh pane",
			callback: () => this.refreshViews(),
		});

		this.addSettingTab(new BeadsSettingTab(this.app, this));

		registerBeadsCodeBlock(this);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("beads-statusbar");

		this.feed = new BeadsFeed({
			bdOptions: () => this.bdOptions(),
			refreshIntervalSec: () => this.settings.refreshIntervalSec,
			onRecords: (recs) => this.onRecords(recs),
			onRebuild: (reason) => this.onRebuild(reason),
			onStatus: (st) => this.onFeedStatus(st),
		});
		this.feedRoot = this.activeRoot();
		// The pane may read before the follower's checkpoint is set; a write in
		// that gap would be missed, so rebuild once the feed is running.
		void this.feed.start().then(() => this.onRebuild("start"));
		// Quitting Obsidian doesn't always unload plugins; stop the follower anyway.
		this.registerDomEvent(window, "beforeunload", () => this.feed.stop());
		this.scheduleCounts(0);
	}

	onunload(): void {
		this.feed.stop();
		for (const t of [this.countsTimer, this.restartTimer, this.embedTimer]) {
			if (t !== null) window.clearTimeout(t);
		}
	}

	/** A project by name, or the active one when no name is given; null if there is none. */
	project(name?: string): BeadsProject | null {
		const want = name ?? this.settings.activeProject;
		return this.settings.projects.find((p) => p.name === want) ?? null;
	}

	/** The active project's root ("" when there is none). */
	activeRoot(): string {
		return this.project()?.path ?? "";
	}

	/**
	 * Options for a bd call in a project (default: the active one), or null
	 * when it has no usable root.
	 */
	bdOptions(name?: string): BdOptions | null {
		const root = this.project(name)?.path;
		if (!root || !existsSync(join(root, ".beads"))) return null;
		return { bdPath: this.settings.bdPath, cwd: root };
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<BeadsSettings> & {
			projectRoot?: unknown;
		};
		this.settings = { ...DEFAULT_SETTINGS, ...data, ...migrateProjects(data) };
		this.settings.savedAssignees = parseSavedAssignees(this.settings.savedAssignees);
		this.settings.hiddenAssignees = parsePatterns(this.settings.hiddenAssignees);
		// Drop the single-root setting once it lives in the project list.
		if ("projectRoot" in this.settings) {
			delete (this.settings as { projectRoot?: unknown }).projectRoot;
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// A new root is a different workspace (and journal): start over.
		if (this.activeRoot() !== this.feedRoot) this.restartFeed();
		for (const view of this.panes()) view.onProjectsChange();
		this.renderStatusBar();
	}

	/**
	 * Make `name` the active project: the feed, status bar, and panes follow
	 * it at once. Editors and lineage views keep the project they were opened in.
	 */
	async setActiveProject(name: string): Promise<void> {
		if (!this.project(name) || name === this.settings.activeProject) return;
		this.settings.activeProject = name;
		this.readyCount = null;
		this.countsError = "";
		await this.saveData(this.settings);
		for (const view of this.panes()) view.onProjectsChange();
		this.renderStatusBar();
		this.restartFeed(0);
	}

	/** A project was renamed in settings: open editors and lineage views follow it. */
	renameProject(from: string, to: string): void {
		for (const v of [...this.editors(), ...this.lineages()]) v.renameProject(from, to);
	}

	/**
	 * Re-detect bd and restart the feed, then rebuild. Debounced, since
	 * settings text fields save on every keystroke.
	 */
	restartFeed(delayMs = 600): void {
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			this.feedRoot = this.activeRoot();
			this.seen.clear();
			void this.feed.start().then(() => this.onRebuild("settings"));
		}, delayMs);
	}

	/** Open (or reveal) the Beads pane in the right sidebar. */
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_BEADS);
		let leaf: WorkspaceLeaf | null;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({
				type: VIEW_TYPE_BEADS,
				active: true,
			});
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	/**
	 * Open a bead in the embedded editor as a main-area tab (like opening a
	 * note). If an editor for the same bead is already open, reveal it instead
	 * of stacking another tab.
	 */
	async openBead(id: string, project = this.settings.activeProject): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_EDITOR)) {
			const state = leaf.getViewState().state as { id?: string; project?: string } | undefined;
			if (state?.id === id && (state.project ?? this.settings.activeProject) === project) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { id, project },
		});
		await workspace.revealLeaf(leaf);
	}

	/**
	 * Show a bead's lineage graph. Re-uses an open lineage view (re-centring it,
	 * so Back returns to the previous bead); otherwise opens one in a split
	 * beside the current tab.
	 */
	async openLineage(id: string, project = this.settings.activeProject): Promise<void> {
		const { workspace } = this.app;
		// setViewState (not view.focus) so a deferred, not-yet-loaded tab works
		// too; the view's setState re-centres and records Back history.
		const leaf =
			workspace.getLeavesOfType(VIEW_TYPE_BEADS_LINEAGE)[0] ??
			workspace.getLeaf("split", "vertical");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_LINEAGE,
			active: true,
			state: { id, project },
		});
		await workspace.revealLeaf(leaf);
	}

	/** Open a blank editor tab to create a new bead (same surface as editing). */
	async newBead(): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { create: true, project: this.settings.activeProject },
		});
		await workspace.revealLeaf(leaf);
	}

	private panes(): BeadsView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BEADS)
			.map((l) => l.view)
			.filter((v): v is BeadsView => v instanceof BeadsView);
	}

	private editors(): BeadEditorView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BEADS_EDITOR)
			.map((l) => l.view)
			.filter((v): v is BeadEditorView => v instanceof BeadEditorView);
	}

	private lineages(): BeadLineageView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BEADS_LINEAGE)
			.map((l) => l.view)
			.filter((v): v is BeadLineageView => v instanceof BeadLineageView);
	}

	/** Re-read every open Beads pane and the counts (manual refresh, own writes). */
	refreshViews(): void {
		invalidateReadCache();
		// Each pane re-reads its own counts.
		for (const view of this.panes()) void view.refresh();
		if (this.countsTimer !== null) window.clearTimeout(this.countsTimer);
		this.countsTimer = null;
		if (!this.hasUnfilteredPane()) void this.loadCounts();
	}

	/** An unfiltered pane's ready count, so the status bar needs no `bd ready` of its own. */
	setReadyCount(n: number): void {
		if (n === this.readyCount && !this.countsError) return;
		this.readyCount = n;
		this.countsError = "";
		this.renderStatusBar();
	}

	private hasUnfilteredPane(): boolean {
		return this.panes().some((v) => v.isUnfiltered());
	}

	/** Journal records: patch what is on screen instead of re-listing. */
	private onRecords(recs: JournalRecord[]): void {
		// Each pane recounts its own tabs when a record can move them.
		for (const view of this.panes()) view.applyRecords(recs);
		let recount = false;
		for (const r of recs) recount = affectsCounts(r, this.seen) || recount;
		if (recount && !this.hasUnfilteredPane()) this.scheduleCounts();
		const ids = new Set(recs.map((r) => r.issue_id));
		for (const ed of this.editors()) ed.onExternalChange(ids);
		this.scheduleEmbeds();
	}

	private onRebuild(reason: string): void {
		this.seen.clear();
		this.refreshViews();
		// Embeds never re-read on a timer (many blocks × a timer is a process
		// storm); editors follow real changes only.
		if (reason === "timer") return;
		this.scheduleEmbeds();
		if (reason !== "change") {
			for (const ed of this.editors()) ed.onExternalChange(null);
		}
	}

	private onFeedStatus(st: FeedStatus): void {
		for (const view of this.panes()) view.onFeedStatus(st);
		this.renderStatusBar();
	}

	/** Coalesce status-bar count reads: one per burst of changes. */
	scheduleCounts(delayMs = 300): void {
		if (this.countsTimer !== null) window.clearTimeout(this.countsTimer);
		this.countsTimer = window.setTimeout(() => {
			this.countsTimer = null;
			void this.loadCounts();
		}, delayMs);
	}

	private async loadCounts(): Promise<void> {
		if (this.countsInFlight) {
			this.countsAgain = true;
			return;
		}
		const opts = this.bdOptions();
		if (!opts) {
			this.readyCount = null;
			this.countsError = "";
			this.renderStatusBar();
			return;
		}
		this.countsInFlight = true;
		try {
			this.readyCount = await bdReadyCount(opts);
			this.countsError = "";
		} catch (e) {
			this.readyCount = null;
			this.countsError = (e as Error).message;
		} finally {
			this.countsInFlight = false;
		}
		this.renderStatusBar();
		if (this.countsAgain) {
			this.countsAgain = false;
			void this.loadCounts();
		}
	}

	/** Re-render on-screen `beads` code blocks, at most twice a second. */
	private scheduleEmbeds(): void {
		if (this.embeds.size === 0 || this.embedTimer !== null) return;
		this.embedTimer = window.setTimeout(() => {
			this.embedTimer = null;
			for (const render of this.embeds) render();
		}, 500);
	}

	/**
	 * Auto-fill a project on first load: if there are none and the vault folder
	 * itself contains a `.beads/`, add it. Never touches a list the user made.
	 */
	private detectRoot(): void {
		if (this.settings.projects.length > 0) return;
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const base = adapter.getBasePath();
			if (existsSync(join(base, ".beads"))) {
				const p = projectFor(base, []);
				this.settings.projects = [p];
				this.settings.activeProject = p.name;
				void this.saveData(this.settings);
			}
		}
	}

	/** Ambient "● N ready" in the status bar (works even with the pane closed). */
	private renderStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const n = this.readyCount;
		// "…" while a project's first count is in flight (e.g. just after a switch).
		const text = this.countsError
			? "● bd error"
			: typeof n === "number"
				? `● ${n} ready`
				: this.bdOptions()
					? "● …"
					: "";
		// Name the project only when there is more than one to tell apart.
		const name = this.settings.projects.length > 1 ? this.settings.activeProject : "";
		el.setText(text && name ? `${name.length > 16 ? `${name.slice(0, 15)}…` : name} ${text}` : text);
		el.toggleClass("is-error", !!this.countsError);
		const st = this.feed?.current;
		el.setAttribute(
			"aria-label",
			this.countsError
				? `Beads: ${this.countsError}`
				: st?.mode === "journal"
					? "Beads: live"
					: `Beads: ${st?.detail ?? ""}`,
		);
		el.toggleClass("is-live", st?.mode === "journal");
	}
}

/** "Switch project": pick the active project by name. */
class ProjectSuggestModal extends SuggestModal<BeadsProject> {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
	) {
		super(app);
		this.setPlaceholder("Switch to project…");
	}

	getSuggestions(query: string): BeadsProject[] {
		const q = query.toLowerCase();
		return this.plugin.settings.projects.filter((p) => p.name.toLowerCase().includes(q));
	}

	renderSuggestion(p: BeadsProject, el: HTMLElement): void {
		el.createDiv({ text: p.name });
		el.createEl("small", { cls: "beads-suggest-path", text: p.path });
	}

	onChooseSuggestion(p: BeadsProject): void {
		void this.plugin.setActiveProject(p.name);
	}
}
