import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allocateId,
  createStore,
  discoverProjects,
  move,
  parse,
  readMarker,
  resolveAll,
  scan,
  seedRequirements,
  serializeEntity,
  write,
  writeGeneratedArtifacts,
  writeMarker
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures", "minimal-project");
const goldenRoot = path.join(__dirname, "fixtures", "golden", "minimal-project");
const entitiesRoot = path.join(fixtureRoot, ".worktracker", "entities");

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

async function copyFixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-phase1-acceptance-"));
  const projectRoot = path.join(root, "minimal-project");
  await fs.cp(fixtureRoot, projectRoot, { recursive: true });
  return projectRoot;
}

async function assertGeneratedArtifactsMatchGolden(projectRoot, artifacts) {
  for (const artifact of artifacts) {
    const relativePath = path.relative(projectRoot, artifact.filePath);
    const expectedPath = path.join(goldenRoot, relativePath);

    assert.equal(
      await fs.readFile(artifact.filePath, "utf8"),
      await fs.readFile(expectedPath, "utf8"),
      `${relativePath} should match its golden snapshot`
    );
  }
}

test("parse reads frontmatter into the stable Entity shape and preserves Markdown body", async () => {
  const entity = await parse(path.join(entitiesRoot, "T-002-render-board.md"));

  assert.equal(entity.id, "T-002");
  assert.equal(entity.type, "task");
  assert.equal(entity.title, "Render board");
  assert.equal(entity.parent, "S-001");
  assert.equal(entity.status, "todo");
  assert.deepEqual(entity.dependsOn, ["T-001"]);
  assert.equal(entity.estimate, 2);
  assert.deepEqual(entity.tags, ["ui"]);
  assert.equal(entity.archived, false);
  assert.match(entity.body, /## Description/);
  assert.equal(entity.filePath, path.join(entitiesRoot, "T-002-render-board.md"));
});

test("parse normalizes non-task status to todo and keeps optional task status default deterministic", async () => {
  const epic = await parse(path.join(entitiesRoot, "E-001-project-foundation.md"));

  assert.equal(epic.status, "todo");
  assert.equal(epic.parent, null);
  assert.deepEqual(epic.dependsOn, []);
});

test("scan builds id lookups and deterministic parent child lists", async () => {
  const index = await scan(fixtureRoot);

  assert.deepEqual([...index.byId.keys()], ["E-001", "S-001", "T-001", "T-002"]);
  assert.deepEqual(index.childrenOf.get("E-001"), ["S-001"]);
  assert.deepEqual(index.childrenOf.get("S-001"), ["T-001", "T-002"]);
});

test("serializeEntity writes canonical frontmatter order and preserves the Markdown body", async () => {
  const entity = {
    id: "T-010",
    type: "task",
    title: "Render: board",
    parent: "S-001",
    status: "in-progress",
    dependsOn: ["T-009", "T-001"],
    estimate: 3,
    tags: ["ui", "phase 1"],
    archived: false,
    created: "2026-06-06T19:55:00Z",
    updated: "2026-06-06T20:00:00Z",
    body: "\n## Description\n\nKeep this body byte-for-byte.\n",
    filePath: "ignored-by-serializer.md"
  };

  assert.equal(
    serializeEntity(entity),
    [
      "---",
      "id: T-010",
      "type: task",
      'title: "Render: board"',
      "parent: S-001",
      "status: in-progress",
      "dependsOn: [T-001, T-009]",
      "estimate: 3",
      "tags: [phase 1, ui]",
      "archived: false",
      "created: 2026-06-06T19:55:00Z",
      "updated: 2026-06-06T20:00:00Z",
      "---",
      "",
      "## Description",
      "",
      "Keep this body byte-for-byte.",
      ""
    ].join("\n")
  );
});

test("serializeEntity omits non-task status and round-trips through parse with sorted metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-serialize-"));
  const filePath = path.join(root, "E-010-quoted-title.md");
  const serialized = serializeEntity({
    id: "E-010",
    type: "epic",
    title: "Quoted # Title",
    parent: null,
    status: "done",
    dependsOn: ["E-009", "E-001"],
    tags: ["zeta", "alpha"],
    archived: true,
    created: "2026-06-06T19:55:00Z",
    updated: "2026-06-06T20:00:00Z",
    body: "\nHuman-authored epic notes.\n",
    filePath
  });

  assert.doesNotMatch(serialized, /^status:/m);
  await fs.writeFile(filePath, serialized, "utf8");

  const reparsed = await parse(filePath);
  assert.equal(reparsed.status, "todo");
  assert.deepEqual(reparsed.dependsOn, ["E-001", "E-009"]);
  assert.deepEqual(reparsed.tags, ["alpha", "zeta"]);
  assert.equal(reparsed.body, "\nHuman-authored epic notes.\n");
});

