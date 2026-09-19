import { App, Component, Keymap, MarkdownRenderer, setIcon } from "obsidian";
import { escapeAngleBrackets } from "./mdtext";

export interface MarkdownFieldOptions {
	app: App;
	/** Owner of the render lifecycle (the editor view). */
	owner: Component;
	label: string;
	placeholder: string;
	value: string;
	/** Open straight into the textarea (e.g. a new bead, or a just-added field). */
	startEditing?: boolean;
	/**
	 * Focus the textarea when starting in edit mode (default true). The new-bead
	 * form passes false: its title takes focus, and a focused-then-blurred
	 * description would flip straight back to preview.
	 */
	focus?: boolean;
	onChange: (value: string) => void;
}

export interface MarkdownFieldHandle {
	/** Unload the preview's render component and edit-mode listeners (call before re-rendering the view). */
	dispose(): void;
}

/**
 * A bead text field (description / design / notes / acceptance criteria) that
 * reads like a note: rendered markdown by default, click it (or the pencil) to
 * edit the raw text, Escape or blur to go back to the preview. bd treats all of
 * these fields as markdown (`bd show` renders them with glamour).
 *
 * SECURITY: rendering goes through Obsidian's own `MarkdownRenderer` — the same
 * sanitized path as any note and as the comment thread — never raw innerHTML.
 */
export function renderMarkdownField(
	parent: HTMLElement,
	opts: MarkdownFieldOptions,
): MarkdownFieldHandle {
	let value = opts.value;
	let preview: Component | null = null;
	let editing = false;
	/** Removes the edit-mode pointer listeners (see showEditor). */
	let detach: (() => void) | null = null;

	const wrap = parent.createDiv({ cls: "beads-mdfield" });
	const head = wrap.createDiv({ cls: "beads-editor-section beads-mdfield-head" });
	head.createSpan({ text: opts.label });
	const toggle = head.createEl("button", { cls: "clickable-icon beads-mdfield-toggle" });
	// Keep focus in the textarea on press, so its blur doesn't flip the mode
	// before this button's click toggles it.
	toggle.addEventListener("mousedown", (e) => e.preventDefault());
	const body = wrap.createDiv({ cls: "beads-mdfield-body" });

	const dropPreview = (): void => {
		if (preview) {
			opts.owner.removeChild(preview);
			preview = null;
		}
	};

	const stopTracking = (): void => {
		detach?.();
		detach = null;
	};

	const showPreview = (): void => {
		editing = false;
		stopTracking();
		dropPreview();
		body.empty();
		setIcon(toggle, "pencil");
		toggle.setAttr("aria-label", `Edit ${opts.label.toLowerCase()}`);
		toggle.onclick = () => showEditor();

		if (!value.trim()) {
			const empty = body.createDiv({
				cls: "beads-mdfield-empty",
				text: opts.placeholder,
			});
			empty.onclick = () => showEditor();
			return;
		}
		const md = body.createDiv({ cls: "beads-md markdown-rendered" });
		md.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			const link = target.closest("a");
			if (link) {
				// Internal [[links]] open like they do in a note; external links
				// and tags keep Obsidian's default handling. Never enter edit mode.
				if (link.hasClass("internal-link")) {
					e.preventDefault();
					const href = link.getAttr("data-href") ?? link.getAttr("href") ?? "";
					void opts.app.workspace.openLinkText(href, "", Keymap.isModEvent(e));
				}
				return;
			}
			if (target.closest("button")) return; // e.g. the code-block copy button
			// Selecting text to copy shouldn't flip into the editor.
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed) return;
			showEditor();
		});
		preview = opts.owner.addChild(new Component());
		void MarkdownRenderer.render(opts.app, escapeAngleBrackets(value), md, "", preview);
	};

	const showEditor = (focus = true): void => {
		editing = true;
		stopTracking();
		dropPreview();
		body.empty();
		setIcon(toggle, "eye");
		toggle.setAttr("aria-label", "Preview");
		toggle.onclick = () => showPreview();

		const ta = body.createEl("textarea", {
			cls: "beads-editor-desc",
			attr: { placeholder: opts.placeholder, "aria-label": opts.label },
		});
		ta.value = value;
		ta.addEventListener("input", () => {
			value = ta.value;
			opts.onChange(value);
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				showPreview();
			}
		});
		// Collapse to preview on blur — but if the blur came from a mouse press
		// elsewhere, wait for the release: collapsing mid-click shrinks this field
		// and moves whatever was clicked out from under the pointer.
		const doc = ta.ownerDocument;
		let pointerDown = false;
		let pending = false;
		const collapse = () => {
			if (editing && wrap.isConnected && doc.activeElement !== ta) showPreview();
		};
		const onDown = () => {
			pointerDown = true;
		};
		const onUp = () => {
			pointerDown = false;
			if (pending) {
				pending = false;
				window.setTimeout(collapse, 0); // after the click has been delivered
			}
		};
		doc.addEventListener("pointerdown", onDown, true);
		doc.addEventListener("pointerup", onUp, true);
		doc.addEventListener("pointercancel", onUp, true);
		detach = () => {
			doc.removeEventListener("pointerdown", onDown, true);
			doc.removeEventListener("pointerup", onUp, true);
			doc.removeEventListener("pointercancel", onUp, true);
		};
		// Blur also fires when the view re-renders (save / revert) and removes the
		// textarea — only flip back while this field is still mounted and editing.
		ta.addEventListener("blur", () => {
			if (!editing || !wrap.isConnected) return;
			if (pointerDown) pending = true;
			else collapse();
		});
		if (focus) ta.focus();
	};

	if (opts.startEditing) showEditor(opts.focus !== false);
	else showPreview();

	return {
		dispose: () => {
			stopTracking();
			dropPreview();
		},
	};
}
