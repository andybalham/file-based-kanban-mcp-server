import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { regenerateProject } from "../dist/main.js";

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeState(root, index = emptyIndex()) {
  const marker = {
    projectId: "wt_regenerate",
    title: "Regenerate Project",
    created: "2026-06-07T00:00:00Z"
  };

  return {
    projectId: marker.projectId,
    root,
    marker,
    index,
    eff: new Map()
  };
}

function emptyIndex() {
  return {
    byId: new Map(),
    childrenOf: new Map()
  };
}

function entity(overrides) {
  return {
    id: "T-001",
    type: "task",
    title: "Task",
    parent: "S-001",
    status: "todo",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z",
    body: "\n",
    filePath: "",
    ...overrides
  };
}

async function writeEntityFile(root, fileName, frontmatter, body = "") {
  const filePath = path.join(root, ".worktracker", "entities", fileName);
  const lines = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(value.length === 0 ? `${key}: []` : `${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
      continue;
    }

    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }

    lines.push(`${key}: ${JSON.stringify(value)}`);
  }

  lines.push("---", body);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

test("regenerateProject refreshes state, writes generated artifacts, and records suppression paths", async () => {
  const root = await makeTempRoot("file-kanban-regenerate-");
  const state = makeState(root);
  const writeSuppressionSet = new Set();

  await writeEntityFile(root, "E-001.md", {
    id: "E-001",
    type: "epic",
    title: "Epic",
    parent: null,
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z"
  });
  await writeEntityFile(root, "S-001.md", {
    id: "S-001",
    type: "story",
    title: "Story",
    parent: "E-001",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z"
  });
  await writeEntityFile(root, "T-001.md", {
    id: "T-001",
    type: "task",
    title: "Task",
    parent: "S-001",
    status: "todo",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z"
  });

  const result = await regenerateProject(state, { writeSuppressionSet });

  assert.equal(state.index.byId.has("T-001"), true);
  assert.equal(state.eff.get("T-001"), "todo");
  assert.equal(result.index, state.index);
  assert.equal(result.eff, state.eff);
  assert.deepEqual(
    result.artifacts.map((artifact) => path.relative(root, artifact.filePath).replaceAll("\\", "/")),
    [
      ".worktracker/index/INDEX.md",
      ".worktracker/index/E-001.md",
      ".worktracker/index/READY.md",
      ".worktracker/index/BLOCKED.md",
      ".worktracker/graphs/dependencies.mmd",
      ".worktracker/graphs/E-001.mmd"
    ]
  );
  assert.equal(writeSuppressionSet.size, result.artifacts.length);
  assert.deepEqual([...writeSuppressionSet].sort(), [...result.suppressedPaths].sort());
  assert.match(await readText(path.join(root, ".worktracker", "index", "READY.md")), /T-001/);
  assert.match(await readText(path.join(root, ".worktracker", "graphs", "dependencies.mmd")), /graph LR/);
});

test("regenerateProject can render from an already refreshed in-memory index", async () => {
  const root = await makeTempRoot("file-kanban-regenerate-memory-");
  const epic = entity({ id: "E-001", type: "epic", title: "Epic", parent: null });
  const story = entity({ id: "S-001", type: "story", title: "Story", parent: "E-001" });
  const task = entity({ id: "T-001", type: "task", title: "Task", parent: "S-001", status: "done" });
  const index = {
    byId: new Map([
      [epic.id, epic],
      [story.id, story],
      [task.id, task]
    ]),
    childrenOf: new Map([
      [epic.id, [story.id]],
      [story.id, [task.id]]
    ])
  };
  const state = makeState(root, index);

  const result = await regenerateProject(state, { refreshIndex: false });

  assert.equal(result.index, index);
  assert.equal(state.eff.get("E-001"), "done");
  assert.match(await readText(path.join(root, ".worktracker", "index", "INDEX.md")), /done/);
});
