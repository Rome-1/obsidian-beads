import { FileSystemAdapter, Plugin, WorkspaceLeaf } from "obsidian";
import { FSWatcher, watch, existsSync } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	DEFAULT_SETTINGS,
	BeadsSettingTab,
} from "./settings";
import { BeadsView } from "./view";
import { BeadEditorView } from "./editor";
import { VIEW_TYPE_BEADS, VIEW_TYPE_BEADS_EDITOR } from "./types";
import { bdReadyCount, invalidateReadCache } from "./bd";
import { BeadCaptureModal } from "./capture";
import { registerBeadsCodeBlock } from "./codeblock";

export default class BeadsPlugin extends Plugin {
	settings!: BeadsSettings;

	private refreshTimer: number | null = null;
	private watcher: FSWatcher | null = null;
	private watchedRoot: string | null = null;
	private watchDebounce: number | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusSeq = 0;

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
			id: "open-beads-pane",
			name: "Open Beads pane",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "capture-bead",
			name: "Capture a bead",
			callback: () => new BeadCaptureModal(this.app, this).open(),
		});

		this.addCommand({
			id: "refresh-beads",
			name: "Refresh Beads pane",
			callback: () => this.refreshViews(),
		});

		this.addSettingTab(new BeadsSettingTab(this.app, this));

		registerBeadsCodeBlock(this);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("beads-statusbar");

		this.restartRefreshTimer();
		this.restartWatch();
		this.updateStatusBar();
	}

	onunload(): void {
		this.stopWatch();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Re-point the filesystem watcher if the project root changed.
		this.restartWatch();
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
		if (leaf) workspace.revealLeaf(leaf);
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
				workspace.revealLeaf(leaf);
				return;
			}
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_BEADS_EDITOR,
			active: true,
			state: { id },
		});
		workspace.revealLeaf(leaf);
	}

	/** Refresh every open Beads pane, and the status-bar ready count. */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_BEADS,
		)) {
			const view = leaf.view;
			if (view instanceof BeadsView) void view.refresh();
		}
		this.updateStatusBar();
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
	updateStatusBar(): void {
		if (!this.statusBarEl) return;
		const s = this.settings;
		if (!s.projectRoot) {
			this.statusBarEl.setText("");
			return;
		}
		// Drop stale results: only the latest request may write the count.
		const my = ++this.statusSeq;
		void bdReadyCount({ bdPath: s.bdPath, cwd: s.projectRoot })
			.then((n) => {
				if (my === this.statusSeq) this.statusBarEl?.setText(`● ${n} ready`);
			})
			.catch(() => {
				if (my === this.statusSeq) this.statusBarEl?.setText("");
			});
	}

	restartRefreshTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		const secs = this.settings.refreshIntervalSec;
		if (secs > 0) {
			this.refreshTimer = window.setInterval(
				() => this.refreshViews(),
				secs * 1000,
			);
			this.registerInterval(this.refreshTimer);
		}
	}

	/** Watch the `.beads` directory so external `bd` writes refresh the pane. */
	restartWatch(): void {
		const root = this.settings.projectRoot;
		if (root === this.watchedRoot && this.watcher) return;
		this.stopWatch();
		this.watchedRoot = root;
		if (!root) return;
		const beadsDir = join(root, ".beads");
		try {
			this.watcher = watch(
				beadsDir,
				{ persistent: false, recursive: false },
				() => this.onBeadsChanged(),
			);
			this.watcher.on("error", () => this.stopWatch());
		} catch {
			// .beads may not exist yet; a later refresh/settings change retries.
			this.watcher = null;
		}
	}

	private onBeadsChanged(): void {
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
		}
		this.watchDebounce = window.setTimeout(() => {
			this.watchDebounce = null;
			// An external bd write changed the DB — drop cached embed reads so
			// code blocks re-render fresh, not from the stale TTL cache.
			invalidateReadCache();
			this.refreshViews();
		}, 400);
	}

	private stopWatch(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.watchDebounce !== null) {
			window.clearTimeout(this.watchDebounce);
			this.watchDebounce = null;
		}
	}
}
