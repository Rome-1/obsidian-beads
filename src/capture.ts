import { App, Modal, Notice, Setting } from "obsidian";
import type BeadsPlugin from "./main";
import { bdCreate, BdError } from "./bd";
import { ISSUE_TYPES, PRIORITIES } from "./types";

/**
 * Quick capture. The title field is focused and Enter submits, so the fast path
 * stays one keystroke — but type, priority, and an optional description are
 * right there when you want them.
 */
export class BeadCaptureModal extends Modal {
	private title = "";
	private type = "task";
	private priority = 2;
	private description = "";

	constructor(
		app: App,
		private plugin: BeadsPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Capture a bead");
		const { contentEl } = this;
		contentEl.addClass("beads-capture");

		const titleInput = contentEl.createEl("input", {
			type: "text",
			cls: "beads-capture-input",
			attr: { placeholder: "What needs doing?" },
		}) as HTMLInputElement;
		titleInput.addEventListener("input", () => (this.title = titleInput.value));
		titleInput.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				void this.submit();
			}
		});

		new Setting(contentEl).setName("Type").addDropdown((d) => {
			for (const t of ISSUE_TYPES) d.addOption(t, t);
			d.setValue(this.type).onChange((v) => (this.type = v));
		});

		new Setting(contentEl).setName("Priority").addDropdown((d) => {
			for (const p of PRIORITIES) d.addOption(String(p.value), p.label);
			d.setValue(String(this.priority)).onChange(
				(v) => (this.priority = Number(v)),
			);
		});

		new Setting(contentEl)
			.setName("Description")
			.setDesc("Optional.")
			.addTextArea((t) =>
				t.setPlaceholder("Details…").onChange((v) => (this.description = v)),
			);

		const actions = contentEl.createDiv({ cls: "beads-capture-actions" });
		actions.createSpan({
			cls: "beads-capture-hint",
			text: "Enter to create",
		});
		const createBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Create",
		});
		createBtn.onclick = () => void this.submit();

		titleInput.focus();
	}

	private async submit(): Promise<void> {
		const title = this.title.trim();
		if (!title) {
			new Notice("Beads: a title is required.");
			return;
		}
		const s = this.plugin.settings;
		if (!s.projectRoot) {
			new Notice("Beads: set a project root first (Settings → Beads).");
			this.close();
			return;
		}
		this.contentEl
			.querySelectorAll("input, button, select, textarea")
			.forEach((el) => ((el as HTMLInputElement).disabled = true));
		try {
			const id = await bdCreate(
				{ bdPath: s.bdPath, cwd: s.projectRoot },
				{
					title,
					type: this.type,
					priority: this.priority,
					description: this.description.trim() || undefined,
				},
			);
			new Notice(`Beads: created ${id}`);
			this.plugin.refreshViews();
			this.close();
		} catch (e) {
			new Notice(`Beads: ${e instanceof BdError ? e.message : String(e)}`);
			this.contentEl
				.querySelectorAll("input, button, select, textarea")
				.forEach((el) => ((el as HTMLInputElement).disabled = false));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
