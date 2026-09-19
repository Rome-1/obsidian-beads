import { AbstractInputSuggest, App } from "obsidian";
import { AssigneeSuggestion, NO_ASSIGNEE, suggestAssignees } from "./filter";

export interface AssigneeSource {
	/** Remembered names, most recent first. */
	saved(): string[];
	/** Assignees bd knows about. */
	known(): string[];
	/** Patterns of bd assignees not to suggest. */
	hidden(): string[];
	/** Remove a remembered name (the × on a saved name). */
	forget(name: string): void;
	/** Stop suggesting a bd assignee (the × on a bd name). */
	hide(name: string): void;
	/** Apply a choice (a name, or NO_ASSIGNEE). */
	pick(value: string): void;
}

/**
 * Suggestion popup for the pane's assignee box: what you typed, "Unassigned",
 * the names you've used (× forgets one), then bd's other assignees (× hides
 * one — it's added to Settings → "Hide assignees matching").
 */
export class AssigneeSuggest extends AbstractInputSuggest<AssigneeSuggestion> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private readonly source: AssigneeSource,
	) {
		super(app, input);
		this.limit = 60;
	}

	protected getSuggestions(query: string): AssigneeSuggestion[] {
		return suggestAssignees(query, this.source.saved(), this.source.known(), 30, this.source.hidden());
	}

	renderSuggestion(s: AssigneeSuggestion, el: HTMLElement): void {
		el.addClass("beads-assignee-suggestion");
		if (s.kind === "typed") {
			el.createSpan({ cls: "beads-assignee-special", text: `Use “${s.name}”` });
			return;
		}
		if (s.kind === "unassigned") {
			el.createSpan({ cls: "beads-assignee-special", text: "Unassigned" });
			return;
		}
		el.createSpan({ cls: "beads-assignee-name", text: s.name });
		const saved = s.kind === "saved";
		const x = el.createSpan({
			cls: "beads-assignee-forget",
			text: "×",
			attr: {
				"aria-label": saved
					? `Remove ${s.name} from your list`
					: `Hide ${s.name} from suggestions (Settings → Beads to undo)`,
			},
		});
		// Handle the × before the popup's own click/select handling sees it,
		// and keep focus in the input so the popup stays open.
		x.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		x.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (saved) this.source.forget(s.name);
			else this.source.hide(s.name);
			// Re-run the query so the list redraws without that name.
			this.input.dispatchEvent(new Event("input"));
		});
	}

	selectSuggestion(s: AssigneeSuggestion): void {
		const value = s.kind === "unassigned" ? NO_ASSIGNEE : s.name;
		this.setValue(value);
		this.close();
		this.source.pick(value);
	}
}
