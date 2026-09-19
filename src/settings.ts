import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { bdVersion } from "./bd";
import { parsePatterns } from "./filter";

export interface BeadsSettings {
	/** Absolute path to the project root (the directory containing `.beads/`). */
	projectRoot: string;
	/** Path to the bd binary, or just "bd" to resolve via PATH. */
	bdPath: string;
	/** Auto-refresh interval in seconds (0 = disabled). */
	refreshIntervalSec: number;
	/** Assignee names typed into the pane filter, most recent first (user-curated). */
	savedAssignees: string[];
	/** bd assignees to leave out of suggestions: exact names or `*` globs. */
	hiddenAssignees: string[];
}

export const DEFAULT_SETTINGS: BeadsSettings = {
	projectRoot: "",
	bdPath: "bd",
	refreshIntervalSec: 30,
	savedAssignees: [],
	hiddenAssignees: [],
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
			.setName("Hide assignees matching")
			.setDesc(
				"Assignees bd knows about that the pane's assignee box shouldn't suggest — one per line. Use * as a wildcard (e.g. harness-*). The × on a suggestion adds its name here. Typing a hidden name still filters for it.",
			)
			.addTextArea((text) => {
				text
					.setPlaceholder("harness-*")
					.setValue(this.plugin.settings.hiddenAssignees.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.hiddenAssignees = parsePatterns(value);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

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
