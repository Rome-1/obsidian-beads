import { execFile } from "child_process";
import { BeadIssue } from "./types";

/**
 * Thin wrapper around the `bd` CLI.
 *
 * SECURITY: every call uses `execFile` with an argument ARRAY — no shell is
 * spawned, so issue IDs, titles, and reasons cannot inject shell metacharacters
 * (`;`, `|`, `$()`, backticks, ...). Never switch this to `exec`/`spawn` with a
 * concatenated command string.
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
	/** Working directory — the project root containing `.beads/`. */
	cwd: string;
	timeoutMs?: number;
}

function run(args: string[], opts: BdOptions): Promise<BdResult> {
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

/** `bd show <id> --json` → the single issue (or null if not found). */
export async function bdShow(
	opts: BdOptions,
	id: string,
): Promise<BeadIssue | null> {
	const { stdout } = await run(["show", id, "--json"], opts);
	const issues = parseIssues(stdout);
	return issues[0] ?? null;
}

/** `bd close <id> -r <reason>`. */
export async function bdClose(
	opts: BdOptions,
	id: string,
	reason: string,
): Promise<void> {
	await run(["close", id, "--reason", reason], opts);
}

/** Cheap probe used to validate settings: `bd --version`. */
export async function bdVersion(opts: BdOptions): Promise<string> {
	const { stdout } = await run(["--version"], { ...opts, timeoutMs: 5_000 });
	return stdout.trim();
}
