import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createStore,
  discoverProjects,
  parse,
  readMarker,
  scan,
  seedRequirements,
  serializeEntity,
  writeMarker
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures", "minimal-project");
const entitiesRoot = path.join(fixtureRoot, ".worktracker", "entities");

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
