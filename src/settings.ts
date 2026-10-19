import { App, PluginSettingTab, Setting, Notice, SettingDefinitionItem, requireApiVersion } from "obsidian";
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

const BD_PATH_DESC =
	'Path to the bd executable. If a project\'s "Test" fails with "not found", run `which bd` in a terminal and paste the full path here — apps launched from the GUI often don\'t inherit your shell PATH.';
const INTERVAL_DESC =
	"Seconds between automatic refreshes (0 to disable). With live updates on, the pane refreshes the moment a bead changes, and this only sets how often it checks for changes the journal can't see, such as a sync.";
const HIDDEN_DESC =
	"Assignees bd knows about that the pane's assignee box shouldn't suggest — one per line. Use * as a wildcard (e.g. harness-*). The × on a suggestion adds its name here. Typing a hidden name still filters for it.";
const PROJECTS_DESC = "Each project is a name and the directory that contains its .beads/ database.";

export class BeadsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * Obsidian 1.13+ renders the tab from these, and indexes them for settings
	 * search, instead of calling display(), which older versions still use.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		if (!this.relisting) this.resetDraft();
		return [
			{
				name: "Active project",
				render: (setting) => {
					this.activeSetting = setting;
					this.renderActive();
				},
			},
			{ name: "bd binary path", desc: BD_PATH_DESC, control: { type: "text", key: "bdPath", placeholder: "bd" } },
			{
				name: "Auto-refresh interval",
				desc: INTERVAL_DESC,
				control: { type: "number", key: "refreshIntervalSec", placeholder: "30", min: 0 },
			},
			{ name: "Live updates", aliases: ["journal"], render: (setting) => this.renderLive(setting) },
			{
				name: "Hide assignees matching",
				desc: HIDDEN_DESC,
				control: { type: "textarea", key: "hiddenAssignees", placeholder: "harness-*", rows: 4 },
			},
			{
				type: "list",
				heading: "Projects",
				addItem: { name: "Add project", action: () => void this.addProject() },
				items: [
					{
						name: "",
						desc: PROJECTS_DESC,
						render: (setting) => {
							this.errorEl = setting.descEl.createDiv({ cls: "beads-settings-error" });
						},
					},
					...this.draft.map((p) => ({ name: "", render: (row: Setting) => this.renderProject(row, p) })),
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		return key === "hiddenAssignees" ? s.hiddenAssignees.join("\n") : s[key as keyof BeadsSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "bdPath") s.bdPath = String(value).trim() || "bd";
		if (key === "refreshIntervalSec") {
			const n = Number.parseInt(String(value), 10);
			s.refreshIntervalSec = Number.isFinite(n) && n >= 0 ? n : 0;
		}
		if (key === "hiddenAssignees") s.hiddenAssignees = parsePatterns(String(value));
		await this.plugin.saveSettings();
		if (key === "refreshIntervalSec") this.plugin.restartFeed();
	}

	hide(): void {
		super.hide();
		// 1.13+ reopens the tab from the definitions it last stored, so rebuild
		// them now: the next visit starts from the saved list, as display() does.
		if (requireApiVersion("1.13.0")) this.update();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.activeSetting = new Setting(containerEl).setName("Active project");
		this.renderActive();

		new Setting(containerEl)
			.setName("bd binary path")
			.setDesc(BD_PATH_DESC)
			.addText((text) =>
				text
					.setPlaceholder("bd")
					.setValue(this.plugin.settings.bdPath)
					.onChange((value) => this.setControlValue("bdPath", value)),
			);

		new Setting(containerEl)
			.setName("Auto-refresh interval")
			.setDesc(INTERVAL_DESC)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.refreshIntervalSec))
					.onChange((value) => this.setControlValue("refreshIntervalSec", value)),
			);

		this.renderLive(new Setting(containerEl).setName("Live updates"));

		new Setting(containerEl)
			.setName("Hide assignees matching")
			.setDesc(HIDDEN_DESC)
			.addTextArea((text) => {
				text
					.setPlaceholder("harness-*")
					.setValue(this.plugin.settings.hiddenAssignees.join("\n"))
					.onChange((value) => this.setControlValue("hiddenAssignees", value));
				text.inputEl.rows = 4;
			});

		new Setting(containerEl).setName("Projects").setHeading().setDesc(PROJECTS_DESC);
		this.listEl = containerEl.createDiv();
		this.errorEl = containerEl.createDiv({ cls: "beads-settings-error" });
		this.resetDraft();
		this.renderProjects();
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Add project").onClick(() => this.addProject()),
		);
	}

	/** The project list being edited, and each row's name as last saved (null: never saved). */
	private draft: (BeadsProject & { saved: string | null })[] = [];
	private listEl: HTMLElement | null = null;
	private errorEl: HTMLElement | null = null;
	private activeSetting: Setting | null = null;
	/** Rebuilding the definitions for an added or removed row: keep the draft. */
	private relisting = false;

	private resetDraft(): void {
		this.draft = this.plugin.settings.projects.map((p) => ({ ...p, saved: p.name }));
	}

	/** Status of the events journal, with "Turn on…" when it is available but off. */
	private renderLive(live: Setting): void {
		const st = this.plugin.feed.current;
		live.setDesc(
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
	}

	private async addProject(): Promise<void> {
		const names = this.draft.map((p) => p.name);
		this.draft.push({ name: uniqueName("Project", names), path: "", saved: null });
		this.renderProjects();
		await this.commit();
	}

	/** One row per draft project (display()), or rebuilt definitions (1.13+). */
	private renderProjects(): void {
		if (requireApiVersion("1.13.0")) {
			this.relisting = true;
			this.update();
			this.relisting = false;
			return;
		}
		const list = this.listEl;
		if (!list) return;
		list.empty();
		for (const p of this.draft) this.renderProject(new Setting(list), p);
	}

	/** A project row: name, path, Test, Remove. */
	private renderProject(row: Setting, p: BeadsProject & { saved: string | null }): void {
		row
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
