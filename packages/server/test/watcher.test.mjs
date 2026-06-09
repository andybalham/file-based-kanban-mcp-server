import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProjectRegistry, createProjectWatcher } from "../dist/main.js";

class FakeWatcher {
  constructor(paths, options) {
    this.paths = paths;
    this.options = options;
    this.listeners = [];
    this.closed = false;
  }

  on(event, listener) {
    assert.equal(event, "all");
    this.listeners.push(listener);
    return this;
  }

  emit(event, filePath) {
    for (const listener of this.listeners) {
      listener(event, filePath);
    }
  }

  async close() {
    this.closed = true;
  }
}

function createFakeWatcherFactory() {
  const watchers = [];

  return {
    watchers,
    factory(paths, options) {
      const watcher = new FakeWatcher(paths, options);
      watchers.push(watcher);
      return watcher;
    }
  };
}

function createBroadcaster() {
  const reloads = [];
  const changes = [];

  return {
    reloads,
    changes,
    broadcastReload(projectId) {
      reloads.push(projectId);
    },
    broadcastChanged(projectId, ids = []) {
      changes.push({ projectId, ids });
    }
  };
}

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMarkedProject(root, projectId, title) {
  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".worktracker", "project.json"),
    `{\n  "projectId": "${projectId}",\n  "title": "${title}",\n  "created": "2026-06-09T00:00:00Z"\n}\n`,
    "utf8"
  );
}

async function writeEntity(root, id, title) {
  const type = id.startsWith("E-") ? "epic" : id.startsWith("S-") ? "story" : "task";
  const parent = type === "epic" ? null : type === "story" ? "E-001" : "S-001";
  const lines = [
    "---",
    `id: "${id}"`,
    `type: "${type}"`,
    `title: "${title}"`,
    `parent: ${parent === null ? "null" : `"${parent}"`}`,
    ...(type === "task" ? ['status: "todo"'] : []),
    "dependsOn: []",
    "tags: []",
    "archived: false",
    'created: "2026-06-09T00:00:00Z"',
    'updated: "2026-06-09T00:00:00Z"',
    "---",
    ""
  ];

  await fs.mkdir(path.join(root, ".worktracker", "entities"), { recursive: true });
  await fs.writeFile(path.join(root, ".worktracker", "entities", `${id}.md`), `${lines.join("\n")}\n`, "utf8");
}

async function waitForCondition(predicate) {
  const started = Date.now();

  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for watcher side effect.");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("project watcher discovers externally added markers and broadcasts only that project", async () => {
  const watchRoot = await makeTempRoot("file-kanban-watcher-marker-");
  const projectRoot = path.join(watchRoot, "repo");
  const fake = createFakeWatcherFactory();
  const broadcaster = createBroadcaster();
  const registry = createProjectRegistry({ watchRoots: [watchRoot] });
  const watcher = createProjectWatcher({
    registry,
    watchRoots: [watchRoot],
    broadcaster,
    watcherFactory: fake.factory
  });

  await watcher.start();
  assert.equal(fake.watchers.length, 1);
  assert.deepEqual(fake.watchers[0].paths, [path.resolve(watchRoot)]);

  await writeMarkedProject(projectRoot, "wt_external", "External Project");
  fake.watchers[0].emit("add", path.join(projectRoot, ".worktracker", "project.json"));

  await waitForCondition(() => broadcaster.reloads.length === 1);

  assert.deepEqual(broadcaster.reloads, ["wt_external"]);
  assert.deepEqual(registry.listProjects(), [
    {
      projectId: "wt_external",
      title: "External Project",
      root: path.resolve(projectRoot)
    }
  ]);
  assert.equal(fake.watchers.length, 2);
  assert.deepEqual(
    fake.watchers[1].paths.map((watchPath) => path.relative(projectRoot, watchPath).replaceAll("\\", "/")),
    [".worktracker/entities", ".worktracker/requirements"]
  );

  await watcher.close();
  assert.equal(fake.watchers.every((fakeWatcher) => fakeWatcher.closed), true);
});

