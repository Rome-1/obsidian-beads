import {
	ItemView,
	Modal,
	Notice,
	Setting,
	ViewStateResult,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS } from "./types";
import {
	bdReady,
	bdBlocked,
	bdByStatus,
	bdCount,
	bdEnableJournal,
	bdLabelNames,
	bdAssigneeNames,
	bdTypeNames,
	BdError,
	BdOptions,
} from "./bd";
import { renderIssueRow } from "./row";
import { AssigneeSuggest } from "./assignee-suggest";
import {
	JournalRecord,
	TabKey,
	TabList,
	affectsCounts,
	applyRecord,
	byPriority,
} from "./journal";
import { FeedStatus } from "./feed";
import {
	EMPTY_FILTER,
	NO_ASSIGNEE,
	PaneFilter,
	describeFilter,
	filterArgs,
	forgetAssignee,
	hideAssignee,
	isFilterActive,
	matchesFilter,
	parseFilter,
	rememberAssignee,
	tabCounts,
} from "./filter";

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

interface FilterOptions {
	assignees: string[];
	labels: string[];
	types: string[];
}

interface PaneState {
	filter?: unknown;
	showFilters?: boolean;
}

/**
 * Tabbed, lazily-loaded pane. Only the active tab's list is loaded, and each
 * tab paginates with "Load more" — so opening the pane is fast even with
 * thousands of closed issues. Tab counts come from the same bd commands as the
 * lists (`tabCounts` — not `bd status`, whose ready count is wrong).
 *
 * Filters (assignee / labels / type) are passed to bd as flags, for the lists
 * and the counts alike. The filter is kept in the view state, so it survives
 * reloads. Counts are per-view because they follow this pane's filter; an
 * unfiltered pane's ready count also feeds the status bar (`setReadyCount`).
 * A tab whose whole list is loaded is counted from its rows, not re-read.
 *
 * With the events journal on, changes are applied to the loaded rows in place;
 * only a change whose effect bd must compute re-reads the tab.
 */
export class BeadsView extends ItemView {
	private active: TabKey = "ready";
	private tabs = {} as Record<TabKey, TabState>;
	private baseState: "ok" | "no-root" | "no-db" = "no-root";
	private loadSeq = 0;
	private filter: PaneFilter = { ...EMPTY_FILTER, labels: [] };
	private showFilters = false;
	private options: FilterOptions | null = null;
	private optionsLoading = false;
	private optionsError: string | null = null;
	private reloadTimer: number | null = null;
	/** Records arrived during a read; read once more when it finishes. */
	private reloadAgain = false;
	/** Tab counts, from `tabCounts` — this pane's filter, this pane's lists. */
	private counts: Record<string, number> = {};
	private countsInFlight = false;
	private countsAgain = false;
	private countsTimer: number | null = null;
	/** Last count-relevant state per bead id under this pane's filter (`affectsCounts`). */
	private seen = new Map<string, string>();

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

	getState(): Record<string, unknown> {
		return { filter: this.filter, showFilters: this.showFilters };
	}

	async setState(state: PaneState, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const next = parseFilter(state?.filter);
		this.showFilters = Boolean(state?.showFilters);
		if (JSON.stringify(next) !== JSON.stringify(this.filter)) {
			this.filter = next;
			await this.refresh();
		} else {
			this.render();
		}
	}

	async onOpen(): Promise<void> {
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		if (this.countsTimer !== null) window.clearTimeout(this.countsTimer);
		for (const t of TABS) this.tabs[t.key] = this.emptyTab();
	}

