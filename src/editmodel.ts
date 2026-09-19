import type { BeadIssue } from "./types";
import type { BdUpdateFields } from "./bd";

/**
 * The bead editor's editable snapshot, and the diff that turns it into a
 * minimal `bd update`. Pure (no Obsidian imports) so it is unit-testable.
 */
export interface EditModel {
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee: string;
	labels: string[];
	description: string;
	design: string;
	notes: string;
	acceptance: string;
}

export type TextKey = "description" | "design" | "notes" | "acceptance";

export interface TextField {
	key: TextKey;
	label: string;
	placeholder: string;
}

/** Markdown text fields, in `bd show` order. Only the description shows when empty. */
export const TEXT_FIELDS: readonly TextField[] = [
	{ key: "description", label: "Description", placeholder: "Add a description…" },
	{ key: "design", label: "Design", placeholder: "Add design notes…" },
	{ key: "notes", label: "Notes", placeholder: "Add notes…" },
	{
		key: "acceptance",
		label: "Acceptance criteria",
		placeholder: "Add acceptance criteria…",
	},
];

/** The stored value of a text field as bd returns it (`acceptance_criteria` in JSON). */
export function issueText(issue: BeadIssue, key: TextKey): string {
	if (key === "acceptance") return issue.acceptance_criteria ?? "";
	return issue[key] ?? "";
}

export function blankModel(): EditModel {
	return {
		title: "",
		status: "open",
		priority: 2,
		type: "task",
		assignee: "",
		labels: [],
		description: "",
		design: "",
		notes: "",
		acceptance: "",
	};
}

export function modelFromIssue(issue: BeadIssue): EditModel {
	return {
		title: issue.title ?? "",
		status: issue.status ?? "open",
		priority: issue.priority ?? 2,
		type: issue.issue_type ?? "task",
		assignee: issue.assignee ?? "",
		labels: [...(issue.labels ?? [])],
		description: issueText(issue, "description"),
		design: issueText(issue, "design"),
		notes: issueText(issue, "notes"),
		acceptance: issueText(issue, "acceptance"),
	};
}

export function cloneModel(m: EditModel): EditModel {
	return { ...m, labels: [...m.labels] };
}

export function modelsEqual(a: EditModel, b: EditModel): boolean {
	return (
		a.title === b.title &&
		a.status === b.status &&
		a.priority === b.priority &&
		a.type === b.type &&
		a.assignee === b.assignee &&
		TEXT_FIELDS.every(({ key }) => a[key] === b[key]) &&
		a.labels.length === b.labels.length &&
		a.labels.every((l, i) => l === b.labels[i])
	);
}

/**
 * The `bd update` fields that differ between the edited model and the stored
 * issue — so Save writes only what changed. The title is trimmed; text fields
 * ignore trailing whitespace (bd may normalise a trailing newline) and an empty
 * value is sent as "" to clear the field. Labels diff into add/remove lists.
 */
export function diffModel(model: EditModel, issue: BeadIssue): BdUpdateFields {
	const f: BdUpdateFields = {};
	const title = model.title.trim();
	if (title !== issue.title) f.title = title;
	if (model.type !== issue.issue_type) f.type = model.type;
	if (model.priority !== (issue.priority ?? 2)) f.priority = model.priority;
	if (model.status !== issue.status) f.status = model.status;
	if (model.assignee !== (issue.assignee ?? "")) f.assignee = model.assignee;
	for (const { key } of TEXT_FIELDS) {
		if (model[key].trimEnd() !== issueText(issue, key).trimEnd()) f[key] = model[key];
	}
	const old = issue.labels ?? [];
	const add = model.labels.filter((l) => !old.includes(l));
	const rem = old.filter((l) => !model.labels.includes(l));
	if (add.length) f.addLabels = add;
	if (rem.length) f.removeLabels = rem;
	return f;
}
