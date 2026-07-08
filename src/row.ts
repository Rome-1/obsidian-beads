import { BeadIssue } from "./types";

const PRIORITY_LABEL: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
	4: "P4",
};

export interface RowHandlers {
	/** True while a close is in flight for this id (checkbox disabled). */
	isClosing: (issue: BeadIssue) => boolean;
	/** Tick handler — close the issue. */
	onClose: (issue: BeadIssue) => void;
	/** Row-body click — open detail. */
	onOpen: (issue: BeadIssue) => void;
	/** Show a "⛓ n" dependency-count hint (blocked group only). */
	showDeps?: boolean;
}

/**
 * The single row component used by EVERY surface — the pane and the `beads`
 * code block (guardrail: one row component everywhere). All bead-derived text
 * is set via `text:`/`setText` (inert `textContent`) — never HTML.
 */
export function renderIssueRow(
	parent: HTMLElement,
	issue: BeadIssue,
	handlers: RowHandlers,
): void {
	const isClosed = issue.status === "closed";
	const row = parent.createDiv({ cls: "beads-row" });
	if (isClosed) row.addClass("beads-row-closed");

	// Checkbox — ticking closes the issue.
	const box = row.createEl("input", {
		type: "checkbox",
		cls: "beads-check",
	}) as HTMLInputElement;
	box.checked = isClosed;
	box.disabled = isClosed || handlers.isClosing(issue);
	box.setAttr("aria-label", `Close ${issue.id}`);
	box.onclick = (ev) => {
		ev.stopPropagation();
		if (isClosed || box.disabled) return;
		box.checked = false; // revert until the close confirms via refresh
		box.disabled = true; // block a second submit until re-render
		handlers.onClose(issue);
	};

	// Priority badge.
	const pr = issue.priority ?? 2;
	row.createSpan({
		cls: `beads-badge beads-p${pr}`,
		text: PRIORITY_LABEL[pr] ?? `P${pr}`,
	});

	// Title + meta (clickable → detail).
	const main = row.createDiv({ cls: "beads-main" });
	main.createDiv({ cls: "beads-title", text: issue.title });
	const meta = main.createDiv({ cls: "beads-meta" });
	meta.createSpan({ cls: "beads-id", text: issue.id });
	if (issue.issue_type) {
		meta.createSpan({ cls: "beads-type", text: issue.issue_type });
	}
	if (isClosed) {
		meta.createSpan({ cls: "beads-status", text: "closed" });
	}
	if (handlers.showDeps && (issue.dependency_count ?? 0) > 0) {
		meta.createSpan({
			cls: "beads-deps",
			text: `⛓ ${issue.dependency_count}`,
		});
	}
	main.onclick = () => handlers.onOpen(issue);
}
