import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { bootstrapProjectRegistry, createProjectRegistry, RegistryError } from "../dist/main.js";

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

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function writeMarkedProject(root, projectId, title) {
  const markerPath = path.join(root, ".worktracker", "project.json");

  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });
  await fs.writeFile(
    markerPath,
    `{\n  "projectId": "${projectId}",\n  "title": "${title}",\n  "created": "2026-06-07T00:00:00Z"\n}\n`,
    "utf8"
  );
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
      root: path.resolve("C:/repos/a")
    },
    {
      projectId: "wt_002",
      title: "Second",
      root: path.resolve("C:/repos/b")
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

  assert.deepEqual(registry.resolveProject("wt_002"), { ...second, root: path.resolve(second.root) });
});

test("resolveProject returns the only project when project id is omitted", () => {
  const project = makeProject("C:/repos/a", "wt_001", "First");
  const registry = createProjectRegistry({
    watchRoots: [],
    initialProjects: [project]
  });

  assert.deepEqual(registry.resolveProject(), { ...project, root: path.resolve(project.root) });
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

test("init creates a marker, seeds requirements once, scans, and registers synchronously", async () => {
  const root = await makeTempRoot("file-kanban-registry-init-");
  const registry = createProjectRegistry({
    watchRoots: [root],
    createProjectId: () => "wt_test_init",
    now: () => new Date("2026-06-07T12:00:00Z")
  });

  assert.deepEqual(await registry.init({ root, title: "Init Project", intent: "Initial requirements" }), {
    projectId: "wt_test_init"
  });

  assert.equal(
    await readText(path.join(root, ".worktracker", "project.json")),
    '{\n  "projectId": "wt_test_init",\n  "title": "Init Project",\n  "created": "2026-06-07T12:00:00Z"\n}\n'
  );
  assert.equal(await readText(path.join(root, ".worktracker", "requirements", "source.md")), "Initial requirements\n");
  assert.equal(await pathExists(path.join(root, ".worktracker", "entities")), true);

  const state = registry.resolveProject("wt_test_init");
  assert.equal(state.root, path.resolve(root));
  assert.equal(state.marker.title, "Init Project");
  assert.equal(state.index.byId.size, 0);
  assert.equal(state.eff.size, 0);
});

test("init on an already marked root returns the existing id and does not reseed requirements", async () => {
  const root = await makeTempRoot("file-kanban-registry-init-existing-");
  const markerPath = path.join(root, ".worktracker", "project.json");
  const requirementsPath = path.join(root, ".worktracker", "requirements", "source.md");

  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.mkdir(path.dirname(requirementsPath), { recursive: true });
  await fs.writeFile(
    markerPath,
    '{\n  "projectId": "wt_existing",\n  "title": "Existing Project",\n  "created": "2026-06-07T11:00:00Z"\n}\n',
    "utf8"
  );
  await fs.writeFile(requirementsPath, "Human-authored requirements", "utf8");

  const registry = createProjectRegistry({
    watchRoots: [root],
    createProjectId: () => "wt_should_not_be_used",
    now: () => new Date("2026-06-07T12:00:00Z")
  });

  assert.deepEqual(await registry.init({ root, title: "Ignored Title", intent: "Ignored requirements" }), {
    projectId: "wt_existing"
  });

  assert.equal(
    await readText(markerPath),
    '{\n  "projectId": "wt_existing",\n  "title": "Existing Project",\n  "created": "2026-06-07T11:00:00Z"\n}\n'
  );
  assert.equal(await readText(requirementsPath), "Human-authored requirements");
  assert.equal(registry.resolveProject("wt_existing").marker.title, "Existing Project");
});

test("init rejects roots outside configured watch roots before mutating files or registry state", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-watch-root-");
  const outsideRoot = await makeTempRoot("file-kanban-registry-outside-init-");
  const registry = createProjectRegistry({
    watchRoots: [watchRoot],
    createProjectId: () => "wt_should_not_write",
    now: () => new Date("2026-06-07T12:00:00Z")
  });

  await assert.rejects(
    () => registry.init({ root: outsideRoot, title: "Outside Project", intent: "Should not be seeded" }),
    (error) =>
      error instanceof RegistryError &&
      error.code === "INVALID_ROOT" &&
      error.message ===
        `Init root '${path.resolve(outsideRoot)}' must be inside one configured watch root. Configured watch roots: ${path.resolve(watchRoot)}.`
  );

  assert.equal(await pathExists(path.join(outsideRoot, ".worktracker", "project.json")), false);
  assert.equal(await pathExists(path.join(outsideRoot, ".worktracker", "requirements", "source.md")), false);
  assert.throws(
    () => registry.resolveProject("wt_should_not_write"),
    (error) =>
      error instanceof RegistryError &&
      error.code === "PROJECT_NOT_FOUND" &&
      error.projectId === "wt_should_not_write"
  );
});

test("init accepts watch root descendants after normalizing relative segments and trailing separators", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-normalized-watch-");
  const projectRoot = path.join(watchRoot, "nested", "repo");
  const equivalentProjectRoot = path.join(projectRoot, "..", "repo", path.sep);
  const registry = createProjectRegistry({
    watchRoots: [path.join(watchRoot, ".")],
    createProjectId: () => "wt_normalized_init",
    now: () => new Date("2026-06-07T12:00:00Z")
  });

  await fs.mkdir(projectRoot, { recursive: true });

  assert.deepEqual(await registry.init({ root: equivalentProjectRoot, title: "Normalized Init" }), {
    projectId: "wt_normalized_init"
  });

  assert.equal(await pathExists(path.join(projectRoot, ".worktracker", "project.json")), true);
  assert.equal(registry.resolveProject("wt_normalized_init").root, path.resolve(projectRoot));
});

