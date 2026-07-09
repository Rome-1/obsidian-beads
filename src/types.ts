export const VIEW_TYPE_BEADS = "beads-pane";
export const VIEW_TYPE_BEADS_EDITOR = "beads-editor";

/** Common issue types offered in the capture / edit dropdowns. */
export const ISSUE_TYPES = [
	"task",
	"bug",
	"feature",
	"chore",
	"epic",
	"decision",
] as const;

/** Priorities 0 (highest) – 4, with display labels. */
export const PRIORITIES: { value: number; label: string }[] = [
	{ value: 0, label: "P0 — critical" },
	{ value: 1, label: "P1 — high" },
	{ value: 2, label: "P2 — medium" },
	{ value: 3, label: "P3 — low" },
	{ value: 4, label: "P4 — backlog" },
];

/** Statuses a user can set by hand (blocked is dependency-derived). */
export const EDITABLE_STATUSES = [
	"open",
	"in_progress",
	"deferred",
	"closed",
] as const;

/**
 * Shape of a single issue as emitted by `bd list --json` / `bd show --json`.
 * Only the fields we render are typed; bd may emit more (we tolerate extras).
 */
export interface BeadIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type: string;
	owner?: string;
	assignee?: string;
	description?: string;
	created_at?: string;
	updated_at?: string;
	created_by?: string;
	dependency_count?: number;
	dependent_count?: number;
	comment_count?: number;
	labels?: string[];
	/** Present only on records returned by `bd dep list`. */
	dependency_type?: string;
}
