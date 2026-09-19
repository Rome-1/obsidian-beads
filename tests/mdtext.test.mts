import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeAngleBrackets } from "../src/mdtext.ts";

test("escapes CLI-style placeholders so they aren't eaten as HTML", () => {
	assert.equal(
		escapeAngleBrackets("bd update <this-id> --append-notes 'artifact: <json path>'"),
		"bd update &lt;this-id> --append-notes 'artifact: &lt;json path>'",
	);
});

test("escapes real-looking HTML tags too (bead text is never HTML)", () => {
	assert.equal(escapeAngleBrackets("<b>hi</b>"), "&lt;b>hi&lt;/b>");
});

test("keeps http(s) and mailto autolinks", () => {
	const text = "see <https://example.com/a?b=1> or <mailto:x@y.z>";
	assert.equal(escapeAngleBrackets(text), text);
});

test("leaves inline code spans untouched", () => {
	assert.equal(
		escapeAngleBrackets("run `bd close <id>` then <done>"),
		"run `bd close <id>` then &lt;done>",
	);
});

test("handles double-backtick spans and unmatched backticks", () => {
	assert.equal(escapeAngleBrackets("``a ` <b>`` <c>"), "``a ` <b>`` &lt;c>");
	assert.equal(escapeAngleBrackets("stray ` <x>"), "stray ` &lt;x>");
});

test("leaves fenced code blocks untouched, resumes escaping after", () => {
	const input = ["<a>", "```sh", "bd show <id>", "```", "<b>"].join("\n");
	const want = ["&lt;a>", "```sh", "bd show <id>", "```", "&lt;b>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
});

test("tilde fences need a matching closer", () => {
	const input = ["~~~~", "<x>", "```", "<y>", "~~~~", "<z>"].join("\n");
	const want = ["~~~~", "<x>", "```", "<y>", "~~~~", "&lt;z>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
});

test("comparison operators and blockquotes are unaffected in meaning", () => {
	assert.equal(escapeAngleBrackets("priority<=1"), "priority&lt;=1");
	assert.equal(escapeAngleBrackets("> quoted"), "> quoted");
});

test("plain text passes through unchanged", () => {
	const text = "stage: compare\ntc: TC-LIFE-05\n\nSCENARIO: x";
	assert.equal(escapeAngleBrackets(text), text);
});

test("leaves indented code blocks untouched (entities would show literally)", () => {
	const input = ["para", "", "    bd close <id>", "", "    bd show <id>", "after <x>"].join("\n");
	const want = ["para", "", "    bd close <id>", "", "    bd show <id>", "after &lt;x>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
});

test("an indented line right after a paragraph is a continuation, not code", () => {
	assert.equal(escapeAngleBrackets("para\n    more <x>"), "para\n    more &lt;x>");
});

test("indented lines under a list item are continuations, not code", () => {
	const input = ["- item", "", "    continued <x>"].join("\n");
	const want = ["- item", "", "    continued &lt;x>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
	assert.equal(escapeAngleBrackets("1. step\n\n\tsee <id>"), "1. step\n\n\tsee &lt;id>");
});

test("a list ends at an unindented paragraph after a blank line", () => {
	const input = ["- item", "", "para", "", "    code <x>"].join("\n");
	const want = ["- item", "", "para", "", "    code <x>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
});

test("indented code at the very start of the text", () => {
	assert.equal(escapeAngleBrackets("    <raw>\nline <y>"), "    <raw>\nline &lt;y>");
});

test("a code span only closes on a backtick run of the same length", () => {
	// The ``` run inside can't close a `` span; the later `` does.
	assert.equal(escapeAngleBrackets("``a ``` <b> `` <c>"), "``a ``` <b> `` &lt;c>");
});

test("a fence indented 4+ spaces inside a nested list item is code (review #3)", () => {
	const input = ["- step", "    - sub", "      ```", "      bd close <id>", "      ```", "after <x>"].join("\n");
	const want = ["- step", "    - sub", "      ```", "      bd close <id>", "      ```", "after &lt;x>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
});

test("a fence line with an info string does not close an open block (review #4)", () => {
	const input = ["````", "```js", "c <d>", "```", "````", "e <f>"].join("\n");
	const want = ["````", "```js", "c <d>", "```", "````", "e &lt;f>"].join("\n");
	assert.equal(escapeAngleBrackets(input), want);
	// Same with a same-length fence: ```js inside ``` is content, the bare ``` closes.
	const same = ["```", "```js", "c <d>", "```", "e <f>"].join("\n");
	assert.equal(escapeAngleBrackets(same), ["```", "```js", "c <d>", "```", "e &lt;f>"].join("\n"));
});

test("a 4-space-indented fence outside a list is indented code, not a fence", () => {
	// CommonMark: 4+ spaces outside a list is an indented code block; its lines stay literal.
	const input = ["para", "", "    ```", "    <x>", "", "after <y>"].join("\n");
	assert.equal(escapeAngleBrackets(input), ["para", "", "    ```", "    <x>", "", "after &lt;y>"].join("\n"));
});
