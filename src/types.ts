export const VIEW_TYPE_BEADS = "beads-pane";

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
}