test("write atomically persists canonical entity bytes and round-trips through parse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-write-entity-"));
  const filePath = path.join(root, ".worktracker", "entities", "T-010-render-card.md");
  const entity = {
    id: "T-010",
    type: "task",
    title: "Render card",
    parent: "S-001",
    status: "todo",
    dependsOn: ["T-009", "T-001"],
    estimate: 1,
    tags: ["ui", "phase 1"],
    archived: false,
    created: "2026-06-06T20:20:00Z",
    updated: "2026-06-06T20:21:00Z",
    body: "\n## Description\n\nPersist this body exactly.\n",
    filePath
  };

  await write(root, entity);

  assert.equal(await fs.readFile(filePath, "utf8"), serializeEntity(entity));

  const reparsed = await parse(filePath);
  assert.deepEqual(
    {
      ...reparsed,
      filePath: entity.filePath
    },
    {
      ...entity,
      dependsOn: ["T-001", "T-009"],
      tags: ["phase 1", "ui"]
    }
  );
});

test("bound store write skips byte-identical entity writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-write-noop-"));
  const filePath = path.join(root, ".worktracker", "entities", "S-010-preserve-time.md");
  const entity = {
    id: "S-010",
    type: "story",
    title: "Preserve time",
    parent: "E-001",
    status: "done",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-06T20:22:00Z",
    updated: "2026-06-06T20:23:00Z",
    body: "\nNo-op writes should not touch this file.\n",
    filePath
  };
  const store = createStore(root);

  await store.write(entity);

  const oldTimestamp = new Date("2026-06-01T00:00:00Z");
  await fs.utimes(filePath, oldTimestamp, oldTimestamp);

  await store.write(entity);

  const stat = await fs.stat(filePath);
  assert.equal(stat.mtime.getTime(), oldTimestamp.getTime());
});

test("allocateId initializes counters from existing entities and persists the next value", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-allocate-init-"));
  const entitiesDir = path.join(root, ".worktracker", "entities");

  await fs.mkdir(entitiesDir, { recursive: true });
  await fs.copyFile(
    path.join(entitiesRoot, "T-002-render-board.md"),
    path.join(entitiesDir, "T-002-render-board.md")
  );
  await fs.copyFile(
    path.join(entitiesRoot, "S-001-initial-board.md"),
    path.join(entitiesDir, "S-001-initial-board.md")
  );

  const nextTaskId = await allocateId(root, "task");

  assert.equal(nextTaskId, "T-003");
  assert.equal(
    await fs.readFile(path.join(root, ".worktracker", ".meta", "counters.json"), "utf8"),
    '{\n  "epic": 0,\n  "story": 1,\n  "task": 3\n}\n'
  );
});

test("bound store allocateId uses persisted counters instead of reusing removed ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-allocate-persisted-"));
  const store = createStore(root);

  assert.equal(await store.allocateId("epic"), "E-001");
  assert.equal(await store.allocateId("epic"), "E-002");

  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });

  assert.equal(await store.allocateId("epic"), "E-003");
});

test("allocateId keeps archived ids in the initial max and zero-pads beyond three digits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-allocate-archived-"));
  const filePath = path.join(root, ".worktracker", "entities", "T-999-archived.md");

  await write(root, {
    id: "T-999",
    type: "task",
    title: "Archived task",
    parent: "S-001",
    status: "done",
    dependsOn: [],
    tags: [],
    archived: true,
    created: "2026-06-06T20:40:00Z",
    updated: "2026-06-06T20:41:00Z",
    body: "\nArchived ids still reserve their numeric suffix.\n",
    filePath
  });

  assert.equal(await allocateId(root, "task"), "T-1000");
});

