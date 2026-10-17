import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { bdVersion } from "./bd";
import { parsePatterns } from "./filter";
import { JournalModal } from "./view";
import { BeadsProject, activeName, projectsError, uniqueName } from "./projects";

export interface BeadsSettings {
	/** The bd workspaces the user keeps. Names are unique and non-empty. */
	projects: BeadsProject[];
	/** Name of the project the pane, feed, and status bar follow. */
	activeProject: string;
	/** Path to the bd binary, or just "bd" to resolve via PATH. */
	bdPath: string;
	/**
	 * Seconds between re-reads while polling; with live updates, how often to
	 * check for changes the journal can't see, like a sync (0 = never).
	 */
	refreshIntervalSec: number;
	/** Assignee names typed into the pane filter, most recent first (user-curated). */
	savedAssignees: string[];
	/** bd assignees to leave out of suggestions: exact names or `*` globs. */
	hiddenAssignees: string[];
	/** The user declined the in-pane offer to turn on the events journal. */
	journalOfferDismissed: boolean;
}

export const DEFAULT_SETTINGS: BeadsSettings = {
	projects: [],
	activeProject: "",
	bdPath: "bd",
	refreshIntervalSec: 30,
	savedAssignees: [],
	hiddenAssignees: [],
	journalOfferDismissed: false,
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

		this.activeSetting = new Setting(containerEl).setName("Active project");
		this.renderActive();

		new Setting(containerEl)
			.setName("bd binary path")
			.setDesc(
				'Path to the bd executable. If a project\'s "Test" fails with "not found", run `which bd` in a terminal and paste the full path here — apps launched from the GUI often don\'t inherit your shell PATH.',
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
			.setDesc(
				"Seconds between automatic refreshes (0 to disable). With live updates on, the pane refreshes the moment a bead changes, and this only sets how often it checks for changes the journal can't see, such as a sync.",
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.refreshIntervalSec))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.refreshIntervalSec =
							Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
						this.plugin.restartFeed();
					}),
			);

		const st = this.plugin.feed.current;
		const live = new Setting(containerEl)
			.setName("Live updates")
			.setDesc(
				st.mode === "journal"
					? "On: the pane follows bd's events journal."
					: `Off. ${st.detail.replace(/\.$/, "")}.`,
			);
		if (st.journalAvailable && st.mode !== "journal") {
			live.addButton((btn) =>
				btn.setButtonText("Turn on…").onClick(() => {
					new JournalModal(this.plugin).open();
				}),
			);
		}

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
			.setName("Projects")
			.setHeading()
			.setDesc(
				"Each project is a name and the directory that contains its .beads/ database.",
			);
		this.listEl = containerEl.createDiv();
		this.errorEl = containerEl.createDiv({ cls: "beads-settings-error" });
		this.draft = this.plugin.settings.projects.map((p) => ({ ...p, saved: p.name }));
		this.renderProjects();
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add project").onClick(async () => {
				const names = this.draft.map((p) => p.name);
				this.draft.push({ name: uniqueName("Project", names), path: "", saved: null });
				this.renderProjects();
				await this.commit();
			}),
		);
	}

	/** The project list being edited, and each row's name as last saved (null: never saved). */
	private draft: (BeadsProject & { saved: string | null })[] = [];
	private listEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private activeSetting: Setting | null = null;

	/** One row per draft project: name, path, Test, Remove. */
	private renderProjects(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		for (const p of this.draft) {
			new Setting(list)
				.addText((text) =>
					text
						.setPlaceholder("Name")
						.setValue(p.name)
						.onChange(async (value) => {
							p.name = value;
							await this.commit();
						}),
				)
				.addText((text) =>
					text
						.setPlaceholder("/home/you/my-project")
						.setValue(p.path)
						.onChange(async (value) => {
							p.path = value.trim();
							await this.commit();
						}),
				)
				.addButton((btn) =>
					btn.setButtonText("Test").onClick(async () => {
						if (!p.path) {
							new Notice("Beads: set the project's path first.");
							return;
						}
						try {
							const v = await bdVersion({ bdPath: this.plugin.settings.bdPath, cwd: p.path });
							new Notice(`Beads: OK — ${v}`);
						} catch (e) {
							new Notice(`Beads: ${(e as Error).message}`);
						}
					}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove project")
						.onClick(async () => {
							this.draft.splice(this.draft.indexOf(p), 1);
							this.renderProjects();
							await this.commit();
						}),
				);
		}
	}

	/**
	 * Save the draft list if it is valid; otherwise say why inline and keep
	 * the saved list as it was. A rename carries the active project with it.
	 */
	private async commit(): Promise<void> {
		const projects = this.draft.map((p) => ({ name: p.name.trim(), path: p.path }));
		const error = projectsError(projects);
		this.errorEl?.setText(error ?? "");
		if (error) return;
		const s = this.plugin.settings;
		let active = s.activeProject;
		for (const p of this.draft) {
			const name = p.name.trim();
			if (p.saved !== null && p.saved !== name) {
				if (p.saved === active) active = name;
				this.plugin.renameProject(p.saved, name);
			}
			p.saved = name;
		}
		s.projects = projects;
		s.activeProject = activeName(projects, active);
		await this.plugin.saveSettings();
		this.renderActive();
	}

	/** The active-project dropdown, refilled in place so typing keeps focus. */
	private renderActive(): void {
		const setting = this.activeSetting;
		if (!setting) return;
		setting.controlEl.empty();
		const s = this.plugin.settings;
		setting.setDesc(
			s.projects.length === 0
				? "Add a project under Projects below."
				: "The project the pane, status bar, and live updates follow. Open bead tabs stay with their own.",
		);
		if (s.projects.length === 0) return;
		setting.addDropdown((dd) => {
			for (const p of s.projects) dd.addOption(p.name, p.name);
			dd.setValue(s.activeProject).onChange((name) => void this.plugin.setActiveProject(name));
		});
	}
}
