import assert from "node:assert/strict";
import { test } from "node:test";

import { renderBlocked, renderEpicIndex, renderIndex, renderReady, resolveAll } from "../dist/index.js";

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
    filePath: overrides.filePath ?? `C:\\repo\\.worktracker\\entities\\${overrides.id.toLowerCase()}.md`
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

test("renderIndex emits a deterministic generated board with entity and epic links", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", title: "Auth", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic", title: "Platform" }),
    entity({ id: "S-001", type: "story", title: "Login", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-002", type: "story", title: "Sessions", parent: "E-002" }),
    entity({ id: "T-001", type: "task", title: "Form", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", title: "Schema", parent: "S-002" }),
    entity({ id: "T-003", type: "task", title: "Archived", parent: "S-002", archived: true })
  ]);

  assert.equal(renderIndex(index, resolveAll(index)), `# Project board

_Generated. Do not edit by hand._

## [E-001 · Auth](./E-001.md) — blocked
- [ ] **S-001 · Login** — blocked · waiting on S-002
  - [ ] [T-001 · Form](../entities/t-001.md) — blocked · waiting on T-002

## [E-002 · Platform](./E-002.md) — todo
- [ ] **S-002 · Sessions** — todo
  - [ ] [T-002 · Schema](../entities/t-002.md) — todo
`);
});

test("renderEpicIndex scopes navigation to one epic", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", title: "Auth" }),
    entity({ id: "E-002", type: "epic", title: "Platform" }),
    entity({ id: "S-001", type: "story", title: "Login", parent: "E-001" }),
    entity({ id: "S-002", type: "story", title: "Sessions", parent: "E-002" }),
    entity({ id: "T-001", type: "task", title: "Form", parent: "S-001", status: "done" }),
    entity({ id: "T-002", type: "task", title: "Schema", parent: "S-002" })
  ]);

  assert.equal(renderEpicIndex(index, "E-001", resolveAll(index)), `# E-001 · Auth

_Generated. Do not edit by hand._

Status: done

- [x] **S-001 · Login** — done
  - [x] [T-001 · Form](../entities/t-001.md) — done
`);
});

test("renderReady lists only effective todo tasks", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" }),
    entity({ id: "T-001", type: "task", title: "Ready", parent: "S-001" }),
    entity({ id: "T-002", type: "task", title: "Done", parent: "S-001", status: "done" }),
    entity({ id: "T-003", type: "task", title: "Blocked", parent: "S-001", dependsOn: ["T-001"] }),
    entity({ id: "T-004", type: "task", title: "Archived", parent: "S-001", archived: true })
  ]);

  assert.equal(renderReady(index, resolveAll(index)), `# Ready tasks

_Generated. Do not edit by hand._

- [ ] [T-001 · Ready](../entities/t-001.md) — todo
`);
});

test("renderBlocked lists all blocked entity types with direct and propagated blockers", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", title: "Auth", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic", title: "Platform" }),
    entity({ id: "S-001", type: "story", title: "Login", parent: "E-001" }),
    entity({ id: "S-002", type: "story", title: "Sessions", parent: "E-002", dependsOn: ["S-003"] }),
    entity({ id: "S-003", type: "story", title: "Data", parent: "E-002" }),
    entity({ id: "T-001", type: "task", title: "Form", parent: "S-001" }),
    entity({ id: "T-002", type: "task", title: "Cookie", parent: "S-002" }),
    entity({ id: "T-003", type: "task", title: "Schema", parent: "S-003" })
  ]);

  assert.equal(renderBlocked(index, resolveAll(index)), `# Blocked work

_Generated. Do not edit by hand._

- [E-001 · Auth](../entities/e-001.md) — blocked · waiting on E-002
- [E-002 · Platform](../entities/e-002.md) — blocked
- [S-001 · Login](../entities/s-001.md) — blocked · waiting on E-001
- [S-002 · Sessions](../entities/s-002.md) — blocked · waiting on S-003
- [T-001 · Form](../entities/t-001.md) — blocked · waiting on E-001
- [T-002 · Cookie](../entities/t-002.md) — blocked · waiting on S-002
`);
});

test("renderEpicIndex rejects non-epic ids", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" })
  ]);

  assert.throws(() => renderEpicIndex(index, "S-001", resolveAll(index)), /unknown epic id S-001/);
});
