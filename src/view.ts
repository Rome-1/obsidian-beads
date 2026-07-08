import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import { bdReady, bdBlocked, bdByStatus, bdClose, BdError } from "./bd";
import { BeadDetailModal } from "./detail";

const PRIORITY_LABEL: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
	4: "P4",
};

interface Group {
	key: string;
	label: string;
	issues: BeadIssue[];
}

/** What the pane is currently showing. bd owns the partition; we only display. */
type PaneState =
	| { kind: "ok"; groups: Group[] }
	| { kind: "error"; message: string }
	| { kind: "no-root" }
	| { kind: "no-db" };

function byPriority(issues: BeadIssue[]): BeadIssue[] {
	return issues
		.slice()
		.sort(
			(a, b) =>
				(a.priority ?? 9) - (b.priority ?? 9) ||
				a.id.localeCompare(b.id),
		);
}

export class BeadsView extends ItemView {
	private state: PaneState = { kind: "no-root" };
	private loading = false;
	private closing = new Set<string>();

	// Refresh correctness guard: single in-flight refresh per pane, plus a
	// monotonic request id so a slow load can never clobber a newer one.
	private inFlight = false;
	private rerunRequested = false;
	private seq = 0;

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
		this.state = { kind: "no-root" };
	}

	/**
	 * Re-fetch and re-render. At most one load runs at a time; a refresh
	 * requested while one is running coalesces into a single re-run afterward,
	 * so overlapping triggers (interval, fs.watch, manual, post-close) can't
	 * race or clobber fresher state.
	 */
	async refresh(): Promise<void> {
		if (this.inFlight) {
			this.rerunRequested = true;
			return;
		}
		this.inFlight = true;
		try {
			do {
				this.rerunRequested = false;
				await this.fetchState();
			} while (this.rerunRequested);
		} finally {
			this.inFlight = false;
			this.render();
		}
	}

	private async fetchState(): Promise<void> {
		const mySeq = ++this.seq;
		const s = this.plugin.settings;

		if (!s.projectRoot) {
			this.state = { kind: "no-root" };
			this.render();
			return;
		}
		if (!existsSync(join(s.projectRoot, ".beads"))) {
			this.state = { kind: "no-db" };
			this.render();
			return;
		}

		this.loading = true;
		this.render();

		const opts = { bdPath: s.bdPath, cwd: s.projectRoot };
		try {
			// Three explicit sources — bd computes each group. Never derive one
			// group by subtracting another (blocked issues keep status=open).
			const [inProgress, ready, blocked, closed] = await Promise.all([
				bdByStatus(opts, "in_progress", s.limit),
				bdReady(opts, s.limit),
				bdBlocked(opts),
				s.showClosed
					? bdByStatus(opts, "closed", s.limit)
					: Promise.resolve([] as BeadIssue[]),
			]);
			if (mySeq !== this.seq) return; // a newer load supersedes this one

			const groups: Group[] = [
				{ key: "in_progress", label: "In progress", issues: byPriority(inProgress) },
				{ key: "ready", label: "Ready", issues: byPriority(ready) },
				{ key: "blocked", label: "Blocked", issues: byPriority(blocked) },
			];
			if (s.showClosed) {
				groups.push({ key: "closed", label: "Closed", issues: byPriority(closed) });
			}
			this.state = { kind: "ok", groups };
		} catch (e) {
			if (mySeq !== this.seq) return;
			this.state = {
				kind: "error",
				message:
					e instanceof BdError ? e.message : `Failed to load: ${String(e)}`,
			};
		} finally {
			if (mySeq === this.seq) {
				this.loading = false;
				this.render();
			}
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

	private openDetail(issue: BeadIssue): void {
		new BeadDetailModal(this.app, this.plugin, issue.id).open();
	}

	private totalIssues(): number {
		if (this.state.kind !== "ok") return 0;
		return this.state.groups.reduce((n, g) => n + g.issues.length, 0);
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-pane");

		// --- Header ---
		const header = root.createDiv({ cls: "beads-header" });
		const title = header.createDiv({ cls: "beads-header-title" });
		title.createSpan({ text: "Beads" });
		if (this.state.kind === "ok") {
			title.createSpan({ cls: "beads-count", text: ` ${this.totalIssues()}` });
		}
		const refreshBtn = header.createEl("button", {
			cls: "beads-icon-btn",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.toggleClass("beads-spin", this.loading || this.inFlight);
		refreshBtn.onclick = () => void this.refresh();

		// --- Body ---
		switch (this.state.kind) {
			case "no-root":
				root.createDiv({
					cls: "beads-empty",
					text: "No project root set. Open Beads settings and point it at a directory containing .beads/.",
				});
				return;
			case "no-db":
				root.createDiv({
					cls: "beads-empty",
					text: "No bd database here — this folder has no .beads/. Check the project root in Beads settings.",
				});
				return;
			case "error": {
				const err = root.createDiv({ cls: "beads-empty beads-error" });
				err.setText(this.state.message);
				return;
			}
			case "ok": {
				const visible = this.state.groups.filter((g) => g.issues.length > 0);
				if (visible.length === 0) {
					root.createDiv({
						cls: "beads-empty",
						text: this.loading ? "Loading…" : "No open issues 🎉",
					});
					return;
				}
				const list = root.createDiv({ cls: "beads-list" });
				for (const group of visible) {
					this.renderGroup(list, group);
				}
				return;
			}
		}
	}

	private renderGroup(parent: HTMLElement, group: Group): void {
		const gh = parent.createDiv({ cls: `beads-group-head beads-group-${group.key}` });
		gh.createSpan({ cls: "beads-group-label", text: group.label });
		gh.createSpan({ cls: "beads-group-count", text: String(group.issues.length) });
		for (const issue of group.issues) {
			this.renderRow(parent, issue, group.key);
		}
	}

	private renderRow(parent: HTMLElement, issue: BeadIssue, groupKey: string): void {
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
			box.checked = false; // revert until the close confirms via refresh
			void this.closeIssue(issue);
		};

		// Priority badge.
		const pr = issue.priority ?? 2;
		row.createSpan({
			cls: `beads-badge beads-p${pr}`,
			text: PRIORITY_LABEL[pr] ?? `P${pr}`,
		});

		// Title + meta (clickable → detail). setText keeps titles inert.
		const main = row.createDiv({ cls: "beads-main" });
		main.createDiv({ cls: "beads-title", text: issue.title });
		const meta = main.createDiv({ cls: "beads-meta" });
		meta.createSpan({ cls: "beads-id", text: issue.id });
		if (issue.issue_type) {
			meta.createSpan({ cls: "beads-type", text: issue.issue_type });
		}
		// Blocked rows: show how many deps they wait on (already in row data).
		if (groupKey === "blocked" && (issue.dependency_count ?? 0) > 0) {
			meta.createSpan({
				cls: "beads-deps",
				text: `⛓ ${issue.dependency_count}`,
			});
		}
		main.onclick = () => this.openDetail(issue);
	}
}
