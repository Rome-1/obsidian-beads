import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EMPTY_FILTER,
	NO_ASSIGNEE,
	MAX_SAVED_ASSIGNEES,
	describeFilter,
	filterArgs,
	forgetAssignee,
	hideAssignee,
	matchesAnyPattern,
	parsePatterns,
	parseSavedAssignees,
	rememberAssignee,
	suggestAssignees,
	isFilterActive,
	matchesFilter,
	parseFilter,
	type PaneFilter,
} from "../src/filter.ts";
import type { BeadIssue } from "../src/types.ts";

const f = (o: Partial<PaneFilter> = {}): PaneFilter => ({ ...EMPTY_FILTER, labels: [], ...o });

const issue = (o: Partial<BeadIssue> = {}): BeadIssue => ({
	id: "pk-1",
	title: "t",
	status: "open",
	priority: 2,
	issue_type: "task",
	...o,
});

test("isFilterActive: empty is inactive; any single criterion activates it", () => {
	assert.equal(isFilterActive(f()), false);
	assert.equal(isFilterActive(f({ assignee: "alice" })), true);
	assert.equal(isFilterActive(f({ assignee: NO_ASSIGNEE })), true);
	assert.equal(isFilterActive(f({ labels: ["x"] })), true);
	assert.equal(isFilterActive(f({ type: "bug" })), true);
});

test("filterArgs: no filter → no flags", () => {
	for (const cmd of ["ready", "list", "count"] as const) assert.deepEqual(filterArgs(f(), cmd), []);
});

test("filterArgs: assignee, repeated labels (AND), and type in --flag=value form", () => {
	assert.deepEqual(filterArgs(f({ assignee: "alice", labels: ["a", "b"], type: "bug" }), "list"), [
		"--assignee=alice",
		"--label=a",
		"--label=b",
		"--type=bug",
	]);
});

test("filterArgs: unassigned is --unassigned for ready, --no-assignee for list/count", () => {
	const un = f({ assignee: NO_ASSIGNEE });
	assert.deepEqual(filterArgs(un, "ready"), ["--unassigned"]);
	assert.deepEqual(filterArgs(un, "list"), ["--no-assignee"]);
	assert.deepEqual(filterArgs(un, "count"), ["--no-assignee"]);
});

test("filterArgs: flag-looking values stay attached to their flag", () => {
	assert.deepEqual(filterArgs(f({ assignee: "--all", labels: ["-x"] }), "list"), [
		"--assignee=--all",
		"--label=-x",
	]);
});

test("matchesFilter: assignee exact / unassigned / anyone", () => {
	const mine = issue({ assignee: "alice" });
	const nobody = issue();
	assert.ok(matchesFilter(mine, f()));
	assert.ok(matchesFilter(mine, f({ assignee: "alice" })));
	assert.ok(!matchesFilter(mine, f({ assignee: "ali" })), "exact match, not substring");
	assert.ok(!matchesFilter(mine, f({ assignee: NO_ASSIGNEE })));
	assert.ok(matchesFilter(nobody, f({ assignee: NO_ASSIGNEE })));
	assert.ok(matchesFilter(issue({ assignee: "" }), f({ assignee: NO_ASSIGNEE })));
	assert.ok(!matchesFilter(nobody, f({ assignee: "alice" })));
});

test("matchesFilter: labels are AND — the issue must carry every one", () => {
	const both = issue({ labels: ["journey", "tier:P1", "extra"] });
	assert.ok(matchesFilter(both, f({ labels: ["journey"] })));
	assert.ok(matchesFilter(both, f({ labels: ["journey", "tier:P1"] })));
	assert.ok(!matchesFilter(both, f({ labels: ["journey", "tier:P0"] })));
	assert.ok(!matchesFilter(issue(), f({ labels: ["journey"] })), "no labels at all");
});

test("matchesFilter: type exact, and all criteria combine", () => {
	const bug = issue({ issue_type: "bug", assignee: "bob", labels: ["x"] });
	assert.ok(matchesFilter(bug, f({ type: "bug" })));
	assert.ok(!matchesFilter(bug, f({ type: "task" })));
	assert.ok(matchesFilter(bug, f({ type: "bug", assignee: "bob", labels: ["x"] })));
	assert.ok(!matchesFilter(bug, f({ type: "bug", assignee: "bob", labels: ["y"] })));
});

