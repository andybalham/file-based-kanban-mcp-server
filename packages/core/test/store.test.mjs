import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStore, parse, readMarker, scan, seedRequirements, writeMarker } from "../dist/index.js";

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
