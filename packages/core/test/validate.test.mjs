import assert from "node:assert/strict";
import { test } from "node:test";

import { validate } from "../dist/index.js";

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

function issueCodes(issues) {
  return issues.map((issue) => `${issue.entityId}:${issue.code}`);
}

test("validate reports hierarchy errors and hierarchy cycles", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", parent: "T-001" }),
    entity({ id: "E-002", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: null }),
    entity({ id: "S-002", type: "story", parent: "T-404" }),
    entity({ id: "S-003", type: "story", parent: "T-001" }),
    entity({ id: "T-001", type: "task", parent: "S-004" }),
    entity({ id: "T-002", type: "task", parent: null }),
    entity({ id: "T-003", type: "task", parent: "E-002" }),
    entity({ id: "S-004", type: "story", parent: "T-001" })
  ]);

  assert.deepEqual(issueCodes(validate(index).errors), [
    "E-001:EPIC_HAS_PARENT",
    "S-001:PARENT_REQUIRED",
    "S-002:DANGLING_PARENT",
    "S-003:INVALID_PARENT_TYPE",
    "S-004:INVALID_PARENT_TYPE",
    "T-001:HIERARCHY_CYCLE",
    "T-002:PARENT_REQUIRED",
    "T-003:INVALID_PARENT_TYPE"
  ]);
});

test("validate reports dependency reference errors and cycles for every same-type graph", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic", dependsOn: ["E-001"] }),
    entity({ id: "E-003", type: "epic", dependsOn: ["S-001", "E-404", "E-003"] }),
    entity({ id: "S-001", type: "story", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-002", type: "story", parent: "E-001", dependsOn: ["S-001"] }),
    entity({ id: "T-001", type: "task", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", dependsOn: ["T-001"] }),
    entity({ id: "T-003", type: "task", parent: "S-001", dependsOn: ["E-001", "T-404", "T-003"] })
  ]);

  assert.deepEqual(issueCodes(validate(index).errors), [
    "E-001:DEP_CYCLE",
    "E-003:DANGLING_DEPENDENCY",
    "E-003:DEP_TYPE_MISMATCH",
    "E-003:SELF_DEPENDENCY",
    "S-001:DEP_CYCLE",
    "T-001:DEP_CYCLE",
    "T-003:DANGLING_DEPENDENCY",
    "T-003:DEP_TYPE_MISMATCH",
    "T-003:SELF_DEPENDENCY"
  ]);
});

test("validate emits status warnings without blocking otherwise valid indexes", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "E-002", type: "epic" }),
    entity({ id: "E-003", type: "epic", dependsOn: ["E-002"] }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", parent: "E-001" }),
    entity({ id: "S-003", type: "story", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-004", type: "story", parent: "E-003" }),
    entity({ id: "T-001", type: "task", parent: "S-001", status: "in-progress", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", parent: "S-001", status: "todo" }),
    entity({ id: "T-003", type: "task", parent: "S-001", status: "done", dependsOn: ["T-002"] }),
    entity({ id: "T-004", type: "task", parent: "S-003", status: "done" }),
    entity({ id: "T-005", type: "task", parent: "S-004", status: "done" })
  ]);

  const result = validate(index);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(issueCodes(result.warnings), [
    "E-002:EMPTY_COMPOSITE",
    "E-003:DONE_WITH_INCOMPLETE_DEP",
    "S-002:EMPTY_COMPOSITE",
    "S-003:DONE_WITH_INCOMPLETE_DEP",
    "T-001:IN_PROGRESS_WITH_INCOMPLETE_DEP",
    "T-003:DONE_WITH_INCOMPLETE_DEP"
  ]);
});
