import { App, Modal, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { BeadIssue } from "./types";
import { bdShow, bdClose, BdError } from "./bd";

/** Modal showing `bd show <id> --json` detail, with a Close-issue action. */
export class BeadDetailModal extends Modal {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
		private id: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(this.id);
		const body = this.contentEl;
		body.addClass("beads-detail");
		body.setText("Loading…");

		const s = this.plugin.settings;
		let issue: BeadIssue | null = null;
		try {
			issue = await bdShow({ bdPath: s.bdPath, cwd: s.projectRoot }, this.id);
		} catch (e) {
			body.empty();
			body.createDiv({
				cls: "beads-error",
				text: e instanceof BdError ? e.message : String(e),
			});
			return;
		}

		body.empty();
		if (!issue) {
			body.createDiv({ text: `No issue found for ${this.id}.` });
			return;
		}

		this.titleEl.setText(issue.title);

		const grid = body.createDiv({ cls: "beads-detail-grid" });
		const field = (label: string, value: string | undefined) => {
			if (!value) return;
			grid.createDiv({ cls: "beads-detail-key", text: label });
			grid.createDiv({ cls: "beads-detail-val", text: value });
		};
		field("ID", issue.id);
		field("Status", issue.status);
		field("Priority", `P${issue.priority ?? 2}`);
		field("Type", issue.issue_type);
		field("Owner", issue.owner ?? issue.assignee);
		field("Created", issue.created_at);
		field("Updated", issue.updated_at);
		if (issue.labels && issue.labels.length) {
			field("Labels", issue.labels.join(", "));
		}

		if (issue.description) {
			body.createEl("h4", { text: "Description" });
			// Plain text — do not render as HTML.
			body.createEl("pre", {
				cls: "beads-detail-desc",
				text: issue.description,
			});
		}

		if (issue.status !== "closed") {
			const actions = body.createDiv({ cls: "beads-detail-actions" });
			const closeBtn = actions.createEl("button", {
				cls: "mod-cta",
				text: "Close issue",
			});
			closeBtn.onclick = async () => {
				closeBtn.disabled = true;
				closeBtn.setText("Closing…");
				try {
					await bdClose(
						{ bdPath: s.bdPath, cwd: s.projectRoot },
						this.id,
						"Done from Obsidian",
					);
					new Notice(`Beads: closed ${this.id}`);
					this.plugin.refreshViews();
					this.close();
				} catch (e) {
					const msg =
						e instanceof BdError
							? e.message
							: `Close failed: ${String(e)}`;
					new Notice(`Beads: ${msg}`);
					closeBtn.disabled = false;
					closeBtn.setText("Close issue");
				}
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
