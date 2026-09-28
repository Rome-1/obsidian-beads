import { ItemView, Modal, Notice, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import { bdReady, bdBlocked, bdByStatus, bdEnableJournal, BdError, BdOptions } from "./bd";
import { renderIssueRow } from "./row";
import { JournalRecord, TabKey, TabList, applyRecord, byPriority } from "./journal";
import { FeedStatus } from "./feed";

interface TabDef {
	key: TabKey;
	label: string;
	countKey: string;
}

const TABS: TabDef[] = [
	{ key: "ready", label: "Ready", countKey: "ready_issues" },
	{ key: "in_progress", label: "In progress", countKey: "in_progress_issues" },
	{ key: "blocked", label: "Blocked", countKey: "blocked_issues" },
	{ key: "closed", label: "Closed", countKey: "closed_issues" },
];
const PAGE = 25;

interface TabState extends TabList {
	limit: number;
	loading: boolean;
	error?: string;
}

/**
 * Tabbed, lazily-loaded pane. Only the active tab hits `bd` (the tab counts
 * come from the plugin's shared `bd status`), and each tab paginates with
 * "Load more" — so opening the pane is fast even with thousands of closed
 * issues. With the events journal on, changes are applied to the loaded rows
 * in place; only a change whose effect bd must compute re-reads the tab.
 */
export class BeadsView extends ItemView {
	private active: TabKey = "ready";
	private tabs = {} as Record<TabKey, TabState>;
	private baseState: "ok" | "no-root" | "no-db" = "no-root";
	private loadSeq = 0;
	private reloadTimer: number | null = null;
	/** Records arrived during a read; read once more when it finishes. */
	private reloadAgain = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	private emptyTab(): TabState {
		return { issues: [], limit: PAGE, hasMore: false, loaded: false, loading: false };
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
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	/** Apply journal records to the loaded tabs; re-read only what bd must settle. */
	applyRecords(recs: JournalRecord[]): void {
		const stale = new Set<TabKey>();
		for (const rec of recs) {
			for (const k of applyRecord(this.tabs, rec)) stale.add(k);
		}
		for (const k of stale) {
			if (k !== this.active) this.tabs[k].loaded = false;
		}
		// A read in flight may predate these records. Don't cancel it (under a
		// steady stream of writes nothing would ever finish); queue one more.
		if (this.tabs[this.active].loading) {
			this.reloadAgain = true;
		} else if (stale.has(this.active)) {
			if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
			this.reloadTimer = window.setTimeout(() => {
				this.reloadTimer = null;
				void this.loadTab(this.active);
			}, 250);
		}
		this.render();
	}

	onCounts(): void {
		this.render();
	}

	onFeedStatus(_st: FeedStatus): void {
		this.render();
	}

	private resolveOpts(): BdOptions | null {
		const s = this.plugin.settings;
		if (!s.projectRoot) {
			this.baseState = "no-root";
			return null;
		}
		if (!existsSync(join(s.projectRoot, ".beads"))) {
			this.baseState = "no-db";
			return null;
		}
		this.baseState = "ok";
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	/** Full refresh: re-count and re-load the active tab; drop cached tabs. */
	async refresh(): Promise<void> {
		for (const t of TABS) {
			this.tabs[t.key].loaded = false;
			this.tabs[t.key].limit = PAGE;
		}
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		await this.loadTab(this.active);
	}

	private fetchTab(
		key: TabKey,
		opts: BdOptions,
		limit: number,
	): Promise<BeadIssue[]> {
		switch (key) {
			case "ready":
				return bdReady(opts, limit);
			case "in_progress":
				return bdByStatus(opts, "in_progress", limit);
			case "closed":
				return bdByStatus(opts, "closed", limit);
			case "blocked":
				return bdBlocked(opts); // no server-side limit; paginated client-side
			default:
				return Promise.resolve([]);
		}
	}

	private async loadTab(key: TabKey): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		const mySeq = ++this.loadSeq;
		const tab = this.tabs[key];
		tab.loading = true;
		tab.error = undefined;
		this.render();
		try {
			const fetched = await this.fetchTab(key, opts, tab.limit);
			if (mySeq !== this.loadSeq) return;
			const sorted = byPriority(fetched);
			if (key === "blocked") {
				tab.hasMore = sorted.length > tab.limit;
				tab.issues = sorted.slice(0, tab.limit);
			} else {
				tab.hasMore = fetched.length === tab.limit;
				tab.issues = sorted;
			}
			tab.loaded = true;
		} catch (e) {
			if (mySeq !== this.loadSeq) return;
			tab.error = e instanceof BdError ? e.message : String(e);
		} finally {
			if (mySeq === this.loadSeq) {
				tab.loading = false;
				this.render();
				if (this.reloadAgain) {
					this.reloadAgain = false;
					void this.loadTab(this.active);
				}
			}
		}
	}

	private async switchTab(key: TabKey): Promise<void> {
		if (this.active === key) return;
		this.active = key;
		if (this.tabs[key].loaded) this.render(); // cached → instant
		else await this.loadTab(key);
	}

	private async loadMore(): Promise<void> {
		this.tabs[this.active].limit += PAGE;
		await this.loadTab(this.active);
	}

	private openBead(issue: BeadIssue): void {
		void this.plugin.openBead(issue.id);
	}

	// --- render ---------------------------------------------------------

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-pane");

		// Header
		const header = root.createDiv({ cls: "beads-header" });
		header.createDiv({ cls: "beads-header-title", text: "Beads" });
		this.renderLive(header);
		const actions = header.createDiv({ cls: "beads-header-actions" });
		const captureBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Capture a bead" },
		});
		setIcon(captureBtn, "plus");
		captureBtn.onclick = () => void this.plugin.newBead();
		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.toggleClass("beads-spin", this.tabs[this.active].loading);
		refreshBtn.onclick = () => this.plugin.refreshViews();

		if (this.baseState === "no-root") {
			root.createDiv({
				cls: "beads-empty",
				text: "No project root set. Open Beads settings and point it at a directory containing .beads/.",
			});
			return;
		}
		if (this.baseState === "no-db") {
			root.createDiv({
				cls: "beads-empty",
				text: "No bd database here — this folder has no .beads/. Check the project root in Beads settings.",
			});
			return;
		}

		// Tab bar
		const tabBar = root.createDiv({ cls: "beads-tabs" });
		for (const t of TABS) {
			const btn = tabBar.createEl("button", { cls: "beads-tab" });
			btn.toggleClass("is-active", t.key === this.active);
			btn.createSpan({ text: t.label });
			const n = this.plugin.counts[t.countKey];
			if (typeof n === "number") {
				btn.createSpan({ cls: "beads-tab-count", text: String(n) });
			}
			btn.onclick = () => void this.switchTab(t.key);
		}

		this.renderJournalOffer(root);

		// Active tab content
		const body = root.createDiv({ cls: "beads-tab-body" });
		const tab = this.tabs[this.active];

		if (tab.error) {
			body.createDiv({ cls: "beads-empty beads-error", text: tab.error });
			return;
		}
		if (tab.loading && tab.issues.length === 0) {
			body.createDiv({ cls: "beads-empty", text: "Loading…" });
			return;
		}
		if (tab.issues.length === 0) {
			body.createDiv({
				cls: "beads-empty",
				text: this.active === "ready" ? "Nothing ready 🎉" : "Nothing here.",
			});
			return;
		}

		const list = body.createDiv({ cls: "beads-list" });
		for (const issue of tab.issues) {
			renderIssueRow(list, issue, {
				onOpen: (i) => this.openBead(i),
				showDeps: this.active === "blocked",
			});
		}

		if (tab.hasMore) {
			const more = body.createEl("button", {
				cls: "beads-loadmore",
				text: tab.loading ? "Loading…" : "Load more",
			});
			more.disabled = tab.loading;
			more.onclick = () => void this.loadMore();
		}
	}

	/** A small dot in the header: live (following bd events) or polling. */
	private renderLive(header: HTMLElement): void {
		const st = this.plugin.feed?.current;
		if (!st) return;
		const live = st.mode === "journal";
		const secs = this.plugin.settings.refreshIntervalSec;
		const polling = secs > 0 ? `Refreshing every ${secs} s` : "Refreshing on changes";
		const dot = header.createSpan({
			cls: `beads-live${live ? " is-live" : ""}`,
			attr: {
				"aria-label": live
					? "Live: following bd events"
					: `${polling}. ${st.detail.replace(/\.$/, "")}.`,
			},
		});
		dot.setAttribute("role", "img");
	}

	/**
	 * Offer the events journal once per vault, in the pane (never a modal at
	 * startup). Turning it on is a workspace-wide change, so it goes through a
	 * confirmation that says so.
	 */
	private renderJournalOffer(root: HTMLElement): void {
		const st = this.plugin.feed?.current;
		if (!st?.journalAvailable || st.mode === "journal") return;
		if (this.plugin.settings.journalOfferDismissed) return;
		const bar = root.createDiv({ cls: "beads-offer" });
		bar.createSpan({ text: "Live updates are available with bd's events journal." });
		const actions = bar.createDiv({ cls: "beads-offer-actions" });
		const on = actions.createEl("button", { cls: "mod-cta", text: "Turn on…" });
		on.onclick = () => new JournalModal(this.plugin).open();
		const no = actions.createEl("button", { text: "Not now" });
		no.onclick = async () => {
			this.plugin.settings.journalOfferDismissed = true;
			await this.plugin.saveSettings();
			this.render();
		};
	}
}