test("parseFilter restores saved state and drops malformed parts", () => {
	assert.deepEqual(parseFilter({ assignee: "alice", labels: ["a", "b"], type: "bug" }), f({
		assignee: "alice",
		labels: ["a", "b"],
		type: "bug",
	}));
	assert.deepEqual(parseFilter(undefined), f());
	assert.deepEqual(parseFilter("nope"), f());
	assert.deepEqual(
		parseFilter({ assignee: 3, labels: ["a", 1, "", "a", null], type: ["x"] }),
		f({ labels: ["a"] }),
	);
});

test("parseFilter returns a fresh labels array (no shared EMPTY_FILTER state)", () => {
	const a = parseFilter(undefined);
	a.labels.push("x");
	assert.deepEqual(parseFilter(undefined).labels, []);
	assert.deepEqual(EMPTY_FILTER.labels, []);
});

test("describeFilter summarises the active criteria", () => {
	assert.equal(describeFilter(f()), "");
	assert.equal(describeFilter(f({ assignee: NO_ASSIGNEE })), "unassigned");
	assert.equal(
		describeFilter(f({ assignee: "alice", labels: ["a", "b"], type: "bug" })),
		"assignee: alice · labels: a, b · type: bug",
	);
	assert.equal(describeFilter(f({ labels: ["a"] })), "label: a");
});

// --- assignee box ------------------------------------------------------------

