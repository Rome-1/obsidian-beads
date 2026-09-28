import { ChildProcess, spawn } from "child_process";
import { FSWatcher, watch } from "fs";
import { join } from "path";
import {
	BdError,
	BdOptions,
	bdHeadCommit,
	bdJournalEnabled,
	bdJournalHead,
	bdVersion,
	invalidateReadCache,
	parseBdVersion,
	versionAtLeast,
} from "./bd";
import { JournalRecord, parseRecord } from "./journal";

/**
 * How the plugin learns that beads changed.
 *
 * - `journal`: bd >= 1.3.0 with `events-journal: true`. A long-lived
 *   `bd events tail --follow` streams each change as a record carrying the
 *   bead's full new state, which the views apply in place. A cheap heartbeat
 *   (`bd vc status`) catches changes the journal never sees — `bd dolt pull`,
 *   `bd sql`, a clone switch — and asks for a rebuild from current state.
 * - `watch`: older bd, or the journal is off. Today's behaviour: an fs.watch on
 *   `.beads/` plus the refresh timer, each triggering a re-read.
 */
export type FeedMode = "journal" | "watch";

export interface FeedStatus {
	mode: FeedMode;
	/** bd can journal (>= 1.3.0) but the workspace has it switched off. */
	journalAvailable: boolean;
	/** One line for the pane and settings, e.g. why we are polling. */
	detail: string;
}

export interface FeedHost {
	bdOptions(): BdOptions | null;
	refreshIntervalSec(): number;
	/** Records in commit order, never repeated. */
	onRecords(records: JournalRecord[]): void;
	/** Something changed that records can't describe: re-read everything. */
	onRebuild(reason: string): void;
	onStatus(status: FeedStatus): void;
}

const JOURNAL_MIN: [number, number, number] = [1, 3, 0];
const MAX_LINE = 8 * 1024 * 1024;
const FS_DEBOUNCE_MS = 400;
// Follow polls the journal once a second; give a record that long to land
// before deciding a moved commit was unjournaled.
const RECORD_GRACE_MS = 2_500;
// Every this many heartbeats, rebuild regardless. The commit check can't tell
// a sync from local writes landing in the same interval, and a defer date
// passing changes Ready with no record at all; this bounds how long either
// can stay stale (5 minutes at the default 30 s) for two cheap reads.
const RECONCILE_EVERY = 10;

/**
 * POSIX wrapper that ties the follower's life to ours. Obsidian doesn't
 * always unload plugins on quit, and a crash never does; a bare `--follow`
 * would then poll forever, since it only notices a dead reader when it next
 * writes. This shell holds our end of a stdin pipe and kills bd when it
 * closes. It is a fixed script: bd's path and arguments arrive as positional
 * parameters ("$@") and are never interpolated into it.
 */
const FOLLOW_WATCHDOG = `exec 3<&0
"$@" </dev/null &
bd=$!
{ read _ <&3; kill "$bd" 2>/dev/null; } &
reader=$!
trap 'kill "$bd" 2>/dev/null' TERM INT HUP
wait "$bd"; code=$?
kill "$reader" 2>/dev/null
exit $code`;

export class BeadsFeed {
	private status: FeedStatus = {
		mode: "watch",
		journalAvailable: false,
		detail: "Starting…",
	};
	/** Bumped on every (re)start so stale async work can tell it lost. */
	private gen = 0;

	private watcher: FSWatcher | null = null;
	private fsDebounce: number | null = null;
	private configDebounce: number | null = null;
	private timer: number | null = null;

	private child: ChildProcess | null = null;
	private lastSeq = 0;
	private recordsSinceBeat = 0;
	private lastCommit = "";
	private beats = 0;
	private beating = false;
	private failures = 0;
	private retryTimer: number | null = null;

	constructor(private host: FeedHost) {}

	get current(): FeedStatus {
		return this.status;
	}

