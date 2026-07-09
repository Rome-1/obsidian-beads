import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { bdVersion } from "./bd";

export interface BeadsSettings {
	/** Absolute path to the project root (the directory containing `.beads/`). */
	projectRoot: string;
	/** Path to the bd binary, or just "bd" to resolve via PATH. */
	bdPath: string;
	/** Auto-refresh interval in seconds (0 = disabled). */
	refreshIntervalSec: number;
	/** Include closed issues in the pane. */
	showClosed: boolean;
	/** Max issues to fetch from `bd list`. */
	limit: number;
}

export const DEFAULT_SETTINGS: BeadsSettings = {
	projectRoot: "",
	bdPath: "bd",
	refreshIntervalSec: 30,
	showClosed: false,
	limit: 200,
};

export class BeadsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Project root")
			.setDesc(
				"Absolute path to the directory that contains the .beads/ database.",
			)
			.addText((text) =>
				text
					.setPlaceholder("/home/you/my-project")
					.setValue(this.plugin.settings.projectRoot)
					.onChange(async (value) => {
						this.plugin.settings.projectRoot = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("bd binary path")
			.setDesc(
				'Path to the bd executable. If "Test connection" fails with "not found", run `which bd` in a terminal and paste the full path here — apps launched from the GUI often don\'t inherit your shell PATH.',
			)
			.addText((text) =>
				text
					.setPlaceholder("bd")
					.setValue(this.plugin.settings.bdPath)
					.onChange(async (value) => {
						this.plugin.settings.bdPath = value.trim() || "bd";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-refresh interval")
			.setDesc("Seconds between automatic refreshes (0 to disable).")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.refreshIntervalSec))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.refreshIntervalSec =
							Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
						this.plugin.restartRefreshTimer();
					}),
			);

		new Setting(containerEl)
			.setName("Show closed issues")
			.setDesc("Add a Closed group to the pane.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showClosed)
					.onChange(async (value) => {
						this.plugin.settings.showClosed = value;
						await this.plugin.saveSettings();
						this.plugin.refreshViews();
					}),
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Run `bd --version` in the project root to verify settings.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					const s = this.plugin.settings;
					if (!s.projectRoot) {
						new Notice("Beads: set a project root first.");
						return;
					}
					try {
						const v = await bdVersion({
							bdPath: s.bdPath,
							cwd: s.projectRoot,
						});
						new Notice(`Beads: OK — ${v}`);
					} catch (e) {
						new Notice(`Beads: ${(e as Error).message}`);
					}
				}),
			);
	}
}
