import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateProjects, projectsError } from "../src/projects.ts";

test("migrateProjects: a legacy projectRoot becomes the active project, once", () => {
	const first = migrateProjects({ projectRoot: "/home/me/work/acme" });
	assert.deepEqual(first, {
		projects: [{ name: "acme", path: "/home/me/work/acme" }],
		activeProject: "acme",
	});
	// Re-running on its own output, with or without the old key, changes nothing.
	assert.deepEqual(migrateProjects(first), first);
	assert.deepEqual(migrateProjects({ ...first, projectRoot: "/home/me/work/acme" }), first);
});

test("migrateProjects: no root, no projects; a stale active name falls back", () => {
	assert.deepEqual(migrateProjects({ projectRoot: "" }), { projects: [], activeProject: "" });
	const two = [
		{ name: "a", path: "/a" },
		{ name: "b", path: "/b" },
	];
	assert.equal(migrateProjects({ projects: two, activeProject: "gone" }).activeProject, "a");
	assert.equal(migrateProjects({ projects: two, activeProject: "b" }).activeProject, "b");
});

test("projectsError: names must be non-empty and unique", () => {
	assert.equal(projectsError([{ name: "a", path: "" }, { name: "b", path: "" }]), null);
	assert.match(projectsError([{ name: " ", path: "/x" }]) ?? "", /needs a name/);
	assert.match(projectsError([{ name: "a", path: "/x" }, { name: "a ", path: "/y" }]) ?? "", /unique/);
});