test("project watcher refreshes known project content and does not broadcast to other projects", async () => {
  const watchRoot = await makeTempRoot("file-kanban-watcher-content-");
  const firstRoot = path.join(watchRoot, "first");
  const secondRoot = path.join(watchRoot, "second");
  const fake = createFakeWatcherFactory();
  const broadcaster = createBroadcaster();

  await writeMarkedProject(firstRoot, "wt_first", "First Project");
  await writeMarkedProject(secondRoot, "wt_second", "Second Project");
  await writeEntity(firstRoot, "E-001", "Initial Epic");
  await writeEntity(firstRoot, "S-001", "Initial Story");
  await writeEntity(firstRoot, "T-001", "Initial Task");

  const registry = createProjectRegistry({ watchRoots: [watchRoot] });
  await registry.discover();

  const watcher = createProjectWatcher({
    registry,
    watchRoots: [watchRoot],
    broadcaster,
    watcherFactory: fake.factory
  });
  await watcher.start();

  assert.equal(fake.watchers.length, 3);
  const firstContentWatcher = fake.watchers.find((candidate) =>
    candidate.paths.some((watchPath) => path.resolve(watchPath).startsWith(path.resolve(firstRoot)))
  );
  assert.notEqual(firstContentWatcher, undefined);

  await writeEntity(firstRoot, "T-001", "Edited Task");
  firstContentWatcher.emit("change", path.join(firstRoot, ".worktracker", "entities", "T-001.md"));

  await waitForCondition(() => broadcaster.reloads.length === 1);

  assert.deepEqual(broadcaster.reloads, ["wt_first"]);
  assert.equal(registry.resolveProject("wt_first").index.byId.get("T-001").title, "Edited Task");
  assert.equal(registry.resolveProject("wt_second").index.byId.size, 0);

  await watcher.close();
});

test("project watcher suppresses server-originated content events until the debounce clears", async () => {
  const watchRoot = await makeTempRoot("file-kanban-watcher-suppression-");
  const projectRoot = path.join(watchRoot, "project");
  const suppressedEntityPath = path.join(projectRoot, ".worktracker", "entities", "T-001.md");
  const fake = createFakeWatcherFactory();
  const broadcaster = createBroadcaster();
  const writeSuppressionSet = new Set([path.resolve(suppressedEntityPath)]);

  await writeMarkedProject(projectRoot, "wt_suppressed", "Suppressed Project");
  await writeEntity(projectRoot, "E-001", "Initial Epic");
  await writeEntity(projectRoot, "S-001", "Initial Story");
  await writeEntity(projectRoot, "T-001", "Initial Task");

  const registry = createProjectRegistry({ watchRoots: [watchRoot] });
  await registry.discover();

  const watcher = createProjectWatcher({
    registry,
    watchRoots: [watchRoot],
    broadcaster,
    watcherFactory: fake.factory,
    writeSuppressionSet,
    writeSuppressionDebounceMs: 10
  });
  await watcher.start();

  const contentWatcher = fake.watchers.find((candidate) =>
    candidate.paths.some((watchPath) => path.resolve(watchPath).startsWith(path.resolve(projectRoot)))
  );
  assert.notEqual(contentWatcher, undefined);

  await writeEntity(projectRoot, "T-001", "Server Written Task");
  contentWatcher.emit("change", suppressedEntityPath);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(broadcaster.reloads, []);
  assert.equal(writeSuppressionSet.has(path.resolve(suppressedEntityPath)), false);
  assert.equal(registry.resolveProject("wt_suppressed").index.byId.get("T-001").title, "Initial Task");

  await writeEntity(projectRoot, "T-001", "External Task");
  contentWatcher.emit("change", suppressedEntityPath);
  await waitForCondition(() => broadcaster.reloads.length === 1);

  assert.deepEqual(broadcaster.reloads, ["wt_suppressed"]);
  assert.equal(registry.resolveProject("wt_suppressed").index.byId.get("T-001").title, "External Task");

  await watcher.close();
});
