import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import { bdList, bdClose, BdError } from "./bd";
import { BeadDetailModal } from "./detail";

const PRIORITY_LABEL: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
	4: "P4",
};

export class BeadsView extends ItemView {
	private issues: BeadIssue[] = [];
	private loading = false;
	private errorMsg: string | null = null;
	private closing = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS;
	}

	getDisplayText(): string {
		return "Beads";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.issues = [];
	}

	/** Re-fetch `bd list --json` and re-render. */
	async refresh(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.projectRoot) {
			this.errorMsg =
				"No project root set. Open Beads settings and point it at a directory containing .beads/.";
			this.issues = [];
			this.render();
			return;
		}
		this.loading = true;
		this.errorMsg = null;
		this.render();
		try {
			const issues = await bdList(
				{ bdPath: s.bdPath, cwd: s.projectRoot },
				s.showClosed,
				s.limit,
			);
			issues.sort(
				(a, b) =>
					(a.priority ?? 9) - (b.priority ?? 9) ||
					a.id.localeCompare(b.id),
			);
			this.issues = issues;
			this.errorMsg = null;
		} catch (e) {
			this.errorMsg =
				e instanceof BdError ? e.message : `Failed to load: ${String(e)}`;
			this.issues = [];
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private async closeIssue(issue: BeadIssue): Promise<void> {
		const s = this.plugin.settings;
		if (this.closing.has(issue.id)) return;
		this.closing.add(issue.id);
		this.render();
		try {
			await bdClose(
				{ bdPath: s.bdPath, cwd: s.projectRoot },
				issue.id,
				"Done from Obsidian",
			);
			new Notice(`Beads: closed ${issue.id}`);
			await this.refresh();
		} catch (e) {
			const msg =
				e instanceof BdError ? e.message : `Close failed: ${String(e)}`;
			new Notice(`Beads: ${msg}`);
		} finally {
			this.closing.delete(issue.id);
			this.render();
		}
	}

	private async openDetail(issue: BeadIssue): Promise<void> {
		new BeadDetailModal(this.app, this.plugin, issue.id).open();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-pane");

		// --- Header ---
		const header = root.createDiv({ cls: "beads-header" });
		const title = header.createDiv({ cls: "beads-header-title" });
		title.createSpan({ text: "Beads" });
		const count = this.issues.length;
		if (!this.loading && !this.errorMsg) {
			title.createSpan({
				cls: "beads-count",
				text: ` ${count}`,
			});
		}
		const refreshBtn = header.createEl("button", {
			cls: "beads-icon-btn",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.toggleClass("beads-spin", this.loading);
		refreshBtn.onclick = () => void this.refresh();

		// --- Body states ---
		if (this.errorMsg) {
			const err = root.createDiv({ cls: "beads-empty beads-error" });
			err.setText(this.errorMsg);
			return;
		}
		if (this.loading && this.issues.length === 0) {
			root.createDiv({ cls: "beads-empty", text: "Loading…" });
			return;
		}
		if (this.issues.length === 0) {
			root.createDiv({
				cls: "beads-empty",
				text: this.plugin.settings.showClosed
					? "No issues."
					: "No open issues. 🎉",
			});
			return;
		}

		// --- List ---
		const list = root.createDiv({ cls: "beads-list" });
		for (const issue of this.issues) {
			this.renderRow(list, issue);
		}
	}

	private renderRow(parent: HTMLElement, issue: BeadIssue): void {
		const isClosed = issue.status === "closed";
		const row = parent.createDiv({ cls: "beads-row" });
		if (isClosed) row.addClass("beads-row-closed");

		// Checkbox — ticking closes the issue.
		const box = row.createEl("input", {
			type: "checkbox",
			cls: "beads-check",
		}) as HTMLInputElement;
		box.checked = isClosed;
		box.disabled = isClosed || this.closing.has(issue.id);
		box.setAttr("aria-label", `Close ${issue.id}`);
		box.onclick = (ev) => {
			ev.stopPropagation();
			if (isClosed) return;
			// revert visual until the close confirms via refresh
			box.checked = false;
			void this.closeIssue(issue);
		};

		// Priority badge.
		const pr = issue.priority ?? 2;
		row.createSpan({
			cls: `beads-badge beads-p${pr}`,
			text: PRIORITY_LABEL[pr] ?? `P${pr}`,
		});

		// Title + meta (clickable → detail). setText keeps titles as inert text.
		const main = row.createDiv({ cls: "beads-main" });
		main.createDiv({ cls: "beads-title", text: issue.title });
		const meta = main.createDiv({ cls: "beads-meta" });
		meta.createSpan({ cls: "beads-id", text: issue.id });
		if (issue.issue_type) {
			meta.createSpan({ cls: "beads-type", text: issue.issue_type });
		}
		if (issue.status && issue.status !== "open") {
			meta.createSpan({ cls: "beads-status", text: issue.status });
		}
		main.onclick = () => void this.openDetail(issue);
	}
}