test("rememberAssignee puts the name first, de-duplicates, trims, and caps the list", () => {
	assert.deepEqual(rememberAssignee([], " alice "), ["alice"]);
	assert.deepEqual(rememberAssignee(["bob", "alice", "carol"], "alice"), ["alice", "bob", "carol"]);
	assert.deepEqual(rememberAssignee(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
	const full = Array.from({ length: MAX_SAVED_ASSIGNEES }, (_, i) => `u${i}`);
	assert.equal(rememberAssignee(full, "new").length, MAX_SAVED_ASSIGNEES);
});

test("rememberAssignee ignores empty input and the unassigned sentinel, without mutating", () => {
	const saved = ["alice"];
	assert.deepEqual(rememberAssignee(saved, "   "), ["alice"]);
	assert.deepEqual(rememberAssignee(saved, NO_ASSIGNEE), ["alice"]);
	rememberAssignee(saved, "bob");
	assert.deepEqual(saved, ["alice"]);
});

test("forgetAssignee removes exactly that name", () => {
	assert.deepEqual(forgetAssignee(["alice", "bob", "alice2"], "alice"), ["bob", "alice2"]);
	assert.deepEqual(forgetAssignee(["alice"], "nobody"), ["alice"]);
});

const names = (xs: ReturnType<typeof suggestAssignees>) =>
	xs.map((s) => (s.kind === "unassigned" ? "<unassigned>" : `${s.kind}:${s.name}`));

test("suggestAssignees with an empty box: Unassigned, then saved, then known (minus saved)", () => {
	assert.deepEqual(names(suggestAssignees("", ["igor", "bob"], ["harness-w1", "bob", "(unassigned)"])), [
		"<unassigned>",
		"saved:igor",
		"saved:bob",
		"known:harness-w1",
	]);
});

test("suggestAssignees offers the typed text first so Enter keeps it, then case-insensitive matches", () => {
	assert.deepEqual(names(suggestAssignees("Ig", ["igor.m"], ["BIG-worker", "bob"])), [
		"typed:Ig",
		"<unassigned>", // "unass-ig-ned" contains the query too
		"saved:igor.m",
		"known:BIG-worker",
	]);
});

test("suggestAssignees doesn't duplicate the typed text when it's an exact match", () => {
	assert.deepEqual(names(suggestAssignees("igor", ["igor"], ["igor-2"])), ["saved:igor", "known:igor-2"]);
	assert.deepEqual(names(suggestAssignees("bob", [], ["bob"])), ["known:bob"]);
	assert.deepEqual(names(suggestAssignees(NO_ASSIGNEE, [], [])), ["<unassigned>"]);
});

test("suggestAssignees shows Unassigned for a partial 'unass' query", () => {
	assert.deepEqual(names(suggestAssignees("unass", [], [])), ["typed:unass", "<unassigned>"]);
});

test("suggestAssignees caps bd's known names but never saved ones", () => {
	const known = Array.from({ length: 100 }, (_, i) => `w${i}`);
	const saved = Array.from({ length: 40 }, (_, i) => `s${i}`);
	const out = suggestAssignees("", saved, known, 30);
	assert.equal(out.filter((s) => s.kind === "saved").length, 40);
	assert.equal(out.filter((s) => s.kind === "known").length, 30);
});

test("parseSavedAssignees keeps trimmed unique strings, drops junk and the sentinel", () => {
	assert.deepEqual(parseSavedAssignees([" alice", "alice", "", 3, null, NO_ASSIGNEE, "bob"]), ["alice", "bob"]);
	assert.deepEqual(parseSavedAssignees(undefined), []);
	assert.deepEqual(parseSavedAssignees("alice"), []);
	const many = Array.from({ length: 80 }, (_, i) => `u${i}`);
	assert.equal(parseSavedAssignees(many).length, MAX_SAVED_ASSIGNEES);
});

// --- hidden assignees ----------------------------------------------------------

test("matchesAnyPattern: exact names and * globs, anchored and case-sensitive", () => {
	assert.ok(matchesAnyPattern("harness-149x6084-w1", ["harness-*"]));
	assert.ok(matchesAnyPattern("bob", ["alice", "bob"]));
	assert.ok(!matchesAnyPattern("my-harness-w1", ["harness-*"]), "anchored at the start");
	assert.ok(!matchesAnyPattern("bobby", ["bob"]), "exact unless *");
	assert.ok(!matchesAnyPattern("Harness-w1", ["harness-*"]), "case-sensitive like bd");
	assert.ok(matchesAnyPattern("a-x-b", ["a*b"]));
	assert.ok(matchesAnyPattern("anything", ["*"]));
	assert.ok(!matchesAnyPattern("x", []));
});

test("matchesAnyPattern treats regex metacharacters literally", () => {
	assert.ok(matchesAnyPattern("igor.m", ["igor.m"]));
	assert.ok(!matchesAnyPattern("igorxm", ["igor.m"]), ". is not a wildcard");
	assert.ok(matchesAnyPattern("a(b)+[c]", ["a(b)+[c]"]));
	assert.ok(matchesAnyPattern("w1 (bot)", ["* (bot)"]));
});

test("hideAssignee appends a trimmed exact name once, without mutating", () => {
	const hidden = ["harness-*"];
	assert.deepEqual(hideAssignee(hidden, " bob "), ["harness-*", "bob"]);
	assert.deepEqual(hideAssignee(["bob"], "bob"), ["bob"]);
	assert.deepEqual(hideAssignee(hidden, "  "), ["harness-*"]);
	assert.deepEqual(hidden, ["harness-*"]);
});

test("parsePatterns reads settings text or a saved array into unique trimmed patterns", () => {
	assert.deepEqual(parsePatterns("harness-*\n\n  bob \nharness-*"), ["harness-*", "bob"]);
	assert.deepEqual(parsePatterns(["a", " a ", "", 3, "b"]), ["a", "b"]);
	assert.deepEqual(parsePatterns(undefined), []);
});

test("suggestAssignees leaves out hidden bd names, but never saved or typed ones", () => {
	const out = suggestAssignees(
		"",
		["harness-w9"], // saved explicitly by the user
		["harness-w1", "harness-w2", "alice"],
		30,
		["harness-*"],
	);
	assert.deepEqual(names(out), ["<unassigned>", "saved:harness-w9", "known:alice"]);
	// Typing a hidden name still offers it (typed), so it can be filtered on.
	assert.deepEqual(names(suggestAssignees("harness-w1", [], ["harness-w1"], 30, ["harness-*"])), [
		"typed:harness-w1",
	]);
});
