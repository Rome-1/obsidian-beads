/**
 * Bead text is written for the bd CLI, whose markdown renderer shows `<...>`
 * literally. Agents lean on that: `bd close <this-id>`, `'artifact: <json path>'`.
 * Obsidian's renderer would instead parse those as HTML tags and its sanitizer
 * would silently drop them. Escape every `<` outside code so the text reads the
 * same as `bd show` — except `<https://…>` / `<mailto:…>` autolinks, which stay
 * links. Code — spans, fenced blocks, and indented blocks — is left untouched:
 * it renders literally, so an entity there would show up as `&lt;`.
 */
export function escapeAngleBrackets(text: string): string {
	let fence: string | null = null; // the opening fence while inside a block
	let inIndented = false; // inside a 4-space / tab indented code block
	let prevBlank = true; // start of text behaves like after a blank line
	let inList = false; // indented lines under a list item are continuations
	return text
		.split("\n")
		.map((line) => {
			if (fence) {
				// Only a bare run of the same char, at least as long, closes it —
				// "```js" inside a block is content.
				const close = FENCE_CLOSE.exec(line);
				if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
				return line;
			}
			const blank = line.trim() === "";
			if (blank) {
				prevBlank = true;
				return line; // blank lines don't end an indented block
			}
			// A fence opens at up to 3 spaces — or deeper inside a list item,
			// where the item's own indentation comes first.
			const open = FENCE_OPEN.exec(line);
			if (open && (open[1].length <= 3 || inList)) {
				fence = open[2];
				inIndented = false;
				prevBlank = false;
				return line;
			}
			const indented = INDENTED.test(line);
			// Indented code can't interrupt a paragraph, and inside a list it's
			// a continuation of the item rather than code.
			if (indented && !inList && (inIndented || prevBlank)) {
				inIndented = true;
				prevBlank = false;
				return line;
			}
			inIndented = false;
			if (LIST_ITEM.test(line)) inList = true;
			else if (prevBlank && !/^\s/.test(line)) inList = false;
			prevBlank = false;
			return escapeOutsideCodeSpans(line);
		})
		.join("\n");
}

const FENCE_OPEN = /^( *)(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ *(`{3,}|~{3,})\s*$/;
const INDENTED = /^(?: {4}|\t)/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

const AUTOLINK = /^<(?:https?:\/\/|mailto:)[^\s<>]*>/i;

function escapeOutsideCodeSpans(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "`") {
			// A code span closes on the next backtick run of the same length.
			let run = 1;
			while (line[i + run] === "`") run++;
			const ticks = "`".repeat(run);
			const close = findRun(line, ticks, i + run);
			if (close === -1) {
				out += ticks; // unmatched — literal backticks
				i += run;
				continue;
			}
			out += line.slice(i, close + run);
			i = close + run;
			continue;
		}
		if (ch === "<") {
			const auto = AUTOLINK.exec(line.slice(i));
			if (auto) {
				out += auto[0];
				i += auto[0].length;
				continue;
			}
			out += "&lt;";
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Index of a backtick run of exactly `ticks.length`, starting at `from`. */
function findRun(line: string, ticks: string, from: number): number {
	let idx = line.indexOf(ticks, from);
	while (idx !== -1) {
		const before = line[idx - 1] === "`";
		const after = line[idx + ticks.length] === "`";
		if (!before && !after) return idx;
		let end = idx;
		while (line[end] === "`") end++;
		idx = line.indexOf(ticks, end);
	}
	return -1;
}
