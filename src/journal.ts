import { BeadIssue } from "./types";

/**
 * One line of `bd events tail` (bd >= 1.3.0). `issue` is the bead's full state
 * AFTER the change, or null on delete; `is_blocked` appears only when true.
 */
export interface JournalRecord {
	seq: number;
	op: string;
	issue_id: string;
	issue?: BeadIssue | null;
}

export function parseRecord(line: string): JournalRecord | null {
	try {
		const r = JSON.parse(line) as Partial<JournalRecord>;
		if (typeof r.seq !== "number" || typeof r.issue_id !== "string") return null;
		return r as JournalRecord;
	} catch {
		return null;
	}
}

export type TabKey = "ready" | "in_progress" | "blocked" | "closed";

export interface TabList {
	issues: BeadIssue[];
	/** bd returned a full page, so more rows exist beyond what is loaded. */
	hasMore: boolean;
	loaded: boolean;
}

export function byPriority(issues: BeadIssue[]): BeadIssue[] {
	return issues
		.slice()
		.sort(
			(a, b) =>
				(a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id),
		);
}

/**
 * Does an issue belong in a tab? "yes" and "no" are exact. "maybe" means the
 * tab is computed by bd from more than the record carries (Ready also hides
 * gates, templates, children of deferred parents, ...), so only bd can say.
 */
function fits(tab: TabKey, i: BeadIssue, now: number): "yes" | "maybe" | "no" {
	const blocked = i.is_blocked === true;
	switch (tab) {
		case "closed":
			return i.status === "closed" ? "yes" : "no";
		case "in_progress":
			return i.status === "in_progress" ? "yes" : "no";
		case "blocked":
			return blocked && i.status !== "closed" ? "maybe" : "no";
		case "ready": {
			const deferred = !!i.defer_until && Date.parse(i.defer_until) > now;
			if (i.status !== "open" || blocked || deferred || i.ephemeral || i.pinned) {
				return "no";
			}
			return "maybe";
		}
	}
}

/**
 * Apply one journal record to the loaded tab lists in place. Exact outcomes
 * (edit a row, drop a row that no longer belongs, insert into a fully loaded
 * status list) happen here with no bd call. Returns the tabs whose membership
 * only bd can settle; the caller re-reads those.
 */
export function applyRecord(
	tabs: Record<TabKey, TabList>,
	rec: JournalRecord,
	now = Date.now(),
): Set<TabKey> {
	const stale = new Set<TabKey>();
	for (const key of Object.keys(tabs) as TabKey[]) {
		const tab = tabs[key];
		if (!tab.loaded) continue;
		const at = tab.issues.findIndex((i) => i.id === rec.issue_id);
		if (!rec.issue) {
			if (at !== -1) tab.issues.splice(at, 1);
			continue;
		}
		const fit = fits(key, rec.issue, now);
		if (fit === "no") {
			if (at !== -1) tab.issues.splice(at, 1);
		} else if (at !== -1) {
			// Keep list-only fields (counts) that journal records don't carry.
			tab.issues[at] = { ...tab.issues[at], ...rec.issue };
			tab.issues = byPriority(tab.issues);
			if (rec.op === "dep_add" || rec.op === "dep_remove") stale.add(key);
		} else if (fit === "yes" && !tab.hasMore) {
			tab.issues = byPriority([...tab.issues, rec.issue]);
		} else {
			stale.add(key);
		}
	}
	return stale;
}

/**
 * Whether a record can move the per-status counts. `seen` holds the last
 * count-relevant state per id and is updated here; a first sighting counts
 * as a change, so this errs toward re-counting.
 */
export function affectsCounts(
	rec: JournalRecord,
	seen: Map<string, string>,
): boolean {
	if (!rec.issue) {
		seen.delete(rec.issue_id);
		return true;
	}
	const i = rec.issue;
	const key = `${i.status}|${i.is_blocked === true}|${i.defer_until ?? ""}`;
	const prev = seen.get(rec.issue_id);
	seen.set(rec.issue_id, key);
	return prev !== key;
}
