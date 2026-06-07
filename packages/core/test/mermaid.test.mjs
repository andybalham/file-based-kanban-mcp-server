import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDependencies, renderEpicSubgraph, resolveAll } from "../dist/index.js";

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

test("renderDependencies emits deterministic same-type Mermaid bands with click targets", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", title: "Auth", dependsOn: ["E-002"] }),
    entity({ id: "E-002", type: "epic", title: "Platform" }),
    entity({ id: "S-001", type: "story", title: "Login", parent: "E-001", dependsOn: ["S-002"] }),
    entity({ id: "S-002", type: "story", title: "Sessions", parent: "E-002" }),
    entity({ id: "T-001", type: "task", title: "Form", parent: "S-001", dependsOn: ["T-002"] }),
    entity({ id: "T-002", type: "task", title: "Schema", parent: "S-002" }),
    entity({ id: "T-003", type: "task", title: "Archived", parent: "S-002", archived: true })
  ]);

  assert.equal(renderDependencies(index, resolveAll(index)), `graph LR
  classDef done fill:#c6f6d5,stroke:#22543d;
  classDef blocked fill:#fed7d7,stroke:#742a2a;
  classDef inprogress fill:#feebc8,stroke:#744210;
  classDef todo fill:#e2e8f0,stroke:#2d3748;
  classDef empty fill:#edf2f7,stroke:#718096,stroke-dasharray: 3 3;
  subgraph Epics
    E001["E-001 Auth"]:::blocked
    E002["E-002 Platform"]:::todo
    E002 --> E001
  end
  subgraph Stories
    S001["S-001 Login"]:::blocked
    S002["S-002 Sessions"]:::todo
    S002 --> S001
  end
  subgraph Tasks
    T001["T-001 Form"]:::blocked
    T002["T-002 Schema"]:::todo
    T002 --> T001
  end
  click E001 "../entities/e-001.md"
  click E002 "../entities/e-002.md"
  click S001 "../entities/s-001.md"
  click S002 "../entities/s-002.md"
  click T001 "../entities/t-001.md"
  click T002 "../entities/t-002.md"
`);
});

test("renderEpicSubgraph includes only an epic's own story and task dependency edges", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic", title: "Auth" }),
    entity({ id: "E-002", type: "epic", title: "Platform" }),
    entity({ id: "S-001", type: "story", title: "Login", parent: "E-001", dependsOn: ["S-002", "S-003"] }),
    entity({ id: "S-002", type: "story", title: "Sessions", parent: "E-001" }),
    entity({ id: "S-003", type: "story", title: "External", parent: "E-002" }),
    entity({ id: "T-001", type: "task", title: "Form", parent: "S-001", dependsOn: ["T-002", "T-003"] }),
    entity({ id: "T-002", type: "task", title: "Schema", parent: "S-002" }),
    entity({ id: "T-003", type: "task", title: "Outside", parent: "S-003" })
  ]);

  assert.equal(renderEpicSubgraph(index, "E-001", resolveAll(index)), `graph LR
  classDef done fill:#c6f6d5,stroke:#22543d;
  classDef blocked fill:#fed7d7,stroke:#742a2a;
  classDef inprogress fill:#feebc8,stroke:#744210;
  classDef todo fill:#e2e8f0,stroke:#2d3748;
  classDef empty fill:#edf2f7,stroke:#718096,stroke-dasharray: 3 3;
  subgraph Stories
    S001["S-001 Login"]:::blocked
    S002["S-002 Sessions"]:::todo
    S002 --> S001
  end
  subgraph Tasks
    T001["T-001 Form"]:::blocked
    T002["T-002 Schema"]:::todo
    T002 --> T001
  end
  click S001 "../entities/s-001.md"
  click S002 "../entities/s-002.md"
  click T001 "../entities/t-001.md"
  click T002 "../entities/t-002.md"
`);
});

test("renderEpicSubgraph rejects non-epic ids", () => {
  const index = indexFrom([
    entity({ id: "E-001", type: "epic" }),
    entity({ id: "S-001", type: "story", parent: "E-001" })
  ]);

  assert.throws(() => renderEpicSubgraph(index, "S-001", resolveAll(index)), /unknown epic id S-001/);
});
