import { App, Component, MarkdownRenderer } from "obsidian";

/**
 * Render markdown that anyone could have written (bead text arrives from
 * teammates, agents and `bd dolt pull`) without letting it act on the vault.
 *
 * - Every `<` is escaped before rendering, so no raw HTML reaches the parser:
 *   no iframes, no `<img>` beacons, no markup. Deciding where HTML is "really"
 *   code is the parser's job, and a second, hand-written guess at it can be
 *   steered, so this does not try. Inside code, where markdown shows entities
 *   literally, the escape is turned back into `<` after rendering.
 * - The language word on any line that opens with ``` or ~~~ is dropped, so a
 *   fence can't hand its body to another plugin's code-block processor (a
 *   `dataviewjs` block would otherwise run as JavaScript). This errs wide: a
 *   paragraph that merely starts with backticks just loses that word.
 * - Links whose scheme isn't http(s) or mailto (`obsidian://`, `file://`, ...)
 *   are reduced to their text. Internal [[links]] carry no scheme and stay.
 *
 * Markdown images (`![](https://...)`) still load, as they do in any note.
 */
export async function renderUntrustedMarkdown(
	app: App,
	text: string,
	el: HTMLElement,
	owner: Component,
): Promise<void> {
	await MarkdownRenderer.render(app, prepare(text), el, "", owner);
	for (const code of Array.from(el.querySelectorAll("code"))) {
		restoreLt(code);
	}
	for (const a of Array.from(el.querySelectorAll("a[href]"))) {
		const href = a.getAttribute("href") ?? "";
		const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
		if (scheme && !["http", "https", "mailto"].includes(scheme)) {
			a.replaceWith(a.textContent ?? "");
		}
	}
}

export function prepare(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^(\s*(?:`{3,}|~{3,}))\s*[^\s`~]*/, "$1"))
		.join("\n")
		.replace(/</g, "&lt;");
}

function restoreLt(node: Node): void {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			child.textContent = (child.textContent ?? "").replace(/&lt;/g, "<");
		} else {
			restoreLt(child);
		}
	}
}