	/** Apply journal records to the loaded tabs; re-read only what bd must settle. */
	applyRecords(recs: JournalRecord[]): void {
		const stale = new Set<TabKey>();
		// The lists were read with this pane's filter as bd flags, so the
		// same filter has to gate what a record may put back on screen.
		const inScope = (i: BeadIssue) => matchesFilter(i, this.filter);
		let recount = false;
		for (const rec of recs) {
			for (const k of applyRecord(this.tabs, rec, inScope)) stale.add(k);
			recount = affectsCounts(rec, this.seen, inScope) || recount;
		}
		if (recount) this.scheduleCounts();
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

	/** No filter: this pane's ready count is the status bar's too. */
	isUnfiltered(): boolean {
		return !isFilterActive(this.filter);
	}

	/** Coalesce recounts: one read per burst of journal records. */
	private scheduleCounts(): void {
		if (this.countsTimer !== null) window.clearTimeout(this.countsTimer);
		this.countsTimer = window.setTimeout(() => {
			this.countsTimer = null;
			void this.loadCounts();
		}, 300);
	}

	/** A tab's whole list is on screen: its count is its row count. */
	private complete(key: TabKey): boolean {
		const tab = this.tabs[key];
		return tab.loaded && !tab.hasMore;
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
		this.seen.clear();
		const opts = this.resolveOpts();
		if (!opts) {
			this.render();
			return;
		}
		// List first: if it fits in one page, its length is the tab's count.
		await this.loadTab(this.active);
		await this.loadCounts();
	}

	/**
	 * The tab counts: each from the same bd command as its tab's list, with
	 * this pane's filter applied (`tabCounts`). Coalesced like the plugin's
	 * count read — one in flight, one queued — so a burst of journal records
	 * can't pile up four bd calls per record.
	 */
	private async loadCounts(): Promise<void> {
		if (this.countsInFlight) {
			this.countsAgain = true;
			return;
		}
		const opts = this.resolveOpts();
		if (!opts) {
			this.counts = {};
			this.render();
			return;
		}
		// setFilter() swaps in a new object, so identity pins the result to the
		// filter it was read for; a filter change mid-read discards it.
		const f = this.filter;
		const known: Partial<Record<TabKey, number>> = {};
		for (const t of TABS) {
			if (this.complete(t.key)) known[t.key] = this.tabs[t.key].issues.length;
		}
		this.countsInFlight = true;
		try {
			const counts = await tabCounts(
				f,
				{
					ready: (args) => bdReady(opts, 0, args),
					count: (status, args) => bdCount(opts, status, args),
					blocked: () => bdBlocked(opts),
				},
				known,
			);
			if (f === this.filter) this.counts = counts;
		} catch {
			if (f === this.filter) this.counts = {}; /* counts are optional chrome */
		} finally {
			this.countsInFlight = false;
		}
		this.render();
		if (this.countsAgain) {
			this.countsAgain = false;
			void this.loadCounts();
		}
	}

	private fetchTab(
		key: TabKey,
		opts: BdOptions,
		limit: number,
	): Promise<BeadIssue[]> {
		const f = this.filter;
		switch (key) {
			case "ready":
				return bdReady(opts, limit, filterArgs(f, "ready"));
			case "in_progress":
				return bdByStatus(opts, "in_progress", limit, filterArgs(f, "list"));
			case "closed":
				return bdByStatus(opts, "closed", limit, filterArgs(f, "list"));
			case "blocked":
				// No server-side limit or filter flags: filter + paginate client-side.
				return bdBlocked(opts).then((all) => all.filter((i) => matchesFilter(i, f)));
			default:
				return Promise.resolve([]);
		}
	}

	// --- filters --------------------------------------------------------

	private setFilter(next: PaneFilter): void {
		this.filter = next;
		// Redraw the bar now (chips, summary) — not after the refresh's bd calls —
		// so a quick second change builds on this one.
		this.render();
		void this.refresh();
		// Persist in the workspace so the filter survives reloads.
		this.app.workspace.requestSaveLayout();
	}

	private toggleFilters(): void {
		this.showFilters = !this.showFilters;
		this.app.workspace.requestSaveLayout();
		this.render(); // an open bar with no options loads them (renderFilterBar)
	}

	/** Load the dropdown choices from bd. On demand only — not on the auto-refresh timer. */
	private async loadOptions(): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts || this.optionsLoading) return;
		this.optionsLoading = true;
		this.optionsError = null;
		this.fillFilterChoices();
		try {
			const [assignees, labels, types] = await Promise.all([
				bdAssigneeNames(opts),
				bdLabelNames(opts),
				bdTypeNames(opts),
			]);
			this.options = { assignees, labels, types };
		} catch (e) {
			this.optionsError = e instanceof BdError ? e.message : String(e);
		} finally {
			this.optionsLoading = false;
			// Refill the dropdowns in place — never rebuild the bar here, or
			// text being typed in the assignee box would be wiped.
			this.fillFilterChoices();
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

	/** Elements built once per open; updates touch them in place. */
	private shell: {
		notice: HTMLElement;
		filters: HTMLElement;
		tabBar: HTMLElement;
		tabs: Record<string, { btn: HTMLButtonElement; count: HTMLElement }>;
		body: HTMLElement;
		filterBtn: HTMLButtonElement;
		refreshBtn: HTMLButtonElement;
		/** The live/polling dot in the header. */
		live: HTMLElement;
		/** Holds the events-journal offer bar, when it's being offered. */
		offer: HTMLElement;
	} | null = null;
	/** What the filter bar was last built from — it's rebuilt only when this changes. */
	private filterBarKey = "";
	private assigneeSuggest: AssigneeSuggest | null = null;
	/** Filter-bar parts that depend on bd's choices (refilled in place). */
	private filterUi: {
		error: HTMLElement;
		type: HTMLSelectElement;
		addLabel: HTMLSelectElement;
	} | null = null;

	/**
	 * Update the pane. Only the bead list is rebuilt; the header, filter bar,
	 * and tab bar are built once and updated in place (counts, active tab,
	 * spinner), so a background refresh never steals focus from — or closes —
	 * a filter control mid-use.
	 */
	private render(): void {
		const shell = this.ensureShell();
		const ok = this.baseState === "ok";

		// Header state.
		const active = isFilterActive(this.filter);
		shell.filterBtn.setAttr("aria-label", active ? `Filter: ${describeFilter(this.filter)}` : "Filter");
		shell.filterBtn.toggleClass("is-active", active || this.showFilters);
		shell.refreshBtn.toggleClass("beads-spin", this.tabs[this.active].loading);
		this.renderLive(shell.live);

		// Setup problems replace everything below the header.
		shell.notice.setText(
			this.baseState === "no-root"
				? "No project root set. Open Beads settings and point it at a directory containing .beads/."
				: this.baseState === "no-db"
					? "No bd database here — this folder has no .beads/. Check the project root in Beads settings."
					: "",
		);
		shell.notice.toggle(!ok);
		shell.tabBar.toggle(ok);
		shell.body.toggle(ok);
		shell.offer.toggle(ok);
		if (ok) this.renderJournalOffer(shell.offer);

		// Filter bar: rebuilt only when the filter itself (or its visibility)
		// changes. Choices arriving from bd refill the dropdowns in place.
		const barKey = JSON.stringify([ok, this.filter, this.showFilters]);
		if (barKey !== this.filterBarKey) {
			this.filterBarKey = barKey;
			this.renderFilterBar(shell.filters, ok);
		}

		// Tab bar: active tab + counts, in place. A fully loaded tab shows its
		// row count, so a journal patch to its rows moves the count with them.
		for (const t of TABS) {
			const { btn, count } = shell.tabs[t.key];
			btn.toggleClass("is-active", t.key === this.active);
			const n = this.complete(t.key) ? this.tabs[t.key].issues.length : this.counts[t.countKey];
			count.setText(typeof n === "number" ? String(n) : "");
			count.toggle(typeof n === "number");
			if (t.key === "ready" && ok && typeof n === "number" && this.isUnfiltered()) {
				this.plugin.setReadyCount(n);
			}
		}

		if (ok) this.renderBody(shell.body);
	}

	private ensureShell(): NonNullable<BeadsView["shell"]> {
		const root = this.contentEl;
		if (this.shell && this.shell.body.isConnected) return this.shell;
		root.empty();
		root.addClass("beads-pane");
		this.filterBarKey = "";

		const header = root.createDiv({ cls: "beads-header" });
		header.createDiv({ cls: "beads-header-title", text: "Beads" });
		const live = header.createSpan({ cls: "beads-live", attr: { role: "img" } });
		const actions = header.createDiv({ cls: "beads-header-actions" });
		const captureBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Capture a bead" },
		});
		setIcon(captureBtn, "plus");
		captureBtn.onclick = () => void this.plugin.newBead();
		const filterBtn = actions.createEl("button", { cls: "clickable-icon" });
		setIcon(filterBtn, "filter");
		filterBtn.onclick = () => this.toggleFilters();
		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.onclick = () => {
			if (this.showFilters) void this.loadOptions();
			this.plugin.refreshViews();
		};

