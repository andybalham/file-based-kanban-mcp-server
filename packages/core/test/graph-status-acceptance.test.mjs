import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blocked,
  buildDepGraph,
  criticalPath,
  detectDepCycle,
  ready,
  resolveDetailed,
  validate
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

function statusesAsObject(statuses) {
  return Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function issueCodes(issues) {
  return issues.map((issue) => `${issue.entityId}:${issue.code}`);
}

test("graph and status acceptance criteria hold together", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic" }),
    entity({ id: "E-003", type: "epic" }),
    entity({ id: "E-004", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", parent: "E-002" }),
    entity({ id: "S-003", type: "story", parent: "E-003", dependsOn: ["S-004"] }),
    entity({ id: "S-004", type: "story", parent: "E-003" }),
    entity({ id: "S-005", type: "story", parent: "E-004" }),
    entity({ id: "T-001", type: "task", parent: "S-001" }),
    entity({ id: "T-002", type: "task", parent: "S-002" }),
    entity({ id: "T-003", type: "task", parent: "S-003" }),
    entity({ id: "T-004", type: "task", parent: "S-004" }),
    entity({ id: "T-005", type: "task", parent: "S-005", dependsOn: ["T-006"], estimate: 4 }),
    entity({ id: "T-006", type: "task", parent: "S-005", estimate: 3 }),
    entity({ id: "T-007", type: "task", parent: "S-005", estimate: 2 })
  ]);

  const resolution = resolveDetailed(index);

  assert.deepEqual(statusesAsObject(resolution.effective), {
    "E-001": "blocked",
    "E-002": "todo",
    "E-003": "blocked",
    "E-004": "blocked",
    "S-001": "blocked",
    "S-002": "todo",
    "S-003": "blocked",
    "S-004": "todo",
    "S-005": "blocked",
    "T-001": "blocked",
    "T-002": "todo",
    "T-003": "blocked",
    "T-004": "todo",
    "T-005": "blocked",
    "T-006": "todo",
    "T-007": "todo"
  });
  assert.deepEqual([...resolution.gateBlocked].sort((a, b) => a.localeCompare(b)), ["E-001", "S-003", "T-005"]);
  assert.deepEqual([...resolution.propagatedBy.entries()].sort(([left], [right]) => left.localeCompare(right)), [
    ["S-001", "E-001"],
    ["T-001", "E-001"],
    ["T-003", "S-003"]
  ]);

  assert.deepEqual(buildDepGraph(index, "epic").dependenciesOf.get("E-001"), ["E-002"]);
  assert.deepEqual(buildDepGraph(index, "story").dependenciesOf.get("S-003"), ["S-004"]);
  assert.deepEqual(buildDepGraph(index, "task").dependenciesOf.get("T-005"), ["T-006"]);
  assert.deepEqual(ready(index, resolution.effective), ["T-002", "T-004", "T-006", "T-007"]);
  assert.deepEqual(blocked(index, resolution.effective, resolution.propagatedBy), [
    { id: "E-001", type: "epic", blockedBy: ["E-002"] },
    { id: "E-003", type: "epic", blockedBy: [] },
    { id: "E-004", type: "epic", blockedBy: [] },
    { id: "S-001", type: "story", blockedBy: ["E-001"] },
    { id: "S-003", type: "story", blockedBy: ["S-004"] },
    { id: "S-005", type: "story", blockedBy: [] },
    { id: "T-001", type: "task", blockedBy: ["E-001"] },
    { id: "T-003", type: "task", blockedBy: ["S-003"] },
    { id: "T-005", type: "task", blockedBy: ["T-006"] }
  ]);
  assert.deepEqual(criticalPath(index), { path: ["T-006", "T-005"], total: 7 });

  assert.deepEqual(validate(index), { errors: [], warnings: [] });
});

test("validation acceptance reports crafted bad graph diagnostics", () => {
  const index = indexFrom([
    entity({ id: "E-010", type: "epic", dependsOn: ["E-011"] }),
    entity({ id: "E-011", type: "epic", dependsOn: ["E-010"] }),
    entity({ id: "E-012", type: "epic" }),
    entity({ id: "S-010", type: "story", parent: "E-010", dependsOn: ["S-011"] }),
    entity({ id: "S-011", type: "story", parent: "E-010", dependsOn: ["S-010"] }),
    entity({ id: "S-012", type: "story", parent: "E-012", dependsOn: ["E-010", "S-404"] }),
    entity({ id: "T-010", type: "task", parent: "S-012", status: "in-progress", dependsOn: ["T-011"] }),
    entity({ id: "T-011", type: "task", parent: "S-012" }),
    entity({ id: "T-012", type: "task", parent: "S-012", status: "done", dependsOn: ["T-011"] })
  ]);

  const result = validate(index);

  assert.deepEqual(detectDepCycle(buildDepGraph(index, "epic")), ["E-010", "E-011", "E-010"]);
  assert.deepEqual(detectDepCycle(buildDepGraph(index, "story")), ["S-010", "S-011", "S-010"]);
  assert.deepEqual(issueCodes(result.errors), [
    "E-010:DEP_CYCLE",
    "S-010:DEP_CYCLE",
    "S-012:DANGLING_DEPENDENCY",
    "S-012:DEP_TYPE_MISMATCH"
  ]);
  assert.deepEqual(issueCodes(result.warnings), [
    "E-011:EMPTY_COMPOSITE",
    "S-010:EMPTY_COMPOSITE",
    "S-011:EMPTY_COMPOSITE",
    "T-010:IN_PROGRESS_WITH_INCOMPLETE_DEP",
    "T-012:DONE_WITH_INCOMPLETE_DEP"
  ]);
});
