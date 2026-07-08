import { App, Modal, Notice } from "obsidian";
import type BeadsPlugin from "./main";
import { BeadIssue } from "./types";
import { bdShow, bdClose, bdDepList, BdError } from "./bd";

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

		// Dependency context — "why is this blocked, and what does it unblock?"
		// Rendered async so the modal shows immediately.
		const depsEl = body.createDiv({ cls: "beads-detail-deps" });
		void this.loadDeps(depsEl);

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

	/** Fetch and render the two dependency directions into `container`. */
	private async loadDeps(container: HTMLElement): Promise<void> {
		const s = this.plugin.settings;
		const opts = { bdPath: s.bdPath, cwd: s.projectRoot };
		try {
			const [blockedBy, blocks] = await Promise.all([
				bdDepList(opts, this.id, "down"), // what this depends on
				bdDepList(opts, this.id, "up"), // what depends on this
			]);
			this.renderDepSection(container, "Blocked by", blockedBy);
			this.renderDepSection(container, "Blocks", blocks);
		} catch (e) {
			container.createDiv({
				cls: "beads-detail-deps-err",
				text: `Couldn't load dependencies: ${(e as Error).message}`,
			});
		}
	}

	private renderDepSection(
		container: HTMLElement,
		label: string,
		deps: BeadIssue[],
	): void {
		if (deps.length === 0) return;
		container.createEl("h4", { text: label });
		const list = container.createDiv({ cls: "beads-dep-list" });
		for (const d of deps) {
			const item = list.createDiv({ cls: "beads-dep-item" });
			if (d.status === "closed") item.addClass("beads-row-closed");
			const pr = d.priority ?? 2;
			item.createSpan({ cls: `beads-badge beads-p${pr}`, text: `P${pr}` });
			item.createSpan({ cls: "beads-dep-id", text: d.id });
			item.createSpan({ cls: "beads-dep-title", text: d.title });
			// Click → open that bead's detail (stacks a new modal).
			item.onclick = () =>
				new BeadDetailModal(this.app, this.plugin, d.id).open();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