		const notice = root.createDiv({ cls: "beads-empty" });
		const filters = root.createDiv({ cls: "beads-filters" });
		const tabBar = root.createDiv({ cls: "beads-tabs" });
		const tabs: Record<string, { btn: HTMLButtonElement; count: HTMLElement }> = {};
		for (const t of TABS) {
			const btn = tabBar.createEl("button", { cls: "beads-tab" });
			btn.createSpan({ text: t.label });
			const count = btn.createSpan({ cls: "beads-tab-count" });
			btn.onclick = () => void this.switchTab(t.key);
			tabs[t.key] = { btn, count };
		}
		const offer = root.createDiv({ cls: "beads-offer-slot" });
		const body = root.createDiv({ cls: "beads-tab-body" });

		this.shell = { notice, filters, tabBar, tabs, body, filterBtn, refreshBtn, live, offer };
		return this.shell;
	}

	/** The active tab's list (or its empty / loading / error state). */
	private renderBody(body: HTMLElement): void {
		body.empty();
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
				text: isFilterActive(this.filter)
					? "No beads match the filter."
					: this.active === "ready"
						? "Nothing ready 🎉"
						: "Nothing here.",
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

	/**
	 * Assignee / type dropdowns and label chips. Every control applies on
	 * change (no free-typing), so the pane's full re-render can't eat input.
	 */
	private renderFilterBar(bar: HTMLElement, ok: boolean): void {
		const f = this.filter;
		this.assigneeSuggest?.close();
		this.assigneeSuggest = null;
		this.filterUi = null;
		bar.empty();
		const visible = ok && (this.showFilters || isFilterActive(f));
		bar.toggle(visible);
		if (!visible) return;

		if (!this.showFilters) {
			// Collapsed but active: a one-line summary with a clear button.
			const summary = bar.createDiv({ cls: "beads-filter-summary" });
			summary.createSpan({ text: describeFilter(f) });
			this.clearButton(summary);
			return;
		}
		// Load choices on first show — including a bar restored open from the
		// saved view state. Once only: an error is shown, not retried in a loop.
		if (!this.options && !this.optionsLoading && !this.optionsError) {
			window.setTimeout(() => void this.loadOptions(), 0);
		}
		const error = bar.createDiv({ cls: "beads-empty beads-error" });

		const row = bar.createDiv({ cls: "beads-filter-row" });
		this.assigneeBox(row);

		// Handlers read `this.filter` when they fire, never a copy captured at
		// build time — two quick changes must both stick.
		const type = this.filterSelect(row, "Type");
		type.onchange = () => this.setFilter({ ...this.filter, type: type.value });

		const labelRow = bar.createDiv({ cls: "beads-filter-row beads-labels" });
		for (const l of f.labels) {
			const chip = labelRow.createSpan({ cls: "beads-label-chip" });
			chip.createSpan({ text: l });
			const x = chip.createSpan({ cls: "beads-label-x", text: "×" });
			x.setAttr("aria-label", `Remove label filter ${l}`);
			x.onclick = () =>
				this.setFilter({ ...this.filter, labels: this.filter.labels.filter((k) => k !== l) });
		}
		const addLabel = this.filterSelect(labelRow, "Add label filter");
		addLabel.onchange = () => {
			const v = addLabel.value;
			if (v && !this.filter.labels.includes(v)) {
				this.setFilter({ ...this.filter, labels: [...this.filter.labels, v] });
			}
		};
		if (isFilterActive(f)) this.clearButton(labelRow);

		this.filterUi = { error, type, addLabel };
		this.fillFilterChoices();
	}

	/** (Re)fill the bd-sourced parts of the filter bar in place. */
	private fillFilterChoices(): void {
		const ui = this.filterUi;
		if (!ui) return;
		const f = this.filter;
		const o = this.options ?? { assignees: [], labels: [], types: [] };
		// Still fetching (or about to) — but not after a failed load, which shows
		// its error and retries on Refresh.
		const loading = this.optionsLoading || (!this.options && !this.optionsError);

		ui.error.setText(
			this.optionsError
				? `Couldn't load filter choices: ${this.optionsError} — press refresh to retry.`
				: "",
		);
		ui.error.toggle(Boolean(this.optionsError));
		setOptions(
			ui.type,
			[{ value: "", label: "Any type" }, ...o.types.map((t) => ({ value: t, label: t }))],
			f.type,
		);
		setOptions(
			ui.addLabel,
			[
				{
					value: "",
					label: loading ? "Loading labels…" : this.optionsError ? "Labels unavailable" : "+ label",
				},
				...o.labels.filter((l) => !f.labels.includes(l)).map((l) => ({ value: l, label: l })),
			],
			"",
		);
	}

	/**
	 * Typeable assignee filter. Enter or picking a suggestion applies it (and
	 * remembers the name); an empty box means anyone. Leaving the box without
	 * Enter restores the applied value, so a half-typed name never filters.
	 */
	private assigneeBox(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "beads-filter-inputwrap" });
		const input = wrap.createEl("input", {
			cls: "beads-filter-select beads-filter-input",
			type: "text",
			attr: { "aria-label": "Assignee", placeholder: "Anyone", spellcheck: "false" },
		});
		input.value = this.filter.assignee;
		// Clear (×) inside the box: back to "Anyone" — no assignee filter.
		const clear = wrap.createSpan({
			cls: "beads-filter-inputclear",
			text: "×",
			attr: { "aria-label": "Clear assignee filter" },
		});
		const syncClear = () => clear.toggle(input.value !== "");
		syncClear();
		input.addEventListener("input", syncClear);
		clear.addEventListener("mousedown", (e) => e.preventDefault());
		clear.addEventListener("click", () => {
			this.assigneeSuggest?.close();
			input.value = "";
			syncClear();
			commit("");
		});
		const commit = (raw: string) => {
			const value = raw.trim();
			if (value && value !== NO_ASSIGNEE) this.rememberAssigneeName(value);
			if (value !== this.filter.assignee) this.setFilter({ ...this.filter, assignee: value });
		};
		this.assigneeSuggest = new AssigneeSuggest(this.app, input, {
			saved: () => this.plugin.settings.savedAssignees,
			known: () => this.options?.assignees ?? [], // read live: choices may load later
			hidden: () => this.plugin.settings.hiddenAssignees,
			forget: (name) => this.forgetAssigneeName(name),
			hide: (name) => this.hideAssigneeName(name),
			pick: (value) => commit(value),
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				// Deferred so a highlighted suggestion (picked on the same Enter)
				// wins; this then sees the committed value and does nothing.
				window.setTimeout(() => {
					if (input.isConnected) commit(input.value);
				}, 0);
			} else if (e.key === "Escape") {
				input.value = this.filter.assignee;
				syncClear();
			}
		});
		input.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (input.isConnected && document.activeElement !== input) {
					input.value = this.filter.assignee;
					syncClear();
				}
			}, 200);
		});
	}

	private rememberAssigneeName(name: string): void {
		const s = this.plugin.settings;
		const next = rememberAssignee(s.savedAssignees, name);
		if (next.join("\n") === s.savedAssignees.join("\n")) return;
		s.savedAssignees = next;
		void this.plugin.saveSettings();
	}

	private hideAssigneeName(name: string): void {
		const s = this.plugin.settings;
		s.hiddenAssignees = hideAssignee(s.hiddenAssignees, name);
		void this.plugin.saveSettings();
	}

	private forgetAssigneeName(name: string): void {
		const s = this.plugin.settings;
		s.savedAssignees = forgetAssignee(s.savedAssignees, name);
		void this.plugin.saveSettings();
	}

	private filterSelect(parent: HTMLElement, label: string): HTMLSelectElement {
		return parent.createEl("select", {
			cls: "dropdown beads-filter-select",
			attr: { "aria-label": label },
		});
	}

	private clearButton(parent: HTMLElement): void {
		const btn = parent.createEl("button", { cls: "beads-filter-clear", text: "Clear" });
		btn.onclick = () => this.setFilter({ ...EMPTY_FILTER, labels: [] });
	}

	/**
	 * A small dot in the header: live (following bd events) or polling.
	 * Updates the span in place — the header is built once (`ensureShell`).
	 */
	private renderLive(dot: HTMLElement): void {
		const st = this.plugin.feed?.current;
		dot.toggle(!!st);
		if (!st) return;
		const live = st.mode === "journal";
		const secs = this.plugin.settings.refreshIntervalSec;
		const polling = secs > 0 ? `Refreshing every ${secs} s` : "Refreshing on changes";
		dot.toggleClass("is-live", live);
		dot.setAttribute(
			"aria-label",
			live
				? "Live: following bd events"
				: `${polling}. ${st.detail.replace(/\.$/, "")}.`,
		);
	}

	/**
	 * Offer the events journal once per vault, in the pane (never a modal at
	 * startup). Turning it on is a workspace-wide change, so it goes through a
	 * confirmation that says so.
	 */
	private renderJournalOffer(slot: HTMLElement): void {
		const st = this.plugin.feed?.current;
		const show =
			!!st?.journalAvailable &&
			st.mode !== "journal" &&
			!this.plugin.settings.journalOfferDismissed;
		// Rebuilt only when the offer appears or disappears, so the buttons
		// aren't replaced underneath a click.
		if (show === (slot.firstElementChild !== null)) return;
		slot.empty();
		if (!show) return;
		const bar = slot.createDiv({ cls: "beads-offer" });
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

/** Replace a select's options, keeping `current` selectable even if bd doesn't list it. */
function setOptions(
	sel: HTMLSelectElement,
	options: { value: string; label: string }[],
	current: string,
): void {
	if (current && !options.some((o) => o.value === current)) {
		options = [...options, { value: current, label: current }];
	}
	sel.empty();
	for (const o of options) sel.createEl("option", { value: o.value, text: o.label });
	sel.value = current;
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
