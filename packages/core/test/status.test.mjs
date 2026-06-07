import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveAll, resolveDetailed } from "../dist/index.js";

function entity(overrides) {
  return {
    id: overrides.id,
    type: overrides.type,
    title: overrides.title ?? overrides.id,
    parent: overrides.parent ?? null,
    status: overrides.status ?? "todo",
    dependsOn: overrides.dependsOn ?? [],
    tags: overrides.tags ?? [],
    archived: overrides.archived ?? false,
    created: overrides.created ?? "2026-06-06T20:00:00Z",
    updated: overrides.updated ?? "2026-06-06T20:00:00Z",
    body: overrides.body ?? "\n",
    filePath: overrides.filePath ?? `${overrides.id}.md`
  };
}

function indexFrom(entities) {
  const byId = new Map();
  const childrenOf = new Map();

  for (const item of [...entities].sort((a, b) => a.id.localeCompare(b.id))) {
    byId.set(item.id, item);

    if (item.parent !== null) {
      const children = childrenOf.get(item.parent) ?? [];
      children.push(item.id);
      childrenOf.set(item.parent, children);
    }
  }

  for (const children of childrenOf.values()) {
    children.sort((a, b) => a.localeCompare(b));
  }

  return { byId, childrenOf };
}

function statusesAsObject(statuses) {
  return Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

test("resolveAll blocks todo tasks with incomplete same-type dependencies", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "todo", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "todo" })
  ]);

  assert.deepEqual(statusesAsObject(resolveAll(index)), {
    "E-001": "blocked",
    "S-001": "blocked",
    "T-001": "blocked",
    "T-002": "todo"
  });
});

test("resolveAll keeps in-progress and done entities effective when their dependencies are incomplete", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "in-progress", dependsOn: ["T-003"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "done", dependsOn: ["T-003"] }),
    entity({ id: "T-003", type: "task", parent: "S-001", status: "todo" })
  ]);

  assert.equal(resolveAll(index).get("T-001"), "in-progress");
  assert.equal(resolveAll(index).get("T-002"), "done");
});

test("resolveAll rolls stories and epics up from child effective statuses", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "done" }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-003", type: "task", parent: "S-002", status: "todo" })
  ]);

  assert.deepEqual(statusesAsObject(resolveAll(index)), {
    "E-001": "in-progress",
    "S-001": "in-progress",
    "S-002": "todo",
    "T-001": "done",
    "T-002": "todo",
    "T-003": "todo"
  });
});

test("resolveDetailed gate-blocks story dependencies and propagates to unfinished tasks only", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-002", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-003", type: "task", parent: "S-002", status: "todo" })
  ]);

  const resolution = resolveDetailed(index);

  assert.equal(resolution.effective.get("S-001"), "blocked");
  assert.equal(resolution.effective.get("T-001"), "blocked");
  assert.equal(resolution.effective.get("T-002"), "blocked");
  assert.equal(resolution.propagatedBy.get("T-001"), "S-001");
  assert.equal(resolution.propagatedBy.get("T-002"), "S-001");
  assert.deepEqual([...resolution.gateBlocked], ["S-001"]);
});

test("resolveDetailed gate-blocks epic dependencies and propagates through stories to unfinished tasks", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", parent: "E-002" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-003", type: "task", parent: "S-002", status: "todo" })
  ]);

  const resolution = resolveDetailed(index);

  assert.equal(resolution.effective.get("E-001"), "blocked");
  assert.equal(resolution.effective.get("S-001"), "blocked");
  assert.equal(resolution.effective.get("T-001"), "blocked");
  assert.equal(resolution.effective.get("T-002"), "blocked");
  assert.equal(resolution.propagatedBy.get("S-001"), "E-001");
  assert.equal(resolution.propagatedBy.get("T-001"), "E-001");
  assert.deepEqual([...resolution.gateBlocked], ["E-001"]);
});

test("resolveAll reports empty composites and ignores archived children in rollups", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "done", archived: true })
  ]);

  assert.deepEqual(statusesAsObject(resolveAll(index)), {
    "E-001": "todo",
    "S-001": "empty",
    "T-001": "done"
  });
});

test("resolveAll terminates with a stable status map when validation has not caught a dependency cycle", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", dependsOn: ["T-001"] })
  ]);

  assert.deepEqual(statusesAsObject(resolveAll(index)), {
    "E-001": "blocked",
    "S-001": "blocked",
    "T-001": "blocked",
    "T-002": "blocked"
  });
});