test("move edits only parent frontmatter while preserving filename and Markdown body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-move-parent-"));
  const filePath = path.join(root, ".worktracker", "entities", "T-010-render-card.md");

  await write(root, {
    id: "T-010",
    type: "task",
    title: "Render card",
    parent: "S-001",
    status: "todo",
    dependsOn: ["T-001"],
    estimate: 1,
    tags: ["ui"],
    archived: false,
    created: "2026-06-06T20:42:00Z",
    updated: "2026-06-06T20:43:00Z",
    body: "\n## Description\n\nMove should preserve this body.\n",
    filePath
  });

  await move(root, "T-010", "S-002");

  assert.equal(await pathExists(filePath), true);
  assert.equal(await pathExists(path.join(root, ".worktracker", "entities", "T-010-S-002.md")), false);

  const moved = await parse(filePath);
  assert.equal(moved.parent, "S-002");
  assert.equal(moved.updated, "2026-06-06T20:43:00Z");
  assert.equal(moved.body, "\n## Description\n\nMove should preserve this body.\n");
});

test("bound store move skips byte-identical parent moves", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-move-noop-"));
  const filePath = path.join(root, ".worktracker", "entities", "S-010-preserve-parent.md");
  const store = createStore(root);

  await store.write({
    id: "S-010",
    type: "story",
    title: "Preserve parent",
    parent: "E-001",
    status: "todo",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-06T20:44:00Z",
    updated: "2026-06-06T20:45:00Z",
    body: "\nNo-op moves should not rewrite this file.\n",
    filePath
  });

  const oldTimestamp = new Date("2026-06-01T00:00:00Z");
  await fs.utimes(filePath, oldTimestamp, oldTimestamp);

  await store.move("S-010", "E-001");

  const stat = await fs.stat(filePath);
  assert.equal(stat.mtime.getTime(), oldTimestamp.getTime());
});

test("move rejects unknown entity ids before writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-move-missing-"));
  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });

  await assert.rejects(() => move(root, "T-404", "S-001"), {
    name: "EntityMoveError",
    message: /T-404/
  });
});

test("write rejects entity paths outside the project entity directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-write-guard-"));
  const entity = {
    id: "T-011",
    type: "task",
    title: "Unsafe path",
    parent: "S-001",
    status: "todo",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-06T20:24:00Z",
    updated: "2026-06-06T20:25:00Z",
    body: "\nThis should not be written.\n",
    filePath: path.join(root, "README.md")
  };

  await assert.rejects(() => write(root, entity), {
    name: "EntityWriteError",
    message: /inside \.worktracker/
  });
});

test("createStore binds scan and parse operations to a project root", async () => {
  const store = createStore(fixtureRoot);
  const index = await store.scan();
  const task = await store.parse(path.join(entitiesRoot, "T-001-create-marker.md"));

  assert.equal(index.byId.size, 4);
  assert.equal(task.id, "T-001");
});

test("readMarker returns null for uninitialized roots and parses initialized markers", async () => {
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-marker-empty-"));

  assert.equal(await readMarker(emptyRoot), null);
  assert.deepEqual(await readMarker(fixtureRoot), {
    projectId: "wt_fixture_minimal",
    title: "Fixture Minimal Project",
    created: "2026-06-01T09:00:00Z"
  });
});

test("writeMarker writes canonical marker JSON through the bound store primitive", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-marker-write-"));
  const marker = {
    projectId: "wt_test_marker",
    title: "Test Marker",
    created: "2026-06-06T19:45:00Z"
  };

  const store = createStore(root);
  await store.writeMarker(marker);

  assert.deepEqual(await store.readMarker(), marker);
  assert.equal(
    await fs.readFile(path.join(root, ".worktracker", "project.json"), "utf8"),
    '{\n  "projectId": "wt_test_marker",\n  "title": "Test Marker",\n  "created": "2026-06-06T19:45:00Z"\n}\n'
  );
});

test("seedRequirements writes once and preserves later human-authored content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-requirements-"));
  const sourcePath = path.join(root, ".worktracker", "requirements", "source.md");

  await seedRequirements(root, "# Initial intent");
  await seedRequirements(root, "# Replacement intent");

  assert.equal(await fs.readFile(sourcePath, "utf8"), "# Initial intent\n");
});

test("writeGeneratedArtifacts persists the deterministic navigation and graph artifact set", async () => {
  const projectRoot = await copyFixtureProject();
  const index = await scan(projectRoot);
  const artifacts = await writeGeneratedArtifacts(projectRoot, index, resolveAll(index));

  assert.deepEqual(
    artifacts.map((artifact) => [artifact.kind, path.relative(projectRoot, artifact.filePath)]),
    [
      ["index", path.join(".worktracker", "index", "INDEX.md")],
      ["index", path.join(".worktracker", "index", "E-001.md")],
      ["index", path.join(".worktracker", "index", "READY.md")],
      ["index", path.join(".worktracker", "index", "BLOCKED.md")],
      ["graph", path.join(".worktracker", "graphs", "dependencies.mmd")],
      ["graph", path.join(".worktracker", "graphs", "E-001.mmd")]
    ]
  );

  await assertGeneratedArtifactsMatchGolden(projectRoot, artifacts);
});

