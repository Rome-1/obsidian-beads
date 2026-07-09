import { execFile } from "child_process";
import { BeadIssue } from "./types";

/**
 * Thin wrapper around the `bd` CLI.
 *
 * SECURITY: every call uses `execFile` with an argument ARRAY — no shell is
 * spawned, so issue IDs, titles, reasons, and query expressions cannot inject
 * shell metacharacters (`;`, `|`, `$()`, backticks, ...). Never switch this to
 * `exec`/`spawn` with a concatenated command string. Data-controlled positional
 * args are additionally placed after a `--` end-of-options sentinel so a value
 * starting with `-` can't be reinterpreted as a bd flag (CWE-88).
 *
 * RESOURCE SAFETY: a global concurrency cap bounds how many `bd` processes can
 * run at once, the code-block read path is de-duplicated, TTL-cached, and
 * serialized to one at a time, and every call has a timeout + output cap.
 */

export interface BdResult {
	stdout: string;
	stderr: string;
}

export class BdError extends Error {
	constructor(
		message: string,
		readonly stderr: string = "",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "BdError";
	}
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB — plenty for JSON of a large repo

export interface BdOptions {
	/** Path to the bd binary (or just "bd" to resolve via PATH). */
	bdPath: string;
	/** Working directory — the project root containing `.beads`. */
	cwd: string;
	timeoutMs?: number;
}

// --- Global concurrency guard --------------------------------------------
// Cap simultaneous bd processes plugin-wide. `active` counts slots in use.
const MAX_CONCURRENT = 4;
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
	if (active < MAX_CONCURRENT) {
		active++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
	const next = waiters.shift();
	if (next) next(); // hand the slot straight to the next waiter (active unchanged)
	else active--;
}

function rawExec(args: string[], opts: BdOptions): Promise<BdResult> {
	return new Promise((resolve, reject) => {
		execFile(
			opts.bdPath,
			args,
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (err) {
					const msg =
						(err as NodeJS.ErrnoException).code === "ENOENT"
							? `bd binary not found at "${opts.bdPath}". Set the path in Beads settings.`
							: `bd ${args[0] ?? ""} failed: ${err.message}`;
					reject(new BdError(msg, String(stderr), err));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

/** Run a bd command through the global concurrency cap. */
async function run(args: string[], opts: BdOptions): Promise<BdResult> {
	await acquire();
	try {
		return await rawExec(args, opts);
	} finally {
		release();
	}
}

function parseIssues(stdout: string): BeadIssue[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (e) {
		throw new BdError(`Could not parse bd JSON output: ${String(e)}`);
	}
	if (Array.isArray(parsed)) return parsed as BeadIssue[];
	if (parsed && typeof parsed === "object") return [parsed as BeadIssue];
	return [];
}

// --- Code-block read cache -----------------------------------------------
// The pane always reads fresh. ONLY the `beads` code block uses this cache
// (guardrail: "no local caches except the code-block's explicit TTL"), so many
// embedded blocks re-rendering don't hammer bd. Cleared on any mutation.
const READ_TTL_MS = 4_000;
const CODEBLOCK_LIMIT_MAX = 50;
const READ_CACHE_MAX = 64;
interface CacheEntry {
	at: number;
	issues: BeadIssue[];
}
const readCache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<BeadIssue[]>>();
// Serialize code-block reads to at most ONE at a time (design guardrail), on top
// of the global cap. Identical concurrent queries still share one process via
// `pending`; repeats within the TTL are served from `readCache`.
let readGate: Promise<unknown> = Promise.resolve();

function cacheKey(opts: BdOptions, args: string[]): string {
	return JSON.stringify([opts.bdPath, opts.cwd, args]);
}

/**
 * Clear the code-block read cache — call after any bd mutation (ours, or via
 * the `.beads` watcher an external one).
 */
export function invalidateReadCache(): void {
	readCache.clear();
	pending.clear();
}

function clampLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return CODEBLOCK_LIMIT_MAX;
	return Math.min(Math.floor(limit), CODEBLOCK_LIMIT_MAX);
}

/** De-duplicated, TTL-cached, singly-serialized read for the code block. */
async function readCached(args: string[], opts: BdOptions): Promise<BeadIssue[]> {
	const key = cacheKey(opts, args);
	const hit = readCache.get(key);
	if (hit) {
		if (Date.now() - hit.at < READ_TTL_MS) return hit.issues;
		readCache.delete(key); // evict stale so the map can't grow unbounded
	}
	const inflight = pending.get(key);
	if (inflight) return inflight;
	const p = (async () => {
		// Wait our turn behind any other code-block read (max 1 concurrent).
		const prev = readGate;
		let done!: () => void;
		readGate = new Promise<void>((r) => (done = r));
		await prev.catch(() => undefined);
		try {
			const { stdout } = await run(args, opts);
			const issues = parseIssues(stdout);
			if (readCache.size >= READ_CACHE_MAX) readCache.clear();
			readCache.set(key, { at: Date.now(), issues });
			return issues;
		} finally {
			pending.delete(key);
			done();
		}
	})();
	pending.set(key, p);
	return p;
}

// --- Pane reads (always fresh) -------------------------------------------

/**
 * `bd ready --json` — unblocked, actionable work (deps satisfied). This is the
 * "what can I do right now" set; bd computes it, we only display it.
 */
export async function bdReady(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	const { stdout } = await run(
		["ready", "--json", "--limit", String(limit)],
		opts,
	);
	return parseIssues(stdout);
}

/**
 * `bd blocked --json` — issues waiting on unsatisfied dependencies. NOTE:
 * dependency-blocked issues keep `status=open`, so they can only be found via
 * this command — never by subtracting `ready` from `list`.
 */
export async function bdBlocked(opts: BdOptions): Promise<BeadIssue[]> {
	const { stdout } = await run(["blocked", "--json"], opts);
	return parseIssues(stdout);
}

/** `bd list --status <status> --json` — issues in one stored status. */
export async function bdByStatus(
	opts: BdOptions,
	status: string,
	limit: number,
): Promise<BeadIssue[]> {
	const { stdout } = await run(
		["list", "--status", status, "--json", "--no-pager", "--limit", String(limit)],
		opts,
	);
	return parseIssues(stdout);
}

/** `bd show --json -- <id>` → the single issue (or null if not found). */
export async function bdShow(
	opts: BdOptions,
	id: string,
): Promise<BeadIssue | null> {
	const { stdout } = await run(["show", "--json", "--", id], opts);
	const issues = parseIssues(stdout);
	return issues[0] ?? null;
}

/**
 * `bd dep list --json [--direction=up] -- <id>` — the issues on one side of an
 * issue's dependency edges. `down` (default) = what this issue depends on (its
 * blockers); `up` = what depends on this issue (its dependents). bd returns
 * full issue records here, so no extra title lookup is needed.
 */
export async function bdDepList(
	opts: BdOptions,
	id: string,
	direction: "down" | "up",
): Promise<BeadIssue[]> {
	const args = ["dep", "list", "--json"];
	if (direction === "up") args.push("--direction=up");
	args.push("--", id);
	const { stdout } = await run(args, opts);
	return parseIssues(stdout);
}

// --- Code-block reads (cached, clamped, serialized) ----------------------

export async function bdReadyCached(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	return readCached(["ready", "--json", "--limit", String(clampLimit(limit))], opts);
}

export async function bdListCached(
	opts: BdOptions,
	limit: number,
): Promise<BeadIssue[]> {
	return readCached(
		["list", "--json", "--no-pager", "--limit", String(clampLimit(limit))],
		opts,
	);
}

export async function bdBlockedCached(opts: BdOptions): Promise<BeadIssue[]> {
	return readCached(["blocked", "--json"], opts);
}

export async function bdQueryCached(
	opts: BdOptions,
	expr: string,
	limit: number,
): Promise<BeadIssue[]> {
	// The whole expression is ONE argv element after `--` — bd parses its own
	// query language; no shell, no flag confusion, no injection.
	return readCached(
		["query", "--json", "--limit", String(clampLimit(limit)), "--", expr],
		opts,
	);
}

// --- Mutations (clear the code-block cache) ------------------------------

/** `bd close --reason <reason> -- <id>`. */
export async function bdClose(
	opts: BdOptions,
	id: string,
	reason: string,
): Promise<void> {
	await run(["close", "--reason", reason, "--", id], opts);
	invalidateReadCache();
}

export interface BdCreateFields {
	title: string;
	type: string;
	priority: number;
	description?: string;
}

/**
 * `bd create --title=<t> -t <type> -p <n> [--description=<d>] --json` → new id.
 * Free-text fields use the `--flag=value` form so a value starting with `-`
 * is taken verbatim and never parsed as a flag.
 */
export async function bdCreate(
	opts: BdOptions,
	f: BdCreateFields,
): Promise<string> {
	const args = [
		"create",
		`--title=${f.title}`,
		`--type=${f.type}`,
		`--priority=${f.priority}`,
	];
	if (f.description) args.push(`--description=${f.description}`);
	args.push("--json");
	const { stdout } = await run(args, opts);
	invalidateReadCache();
	const id = parseIssues(stdout)[0]?.id;
	if (!id) throw new BdError("bd create did not return an issue id.");
	return id;
}

export interface BdUpdateFields {
	title?: string;
	description?: string;
	priority?: number;
	type?: string;
	status?: string;
}

/** `bd update <flags> -- <id>` — change any subset of an issue's fields. */
export async function bdUpdate(
	opts: BdOptions,
	id: string,
	f: BdUpdateFields,
): Promise<void> {
	const args = ["update"];
	if (f.title !== undefined) args.push(`--title=${f.title}`);
	if (f.description !== undefined) args.push(`--description=${f.description}`);
	if (f.priority !== undefined) args.push(`--priority=${f.priority}`);
	if (f.type !== undefined) args.push(`--type=${f.type}`);
	if (f.status !== undefined) args.push(`--status=${f.status}`);
	args.push("--", id);
	await run(args, opts);
	invalidateReadCache();
}

export interface BdComment {
	id?: string;
	issue_id?: string;
	author?: string;
	text?: string;
	created_at?: string;
}

/**
 * `bd comments --json -- <id>` — the comment thread on an issue, oldest first.
 * Read-only: the editor renders each comment's text as markdown.
 */
export async function bdComments(
	opts: BdOptions,
	id: string,
): Promise<BdComment[]> {
	const { stdout } = await run(["comments", "--json", "--", id], opts);
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? (parsed as BdComment[]) : [];
	} catch (e) {
		throw new BdError(`Could not parse bd comments JSON: ${String(e)}`);
	}
}

/** Cheap probe used to validate settings: `bd --version`. */
export async function bdVersion(opts: BdOptions): Promise<string> {
	const { stdout } = await run(["--version"], { ...opts, timeoutMs: 5_000 });
	return stdout.trim();
}

/**
 * The `summary` block of `bd status --json` — per-status counts in one cheap
 * call (keys like `ready_issues`, `blocked_issues`, `closed_issues`, ...).
 */
export async function bdStatusCounts(
	opts: BdOptions,
): Promise<Record<string, number>> {
	const { stdout } = await run(["status", "--json"], opts);
	try {
		const d = JSON.parse(stdout.trim()) as {
			summary?: Record<string, number>;
		};
		return d?.summary ?? {};
	} catch {
		return {};
	}
}

/** Ready-issue count (for the status bar). */
export async function bdReadyCount(opts: BdOptions): Promise<number> {
	const counts = await bdStatusCounts(opts);
	return counts.ready_issues ?? 0;
}
