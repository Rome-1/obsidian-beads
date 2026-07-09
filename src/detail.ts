import { App, Modal, Notice, Setting } from "obsidian";
import type BeadsPlugin from "./main";
import { BeadIssue, ISSUE_TYPES, PRIORITIES, EDITABLE_STATUSES } from "./types";
import { bdShow, bdUpdate, bdDepList, BdError, BdOptions } from "./bd";

/**
 * Detail modal: shows `bd show <id>`, lets you edit the common fields (title,
 * type, priority, status, description) via `bd update`, and lists the issue's
 * dependencies in both directions.
 */
export class BeadDetailModal extends Modal {
	constructor(
		app: App,
		private plugin: BeadsPlugin,
		private id: string,
	) {
		super(app);
	}

	private get opts(): BdOptions {
		const s = this.plugin.settings;
		return { bdPath: s.bdPath, cwd: s.projectRoot };
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(this.id);
		const body = this.contentEl;
		body.addClass("beads-detail");
		body.setText("Loading…");

		let issue: BeadIssue | null = null;
		try {
			issue = await bdShow(this.opts, this.id);
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
		this.buildForm(issue);
	}

	private buildForm(issue: BeadIssue): void {
		const body = this.contentEl;
		this.titleEl.setText(issue.title);

		// Editable working copy; only changed fields are sent on save.
		const orig = {
			title: issue.title,
			type: issue.issue_type,
			priority: issue.priority ?? 2,
			status: issue.status,
			description: issue.description ?? "",
		};
		const cur = { ...orig };

		new Setting(body).setName("Title").addText((t) =>
			t.setValue(cur.title).onChange((v) => (cur.title = v)),
		);

		new Setting(body).setName("Type").addDropdown((d) => {
			const types = new Set<string>([...ISSUE_TYPES, issue.issue_type]);
			for (const t of types) d.addOption(t, t);
			d.setValue(cur.type).onChange((v) => (cur.type = v));
		});

		new Setting(body).setName("Priority").addDropdown((d) => {
			for (const p of PRIORITIES) d.addOption(String(p.value), p.label);
			d.setValue(String(cur.priority)).onChange(
				(v) => (cur.priority = Number(v)),
			);
		});

		new Setting(body).setName("Status").addDropdown((d) => {
			const statuses = new Set<string>([...EDITABLE_STATUSES, issue.status]);
			for (const st of statuses) d.addOption(st, st);
			d.setValue(cur.status).onChange((v) => (cur.status = v));
		});

		new Setting(body).setName("Description").addTextArea((t) => {
			t.setValue(cur.description).onChange((v) => (cur.description = v));
			t.inputEl.rows = 4;
		});

		// Read-only provenance.
		const meta = body.createDiv({ cls: "beads-detail-meta" });
		const metaBits = [
			`id ${issue.id}`,
			issue.owner ? `owner ${issue.owner}` : "",
			issue.updated_at ? `updated ${issue.updated_at}` : "",
		].filter(Boolean);
		meta.setText(metaBits.join("  ·  "));

		// Dependencies (async).
		const depsEl = body.createDiv({ cls: "beads-detail-deps" });
		void this.loadDeps(depsEl);

		// Save.
		const actions = body.createDiv({ cls: "beads-detail-actions" });
		const saveBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Save",
		});
		saveBtn.onclick = async () => {
			const f: Parameters<typeof bdUpdate>[2] = {};
			if (cur.title.trim() && cur.title !== orig.title) f.title = cur.title.trim();
			if (cur.type !== orig.type) f.type = cur.type;
			if (cur.priority !== orig.priority) f.priority = cur.priority;
			if (cur.status !== orig.status) f.status = cur.status;
			if (cur.description !== orig.description) f.description = cur.description;
			if (Object.keys(f).length === 0) {
				new Notice("Beads: no changes.");
				return;
			}
			saveBtn.disabled = true;
			saveBtn.setText("Saving…");
			try {
				await bdUpdate(this.opts, this.id, f);
				new Notice(`Beads: updated ${this.id}`);
				this.plugin.refreshViews();
				this.close();
			} catch (e) {
				new Notice(
					`Beads: ${e instanceof BdError ? e.message : `Update failed: ${String(e)}`}`,
				);
				saveBtn.disabled = false;
				saveBtn.setText("Save");
			}
		};
	}

	/** Fetch and render the two dependency directions into `container`. */
	private async loadDeps(container: HTMLElement): Promise<void> {
		try {
			const [blockedBy, blocks] = await Promise.all([
				bdDepList(this.opts, this.id, "down"), // what this depends on
				bdDepList(this.opts, this.id, "up"), // what depends on this
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