test("bound store generated artifact writes skip byte-identical regeneration", async () => {
  const projectRoot = await copyFixtureProject();
  const store = createStore(projectRoot);
  const index = await store.scan();
  const artifacts = await store.writeGeneratedArtifacts(index, resolveAll(index));
  const oldTimestamp = new Date("2026-06-01T00:00:00Z");

  for (const artifact of artifacts) {
    await fs.utimes(artifact.filePath, oldTimestamp, oldTimestamp);
  }

  await store.writeGeneratedArtifacts(index, resolveAll(index));

  for (const artifact of artifacts) {
    const stat = await fs.stat(artifact.filePath);
    assert.equal(stat.mtime.getTime(), oldTimestamp.getTime());
  }
});

test("discoverProjects finds markers under watch roots in deterministic root order", async () => {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-discover-order-"));
  const zetaRoot = path.join(watchRoot, "zeta-repo");
  const alphaRoot = path.join(watchRoot, "alpha-repo");

  await writeMarker(zetaRoot, {
    projectId: "wt_zeta",
    title: "Zeta Project",
    created: "2026-06-06T19:45:00Z"
  });
  await writeMarker(alphaRoot, {
    projectId: "wt_alpha",
    title: "Alpha Project",
    created: "2026-06-06T19:40:00Z"
  });

  const discovered = await discoverProjects([watchRoot]);

  assert.deepEqual(
    discovered.map((project) => [project.root, project.marker.projectId]),
    [
      [alphaRoot, "wt_alpha"],
      [zetaRoot, "wt_zeta"]
    ]
  );
});

test("discoverProjects ignores standard noisy directories and does not descend past a marker", async () => {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-discover-ignore-"));
  const projectRoot = path.join(watchRoot, "active-repo");
  const nestedProjectRoot = path.join(projectRoot, "fixtures", "nested-repo");
  const ignoredRoots = [
    path.join(watchRoot, "node_modules", "vendored-project"),
    path.join(watchRoot, ".git", "worktree-project"),
    path.join(watchRoot, "dist", "built-project")
  ];

  await writeMarker(projectRoot, {
    projectId: "wt_active",
    title: "Active Project",
    created: "2026-06-06T19:45:00Z"
  });
  await writeMarker(nestedProjectRoot, {
    projectId: "wt_nested",
    title: "Nested Project",
    created: "2026-06-06T19:46:00Z"
  });

  for (const [index, ignoredRoot] of ignoredRoots.entries()) {
    await writeMarker(ignoredRoot, {
      projectId: `wt_ignored_${index}`,
      title: `Ignored Project ${index}`,
      created: "2026-06-06T19:47:00Z"
    });
  }

  const discovered = await discoverProjects([watchRoot]);

  assert.deepEqual(
    discovered.map((project) => project.marker.projectId),
    ["wt_active"]
  );
});

test("discoverProjects honors gitignore directory rules while scanning for markers", async () => {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-discover-gitignore-"));
  await fs.writeFile(
    path.join(watchRoot, ".gitignore"),
    ["ignored-repo/", "*.generated/", "/anchored-only/", "ignored-*", "!ignored-allowed", ""].join("\n"),
    "utf8"
  );

  await writeMarker(path.join(watchRoot, "visible-repo"), {
    projectId: "wt_visible",
    title: "Visible Project",
    created: "2026-06-06T20:10:00Z"
  });
  await writeMarker(path.join(watchRoot, "ignored-repo"), {
    projectId: "wt_ignored_directory",
    title: "Ignored Directory Project",
    created: "2026-06-06T20:11:00Z"
  });
  await writeMarker(path.join(watchRoot, "snapshot.generated"), {
    projectId: "wt_ignored_glob",
    title: "Ignored Glob Project",
    created: "2026-06-06T20:12:00Z"
  });
  await writeMarker(path.join(watchRoot, "anchored-only"), {
    projectId: "wt_ignored_rooted",
    title: "Ignored Rooted Project",
    created: "2026-06-06T20:13:00Z"
  });
  await writeMarker(path.join(watchRoot, "nested", "anchored-only"), {
    projectId: "wt_nested_anchored",
    title: "Nested Anchored Project",
    created: "2026-06-06T20:14:00Z"
  });
  await writeMarker(path.join(watchRoot, "ignored-allowed"), {
    projectId: "wt_negated",
    title: "Negated Project",
    created: "2026-06-06T20:15:00Z"
  });

  const discovered = await discoverProjects([watchRoot]);

  assert.deepEqual(
    discovered.map((project) => project.marker.projectId),
    ["wt_negated", "wt_nested_anchored", "wt_visible"]
  );
});

