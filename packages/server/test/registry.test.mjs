import assert from "node:assert/strict";
import { test } from "node:test";

import { createProjectRegistry, RegistryError } from "../dist/main.js";

function makeProject(root, projectId, title) {
  const marker = {
    projectId,
    title,
    created: "2026-06-07T00:00:00Z"
  };

  return {
    projectId,
    root,
    marker,
    index: {
      byId: new Map(),
      childrenOf: new Map()
    },
    eff: new Map()
  };
}

test("listProjects returns deterministic public project summaries", () => {
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [
      makeProject("C:/repos/b", "wt_002", "Second"),
      makeProject("C:/repos/a", "wt_001", "First")
    ]
  });

  assert.deepEqual(registry.listProjects(), [
    {
      projectId: "wt_001",
      title: "First",
      root: "C:/repos/a"
    },
    {
      projectId: "wt_002",
      title: "Second",
      root: "C:/repos/b"
    }
  ]);
});

test("resolveProject returns an explicit project from a multi-project registry", () => {
  const first = makeProject("C:/repos/a", "wt_001", "First");
  const second = makeProject("C:/repos/b", "wt_002", "Second");
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [first, second]
  });

  assert.equal(registry.resolveProject("wt_002"), second);
});

test("resolveProject returns the only project when project id is omitted", () => {
  const project = makeProject("C:/repos/a", "wt_001", "First");
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [project]
  });

  assert.equal(registry.resolveProject(), project);
});

test("resolveProject raises AMBIGUOUS_PROJECT when id is omitted with multiple projects", () => {
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [
      makeProject("C:/repos/a", "wt_001", "First"),
      makeProject("C:/repos/b", "wt_002", "Second")
    ]
  });

  assert.throws(
    () => registry.resolveProject(),
    (error) => error instanceof RegistryError && error.code === "AMBIGUOUS_PROJECT"
  );
});

test("resolveProject raises PROJECT_NOT_FOUND for an unknown supplied id", () => {
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [makeProject("C:/repos/a", "wt_001", "First")]
  });

  assert.throws(
    () => registry.resolveProject("wt_missing"),
    (error) =>
      error instanceof RegistryError &&
      error.code === "PROJECT_NOT_FOUND" &&
      error.projectId === "wt_missing"
  );
});

test("resolveProject raises PROJECT_NOT_FOUND when no projects are registered", () => {
  const registry = createProjectRegistry({
    watchRoots: []
  });

  assert.throws(
    () => registry.resolveProject(),
    (error) => error instanceof RegistryError && error.code === "PROJECT_NOT_FOUND"
  );
});