	/** (Re)detect bd's capabilities and start the matching mode. */
	async start(): Promise<void> {
		this.stop();
		const gen = ++this.gen;
		const opts = this.host.bdOptions();
		if (!opts) {
			this.setStatus({ mode: "watch", journalAvailable: false, detail: "No project root" });
			return;
		}
		this.startWatch(opts);

		let journalAvailable = false;
		let detail: string;
		try {
			const version = await bdVersion(opts);
			const v = parseBdVersion(version);
			if (gen !== this.gen) return;
			if (!v || !versionAtLeast(v, JOURNAL_MIN)) {
				detail = `bd ${v ? v.join(".") : "(unknown version)"} has no events journal (needs 1.3.0)`;
			} else if (await bdJournalEnabled(opts)) {
				if (gen !== this.gen) return;
				await this.startJournal(opts, gen);
				return;
			} else {
				journalAvailable = true;
				detail = "The events journal is off for this workspace";
			}
		} catch (e) {
			detail = e instanceof BdError ? e.message : String(e);
		}
		if (gen !== this.gen) return;
		this.startPolling(journalAvailable, detail);
	}

	stop(): void {
		this.gen++;
		this.stopChild();
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		for (const t of [this.fsDebounce, this.configDebounce]) {
			if (t !== null) window.clearTimeout(t);
		}
		this.fsDebounce = this.configDebounce = null;
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
	}

	private setStatus(s: FeedStatus): void {
		this.status = s;
		this.host.onStatus(s);
	}

	private startPolling(journalAvailable: boolean, detail: string): void {
		this.setStatus({ mode: "watch", journalAvailable, detail });
		this.startTimer(() => this.host.onRebuild("timer"));
	}

	private startTimer(tick: () => void): void {
		const secs = this.host.refreshIntervalSec();
		if (secs > 0) this.timer = window.setInterval(tick, secs * 1000);
	}

	// --- fs.watch --------------------------------------------------------

