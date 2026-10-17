import { basename } from "path";

/** One bd workspace: a name to pick it by and the directory containing `.beads/`. */
export interface BeadsProject {
	name: string;
	path: string;
}

/** `base`, or `base 2`, `base 3`… — the first not already taken. */
export function uniqueName(base: string, taken: string[]): string {
	let name = base;
	for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`;
	return name;
}

/** A project for a directory, named after its folder. */
export function projectFor(path: string, taken: string[]): BeadsProject {
	return { name: uniqueName(basename(path) || path, taken), path };
}

/**
 * The project list and active name from saved data. Earlier versions kept a
 * single `projectRoot`; a non-empty one becomes a project (named after its
 * folder) and the active one. Idempotent: a root already in the list is not
 * added again, so re-running on migrated data changes nothing.
 */
export function migrateProjects(data: {
	projects?: unknown;
	activeProject?: unknown;
	projectRoot?: unknown;
}): { projects: BeadsProject[]; activeProject: string } {
	const projects: BeadsProject[] = [];
	if (Array.isArray(data.projects)) {
		for (const p of data.projects as unknown[]) {
			const { name, path } = (p ?? {}) as Record<string, unknown>;
			if (typeof name === "string" && typeof path === "string") {
				projects.push({ name, path });
			}
		}
	}
	let active = typeof data.activeProject === "string" ? data.activeProject : "";
	const root = typeof data.projectRoot === "string" ? data.projectRoot.trim() : "";
	if (root && !projects.some((p) => p.path === root)) {
		const p = projectFor(root, projects.map((q) => q.name));
		projects.push(p);
		if (!active) active = p.name;
	}
	return { projects, activeProject: activeName(projects, active) };
}

/** `name` if it is a project, else the first project's (or "" with none). */
export function activeName(projects: BeadsProject[], name: string): string {
	return projects.some((p) => p.name === name) ? name : (projects[0]?.name ?? "");
}

/** Why a project list can't be saved, or null if it can. */
export function projectsError(projects: BeadsProject[]): string | null {
	const seen = new Set<string>();
	for (const p of projects) {
		const name = p.name.trim();
		if (!name) return "Every project needs a name.";
		if (seen.has(name)) return `Two projects are named "${name}"; names must be unique.`;
		seen.add(name);
	}
	return null;
}
