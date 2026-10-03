import { test } from "node:test";
import assert from "node:assert/strict";
import type { BeadIssue } from "../src/types.ts";
import {
	type JournalRecord,
	type TabKey,
	type TabList,
	affectsCounts,
	applyRecord,
	parseRecord,
} from "../src/journal.ts";
import { EMPTY_FILTER, matchesFilter, type PaneFilter } from "../src/filter.ts";

// --- helpers ---------------------------------------------------------------

function issue(over: Partial<BeadIssue> & { id: string }): BeadIssue {
	return {
		status: "open",
		priority: 2,
		title: over.id,
		...over,
	} as BeadIssue;
}

function rec(over: Partial<JournalRecord> & { issue_id: string }): JournalRecord {
	return { seq: 1, op: "update", ...over } as JournalRecord;
}

/** All four tabs, loaded and fully read (no `hasMore`), holding `issues`. */
function tabs(issues: Partial<Record<TabKey, BeadIssue[]>>): Record<TabKey, TabList> {
	const keys: TabKey[] = ["ready", "in_progress", "blocked", "closed"];
	const out = {} as Record<TabKey, TabList>;
	for (const k of keys) {
		out[k] = { issues: issues[k] ?? [], hasMore: false, loaded: true };
	}
	return out;
}

const ids = (t: TabList) => t.issues.map((i) => i.id);
const filter = (over: Partial<PaneFilter> = {}): PaneFilter => ({
	...EMPTY_FILTER,
	labels: [],
	...over,
});
const inScope = (f: PaneFilter) => (i: BeadIssue) => matchesFilter(i, f);

// --- parseRecord -----------------------------------------------------------

test("parseRecord keeps a well-formed record", () => {
	const r = parseRecord('{"seq":7,"op":"update","issue_id":"bd-a1","issue":{"id":"bd-a1","status":"open"}}');
	assert.equal(r?.seq, 7);
	assert.equal(r?.issue_id, "bd-a1");
	assert.equal(r?.issue?.id, "bd-a1");
});

test("parseRecord drops malformed lines rather than throwing", () => {
	for (const line of [
		"",
		"not json",
		"{}",
		'{"seq":"1","issue_id":"bd-a1"}', // seq not a number
		'{"seq":1}', // no issue_id
		'{"seq":1,"issue_id":"bd-a1","issue":{"status":"open"}}', // issue has no id
		'{"seq":1,"issue_id":"bd-a1","issue":{"id":"bd-a1"}}', // issue has no status
	]) {
		assert.equal(parseRecord(line), null, line);
	}
});

test("parseRecord keeps a delete (issue: null)", () => {
	const r = parseRecord('{"seq":9,"op":"delete","issue_id":"bd-a1","issue":null}');
	assert.equal(r?.issue, null);
	assert.equal(r?.issue_id, "bd-a1");
});

// --- applyRecord: tab membership ------------------------------------------

test("applyRecord patches a row in place and keeps list-only counts", () => {
	const t = tabs({ ready: [issue({ id: "bd-a1", title: "old", blocked_by_count: 3, dependency_count: 2 })] });
	// The record carries full state but no list-only counts.
	const stale = applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", title: "new" }) }));
	assert.deepEqual([...stale], []);
	assert.equal(t.ready.issues[0].title, "new");
	assert.equal(t.ready.issues[0].blocked_by_count, 3);
	assert.equal(t.ready.issues[0].dependency_count, 2);
});

test("applyRecord drops a row that no longer belongs in the tab", () => {
	const t = tabs({ in_progress: [issue({ id: "bd-a1", status: "in_progress" })] });
	applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed" }) }));
	assert.deepEqual(ids(t.in_progress), []);
	assert.deepEqual(ids(t.closed), ["bd-a1"]); // exact fit, fully loaded → inserted
});

test("applyRecord removes a deleted bead from every loaded tab", () => {
	const t = tabs({ ready: [issue({ id: "bd-a1" })], closed: [issue({ id: "bd-a1", status: "closed" })] });
	applyRecord(t, rec({ issue_id: "bd-a1", op: "delete", issue: null }));
	assert.deepEqual(ids(t.ready), []);
	assert.deepEqual(ids(t.closed), []);
});

test("applyRecord marks Ready stale instead of guessing (only bd knows)", () => {
	const t = tabs({});
	const stale = applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "open" }) }));
	assert.ok(stale.has("ready"), "an open, unblocked bead might be ready — bd must settle it");
	assert.ok(!stale.has("closed"));
});

test("applyRecord never touches a tab that isn't loaded", () => {
	const t = tabs({ closed: [issue({ id: "bd-a1", status: "closed" })] });
	t.closed.loaded = false;
	applyRecord(t, rec({ issue_id: "bd-a1", op: "delete", issue: null }));
	assert.deepEqual(ids(t.closed), ["bd-a1"], "an unloaded tab is re-read, not patched");
});

