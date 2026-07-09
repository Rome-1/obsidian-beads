import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import { bdReady, bdBlocked, bdByStatus, bdClose, BdError } from "./bd";
import { BeadDetailModal } from "./detail";
import { BeadCaptureModal } from "./capture";
import { renderIssueRow } from "./row";

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

	// Refresh correctness guard: at most one load runs at a time, and every
	// refresh REQUEST bumps `reqSeq`. A load captures the request it serves and
	// drops its render if a newer request arrived meanwhile — so a slow load can
	// never clobber (or briefly flash) staler state over a fresher one.
	private inFlight = false;
	private reqSeq = 0;

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
	 * Re-fetch and re-render. Every call registers a request; at most one load
	 * runs at a time and it re-loops until it has served the latest request, so
	 * overlapping triggers (interval, fs.watch, manual, post-close) always
	 * converge on the freshest state without racing.
	 */
	async refresh(): Promise<void> {
		++this.reqSeq;
		if (this.inFlight) return; // the running loop will observe the new reqSeq
		this.inFlight = true;
		try {
			let served = 0;
			while (served !== this.reqSeq) {
				served = this.reqSeq;
				await this.fetchState(served);
			}
		} finally {
			this.inFlight = false;
			this.render();
		}
	}

	private async fetchState(reqId: number): Promise<void> {
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
			if (reqId !== this.reqSeq) return; // superseded by a newer request

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
			if (reqId !== this.reqSeq) return;
			this.state = {
				kind: "error",
				message:
					e instanceof BdError ? e.message : `Failed to load: ${String(e)}`,
			};
		} finally {
			if (reqId === this.reqSeq) {
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

		const actions = header.createDiv({ cls: "beads-header-actions" });

		const captureBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Capture a bead" },
		});
		setIcon(captureBtn, "plus");
		captureBtn.onclick = () =>
			new BeadCaptureModal(this.app, this.plugin).open();

		const showClosed = this.plugin.settings.showClosed;
		const closedBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": showClosed ? "Hide closed" : "Show closed" },
		});
		setIcon(closedBtn, showClosed ? "eye" : "eye-off");
		closedBtn.toggleClass("is-active", showClosed);
		closedBtn.onclick = async () => {
			this.plugin.settings.showClosed = !this.plugin.settings.showClosed;
			await this.plugin.saveSettings();
			await this.refresh();
		};

		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
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
			renderIssueRow(parent, issue, {
				isClosing: (i) => this.closing.has(i.id),
				onClose: (i) => void this.closeIssue(i),
				onOpen: (i) => this.openDetail(i),
				showDeps: group.key === "blocked",
			});
		}
	}
}
