import {
	ItemView,
	WorkspaceLeaf,
	Notice,
	MarkdownRenderer,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import { existsSync } from "fs";
import { join } from "path";
import type BeadsPlugin from "./main";
import { BeadIssue, VIEW_TYPE_BEADS_EDITOR } from "./types";
import {
	bdShow,
	bdUpdate,
	bdDepList,
	bdComments,
	BdUpdateFields,
	BdError,
	BdOptions,
} from "./bd";

interface EditorState {
	id?: string;
}

interface ParsedFields {
	title: string;
	type: string;
	priority: number;
	status: string;
}

/**
 * Embedded bead editor. Opens as a normal main-area tab (not a popup): the bead
 * is shown as a single markdown document — a YAML frontmatter block for the
 * fields, then the description as a markdown body. Save parses that back and
 * writes only the changed fields via `bd update`; broken frontmatter is
 * reported, never silently dropped. Dependencies and the comment thread render
 * read-only below.
 */
export class BeadEditorView extends ItemView {
	private id: string | null = null;
	private issue: BeadIssue | null = null;
	private origText = "";
	private textarea: HTMLTextAreaElement | null = null;
	private loadSeq = 0;

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
		return this.id ?? "Bead";
	}

	getState(): Record<string, unknown> {
		return { id: this.id ?? undefined };
	}

	async setState(state: EditorState, result: unknown): Promise<void> {
		if (state && typeof state.id === "string") this.id = state.id;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await super.setState(state, result as any);
		await this.reload();
	}

	async onOpen(): Promise<void> {
		// setState (which supplies the bead id) may land before or after onOpen.
		// If the id isn't known yet, show a neutral placeholder and let setState
		// drive the load, rather than flashing "No bead selected".
		if (this.id) await this.reload();
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
			// Refresh the tab title now that we know the issue's title.
			const leaf = this.leaf as unknown as { updateHeader?: () => void };
			leaf.updateHeader?.();
		} catch (e) {
			if (seq !== this.loadSeq) return;
			this.message(e instanceof BdError ? e.message : String(e), true);
		}
	}

	// --- serialization ---------------------------------------------------

	/** A bead as an editable `--- yaml --- \n body` markdown document. */
	private serialize(issue: BeadIssue): string {
		const fm = stringifyYaml({
			title: issue.title ?? "",
			type: issue.issue_type ?? "task",
			priority: issue.priority ?? 2,
			status: issue.status ?? "open",
		});
		const body = issue.description ?? "";
		return `---\n${fm}---\n${body ? `${body}\n` : ""}`;
	}

	/**
	 * Parse the document back into fields + description. Returns a friendly
	 * error string (rather than throwing) so `save` can complain via a Notice
	 * and leave the user's text untouched to fix.
	 */
	private parseDoc(
		text: string,
	): { fields: ParsedFields; description: string } | { error: string } {
		const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
		if (!m) {
			return {
				error: "Keep the frontmatter block: a `---` line, the fields, a `---` line, then the description.",
			};
		}
		let obj: unknown;
		try {
			obj = parseYaml(m[1]);
		} catch (e) {
			return {
				error: `Couldn't parse the frontmatter YAML — ${(e as Error).message}. Fix it and save again.`,
			};
		}
		if (!obj || typeof obj !== "object") {
			return { error: "Frontmatter is empty or not `key: value` pairs." };
		}
		const rec = obj as Record<string, unknown>;
		const title = String(rec.title ?? "").trim();
		if (!title) return { error: "`title:` is required in the frontmatter." };

		const cur = this.issue;
		const type = String(rec.type ?? cur?.issue_type ?? "task").trim();
		const status = String(rec.status ?? cur?.status ?? "open").trim();
		let priority = Number.parseInt(String(rec.priority ?? cur?.priority ?? 2), 10);
		if (!Number.isFinite(priority)) priority = cur?.priority ?? 2;
		priority = Math.max(0, Math.min(4, priority)); // coerce into range, don't reject

		// Drop trailing blank lines the editor tends to add; keep inner content.
		const description = m[2].replace(/\n+$/, "");
		return { fields: { title, type, priority, status }, description };
	}

	// --- render ----------------------------------------------------------

	private render(): void {
		const issue = this.issue;
		if (!issue) return;
		const root = this.contentEl;
		root.empty();
		root.addClass("beads-editor");
		this.origText = this.serialize(issue);

		// Toolbar: id + Save / Revert.
		const bar = root.createDiv({ cls: "beads-editor-bar" });
		bar.createDiv({ cls: "beads-editor-id", text: issue.id });
		const actions = bar.createDiv({ cls: "beads-editor-actions" });
		const revertBtn = actions.createEl("button", { text: "Revert" });
		const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save" });
		saveBtn.disabled = true;
		revertBtn.disabled = true;

		root.createDiv({
			cls: "beads-editor-hint",
			text: "YAML frontmatter for the fields · markdown body for the description. ⌘/Ctrl-S to save.",
		});

		const ta = root.createEl("textarea", { cls: "beads-editor-text" });
		ta.value = this.origText;
		ta.spellcheck = false;
		this.textarea = ta;

		const syncDirty = (): void => {
			const dirty = ta.value !== this.origText;
			saveBtn.disabled = !dirty;
			revertBtn.disabled = !dirty;
		};
		ta.addEventListener("input", syncDirty);
		ta.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void this.save(saveBtn);
			}
		});
		saveBtn.onclick = () => void this.save(saveBtn);
		revertBtn.onclick = () => {
			ta.value = this.origText;
			syncDirty();
			ta.focus();
		};

		// Provenance.
		const metaBits = [
			issue.owner ? `owner ${issue.owner}` : "",
			issue.created_at ? `created ${issue.created_at}` : "",
			issue.updated_at ? `updated ${issue.updated_at}` : "",
		].filter(Boolean);
		if (metaBits.length) {
			root.createDiv({ cls: "beads-editor-meta", text: metaBits.join("  ·  ") });
		}

		// Dependencies + comments (async, read-only).
		void this.loadDeps(root.createDiv({ cls: "beads-editor-deps" }));
		void this.loadComments(root.createDiv({ cls: "beads-editor-comments" }));
	}

	private async save(saveBtn: HTMLButtonElement): Promise<void> {
		const ta = this.textarea;
		const issue = this.issue;
		if (!ta || !issue) return;
		const opts = this.resolveOpts();
		if (!opts) {
			new Notice("Beads: no project root set.");
			return;
		}

		const parsed = this.parseDoc(ta.value);
		if ("error" in parsed) {
			new Notice(`Beads: ${parsed.error}`, 8000);
			return;
		}
		const { fields, description } = parsed;

		const f: BdUpdateFields = {};
		if (fields.title !== issue.title) f.title = fields.title;
		if (fields.type !== issue.issue_type) f.type = fields.type;
		if (fields.priority !== (issue.priority ?? 2)) f.priority = fields.priority;
		if (fields.status !== issue.status) f.status = fields.status;
		if (description.trimEnd() !== (issue.description ?? "").trimEnd()) {
			f.description = description;
		}
		if (Object.keys(f).length === 0) {
			new Notice("Beads: no changes.");
			return;
		}

		saveBtn.disabled = true;
		saveBtn.setText("Saving…");
		try {
			await bdUpdate(opts, issue.id, f);
			new Notice(`Beads: updated ${issue.id}`);
			this.plugin.refreshViews();
			await this.reload(); // reflect canonical stored values (status, updated_at)
		} catch (e) {
			new Notice(
				`Beads: ${e instanceof BdError ? e.message : `Update failed: ${String(e)}`}`,
				8000,
			);
			saveBtn.disabled = false;
			saveBtn.setText("Save");
		}
	}

	// --- dependencies ----------------------------------------------------

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
			const pr = d.priority ?? 2;
			item.createSpan({ cls: `beads-badge beads-p${pr}`, text: `P${pr}` });
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
			// Comment text renders as markdown; MarkdownRenderer inserts inert DOM.
			await MarkdownRenderer.render(this.app, c.text ?? "", bodyEl, "", this);
		}
	}
}
