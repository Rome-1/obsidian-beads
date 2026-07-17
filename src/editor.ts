import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	MarkdownRenderer,
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
import {
	bdShow,
	bdUpdate,
	bdCreate,
	bdDepList,
	bdComments,
	BdUpdateFields,
	BdError,
	BdOptions,
} from "./bd";

interface EditorState {
	id?: string;
	/** Open a blank editor to create a new bead (no id yet). */
	create?: boolean;
}

/** The editable snapshot of a bead's fields. */
interface EditModel {
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee: string;
	labels: string[];
	description: string;
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

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: BeadsPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEADS_EDITOR;
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

	async setState(state: EditorState, result: unknown): Promise<void> {
		if (state && typeof state.id === "string") this.id = state.id;
		if (state && state.create) this.creating = true;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await super.setState(state, result as any);
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
		root.empty();
		root.addClass("beads-editor");

		// Editable snapshot + a pristine copy to diff / revert against.
		this.model = issue ? modelFromIssue(issue) : blankModel();
		this.orig = cloneModel(this.model);

		// Toolbar: id/label + actions (Create for a new bead, Revert/Save to edit).
		const bar = root.createDiv({ cls: "beads-editor-bar" });
		bar.createDiv({
			cls: "beads-editor-id",
			text: issue ? issue.id : "New bead",
		});
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

		// Description — a comfortable, note-style body (not a monospace blob).
		root.createDiv({ cls: "beads-editor-section", text: "Description" });
		const ta = root.createEl("textarea", {
			cls: "beads-editor-desc",
			attr: { placeholder: "Add a description…" },
		});
		ta.value = this.model.description;
		ta.addEventListener("input", () => {
			this.model.description = ta.value;
			this.syncDirty();
		});

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
				(cell.querySelector(".beads-label-add") as HTMLInputElement | null)?.focus();
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

		const f: BdUpdateFields = {};
		if (title !== issue.title) f.title = title;
		if (this.model.type !== issue.issue_type) f.type = this.model.type;
		if (this.model.priority !== (issue.priority ?? 2)) f.priority = this.model.priority;
		if (this.model.status !== issue.status) f.status = this.model.status;
		if (this.model.assignee !== (issue.assignee ?? "")) f.assignee = this.model.assignee;
		if (this.model.description.trimEnd() !== (issue.description ?? "").trimEnd()) {
			f.description = this.model.description;
		}
		const old = issue.labels ?? [];
		const add = this.model.labels.filter((l) => !old.includes(l));
		const rem = old.filter((l) => !this.model.labels.includes(l));
		if (add.length) f.addLabels = add;
		if (rem.length) f.removeLabels = rem;

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

// --- model helpers -------------------------------------------------------

function blankModel(): EditModel {
	return {
		title: "",
		status: "open",
		priority: 2,
		type: "task",
		assignee: "",
		labels: [],
		description: "",
	};
}

function modelFromIssue(issue: BeadIssue): EditModel {
	return {
		title: issue.title ?? "",
		status: issue.status ?? "open",
		priority: issue.priority ?? 2,
		type: issue.issue_type ?? "task",
		assignee: issue.assignee ?? "",
		labels: [...(issue.labels ?? [])],
		description: issue.description ?? "",
	};
}

function cloneModel(m: EditModel): EditModel {
	return { ...m, labels: [...m.labels] };
}

function modelsEqual(a: EditModel, b: EditModel): boolean {
	return (
		a.title === b.title &&
		a.status === b.status &&
		a.priority === b.priority &&
		a.type === b.type &&
		a.assignee === b.assignee &&
		a.description === b.description &&
		a.labels.length === b.labels.length &&
		a.labels.every((l, i) => l === b.labels[i])
	);
}