test("discover registers pre-marked projects from watch roots without init", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-discover-");
  const firstRoot = path.join(watchRoot, "repo-a");
  const secondRoot = path.join(watchRoot, "repo-b");

  await writeMarkedProject(firstRoot, "wt_discovered_a", "Discovered A");
  await writeMarkedProject(secondRoot, "wt_discovered_b", "Discovered B");

  const registry = createProjectRegistry({
    watchRoots: [watchRoot]
  });

  const states = await registry.discover();

  assert.deepEqual(
    states.map((state) => state.projectId),
    ["wt_discovered_a", "wt_discovered_b"]
  );
  assert.deepEqual(registry.listProjects(), [
    {
      projectId: "wt_discovered_a",
      title: "Discovered A",
      root: path.resolve(firstRoot)
    },
    {
      projectId: "wt_discovered_b",
      title: "Discovered B",
      root: path.resolve(secondRoot)
    }
  ]);
  assert.equal(registry.resolveProject("wt_discovered_a").index.byId.size, 0);
});

test("discover skips malformed markers and reports them instead of failing startup", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-malformed-");
  const validRoot = path.join(watchRoot, "repo-valid");
  const malformedRoot = path.join(watchRoot, "repo-malformed");

  await writeMarkedProject(validRoot, "wt_valid", "Valid");
  await fs.mkdir(path.join(malformedRoot, ".worktracker"), { recursive: true });
  await fs.writeFile(path.join(malformedRoot, ".worktracker", "project.json"), '{ "id": "stale" }\n', "utf8");

  const reported = [];
  const registry = await bootstrapProjectRegistry({
    watchRoots: [watchRoot],
    onInvalidMarker: (issue) => reported.push(issue)
  });

  assert.deepEqual(
    registry.listProjects().map((project) => project.projectId),
    ["wt_valid"]
  );
  assert.deepEqual(
    reported.map((issue) => issue.root),
    [malformedRoot]
  );
});

