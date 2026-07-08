import { App, Modal, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { bdCreate, BdError } from "./bd";

/**
 * One-field quick capture. Enter → `bd create` → toast. No type/priority/
 * description pickers — the one-field rule keeps capture frictionless; triage
 * is the CLI's job.
 */
export class BeadCaptureModal extends Modal {
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

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "beads-capture-input",
			attr: { placeholder: "What needs doing?" },
		}) as HTMLInputElement;
		contentEl.createDiv({
			cls: "beads-capture-hint",
			text: "Enter to create · Esc to cancel",
		});
		input.focus();

		let busy = false;
		const submit = async () => {
			const title = input.value.trim();
			if (!title || busy) return;
			const s = this.plugin.settings;
			if (!s.projectRoot) {
				new Notice("Beads: set a project root first (Settings → Beads).");
				this.close();
				return;
			}
			busy = true;
			input.disabled = true;
			try {
				const id = await bdCreate(
					{ bdPath: s.bdPath, cwd: s.projectRoot },
					title,
				);
				new Notice(`Beads: created ${id}`);
				this.plugin.refreshViews();
				this.close();
			} catch (e) {
				new Notice(
					`Beads: ${e instanceof BdError ? e.message : String(e)}`,
				);
				busy = false;
				input.disabled = false;
				input.focus();
			}
		};

		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				void submit();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
