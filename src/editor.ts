import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	MarkdownRenderer,
	ViewStateResult,
	setIcon,
} from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import {
	BeadIssue,
	VIEW_TYPE_BEADS_EDITOR,
	ISSUE_TYPES,
	PRIORITIES,
	EDITABLE_STATUSES,
} from "./types";
import { renderPriorityDot } from "./row";
import { renderMarkdownField, MarkdownFieldHandle } from "./mdfield";
import {
	EditModel,
	TEXT_FIELDS,
	TextField,
	blankModel,
	cloneModel,
	diffModel,
	modelFromIssue,
	modelsEqual,
} from "./editmodel";
import {
	bdShow,
	bdUpdate,
	bdCreate,
	bdDepList,
	bdComments,
	BdError,
	BdOptions,
} from "./bd";

interface EditorState {
	id?: string;
	/** Open a blank editor to create a new bead (no id yet). */
	create?: boolean;
}

/**
 * Embedded bead editor. Opens as a normal main-area tab (not a popup) and reads
 * like a native Obsidian note: a title, a Properties panel of typed controls
 * (status / priority / type / assignee / labels), then a markdown description
 * body. Save writes only the fields that changed via `bd update`. Dependencies
 * and the comment thread render read-only below.
 */
export class BeadEditorView extends ItemView {
	private id: string | null = null;
	private issue: BeadIssue | null = null;
	private creating = false;
	private loadSeq = 0;

	private model: EditModel = blankModel();
	private orig: EditModel = blankModel();
	private saveBtn: HTMLButtonElement | null = null;
	private revertBtn: HTMLButtonElement | null = null;
	private textFields: MarkdownFieldHandle[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS_EDITOR;
	}
	/** The bead this tab edits (null while creating a new one). */
	get beadId(): string | null {
		return this.issue?.id ?? null;
	}
	getIcon(): string {
		return "list-checks";
	}
	getDisplayText(): string {
		if (this.issue) return this.issue.title || this.issue.id;
		if (this.creating) return "New bead";
		return this.id ?? "Bead";
	}

	getState(): Record<string, unknown> {
		return {
			id: this.id ?? undefined,
			create: this.creating && !this.id ? true : undefined,
		};
	}

	async setState(state: EditorState, result: ViewStateResult): Promise<void> {
		if (state && typeof state.id === "string") this.id = state.id;
		if (state && state.create) this.creating = true;
		await super.setState(state, result);
		await this.reload();
	}