test("phase 1 core store acceptance criteria hold together", async () => {
  const projectRoot = await copyFixtureProject();
  const store = createStore(projectRoot);

  const index = await store.scan();
  assert.deepEqual([...index.byId.keys()], ["E-001", "S-001", "T-001", "T-002"]);
  assert.deepEqual(index.childrenOf.get("E-001"), ["S-001"]);
  assert.deepEqual(index.childrenOf.get("S-001"), ["T-001", "T-002"]);

  for (const entity of index.byId.values()) {
    const beforeWrite = await fs.readFile(entity.filePath, "utf8");

    await store.write(entity);

    const afterWrite = await fs.readFile(entity.filePath, "utf8");
    const reparsed = await store.parse(entity.filePath);

    assert.equal(afterWrite, beforeWrite);
    assert.match(afterWrite, /^dependsOn: \[/m);
    assert.deepEqual(
      {
        ...reparsed,
        filePath: entity.filePath
      },
      entity
    );
  }

  const allocatedTaskId = await store.allocateId("task");
  const archivedFilePath = path.join(projectRoot, ".worktracker", "entities", `${allocatedTaskId}-archived.md`);

  assert.equal(allocatedTaskId, "T-003");

  await store.write({
    id: allocatedTaskId,
    type: "task",
    title: "Archived acceptance task",
    parent: "S-001",
    status: "done",
    dependsOn: [],
    tags: [],
    archived: true,
    created: "2026-06-06T20:50:00Z",
    updated: "2026-06-06T20:51:00Z",
    body: "\nArchived ids still count for allocation.\n",
    filePath: archivedFilePath
  });

  await fs.unlink(archivedFilePath);

  assert.equal(await store.allocateId("task"), "T-004");

  const moveTargetPath = path.join(projectRoot, ".worktracker", "entities", "T-002-render-board.md");
  const moveBefore = await fs.readFile(moveTargetPath, "utf8");

  await store.move("T-002", "S-002");

  const moveAfter = await fs.readFile(moveTargetPath, "utf8");
  const moved = await store.parse(moveTargetPath);

  assert.equal(moved.parent, "S-002");
  assert.equal(moved.body, "\n## Description\n\nRender the fixture board after the marker task is complete.\n\n## Acceptance Criteria\n\n- [ ] The task is ready when `T-001` is done.\n");
  assert.notEqual(moveAfter, moveBefore);
  assert.match(moveAfter, /^parent: S-002$/m);
  assert.doesNotMatch(moveAfter, /T-002-S-002/);
  assert.equal(await pathExists(path.join(projectRoot, ".worktracker", "entities", "T-002-S-002.md")), false);

  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-phase1-discovery-"));
  const activeRoot = path.join(watchRoot, "active");
  const nestedRoot = path.join(activeRoot, "fixtures", "nested");
  const ignoredRoots = [
    path.join(watchRoot, ".git", "hidden"),
    path.join(watchRoot, "node_modules", "dependency"),
    path.join(watchRoot, "dist", "generated")
  ];

  await fs.cp(projectRoot, activeRoot, { recursive: true });
  await writeMarker(nestedRoot, {
    projectId: "wt_nested_acceptance",
    title: "Nested Acceptance Project",
    created: "2026-06-06T20:52:00Z"
  });

  for (const [index, ignoredRoot] of ignoredRoots.entries()) {
    await writeMarker(ignoredRoot, {
      projectId: `wt_ignored_acceptance_${index}`,
      title: `Ignored Acceptance Project ${index}`,
      created: "2026-06-06T20:53:00Z"
    });
  }

  const discovered = await discoverProjects([watchRoot]);

  assert.deepEqual(
    discovered.map((project) => project.marker.projectId),
    ["wt_fixture_minimal"]
  );
});
