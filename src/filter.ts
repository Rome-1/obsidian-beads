import type { BeadIssue } from "./types";

/**
 * The pane's filter: assignee, labels (AND — must have all), and type.
 * Pure (no Obsidian imports) so it's unit-testable.
 *
 * bd does the filtering wherever it can (`bd ready`, `bd list`, `bd count` take
 * the same flags). The one exception is the Blocked tab: `bd blocked` has no
 * filter flags, so `matchesFilter` applies the same rules to its output —
 * pinned to bd's behaviour by tests/bd.integration.test.mts.
 */
export interface PaneFilter {
	/** "" = anyone; NO_ASSIGNEE = unassigned only; else an exact assignee. */
	assignee: string;
	/** Every label must be present (bd's `--label` AND semantics). */
	labels: string[];
	/** "" = any type. */
	type: string;
}

/** bd's own name for the unassigned group (`bd count --by-assignee`). */
export const NO_ASSIGNEE = "(unassigned)";

export const EMPTY_FILTER: PaneFilter = { assignee: "", labels: [], type: "" };

export function isFilterActive(f: PaneFilter): boolean {
	return f.assignee !== "" || f.labels.length > 0 || f.type !== "";
}

/**
 * The filter as bd flags, in `--flag=value` form so a value can never be read
 * as another flag. Only the unassigned flag's spelling differs by command:
 * `bd ready` has `--unassigned`, `bd list` / `bd count` have `--no-assignee`.
 */
export function filterArgs(f: PaneFilter, cmd: "ready" | "list" | "count"): string[] {
	const args: string[] = [];
	if (f.assignee === NO_ASSIGNEE) {
		args.push(cmd === "ready" ? "--unassigned" : "--no-assignee");
	} else if (f.assignee) {
		args.push(`--assignee=${f.assignee}`);
	}
	for (const l of f.labels) args.push(`--label=${l}`);
	if (f.type) args.push(`--type=${f.type}`);
	return args;
}

/** Local equivalent of the bd flags above, for `bd blocked` output. */
export function matchesFilter(issue: BeadIssue, f: PaneFilter): boolean {
	const assignee = issue.assignee ?? "";
	if (f.assignee === NO_ASSIGNEE ? assignee !== "" : f.assignee && assignee !== f.assignee) {
		return false;
	}
	const labels = issue.labels ?? [];
	if (!f.labels.every((l) => labels.includes(l))) return false;
	if (f.type && issue.issue_type !== f.type) return false;
	return true;
}

/** Restore a filter from saved view state, dropping anything malformed. */
export function parseFilter(raw: unknown): PaneFilter {
	if (!raw || typeof raw !== "object") return { ...EMPTY_FILTER, labels: [] };
	const r = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const labels = Array.isArray(r.labels)
		? [...new Set(r.labels.filter((l): l is string => typeof l === "string" && l !== ""))]
		: [];
	return { assignee: str(r.assignee), labels, type: str(r.type) };
}

/** Short human summary, e.g. `assignee: alice · label: a, b · type: bug`. */
export function describeFilter(f: PaneFilter): string {
	const bits: string[] = [];
	if (f.assignee) bits.push(f.assignee === NO_ASSIGNEE ? "unassigned" : `assignee: ${f.assignee}`);
	if (f.labels.length) bits.push(`${f.labels.length > 1 ? "labels" : "label"}: ${f.labels.join(", ")}`);
	if (f.type) bits.push(`type: ${f.type}`);
	return bits.join(" · ");
}

// --- assignee box: remembered names + suggestions ------------------------

/** How many typed assignee names the pane remembers. */
export const MAX_SAVED_ASSIGNEES = 50;

export type AssigneeSuggestion =
	/** Exactly what was typed, when it isn't already an exact suggestion — first, so Enter keeps it. */
	| { kind: "typed"; name: string }
	| { kind: "unassigned" }
	/** A name the user typed or picked before — removable from the list. */
	| { kind: "saved"; name: string }
	/** An assignee bd knows about (`bd count --by-assignee`). */
	| { kind: "known"; name: string };

/** Add `name` to the front of the remembered list (most recent first), de-duplicated and capped. */
export function rememberAssignee(
	saved: readonly string[],
	name: string,
	max = MAX_SAVED_ASSIGNEES,
): string[] {
	const n = name.trim();
	if (!n || n === NO_ASSIGNEE) return [...saved];
	return [n, ...saved.filter((s) => s !== n)].slice(0, max);
}

export function forgetAssignee(saved: readonly string[], name: string): string[] {
	return saved.filter((s) => s !== name);
}

/**
 * What the assignee box suggests for `query` (case-insensitive substring):
 * the typed text itself (unless it exactly matches a suggestion), then
 * "Unassigned", then remembered names, then bd's other assignees (capped at
 * `knownLimit` — a busy harness can have dozens). bd names matching a `hidden`
 * pattern are left out; saved names never are (the user chose them).
 */
export function suggestAssignees(
	query: string,
	saved: readonly string[],
	known: readonly string[],
	knownLimit = 30,
	hidden: readonly string[] = [],
): AssigneeSuggestion[] {
	const q = query.trim().toLowerCase();
	const hit = (s: string) => s.toLowerCase().includes(q);
	const out: AssigneeSuggestion[] = [];
	if (!q || hit("unassigned") || hit(NO_ASSIGNEE)) out.push({ kind: "unassigned" });
	for (const name of saved) if (hit(name)) out.push({ kind: "saved", name });
	const savedSet = new Set(saved);
	out.push(
		...known
			.filter(
				(name) =>
					!savedSet.has(name) &&
					name !== NO_ASSIGNEE &&
					hit(name) &&
					!matchesAnyPattern(name, hidden),
			)
			.slice(0, knownLimit)
			.map((name) => ({ kind: "known" as const, name })),
	);
	const typed = query.trim();
	const exact = out.some((s) =>
		s.kind === "unassigned" ? typed === NO_ASSIGNEE : s.kind !== "typed" && s.name === typed,
	);
	if (typed && !exact) out.unshift({ kind: "typed", name: typed });
	return out;
}

/** Keep only well-formed names from saved settings. */
export function parseSavedAssignees(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const names = raw.filter((s): s is string => typeof s === "string").map((s) => s.trim());
	return [...new Set(names.filter((s) => s && s !== NO_ASSIGNEE))].slice(0, MAX_SAVED_ASSIGNEES);
}

// --- hidden assignees (settings: "Hide assignees matching") ---------------

/**
 * Does `name` match any pattern? Patterns are exact names or globs where `*`
 * matches any run of characters (e.g. `harness-*`). Case-sensitive, like bd.
 */
export function matchesAnyPattern(name: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => globToRegExp(p).test(name));
}

function globToRegExp(pattern: string): RegExp {
	const body = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${body}$`);
}

/** Add an exact name to the hidden list (the × on a bd suggestion). */
export function hideAssignee(hidden: readonly string[], name: string): string[] {
	const n = name.trim();
	if (!n || hidden.includes(n)) return [...hidden];
	return [...hidden, n];
}

/** Settings text (one pattern per line) → clean, unique pattern list. */
export function parsePatterns(raw: unknown): string[] {
	const lines = Array.isArray(raw)
		? raw.filter((s): s is string => typeof s === "string")
		: typeof raw === "string"
			? raw.split("\n")
			: [];
	return [...new Set(lines.map((s) => s.trim()).filter(Boolean))];
}