	async onOpen(): Promise<void> {
		// Save from anywhere in the view with Cmd/Ctrl-S. Registered once here
		// (not per-render) so revert/re-render can't stack duplicate handlers.
		this.registerDomEvent(this.contentEl, "keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void this.save();
			}
		});
		// setState (which supplies the bead id or create flag) may land before
		// or after onOpen.
		if (this.id || this.creating) await this.reload();
		else this.message("Loading…");
	}

	onClose(): Promise<void> {
		this.disposeTextFields();
		this.contentEl.empty();
		return Promise.resolve();
	}

	private resolveOpts(): BdOptions | null {
		const s = this.plugin.settings;
		if (!s.projectRoot) return null;
		if (!existsSync(join(s.projectRoot, ".beads"))) return null;
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	private message(text: string, isError = false): void {
		const root = this.contentEl;
		this.disposeTextFields();
		root.empty();
		root.addClass("beads-editor");
		root.createDiv({
			cls: isError ? "beads-empty beads-error" : "beads-empty",
			text,
		});
	}

	/** (Re)load the bead from bd and render it. Safe to call repeatedly. */
	private async reload(): Promise<void> {
		if (this.creating && !this.id) {
			this.issue = null;
			this.render(); // blank create form
			return;
		}
		if (!this.id) {
			this.message("No bead selected.");
			return;
		}
		const opts = this.resolveOpts();
		if (!opts) {
			this.message(
				"Set a project root that contains a .beads/ database in Beads settings.",
			);
			return;
		}
		const seq = ++this.loadSeq;
		try {
			const issue = await bdShow(opts, this.id);
			if (seq !== this.loadSeq) return;
			if (!issue) {
				this.message(`No issue found for ${this.id}.`, true);
				return;
			}
			this.issue = issue;
			this.render();
			const leaf = this.leaf as unknown as { updateHeader?: () => void };
			leaf.updateHeader?.();
		} catch (e) {
			if (seq !== this.loadSeq) return;
			this.message(e instanceof BdError ? e.message : String(e), true);
		}
	}

	// --- render ----------------------------------------------------------

	private render(): void {
		const creating = this.creating && !this.issue;
		const issue = this.issue;
		if (!creating && !issue) return;
		const root = this.contentEl;
		this.disposeTextFields();
		root.empty();
		root.addClass("beads-editor");

		// Editable snapshot + a pristine copy to diff / revert against.
		this.model = issue ? modelFromIssue(issue) : blankModel();
		this.orig = cloneModel(this.model);

		// Toolbar: id/label + actions (Create for a new bead, Revert/Save to edit).
		const bar = root.createDiv({ cls: "beads-editor-bar" });
		const idWrap = bar.createDiv({ cls: "beads-editor-idwrap" });
		idWrap.createSpan({
			cls: "beads-editor-id",
			text: issue ? issue.id : "New bead",
		});
		if (issue) {
			const copy = idWrap.createEl("button", {
				cls: "clickable-icon beads-editor-copy",
				attr: { "aria-label": "Copy bead ID" },
			});
			setIcon(copy, "copy");
			copy.onclick = () => {
				navigator.clipboard.writeText(issue.id).then(
					() => new Notice(`Copied ${issue.id}`),
					(e) => new Notice(`Beads: couldn't copy: ${String(e)}`),
				);
			};
		}
		const actions = bar.createDiv({ cls: "beads-editor-actions" });
		if (creating) {
			this.revertBtn = null;
			this.saveBtn = actions.createEl("button", {
				cls: "mod-cta",
				text: "Create",
			});
			this.saveBtn.disabled = true;
			this.saveBtn.onclick = () => void this.save();
		} else {
			const lineage = actions.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Show lineage" },
			});
			setIcon(lineage, "git-fork");
			lineage.onclick = () => {
				if (issue) void this.plugin.openLineage(issue.id);
			};
			this.revertBtn = actions.createEl("button", { text: "Revert" });
			this.saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save" });
			this.saveBtn.disabled = true;
			this.revertBtn.disabled = true;
			this.saveBtn.onclick = () => void this.save();
			this.revertBtn.onclick = () => this.render(); // re-derive from this.issue
		}

		// Title — prominent, like a note's inline title.
		const titleInput = root.createEl("input", {
			cls: "beads-editor-title",
			type: "text",
			attr: { placeholder: "Title", "aria-label": "Title" },
		});
		titleInput.value = this.model.title;
		titleInput.addEventListener("input", () => {
			this.model.title = titleInput.value;
			this.syncDirty();
		});

		// Properties panel — typed controls, styled like note Properties.
		const props = root.createDiv({ cls: "beads-props" });
		// Status isn't set at creation (a new bead starts "open").
		if (!creating) {
			this.propRow(props, "Status", (cell) => {
				const sel = this.select(
					cell,
					EDITABLE_STATUSES.map((s) => ({ value: s, label: s })),
					this.model.status,
				);
				sel.addEventListener("change", () => {
					this.model.status = sel.value;
					this.syncDirty();
				});
			});
		}
		this.propRow(props, "Priority", (cell) => {
			const sel = this.select(
				cell,
				PRIORITIES.map((p) => ({ value: String(p.value), label: p.label })),
				String(this.model.priority),
			);
			sel.addEventListener("change", () => {
				this.model.priority = Number(sel.value);
				this.syncDirty();
			});
		});
		this.propRow(props, "Type", (cell) => {
			const sel = this.select(
				cell,
				ISSUE_TYPES.map((t) => ({ value: t, label: t })),
				this.model.type,
			);
			sel.addEventListener("change", () => {
				this.model.type = sel.value;
				this.syncDirty();
			});
		});
		this.propRow(props, "Assignee", (cell) => {
			const inp = cell.createEl("input", {
				cls: "beads-prop-input",
				type: "text",
				attr: { placeholder: "unassigned" },
			});
			inp.value = this.model.assignee;
			inp.addEventListener("input", () => {
				this.model.assignee = inp.value;
				this.syncDirty();
			});
		});
		this.propRow(props, "Labels", (cell) => this.renderLabels(cell));

		// Text fields — rendered markdown like a note; click to edit the raw text.
		// A new bead only gets the description (straight into edit mode); an
		// existing one shows every non-empty field plus "+ add" for the rest.
		const text = root.createDiv({ cls: "beads-editor-text" });
		const addRow = root.createDiv({ cls: "beads-mdfield-add" });
		for (const field of TEXT_FIELDS) {
			const isDesc = field.key === "description";
			if (creating && !isDesc) continue;
			if (isDesc || this.model[field.key].trim()) {
				this.textField(text, field, creating);
				continue;
			}
			const btn = addRow.createEl("button", { text: `+ ${field.label}` });
			btn.onclick = () => {
				btn.remove();
				if (!addRow.childElementCount) addRow.remove();
				this.textField(text, field, true);
			};
		}
		if (!addRow.childElementCount) addRow.remove();

		// Provenance + dependencies + comments — only for an existing bead.
		if (issue) {
			const metaBits = [
				issue.owner ? `owner ${issue.owner}` : "",
				issue.created_at ? `created ${issue.created_at}` : "",
				issue.updated_at ? `updated ${issue.updated_at}` : "",
			].filter(Boolean);
			if (metaBits.length) {
				root.createDiv({
					cls: "beads-editor-meta",
					text: metaBits.join("  ·  "),
				});
			}
			void this.loadDeps(root.createDiv({ cls: "beads-editor-deps" }));
			void this.loadComments(root.createDiv({ cls: "beads-editor-comments" }));
		} else {
			titleInput.focus();
		}
	}

	/**
	 * Release every text field (preview components + edit-mode document
	 * listeners). Call before anything empties `contentEl`.
	 */
	private disposeTextFields(): void {
		for (const f of this.textFields) f.dispose();
		this.textFields = [];
	}

	private textField(
		parent: HTMLElement,
		field: TextField,
		startEditing: boolean,
	): void {
		this.textFields.push(
			renderMarkdownField(parent, {
				app: this.app,
				owner: this,
				label: field.label,
				placeholder: field.placeholder,
				value: this.model[field.key],
				startEditing,
				// Creating: the title gets focus; the description opens ready to click into.
				focus: !(this.creating && !this.issue),
				onChange: (value) => {
					this.model[field.key] = value;
					this.syncDirty();
				},
			}),
		);
	}

	private propRow(
		grid: HTMLElement,
		label: string,
		build: (cell: HTMLElement) => void,
	): void {
		grid.createDiv({ cls: "beads-prop-key", text: label });
		build(grid.createDiv({ cls: "beads-prop-val" }));
	}

	private select(
		cell: HTMLElement,
		options: { value: string; label: string }[],
		current: string,
	): HTMLSelectElement {
		const sel = cell.createEl("select", { cls: "dropdown beads-prop-input" });
		// Preserve an out-of-set current value (e.g. an unusual stored status).
		if (!options.some((o) => o.value === current)) {
			sel.createEl("option", { value: current, text: current });
		}
		for (const o of options) sel.createEl("option", { value: o.value, text: o.label });
		sel.value = current;
		return sel;
	}

	private renderLabels(cell: HTMLElement): void {
		cell.empty();
		const wrap = cell.createDiv({ cls: "beads-labels" });
		for (const label of this.model.labels) {
			const chip = wrap.createSpan({ cls: "beads-label-chip" });
			chip.createSpan({ text: label });
			const x = chip.createSpan({ cls: "beads-label-x", text: "×" });
			x.setAttr("aria-label", `Remove ${label}`);
			x.onclick = () => {
				this.model.labels = this.model.labels.filter((l) => l !== label);
				this.renderLabels(cell);
				this.syncDirty();
			};
		}
		const add = wrap.createEl("input", {
			cls: "beads-label-add",
			type: "text",
			attr: { placeholder: "+ label", "aria-label": "Add label" },
		});
		add.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const v = add.value.trim();
			if (v && !this.model.labels.includes(v)) {
				this.model.labels.push(v);
				this.renderLabels(cell);
				this.syncDirty();
				cell.querySelector<HTMLInputElement>(".beads-label-add")?.focus();
			}
		});
	}

	private syncDirty(): void {
		// Creating: enabled once there's a title. Editing: enabled when changed.
		const canAct =
			this.creating && !this.issue
				? this.model.title.trim().length > 0
				: !modelsEqual(this.model, this.orig);
		if (this.saveBtn) this.saveBtn.disabled = !canAct;
		if (this.revertBtn) this.revertBtn.disabled = !canAct;
	}

	// --- save ------------------------------------------------------------

	private async save(): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts) {
			new Notice("Beads: no project root set.");
			return;
		}
		if (this.creating && !this.issue) {
			await this.create(opts);
			return;
		}
		const issue = this.issue;
		if (!issue) return;
		if (modelsEqual(this.model, this.orig)) {
			new Notice("Beads: no changes.");
			return;
		}
		const title = this.model.title.trim();
		if (!title) {
			new Notice("Beads: a title is required.");
			return;
		}

		const f = diffModel(this.model, issue);

		if (Object.keys(f).length === 0) {
			new Notice("Beads: no changes.");
			return;
		}

		const saveBtn = this.saveBtn;
		if (saveBtn) {
			saveBtn.disabled = true;
			saveBtn.setText("Saving…");
		}
		try {
			await bdUpdate(opts, issue.id, f);
			new Notice(`Beads: updated ${issue.id}`);
			this.plugin.refreshViews();
			await this.reload(); // reflect canonical stored values (updated_at, etc.)
		} catch (e) {
			new Notice(
				`Beads: ${e instanceof BdError ? e.message : `Update failed: ${String(e)}`}`,
				8000,
			);
			if (saveBtn) {
				saveBtn.disabled = false;
				saveBtn.setText("Save");
			}
		}
	}

	/** Create a brand-new bead from the form, then switch to editing it. */
	private async create(opts: BdOptions): Promise<void> {
		const title = this.model.title.trim();
		if (!title) {
			new Notice("Beads: a title is required.");
			return;
		}
		const btn = this.saveBtn;
		if (btn) {
			btn.disabled = true;
			btn.setText("Creating…");
		}
		try {
			const id = await bdCreate(opts, {
				title,
				type: this.model.type,
				priority: this.model.priority,
				description: this.model.description.trim() || undefined,
				assignee: this.model.assignee.trim() || undefined,
				labels: this.model.labels.length ? this.model.labels : undefined,
			});
			new Notice(`Beads: created ${id}`);
			this.plugin.refreshViews();
			// Switch this same tab into edit mode on the new bead.
			this.id = id;
			this.creating = false;
			await this.reload();
			const leaf = this.leaf as unknown as { updateHeader?: () => void };
			leaf.updateHeader?.();
		} catch (e) {
			new Notice(
				`Beads: ${e instanceof BdError ? e.message : `Create failed: ${String(e)}`}`,
				8000,
			);
			if (btn) {
				btn.disabled = false;
				btn.setText("Create");
			}
		}
	}

	// --- dependencies (read-only) ----------------------------------------

	private async loadDeps(container: HTMLElement): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts || !this.id) return;
		try {
			const [blockedBy, blocks] = await Promise.all([
				bdDepList(opts, this.id, "down"), // what this depends on
				bdDepList(opts, this.id, "up"), // what depends on this
			]);
			this.renderDepSection(container, "Blocked by", blockedBy);
			this.renderDepSection(container, "Blocks", blocks);
		} catch (e) {
			container.createDiv({
				cls: "beads-editor-cerr",
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
		container.createEl("h4", { cls: "beads-editor-section", text: label });
		const list = container.createDiv({ cls: "beads-dep-list" });
		for (const d of deps) {
			const item = list.createDiv({ cls: "beads-dep-item" });
			if (d.status === "closed") item.addClass("beads-row-closed");
			renderPriorityDot(item, d.priority ?? 2);
			item.createSpan({ cls: "beads-dep-id", text: d.id });
			item.createSpan({ cls: "beads-dep-title", text: d.title });
			item.onclick = () => void this.plugin.openBead(d.id);
		}
	}

	// --- comments (read-only, markdown) ----------------------------------

	private async loadComments(container: HTMLElement): Promise<void> {
		const opts = this.resolveOpts();
		if (!opts || !this.id) return;
		let comments;
		try {
			comments = await bdComments(opts, this.id);
		} catch (e) {
			container.createDiv({
				cls: "beads-editor-cerr",
				text: `Couldn't load comments: ${(e as Error).message}`,
			});
			return;
		}
		if (comments.length === 0) return;
		container.createEl("h4", {
			cls: "beads-editor-section",
			text: `Comments (${comments.length})`,
		});
		for (const c of comments) {
			const card = container.createDiv({ cls: "beads-comment" });
			const head = card.createDiv({ cls: "beads-comment-head" });
			head.createSpan({
				cls: "beads-comment-author",
				text: c.author ?? "unknown",
			});
			if (c.created_at) {
				head.createSpan({ cls: "beads-comment-date", text: c.created_at });
			}
			const bodyEl = card.createDiv({ cls: "beads-comment-body" });
			await MarkdownRenderer.render(this.app, c.text ?? "", bodyEl, "", this);
		}
	}
}
