import { test } from "node:test";
import assert from "node:assert/strict";
import {
	TEXT_FIELDS,
	blankModel,
	cloneModel,
	diffModel,
	issueText,
	modelFromIssue,
	modelsEqual,
} from "../src/editmodel.ts";
import type { BeadIssue } from "../src/types.ts";

// Shaped like real `bd show --json` output (bd 1.2.2): acceptance criteria come
// back as `acceptance_criteria`, and empty text fields are simply absent.
const ISSUE: BeadIssue = {
	id: "pk-mol-0aoo",
	title: "TC-LIFE-05 compare: Project deletion (P1)",
	status: "open",
	priority: 2,
	issue_type: "task",
	labels: ["journey", "tier:P1"],
	description: "stage: compare\ntc: TC-LIFE-05\n",
	notes: "artifact: tests/sbs/results/TC-LIFE-05/compare.json",
	acceptance_criteria: "JSON parses",
};

test("TEXT_FIELDS are the four bd markdown fields, in bd show order", () => {
	assert.deepEqual(
		TEXT_FIELDS.map((f) => f.key),
		["description", "design", "notes", "acceptance"],
	);
});

test("issueText maps acceptance to bd's acceptance_criteria and defaults to empty", () => {
	assert.equal(issueText(ISSUE, "acceptance"), "JSON parses");
	assert.equal(issueText(ISSUE, "notes"), ISSUE.notes);
	assert.equal(issueText(ISSUE, "design"), "");
});

test("modelFromIssue copies every editable field, with defaults for missing ones", () => {
	const m = modelFromIssue(ISSUE);
	assert.equal(m.acceptance, "JSON parses");
	assert.equal(m.design, "");
	assert.equal(m.assignee, "");
	assert.deepEqual(m.labels, ["journey", "tier:P1"]);
	const bare = modelFromIssue({ id: "x", title: "t", status: "open", priority: 0, issue_type: "bug" });
	assert.equal(bare.priority, 0); // 0 is a real priority, not "missing"
	assert.deepEqual(bare.labels, []);
});

test("modelFromIssue doesn't alias the issue's labels array", () => {
	const m = modelFromIssue(ISSUE);
	m.labels.push("new");
	assert.deepEqual(ISSUE.labels, ["journey", "tier:P1"]);
});

test("cloneModel + modelsEqual detect a change in any field, including text fields", () => {
	const a = modelFromIssue(ISSUE);
	assert.ok(modelsEqual(a, cloneModel(a)));
	for (const key of ["title", "status", "type", "assignee", "description", "design", "notes", "acceptance"] as const) {
		const b = cloneModel(a);
		b[key] = `${b[key]}!`;
		assert.ok(!modelsEqual(a, b), key);
	}
	const p = cloneModel(a);
	p.priority = 0;
	assert.ok(!modelsEqual(a, p));
	const l = cloneModel(a);
	l.labels.push("x");
	assert.ok(!modelsEqual(a, l));
	assert.ok(modelsEqual(a, cloneModel(a)), "clone isn't affected by edits to other clones");
});

test("diffModel of an unchanged model is empty", () => {
	assert.deepEqual(diffModel(modelFromIssue(ISSUE), ISSUE), {});
});

test("diffModel sends only the fields that changed", () => {
	const m = modelFromIssue(ISSUE);
	m.priority = 0;
	m.design = "## Approach\nuse <id>";
	assert.deepEqual(diffModel(m, ISSUE), { priority: 0, design: "## Approach\nuse <id>" });
});

test("diffModel ignores trailing-whitespace-only text edits", () => {
	const m = modelFromIssue(ISSUE);
	m.description = ISSUE.description!.trimEnd(); // bd stored a trailing newline
	m.notes = `${ISSUE.notes}\n\n`;
	assert.deepEqual(diffModel(m, ISSUE), {});
});

test("diffModel clears a text field by sending an empty string", () => {
	const m = modelFromIssue(ISSUE);
	m.notes = "";
	m.acceptance = "   ";
	assert.deepEqual(diffModel(m, ISSUE), { notes: "", acceptance: "   " });
});

test("diffModel trims the title and skips a whitespace-only title change", () => {
	const m = modelFromIssue(ISSUE);
	m.title = `  ${ISSUE.title}  `;
	assert.deepEqual(diffModel(m, ISSUE), {});
	m.title = "  New title ";
	assert.deepEqual(diffModel(m, ISSUE), { title: "New title" });
});

test("diffModel turns label edits into add/remove lists", () => {
	const m = modelFromIssue(ISSUE);
	m.labels = ["tier:P1", "sbs"];
	assert.deepEqual(diffModel(m, ISSUE), { addLabels: ["sbs"], removeLabels: ["journey"] });
});

test("diffModel compares priority and assignee against bd's defaults", () => {
	const bare: BeadIssue = { id: "x", title: "t", status: "open", priority: undefined as unknown as number, issue_type: "task" };
	const m = modelFromIssue(bare);
	assert.equal(m.priority, 2);
	assert.deepEqual(diffModel(m, bare), {});
	m.assignee = "igor";
	assert.deepEqual(diffModel(m, bare), { assignee: "igor" });
});

test("blankModel is a fresh object each call", () => {
	const a = blankModel();
	a.labels.push("x");
	assert.deepEqual(blankModel().labels, []);
	assert.equal(blankModel().status, "open");
});