	/**
	 * Watch `.beads/`. In watch mode any change means "re-read"; in either
	 * mode a `config.yaml` change means the journal may have been switched,
	 * so capabilities are detected again.
	 */
	private startWatch(opts: BdOptions): void {
		try {
			this.watcher = watch(
				join(opts.cwd, ".beads"),
				{ persistent: false, recursive: false },
				(_event, file) => this.onFsEvent(String(file ?? "")),
			);
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = null;
			});
		} catch {
			// .beads may not exist yet; a settings change or restart retries.
			this.watcher = null;
		}
	}

	private onFsEvent(file: string): void {
		if (file === "config.yaml") {
			if (this.configDebounce !== null) window.clearTimeout(this.configDebounce);
			this.configDebounce = window.setTimeout(() => {
				this.configDebounce = null;
				void this.restartIfModeChanged();
			}, 500);
			return;
		}
		if (this.status.mode !== "watch") return;
		if (this.fsDebounce !== null) window.clearTimeout(this.fsDebounce);
		this.fsDebounce = window.setTimeout(() => {
			this.fsDebounce = null;
			// An external bd write changed the DB — drop cached embed reads.
			invalidateReadCache();
			this.host.onRebuild("change");
		}, FS_DEBOUNCE_MS);
	}

	private async restartIfModeChanged(): Promise<void> {
		const opts = this.host.bdOptions();
		if (!opts) return;
		const wasJournal = this.status.mode === "journal";
		let on = false;
		try {
			on = (this.status.journalAvailable || wasJournal) && (await bdJournalEnabled(opts));
		} catch {
			return;
		}
		if (on !== wasJournal) {
			await this.start();
			this.host.onRebuild("mode change");
		}
	}

	// --- journal ---------------------------------------------------------

	private async startJournal(opts: BdOptions, gen: number): Promise<void> {
		try {
			this.lastSeq = await bdJournalHead(opts);
			this.lastCommit = await bdHeadCommit(opts);
		} catch (e) {
			if (gen !== this.gen) return;
			this.startPolling(true, `Couldn't read the events journal: ${(e as Error).message}`);
			return;
		}
		if (gen !== this.gen) return;
		this.failures = 0;
		this.recordsSinceBeat = 0;
		this.spawnFollow(opts, gen);
		this.setStatus({
			mode: "journal",
			journalAvailable: true,
			detail: "Following bd events",
		});
		this.startTimer(() => void this.heartbeat(gen));
	}

	/**
	 * Journal-mode heartbeat. The commit moving with no record to explain it
	 * means an unjournaled change (a sync, `bd sql`), so rebuild. Records
	 * arrive up to a second after their commit, hence the grace wait.
	 */
	private async heartbeat(gen: number): Promise<void> {
		const opts = this.host.bdOptions();
		if (!opts || this.beating) return;
		this.beating = true;
		try {
			if (++this.beats % RECONCILE_EVERY === 0) {
				invalidateReadCache();
				this.host.onRebuild("timer"); // same as polling: embeds and editors untouched
			}
			const before = this.recordsSinceBeat;
			const commit = await bdHeadCommit(opts);
			if (gen !== this.gen || !commit || commit === this.lastCommit) return;
			if (before === 0) {
				await new Promise((r) => window.setTimeout(r, RECORD_GRACE_MS));
				if (gen !== this.gen) return;
				if (this.recordsSinceBeat === 0) {
					invalidateReadCache();
					this.host.onRebuild("unjournaled change");
				}
			}
			this.lastCommit = commit;
			this.recordsSinceBeat = 0;
		} catch {
			/* bd busy or broken: try again next beat */
		} finally {
			this.beating = false;
		}
	}

	private spawnFollow(opts: BdOptions, gen: number): void {
		// Argument array, never a command string — same rule as every bd call.
		const args = ["events", "tail", "--since", String(this.lastSeq), "--follow"];
		const child =
			process.platform === "win32"
				? spawn(opts.bdPath, args, {
						cwd: opts.cwd,
						windowsHide: true,
						stdio: ["ignore", "pipe", "pipe"],
					})
				: spawn("/bin/sh", ["-c", FOLLOW_WATCHDOG, "sh", opts.bdPath, ...args], {
						cwd: opts.cwd,
						stdio: ["pipe", "pipe", "pipe"],
					});
		this.child = child;
		const started = Date.now();
		let buf = "";
		let errTail = "";

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_LINE) {
				// A runaway line: drop it and rebuild rather than grow forever.
				buf = "";
				this.host.onRebuild("oversized record");
				return;
			}
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			const batch: JournalRecord[] = [];
			if (gen !== this.gen) return; // a stopped follower's late output
			for (const line of lines) {
				const rec = line.startsWith("{") ? parseRecord(line) : null;
				if (!rec || rec.seq <= this.lastSeq) continue;
				this.lastSeq = rec.seq;
				batch.push(rec);
			}
			if (batch.length) {
				this.recordsSinceBeat += batch.length;
				invalidateReadCache();
				this.host.onRecords(batch);
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			errTail = (errTail + chunk).slice(-4096);
		});
		child.on("error", (e) => {
			errTail = e.message;
		});
		child.on("close", () => {
			if (this.child !== child) return; // stopped on purpose
			this.child = null;
			if (gen !== this.gen) return;
			void this.onFollowExit(opts, gen, errTail, Date.now() - started);
		});
	}

	private async onFollowExit(
		opts: BdOptions,
		gen: number,
		errTail: string,
		livedMs: number,
	): Promise<void> {
		this.failures = livedMs < 10_000 ? this.failures + 1 : 1;
		if (/events journal truncated/i.test(errTail)) {
			// Our checkpoint fell out of the retained window: records are
			// missing, so rebuild from current state and follow from the head.
			// If the head can't be read, fall through to the backoff below.
			try {
				this.lastSeq = await bdJournalHead(opts);
				if (gen !== this.gen) return;
				invalidateReadCache();
				this.host.onRebuild("journal truncated");
				this.spawnFollow(opts, gen);
				return;
			} catch {
				if (gen !== this.gen) return;
			}
		}
		if (this.failures >= 5) {
			const why = errTail.trim().split("\n").pop() || "bd events tail kept exiting";
			if (this.timer !== null) window.clearInterval(this.timer);
			this.timer = null;
			this.startPolling(true, `Live updates stopped: ${why}`);
			return;
		}
		// Resume from our checkpoint after a short backoff; nothing is lost.
		const delay = Math.min(60_000, 1000 * 2 ** this.failures);
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			if (gen === this.gen) this.spawnFollow(opts, gen);
		}, delay);
	}

	private stopChild(): void {
		if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null) child.kill();
	}
}