test("discover skips a project with unparseable entity files and still loads the others", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-bad-entity-");
  const validRoot = path.join(watchRoot, "repo-valid");
  const brokenRoot = path.join(watchRoot, "repo-broken");

  await writeMarkedProject(validRoot, "wt_valid", "Valid");
  await writeMarkedProject(brokenRoot, "wt_broken", "Broken");
  await fs.mkdir(path.join(brokenRoot, ".worktracker", "entities"), { recursive: true });
  await fs.writeFile(
    path.join(brokenRoot, ".worktracker", "entities", "T-001-broken.md"),
    "---\nid: [unclosed\n---\n",
    "utf8"
  );

  const reported = [];
  const registry = await bootstrapProjectRegistry({
    watchRoots: [watchRoot],
    onProjectLoadError: (issue) => reported.push(issue)
  });

  assert.deepEqual(
    registry.listProjects().map((project) => project.projectId),
    ["wt_valid"]
  );
  assert.equal(reported.length, 1);
  assert.equal(reported[0].projectId, "wt_broken");
  assert.equal(reported[0].outcome, "skipped");
  assert.match(reported[0].message, /T-001-broken\.md: Frontmatter is not valid YAML/);
});

test("bootstrapProjectRegistry discovers pre-marked projects during server startup", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-bootstrap-");
  const projectRoot = path.join(watchRoot, "repo");

  await writeMarkedProject(projectRoot, "wt_boot_discovered", "Boot Discovered");

  const registry = await bootstrapProjectRegistry({
    watchRoots: [watchRoot]
  });

  assert.deepEqual(registry.listProjects(), [
    {
      projectId: "wt_boot_discovered",
      title: "Boot Discovered",
      root: path.resolve(projectRoot)
    }
  ]);
  assert.equal(registry.resolveProject("wt_boot_discovered").root, path.resolve(projectRoot));
});

test("registerDiscovered is idempotent and refreshes cached state for the same root", async () => {
  const root = await makeTempRoot("file-kanban-registry-register-discovered-");
  const marker = {
    projectId: "wt_discovered_refresh",
    title: "Discovered Refresh",
    created: "2026-06-07T00:00:00Z"
  };
  const builtStates = [
    makeProject(root, marker.projectId, marker.title),
    {
      ...makeProject(root, marker.projectId, "Updated Title"),
      marker: { ...marker, title: "Updated Title" }
    }
  ];
  const registry = createProjectRegistry({
    watchRoots: [],
    buildProjectState: async () => builtStates.shift()
  });

  await registry.registerDiscovered(root, marker);
  await registry.registerDiscovered(root, { ...marker, title: "Updated Title" });

  assert.deepEqual(registry.listProjects(), [
    {
      projectId: "wt_discovered_refresh",
      title: "Updated Title",
      root: path.resolve(root)
    }
  ]);
});

test("a fresh registry rebuilds identical project summaries from discovered markers", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-rebuild-");
  const projectRoot = path.join(watchRoot, "repo");

  await writeMarkedProject(projectRoot, "wt_rebuild", "Rebuildable Project");

  const firstRegistry = createProjectRegistry({
    watchRoots: [watchRoot]
  });
  const secondRegistry = createProjectRegistry({
    watchRoots: [watchRoot]
  });

  await firstRegistry.discover();
  await secondRegistry.discover();

  assert.deepEqual(secondRegistry.listProjects(), firstRegistry.listProjects());
});

test("init-created projects rebuild identically from their portable marker", async () => {
  const watchRoot = await makeTempRoot("file-kanban-registry-acceptance-");
  const projectRoot = path.join(watchRoot, "repo");
  const initRegistry = createProjectRegistry({
    watchRoots: [watchRoot],
    createProjectId: () => "wt_phase4_acceptance",
    now: () => new Date("2026-06-07T12:30:00Z")
  });

  await fs.mkdir(projectRoot, { recursive: true });

  assert.deepEqual(await initRegistry.init({ root: projectRoot, title: "Phase 4 Acceptance" }), {
    projectId: "wt_phase4_acceptance"
  });

  const initSummary = initRegistry.listProjects();
  const rebuiltRegistry = await bootstrapProjectRegistry({
    watchRoots: [watchRoot]
  });

  assert.deepEqual(rebuiltRegistry.listProjects(), initSummary);
  assert.equal(rebuiltRegistry.resolveProject("wt_phase4_acceptance").marker.title, "Phase 4 Acceptance");
  assert.throws(
    () => rebuiltRegistry.resolveProject("wt_missing"),
    (error) =>
      error instanceof RegistryError &&
      error.code === "PROJECT_NOT_FOUND" &&
      error.projectId === "wt_missing"
  );
});
