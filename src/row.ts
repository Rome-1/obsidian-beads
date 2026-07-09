import { BeadIssue } from "./types";

const PRIORITY_LABEL: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
	4: "P4",
};

export interface RowHandlers {
	/** Row click — open the bead. */
	onOpen: (issue: BeadIssue) => void;
	/** Show a "⛓ n" dependency-count hint (blocked list only). */
	showDeps?: boolean;
}

/**
 * The single row component used by the pane and the `beads` code block. All
 * bead-derived text is set via `text:` (inert `textContent`) — never HTML.
 * The whole row is clickable; there is no checkbox (close/reopen happens in the
 * bead editor via its status field).
 */
export function renderIssueRow(
	parent: HTMLElement,
	issue: BeadIssue,
	handlers: RowHandlers,
): void {
	const row = parent.createDiv({ cls: "beads-row" });
	if (issue.status === "closed") row.addClass("beads-row-closed");

	const pr = issue.priority ?? 2;
	row.createSpan({
		cls: `beads-badge beads-p${pr}`,
		text: PRIORITY_LABEL[pr] ?? `P${pr}`,
	});

	const main = row.createDiv({ cls: "beads-main" });
	main.createDiv({ cls: "beads-title", text: issue.title });
	const meta = main.createDiv({ cls: "beads-meta" });
	meta.createSpan({ cls: "beads-id", text: issue.id });
	if (issue.issue_type) {
		meta.createSpan({ cls: "beads-type", text: issue.issue_type });
	}
	if (handlers.showDeps && (issue.dependency_count ?? 0) > 0) {
		meta.createSpan({
			cls: "beads-deps",
			text: `⛓ ${issue.dependency_count}`,
		});
	}

	row.onclick = () => handlers.onOpen(issue);
}
