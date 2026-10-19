/**
 * The few Node APIs this plugin uses, typed here instead of through
 * @types/node. Obsidian's plugin review type-checks the source without
 * @types/node installed, so every Node call would read as `any` there (and
 * did, in the 0.1.0 and 0.1.1 reviews). With these declarations the project
 * has no @types/node at all, so `npm run lint` checks exactly what the review
 * checks. Add a declaration here when the code needs another Node API.
 */

declare namespace NodeJS {
	interface ProcessEnv {
		[key: string]: string | undefined;
	}
	interface ErrnoException extends Error {
		code?: string;
	}
}

declare const process: {
	readonly platform: string;
	readonly env: NodeJS.ProcessEnv;
};

declare module "child_process" {
	interface ExecFileOptions {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeout?: number;
		maxBuffer?: number;
		windowsHide?: boolean;
		signal?: AbortSignal;
	}
	function execFile(
		file: string,
		args: readonly string[],
		options: ExecFileOptions,
		callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
	): ChildProcess;

	interface SpawnOptions {
		cwd?: string;
		windowsHide?: boolean;
		stdio?: Array<"pipe" | "ignore" | "inherit">;
	}
	function spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;

	interface Readable {
		setEncoding(encoding: "utf8"): this;
		on(event: "data", listener: (chunk: string) => void): this;
	}
	interface ChildProcess {
		readonly stdout: Readable | null;
		readonly stderr: Readable | null;
		readonly exitCode: number | null;
		kill(signal?: string): boolean;
		on(event: "error", listener: (err: Error) => void): this;
		on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
	}
}

declare module "fs" {
	function existsSync(path: string): boolean;
	interface FSWatcher {
		close(): void;
		on(event: "error", listener: (err: Error) => void): this;
	}
	function watch(
		filename: string,
		options: { persistent?: boolean; recursive?: boolean },
		listener: (event: string, filename: string | null) => void,
	): FSWatcher;
}

declare module "path" {
	function join(...paths: string[]): string;
	function basename(path: string): string;
}
