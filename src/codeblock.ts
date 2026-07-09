import type BeadsPlugin from "./main";
import { BeadIssue } from "./types";
import {
	bdReadyCached,
	bdBlockedCached,
	bdListCached,
	bdQueryCached,
	BdError,
	BdOptions,
} from "./bd";
import { renderIssueRow } from "./row";

type Source = "ready" | "blocked" | "list" | "query";

interface BlockConfig {
	source: Source;
	query?: string;
	limit: number;
}

const DEFAULT_LIMIT = 30;

/**
 * Parse a `beads` code block. Whitelisted, tiny grammar (one directive per
 * line): a bare `ready` / `blocked` / `list`, or `query: <expr>`, plus an
 * optional `limit: <n>`. Anything else is an explicit error, not a guess.
 */
export function parseBlockConfig(
	src: string,
): { config: BlockConfig } | { error: string } {
	let source: Source | null = null;
	let query: string | undefined;
	let limit = DEFAULT_LIMIT;

	for (const raw of src.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const colon = line.indexOf(":");
		if (colon === -1) {
			const kw = line.toLowerCase();
			if (kw === "ready" || kw === "blocked" || kw === "list") {
				source = kw;
			} else {
				return {
					error: `Unknown directive "${line}". Use ready, blocked, list, query:, or limit:.`,
				};
			}
			continue;
		}

		const key = line.slice(0, colon).trim().toLowerCase();
		const val = line.slice(colon + 1).trim();
		if (key === "query") {
			source = "query";
			query = val;
		} else if (key === "limit") {
			const n = Number.parseInt(val, 10);
			if (Number.isFinite(n) && n > 0) limit = n;
		} else if (key === "source") {
			if (val === "ready" || val === "blocked" || val === "list") {
				source = val;
			} else {
				return { error: `Unknown source "${val}". Use ready, blocked, or list.` };
			}
		} else {
			return {
				error: `Unknown key "${key}". Allowed: query, limit (or a bare ready / blocked / list).`,
			};
		}
	}

	if (!source) {
		return {
			error: "Empty beads block. Add `ready`, `blocked`, `list`, or `query: <expr>`.",
		};
	}
	if (source === "query" && !query) {
		return {
			error: "query: needs an expression, e.g. `query: status=open AND priority<=1`.",
		};
	}
	return { config: { source, query, limit } };
}

function fetchForConfig(
	cfg: BlockConfig,
	opts: BdOptions,
): Promise<BeadIssue[]> {
	switch (cfg.source) {
		case "ready":
			return bdReadyCached(opts, cfg.limit);
		case "blocked":
			return bdBlockedCached(opts);
		case "list":
			return bdListCached(opts, cfg.limit);
		case "query":
			return bdQueryCached(opts, cfg.query as string, cfg.limit);
	}
}

/**
 * Register the `beads` markdown code-block processor — a live, clickable query
 * embedded inside a note (Dataview-style), rendering the same row component as
 * the pane.
 *
 * Process-storm defenses (many blocks × re-renders): reads go through the
 * shared concurrency cap + TTL cache in bd.ts, limits are clamped there, and a
 * block only re-fetches on note re-render or after a close it initiated — never
 * on a timer.
 */
export function registerBeadsCodeBlock(plugin: BeadsPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("beads", async (src, el) => {
		el.addClass("beads-embed");
		const parsed = parseBlockConfig(src);
		if ("error" in parsed) {
			el.createDiv({ cls: "beads-embed-error", text: parsed.error });
			return;
		}
		const cfg = parsed.config;

		const s = plugin.settings;
		if (!s.projectRoot) {
			el.createDiv({
				cls: "beads-embed-error",
				text: "Beads: no project root set (Settings → Beads).",
			});
			return;
		}
		const opts: BdOptions = { bdPath: s.bdPath, cwd: s.projectRoot };
		const list = el.createDiv({ cls: "beads-embed-list" });

		const render = async (): Promise<void> => {
			try {
				const issues = await fetchForConfig(cfg, opts);
				list.empty();
				if (issues.length === 0) {
					list.createDiv({ cls: "beads-empty", text: "No matching issues." });
					return;
				}
				for (const issue of issues) {
					renderIssueRow(list, issue, {
						onOpen: (i) => void plugin.openBead(i.id),
						showDeps: cfg.source === "blocked",
					});
				}
			} catch (e) {
				list.empty();
				list.createDiv({
					cls: "beads-embed-error",
					text: e instanceof BdError ? e.message : String(e),
				});
			}
		};

		await render();
	});
}
