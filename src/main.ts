import { FileSystemAdapter, Plugin, WorkspaceLeaf } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	DEFAULT_SETTINGS,
	BeadsSettingTab,
} from "./settings";
import { BeadsView } from "./view";
import { BeadEditorView } from "./editor";
import { VIEW_TYPE_BEADS, VIEW_TYPE_BEADS_EDITOR } from "./types";
import { BdOptions, bdStatusCounts, invalidateReadCache } from "./bd";
import { registerBeadsCodeBlock } from "./codeblock";
import { BeadsFeed, FeedStatus } from "./feed";
import { JournalRecord, affectsCounts } from "./journal";

export default class BeadsPlugin extends Plugin {
	settings!: BeadsSettings;

	feed!: BeadsFeed;
	/** `bd status` summary counts, shared by the pane tabs and the status bar. */
	counts: Record<string, number> = {};
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
		this.feedRoot = this.settings.projectRoot;
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

	/** Options for a bd call, or null when no usable project root is set. */
	bdOptions(): BdOptions | null {
		const s = this.settings;
		if (!s.projectRoot || !existsSync(join(s.projectRoot, ".beads"))) return null;
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<BeadsSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// A new root is a different workspace (and journal): start over.
		if (this.settings.projectRoot !== this.feedRoot) this.restartFeed();
	}

	/**
	 * Re-detect bd and restart the feed, then rebuild. Debounced, since
	 * settings text fields save on every keystroke.
	 */
	restartFeed(delayMs = 600): void {
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			this.feedRoot = this.settings.projectRoot;
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
	async openBead(id: string): Promise<void> {
		const { workspace } = this.app;
		for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_BEADS_EDITOR)) {
			const state = leaf.getViewState().state as { id?: string } | undefined;
			if (state?.id === id) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { id },
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
			state: { create: true },
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

	/** Re-read every open Beads pane and the counts (manual refresh, own writes). */
	refreshViews(): void {
		invalidateReadCache();
		for (const view of this.panes()) void view.refresh();
		this.scheduleCounts(0);
	}

	/** Journal records: patch what is on screen instead of re-listing. */
	private onRecords(recs: JournalRecord[]): void {
		for (const view of this.panes()) view.applyRecords(recs);
		let recount = false;
		for (const r of recs) recount = affectsCounts(r, this.seen) || recount;
		if (recount) this.scheduleCounts();
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

	/** Coalesce count refreshes: one `bd status` per burst of changes. */
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
			this.counts = {};
			this.countsError = "";
			this.renderStatusBar();
			return;
		}
		this.countsInFlight = true;
		try {
			this.counts = await bdStatusCounts(opts);
			this.countsError = "";
		} catch (e) {
			this.counts = {};
			this.countsError = (e as Error).message;
		} finally {
			this.countsInFlight = false;
		}
		this.renderStatusBar();
		for (const view of this.panes()) view.onCounts();
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
	 * Auto-fill the project root on first load: if it's unset and the vault
	 * folder itself contains a `.beads/`, use that. Never overwrite a root the
	 * user set by hand.
	 */
	private detectRoot(): void {
		if (this.settings.projectRoot) return;
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const base = adapter.getBasePath();
			if (existsSync(join(base, ".beads"))) {
				this.settings.projectRoot = base;
				void this.saveSettings();
			}
		}
	}

	/** Ambient "● N ready" in the status bar (works even with the pane closed). */
	private renderStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const n = this.counts.ready_issues;
		el.setText(
			this.countsError ? "● bd error" : typeof n === "number" ? `● ${n} ready` : "",
		);
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