test("applyRecord won't insert into a partially loaded tab", () => {
	const t = tabs({ closed: [] });
	t.closed.hasMore = true; // more rows exist beyond the page
	const stale = applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed" }) }));
	assert.deepEqual(ids(t.closed), [], "would land in the wrong place on the page");
	assert.ok(stale.has("closed"));
});

test("applyRecord keeps rows sorted by priority", () => {
	const t = tabs({ closed: [issue({ id: "bd-a1", status: "closed", priority: 0 })] });
	applyRecord(t, rec({ issue_id: "bd-b2", issue: issue({ id: "bd-b2", status: "closed", priority: 1 }) }));
	applyRecord(t, rec({ issue_id: "bd-c3", issue: issue({ id: "bd-c3", status: "closed", priority: 0 }) }));
	assert.deepEqual(ids(t.closed), ["bd-a1", "bd-c3", "bd-b2"]);
});

// --- applyRecord: the pane filter -----------------------------------------
//
// The lists were read with the filter applied as bd flags, so a record for a
// bead the filter excludes must not put it on screen.

test("applyRecord does not insert a bead the filter excludes", () => {
	const f = filter({ assignee: "alice" });
	const t = tabs({ closed: [] });
	applyRecord(t, rec({ issue_id: "bd-b2", issue: issue({ id: "bd-b2", status: "closed", assignee: "bob" }) }), inScope(f));
	assert.deepEqual(ids(t.closed), [], "bob's bead has no business in an alice-filtered pane");
});

test("applyRecord still inserts a bead the filter keeps", () => {
	const f = filter({ assignee: "alice" });
	const t = tabs({ closed: [] });
	applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed", assignee: "alice" }) }), inScope(f));
	assert.deepEqual(ids(t.closed), ["bd-a1"]);
});

test("applyRecord drops a row once it stops matching the filter", () => {
	const f = filter({ assignee: "alice" });
	const t = tabs({ closed: [issue({ id: "bd-a1", status: "closed", assignee: "alice" })] });
	// Reassigned away from alice: it leaves this pane even though the tab fits.
	applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed", assignee: "bob" }) }), inScope(f));
	assert.deepEqual(ids(t.closed), []);
});

test("applyRecord honours label and type filters too", () => {
	const t = tabs({ closed: [] });
	const labelled = filter({ labels: ["ui", "api"] });
	applyRecord(
		t,
		rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed", labels: ["ui"] }) }),
		inScope(labelled),
	);
	assert.deepEqual(ids(t.closed), [], "labels are AND — one of two is not a match");

	applyRecord(
		t,
		rec({ issue_id: "bd-b2", issue: issue({ id: "bd-b2", status: "closed", labels: ["ui", "api"] }) }),
		inScope(labelled),
	);
	assert.deepEqual(ids(t.closed), ["bd-b2"]);

	const t2 = tabs({ closed: [] });
	applyRecord(
		t2,
		rec({ issue_id: "bd-c3", issue: issue({ id: "bd-c3", status: "closed", issue_type: "bug" }) }),
		inScope(filter({ type: "task" })),
	);
	assert.deepEqual(ids(t2.closed), []);
});

test("applyRecord with no filter keeps the unfiltered behaviour", () => {
	const t = tabs({ closed: [] });
	applyRecord(t, rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed", assignee: "bob" }) }));
	assert.deepEqual(ids(t.closed), ["bd-a1"]);
});

// --- affectsCounts ---------------------------------------------------------

test("affectsCounts errs toward recounting on a first sighting", () => {
	const seen = new Map<string, string>();
	const r = rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1" }) });
	assert.equal(affectsCounts(r, seen), true);
	assert.equal(affectsCounts(r, seen), false, "same count-relevant state → no recount");
});

test("affectsCounts spots a status change but ignores cosmetic edits", () => {
	const seen = new Map<string, string>();
	affectsCounts(rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", title: "a" }) }), seen);
	assert.equal(
		affectsCounts(rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", title: "b" }) }), seen),
		false,
		"a retitle can't move a count",
	);
	assert.equal(
		affectsCounts(rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", status: "closed" }) }), seen),
		true,
	);
});

test("affectsCounts spots blocking and defer changes, and deletes", () => {
	const seen = new Map<string, string>();
	affectsCounts(rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1" }) }), seen);
	assert.equal(
		affectsCounts(rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", is_blocked: true }) }), seen),
		true,
	);
	assert.equal(
		affectsCounts(
			rec({ issue_id: "bd-a1", issue: issue({ id: "bd-a1", is_blocked: true, defer_until: "2099-01-01" }) }),
			seen,
		),
		true,
	);
	assert.equal(affectsCounts(rec({ issue_id: "bd-a1", issue: null }), seen), true);
	assert.equal(seen.has("bd-a1"), false, "a deleted bead is forgotten");
});