/** Explains the workspace-wide effect of the events journal before enabling it. */
export class JournalModal extends Modal {
	constructor(private plugin: BeadsPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Turn on bd's events journal?");
		contentEl.createEl("p", {
			text: "The pane will follow bd's change journal and update the moment a bead changes, instead of re-reading everything on a timer.",
		});
		const p = contentEl.createEl("p");
		p.appendText("This runs ");
		p.createEl("code", { text: "bd config set events-journal true" });
		p.appendText(", which writes ");
		p.createEl("code", { text: ".beads/config.yaml" });
		p.appendText(
			". From then on every bd command in this workspace records its changes, including other people's and agents' if that file is shared through git. bd keeps the last 7 days or 100,000 records.",
		);
		const off = contentEl.createEl("p");
		off.appendText("Turn it off any time with ");
		off.createEl("code", { text: "bd config set events-journal false" });
		off.appendText(".");
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Turn on")
					.onClick(async () => {
						const opts = this.plugin.bdOptions();
						if (!opts) return;
						b.setDisabled(true);
						try {
							await bdEnableJournal(opts);
							new Notice("Beads: events journal on — live updates enabled.");
							this.plugin.restartFeed(0);
						} catch (e) {
							new Notice(`Beads: ${(e as Error).message}`, 8000);
						}
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
