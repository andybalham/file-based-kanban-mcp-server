import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blocked,
  buildDepGraph,
  criticalPath,
  detectDepCycle,
  detectHierarchyCycle,
  ready,
  resolveAll,
  resolveDetailed,
  topoSort
} from "../dist/index.js";

function entity(overrides) {
  return {
    id: overrides.id,
    type: overrides.type,
    title: overrides.title ?? overrides.id,
    parent: overrides.parent ?? null,
    status: overrides.status ?? "todo",
    dependsOn: overrides.dependsOn ?? [],
    estimate: overrides.estimate,
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

test("buildDepGraph creates a deterministic same-type graph for one entity layer", () => {
  const index = indexFrom([
    entity({ id: "T-003", type: "task", parent: "S-001", dependsOn: ["T-002", "T-001", "S-001", "T-404"] }),
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-002", type: "task", parent: "S-001", dependsOn: ["T-001"] }),
    entity({ id: "T-001", type: "task", parent: "S-001" })
  ]);

  const graph = buildDepGraph(index, "task");

  assert.equal(graph.type, "task");
  assert.deepEqual(graph.nodes, ["T-001", "T-002", "T-003"]);
  assert.deepEqual(graph.dependenciesOf.get("T-001"), []);
  assert.deepEqual(graph.dependenciesOf.get("T-002"), ["T-001"]);
  assert.deepEqual(graph.dependenciesOf.get("T-003"), ["T-001", "T-002"]);
  assert.deepEqual(graph.dependentsOf.get("T-001"), ["T-002", "T-003"]);
  assert.deepEqual(graph.dependentsOf.get("T-002"), ["T-003"]);
});

test("topoSort returns dependency-before-dependent order with lexical tie breaks", () => {
  const index = indexFrom([
    entity({ id: "T-004", type: "task", parent: "S-001", dependsOn: ["T-002", "T-003"] }),
    entity({ id: "T-003", type: "task", parent: "S-001", dependsOn: ["T-001"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", dependsOn: ["T-001"] }),
    entity({ id: "T-001", type: "task", parent: "S-001" })
  ]);

  assert.deepEqual(topoSort(buildDepGraph(index, "task")), ["T-001", "T-002", "T-003", "T-004"]);
});

test("detectDepCycle reports a concrete cycle path independently for each type graph", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic", dependsOn: ["E-001"] }),
    entity({ id: "S-001", type: "story", parent: "E-001", dependsOn: ["S-003"] }),
    entity({ id: "S-002", type: "story", parent: "E-001", dependsOn: ["S-001"] }),
    entity({ id: "S-003", type: "story", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "T-001", type: "task", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001" })
  ]);

  assert.deepEqual(detectDepCycle(buildDepGraph(index, "epic")), ["E-001", "E-002", "E-001"]);
  assert.deepEqual(detectDepCycle(buildDepGraph(index, "story")), ["S-001", "S-003", "S-002", "S-001"]);
  assert.equal(detectDepCycle(buildDepGraph(index, "task")), null);
});

test("topoSort rejects cyclic dependency graphs with the cycle path in the error", () => {
  const index = indexFrom([
    entity({ id: "T-001", type: "task", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", dependsOn: ["T-001"] })
  ]);

  assert.throws(() => topoSort(buildDepGraph(index, "task")), {
    name: "GraphCycleError",
    message: /T-001 -> T-002 -> T-001/
  });
});

test("detectHierarchyCycle follows known parent links and returns a concrete closed path", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", parent: "T-001" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001" }),
    entity({ id: "E-002", type: "epic" })
  ]);

  assert.deepEqual(detectHierarchyCycle(index), ["E-001", "T-001", "S-001", "E-001"]);
});

test("detectHierarchyCycle returns null for an acyclic hierarchy", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001" })
  ]);

  assert.equal(detectHierarchyCycle(index), null);
});

test("ready returns active effective-todo tasks only", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001" }),
    entity({ id: "T-003", type: "task", parent: "S-001", archived: true }),
    entity({ id: "T-004", type: "task", parent: "S-001", status: "done" })
  ]);

  assert.deepEqual(ready(index, resolveAll(index)), ["T-002"]);
});

test("blocked reports direct same-type blockers and propagated gate blockers", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-002", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", parent: "S-001" }),
    entity({ id: "T-002", type: "task", parent: "S-002", dependsOn: ["T-003"] }),
    entity({ id: "T-003", type: "task", parent: "S-002" })
  ]);
  const resolution = resolveDetailed(index);

  assert.deepEqual(blocked(index, resolution.effective, resolution.propagatedBy), [
    { id: "E-001", type: "epic", blockedBy: [] },
    { id: "S-001", type: "story", blockedBy: ["S-002"] },
    { id: "S-002", type: "story", blockedBy: [] },
    { id: "T-001", type: "task", blockedBy: ["S-001"] },
    { id: "T-002", type: "task", blockedBy: ["T-003"] }
  ]);
});

test("criticalPath returns the weighted task dependency chain with deterministic ties", () => {
  const index = indexFrom([
    entity({ id: "T-001", type: "task", estimate: 2 }),
    entity({ id: "T-002", type: "task", estimate: 3, dependsOn: ["T-001"] }),
    entity({ id: "T-003", type: "task", estimate: 3, dependsOn: ["T-001"] }),
    entity({ id: "T-004", type: "task", estimate: 1, dependsOn: ["T-002", "T-003"] }),
    entity({ id: "T-005", type: "task", estimate: 6, archived: true })
  ]);

  assert.deepEqual(criticalPath(index), { path: ["T-001", "T-002", "T-004"], total: 6 });
});

test("criticalPath counts story and epic nodes instead of task estimates", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "E-002", type: "epic", dependsOn: ["E-001"] }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", parent: "E-001", estimate: 99, dependsOn: ["S-001"] }),
    entity({ id: "S-003", type: "story", parent: "E-002", dependsOn: ["S-002"] })
  ]);

  assert.deepEqual(criticalPath(index, "story"), { path: ["S-001", "S-002", "S-003"], total: 3 });
  assert.deepEqual(criticalPath(index, "epic"), { path: ["E-001", "E-002"], total: 2 });
});
