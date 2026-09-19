import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildUpdateArgs,
	parseAssigneeNames,
	parseComments,
	parseCount,
	parseIssues,
	unwrapEnvelope,
	parseLabelNames,
	parseTypeNames,
} from "../src/bd.ts";

test("maps every text field to its bd flag, id after the -- sentinel", () => {
	assert.deepEqual(
		buildUpdateArgs("pk-1", { description: "d", design: "g", notes: "n", acceptance: "a" }),
		["update", "--description=d", "--design=g", "--notes=n", "--acceptance=a", "--", "pk-1"],
	);
});

test("an empty string is sent (bd clears the field), undefined is omitted", () => {
	assert.deepEqual(buildUpdateArgs("pk-1", { notes: "", design: undefined }), [
		"update",
		"--notes=",
		"--",
		"pk-1",
	]);
});

test("values that look like flags or contain newlines stay one argv token", () => {
	const args = buildUpdateArgs("-pk-1", { notes: "--status=closed\nline 2", title: "-x" });
	assert.deepEqual(args, ["update", "--title=-x", "--notes=--status=closed\nline 2", "--", "-pk-1"]);
});

test("labels diff into repeated add/remove flags; other fields keep their form", () => {
	assert.deepEqual(
		buildUpdateArgs("pk-1", {
			priority: 0,
			type: "bug",
			status: "in_progress",
			assignee: "",
			addLabels: ["a", "b"],
			removeLabels: ["c"],
		}),
		[
			"update",
			"--priority=0",
			"--type=bug",
			"--status=in_progress",
			"--assignee=",
			"--add-label=a",
			"--add-label=b",
			"--remove-label=c",
			"--",
			"pk-1",
		],
	);
});

test("no fields → just the id (bd reports nothing to update)", () => {
	assert.deepEqual(buildUpdateArgs("pk-1", {}), ["update", "--", "pk-1"]);
});

// --- JSON parsers for the pane's filter options (shapes from bd 1.2.2) -----

test("parseCount reads {count}, defaulting to 0", () => {
	assert.equal(parseCount('{"count": 203, "schema_version": 1}'), 203);
	assert.equal(parseCount("{}"), 0);
});

test("parseLabelNames sorts by usage then name, skipping junk", () => {
	const json = JSON.stringify([
		{ label: "fixture", count: 11 },
		{ label: "journey", count: 246 },
		{ label: "catalog", count: 129 },
		{ label: "a-tie", count: 11 },
		{ label: "", count: 99 },
		{ nope: true },
	]);
	assert.deepEqual(parseLabelNames(json), ["journey", "catalog", "a-tie", "fixture"]);
	assert.deepEqual(parseLabelNames("{}"), []);
});

test("parseAssigneeNames drops bd's (unassigned) group and sorts by count", () => {
	const json = JSON.stringify({
		groups: [
			{ count: 219, group: "(unassigned)" },
			{ count: 1, group: "harness-149x6084-w1" },
			{ count: 2, group: "harness-21102x60669-w2" },
		],
		schema_version: 1,
	});
	assert.deepEqual(parseAssigneeNames(json), ["harness-21102x60669-w2", "harness-149x6084-w1"]);
	assert.deepEqual(parseAssigneeNames('{"schema_version":1}'), []);
});

test("parseTypeNames lists core then custom types, de-duplicated", () => {
	const json = JSON.stringify({
		core_types: [
			{ name: "task", description: "General work item (default)" },
			{ name: "bug", description: "Bug report or defect" },
		],
		custom_types: ["molecule", "gate", "task"],
		schema_version: 1,
	});
	assert.deepEqual(parseTypeNames(json), ["task", "bug", "molecule", "gate"]);
});

test("parsers throw a BdError on non-JSON output", () => {
	for (const parse of [parseCount, parseLabelNames, parseAssigneeNames, parseTypeNames]) {
		assert.throws(() => parse("not json"), (e: Error) => e.name === "BdError");
	}
});

// --- bd v2 JSON envelope ({"schema_version", "data"}) ------------------------

const env = (data: unknown) => JSON.stringify({ schema_version: 1, data });

test("unwrapEnvelope returns .data for an envelope and leaves everything else alone", () => {
	assert.deepEqual(unwrapEnvelope({ schema_version: 1, data: [1] }), [1]);
	assert.equal(unwrapEnvelope({ schema_version: 1, data: null }), null);
	// Legacy object commands (e.g. `bd create`) have schema_version but no data key.
	const created = { schema_version: 1, id: "pk-1", title: "t" };
	assert.equal(unwrapEnvelope(created), created);
	const arr = [{ id: "a" }];
	assert.equal(unwrapEnvelope(arr), arr);
	assert.equal(unwrapEnvelope("x"), "x");
	// A plain object with `data` but no schema_version is not an envelope.
	const notEnv = { data: 1 };
	assert.equal(unwrapEnvelope(notEnv), notEnv);
});

test("every parser reads the enveloped (bd 2.x) format the same as the legacy one", () => {
	const issues = [{ id: "pk-1", title: "t", status: "open", priority: 2, issue_type: "task" }];
	assert.deepEqual(parseIssues(env(issues)), parseIssues(JSON.stringify(issues)));
	assert.deepEqual(parseIssues(env(issues[0])), issues); // bd show / create single object
	assert.equal(parseCount(env({ count: 375 })), 375);
	assert.deepEqual(parseLabelNames(env([{ label: "a", count: 1 }])), ["a"]);
	assert.deepEqual(parseAssigneeNames(env({ groups: [{ group: "bob", count: 1 }] })), ["bob"]);
	assert.deepEqual(parseTypeNames(env({ core_types: [{ name: "task" }], custom_types: [] })), ["task"]);
	const comments = [{ id: "c1", issue_id: "pk-1", author: "a", text: "hi" }];
	assert.deepEqual(parseComments(env(comments)), comments);
});

test("legacy single-object output (bd create) still parses to one issue", () => {
	assert.deepEqual(parseIssues('{"schema_version":1,"id":"pk-9","title":"x"}'), [
		{ schema_version: 1, id: "pk-9", title: "x" },
	]);
});

test("empty output parses to nothing", () => {
	assert.deepEqual(parseIssues("  "), []);
	assert.deepEqual(parseComments(""), []);
	assert.equal(parseCount(""), 0);
});
