import { Plugin, WorkspaceLeaf } from "obsidian";
import { FSWatcher, watch } from "fs";
import { join } from "path";
import {
	BeadsSettings,
	DEFAULT_SETTINGS,
	BeadsSettingTab,
} from "./settings";
import { BeadsView } from "./view";
import { VIEW_TYPE_BEADS } from "./types";

export default class BeadsPlugin extends Plugin {
	settings!: BeadsSettings;

	private refreshTimer: number | null = null;
	private watcher: FSWatcher | null = null;
	private watchedRoot: string | null = null;
	private watchDebounce: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_BEADS,
			(leaf) => new BeadsView(leaf, this),
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
			id: "refresh-beads",
			name: "Refresh Beads pane",
			callback: () => this.refreshViews(),
		});

		this.addSettingTab(new BeadsSettingTab(this.app, this));

		this.restartRefreshTimer();
		this.restartWatch();
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

	/** Refresh every open Beads pane. */
	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_BEADS,
		)) {
			const view = leaf.view;
			if (view instanceof BeadsView) void view.refresh();
		}
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
