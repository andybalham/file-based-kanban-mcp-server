import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MCP_ERROR_CODES,
  MCP_RESOURCE_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  McpAdapterError,
  RegistryError,
  executeMcpMutationTool,
  executeMcpQueryTool,
  isMcpErrorCode,
  readMcpResource,
  toMcpStructuredError,
  validationIssueCodeToMcpErrorCode,
  validationIssueToMcpError
} from "../dist/main.js";

test("MCP resource templates match the design surface", () => {
  assert.deepEqual(MCP_RESOURCE_TEMPLATES, {
    projectList: "project://list",
    requirementsSource: "requirements://{project}/source",
    entity: "entity://{project}/{id}",
    dependenciesGraph: "graph://{project}/dependencies",
    epicGraph: "graph://{project}/epic/{id}",
    boardIndex: "index://{project}/board"
  });
});

test("MCP resource definitions expose every design resource in deterministic order", () => {
  assert.deepEqual(Object.keys(MCP_RESOURCE_DEFINITIONS), [
    "projectList",
    "requirementsSource",
    "entity",
    "dependenciesGraph",
    "epicGraph",
    "boardIndex"
  ]);
  assert.equal(MCP_RESOURCE_DEFINITIONS.projectList.uriTemplate, "project://list");
  assert.equal(MCP_RESOURCE_DEFINITIONS.projectList.mimeType, "application/json");
  assert.equal(MCP_RESOURCE_DEFINITIONS.entity.mimeType, "application/json");
  assert.equal(MCP_RESOURCE_DEFINITIONS.requirementsSource.mimeType, "text/markdown");
  assert.equal(MCP_RESOURCE_DEFINITIONS.dependenciesGraph.mimeType, "text/plain");
  assert.equal(MCP_RESOURCE_DEFINITIONS.boardIndex.mimeType, "text/markdown");
});

test("readMcpResource returns project list and entity JSON without filesystem rewrites", async () => {
  const root = await makeTempRoot("file-kanban-mcp-resources-");
  const state = projectState(root);
  const registry = resourceRegistry([state]);

  const projectList = await readMcpResource(registry, { key: "projectList" });
  assert.equal(projectList.uri, "project://list");
  assert.equal(projectList.mimeType, "application/json");
  assert.deepEqual(JSON.parse(projectList.text), {
    projects: [
      {
        projectId: "wt_resource",
        title: "Resource Project",
        root
      }
    ]
  });

  const entity = await readMcpResource(registry, {
    key: "entity",
    projectId: "wt_resource",
    id: "T-001"
  });
  assert.equal(entity.uri, "entity://wt_resource/T-001");
  assert.equal(entity.mimeType, "application/json");
  assert.deepEqual(JSON.parse(entity.text), {
    id: "T-001",
    type: "task",
    title: "Read resource",
    parent: "S-001",
    status: "todo",
    dependsOn: [],
    tags: ["mcp"],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z",
    body: "\nHuman-authored body.\n",
    filePath: path.join(root, ".worktracker", "entities", "T-001-read-resource.md")
  });
});

test("readMcpResource returns raw requirements, graph, epic graph, and board text", async () => {
  const root = await makeTempRoot("file-kanban-mcp-files-");
  const registry = resourceRegistry([projectState(root)]);

  await writeText(root, path.join(".worktracker", "requirements", "source.md"), "Requirements\n");
  await writeText(root, path.join(".worktracker", "graphs", "dependencies.mmd"), "graph LR\n");
  await writeText(root, path.join(".worktracker", "graphs", "E-001.mmd"), "graph TB\n");
  await writeText(root, path.join(".worktracker", "index", "INDEX.md"), "# Project board\n");

  assert.deepEqual(await readMcpResource(registry, { key: "requirementsSource", projectId: "wt_resource" }), {
    uri: "requirements://wt_resource/source",
    mimeType: "text/markdown",
    text: "Requirements\n"
  });
  assert.deepEqual(await readMcpResource(registry, { key: "dependenciesGraph", projectId: "wt_resource" }), {
    uri: "graph://wt_resource/dependencies",
    mimeType: "text/plain",
    text: "graph LR\n"
  });
  assert.deepEqual(await readMcpResource(registry, { key: "epicGraph", projectId: "wt_resource", id: "E-001" }), {
    uri: "graph://wt_resource/epic/E-001",
    mimeType: "text/plain",
    text: "graph TB\n"
  });
  assert.deepEqual(await readMcpResource(registry, { key: "boardIndex", projectId: "wt_resource" }), {
    uri: "index://wt_resource/board",
    mimeType: "text/markdown",
    text: "# Project board\n"
  });
});

test("readMcpResource surfaces missing generated files as structured MCP not found errors", async () => {
  const root = await makeTempRoot("file-kanban-mcp-missing-");
  const registry = resourceRegistry([projectState(root)]);

  await assert.rejects(
    () => readMcpResource(registry, { key: "boardIndex", projectId: "wt_resource" }),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "NOT_FOUND",
        message: `Resource file '${path.join(root, ".worktracker", "index", "INDEX.md")}' was not found.`,
        details: {
          filePath: path.join(root, ".worktracker", "index", "INDEX.md")
        }
      });
      return true;
    }
  );
});

test("MCP tool definitions expose every design tool in deterministic order", () => {
  assert.deepEqual(MCP_TOOL_NAMES, [
    "init",
    "create_entity",
    "update_entity",
    "set_status",
    "link_dependency",
    "unlink_dependency",
    "move_entity",
    "archive_entity",
    "query_ready",
    "query_blocked",
    "critical_path",
    "validate",
    "list_projects"
  ]);

  assert.deepEqual(Object.keys(MCP_TOOL_DEFINITIONS), MCP_TOOL_NAMES);
  assert.equal(MCP_TOOL_DEFINITIONS.list_projects.mutates, false);
  assert.equal(MCP_TOOL_DEFINITIONS.link_dependency.mutates, true);
  assert.deepEqual(MCP_TOOL_DEFINITIONS.link_dependency.inputFields, ["projectId", "from", "to"]);
  assert.deepEqual(MCP_TOOL_DEFINITIONS.set_status.resultFields, ["id", "effectiveStatus"]);
});

test("executeMcpQueryTool returns registered projects and validation results", () => {
  const root = path.join(os.tmpdir(), "file-kanban-query-list");
  const registry = resourceRegistry([queryProjectState(root)]);

  assert.deepEqual(executeMcpQueryTool(registry, "list_projects", {}), {
    projects: [
      {
        projectId: "wt_query",
        title: "Query Project",
        root
      }
    ]
  });

  assert.deepEqual(executeMcpQueryTool(registry, "validate", { projectId: "wt_query" }), {
    errors: [],
    warnings: []
  });
});

test("executeMcpQueryTool returns ready tasks and blocked entities with blockers", () => {
  const registry = resourceRegistry([queryProjectState(path.join(os.tmpdir(), "file-kanban-query-status"))]);

  assert.deepEqual(executeMcpQueryTool(registry, "query_ready", { projectId: "wt_query" }), {
    tasks: ["T-001"]
  });

  assert.deepEqual(executeMcpQueryTool(registry, "query_blocked", { projectId: "wt_query" }), {
    blocked: [
      { id: "E-001", type: "epic", blockedBy: [] },
      { id: "S-001", type: "story", blockedBy: [] },
      { id: "S-002", type: "story", blockedBy: ["S-001"] },
      { id: "T-003", type: "task", blockedBy: ["T-001"] },
      { id: "T-005", type: "task", blockedBy: ["S-002"] }
    ]
  });
});

test("executeMcpQueryTool returns deterministic critical path by selected type", () => {
  const registry = resourceRegistry([queryProjectState(path.join(os.tmpdir(), "file-kanban-query-path"))]);

  assert.deepEqual(executeMcpQueryTool(registry, "critical_path", { projectId: "wt_query" }), {
    path: ["T-002", "T-001", "T-003"],
    total: 6
  });

  assert.deepEqual(executeMcpQueryTool(registry, "critical_path", { projectId: "wt_query", type: "story" }), {
    path: ["S-001", "S-002"],
    total: 2
  });
});

test("executeMcpQueryTool uses registry project resolution errors", () => {
  const registry = resourceRegistry([
    queryProjectState(path.join(os.tmpdir(), "file-kanban-query-one")),
    {
      ...queryProjectState(path.join(os.tmpdir(), "file-kanban-query-two")),
      projectId: "wt_second",
      marker: {
        projectId: "wt_second",
        title: "Second Project",
        created: "2026-06-07T00:00:00Z"
      }
    }
  ]);

  assert.throws(
    () => executeMcpQueryTool(registry, "query_ready", {}),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "AMBIGUOUS_PROJECT",
        message: "Multiple projects are registered; provide projectId to choose one."
      });
      return true;
    }
  );
});

test("executeMcpMutationTool creates an entity and regenerates selected project artifacts", async () => {
  const root = await makeTempRoot("file-kanban-mcp-create-");
  const state = mutationProjectState(root);
  await seedEntityFiles(root, state);
  const registry = resourceRegistry([state]);

  const result = await executeMcpMutationTool(
    registry,
    "create_entity",
    {
      type: "story",
      title: "Created from MCP",
      parent: "E-001",
      tags: ["mcp", "created"],
      body: "\nCreated body.\n"
    },
    { now: fixedNow }
  );

  assert.deepEqual(result, { id: "S-002" });
  assert.equal(state.index.byId.get("S-002").title, "Created from MCP");
  assert.match(await fs.readFile(path.join(root, ".worktracker", "entities", "S-002-created-from-mcp.md"), "utf8"), /id: S-002/);
  assert.match(await fs.readFile(path.join(root, ".worktracker", "index", "INDEX.md"), "utf8"), /Created from MCP/);
});

test("executeMcpMutationTool updates fields, task status, parent, and archived flag", async () => {
  const root = await makeTempRoot("file-kanban-mcp-mutates-");
  const state = mutationProjectState(root);
  await seedEntityFiles(root, state);
  const registry = resourceRegistry([state]);

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "update_entity",
      {
        projectId: "wt_mutation",
        id: "T-001",
        fields: {
          title: "Updated task",
          estimate: 5,
          tags: ["updated"]
        }
      },
      { now: fixedNow }
    ),
    { id: "T-001" }
  );
  assert.equal(state.index.byId.get("T-001").title, "Updated task");
  assert.equal(state.index.byId.get("T-001").updated, "2026-06-07T12:00:00Z");

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "set_status",
      { projectId: "wt_mutation", id: "T-001", status: "done" },
      { now: fixedNow }
    ),
    { id: "T-001", effectiveStatus: "done" }
  );

  await executeMcpMutationTool(
    registry,
    "create_entity",
    { projectId: "wt_mutation", type: "story", title: "Second story", parent: "E-001" },
    { now: fixedNow }
  );
  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "move_entity",
      { projectId: "wt_mutation", id: "T-001", newParent: "S-002" },
      { now: fixedNow }
    ),
    { id: "T-001" }
  );
  assert.equal(state.index.byId.get("T-001").parent, "S-002");

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "archive_entity",
      { projectId: "wt_mutation", id: "T-001" },
      { now: fixedNow }
    ),
    { id: "T-001" }
  );
  assert.equal(state.index.byId.get("T-001").archived, true);
});

test("executeMcpMutationTool links and unlinks dependencies for every entity type", async () => {
  const root = await makeTempRoot("file-kanban-mcp-dependencies-");
  const state = mutationProjectState(root);
  await seedEntityFiles(root, state);
  const registry = resourceRegistry([state]);

  await executeMcpMutationTool(registry, "create_entity", { projectId: "wt_mutation", type: "epic", title: "Second epic" }, { now: fixedNow });
  await executeMcpMutationTool(
    registry,
    "create_entity",
    { projectId: "wt_mutation", type: "story", title: "Second story", parent: "E-001" },
    { now: fixedNow }
  );
  await executeMcpMutationTool(
    registry,
    "create_entity",
    { projectId: "wt_mutation", type: "task", title: "Second task", parent: "S-001" },
    { now: fixedNow }
  );

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "link_dependency",
      { projectId: "wt_mutation", from: "E-002", to: "E-001" },
      { now: fixedNow }
    ),
    { from: "E-002", to: "E-001" }
  );
  assert.deepEqual(state.index.byId.get("E-002").dependsOn, ["E-001"]);

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "link_dependency",
      { projectId: "wt_mutation", from: "S-002", to: "S-001" },
      { now: fixedNow }
    ),
    { from: "S-002", to: "S-001" }
  );
  assert.deepEqual(state.index.byId.get("S-002").dependsOn, ["S-001"]);

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "link_dependency",
      { projectId: "wt_mutation", from: "T-002", to: "T-001" },
      { now: fixedNow }
    ),
    { from: "T-002", to: "T-001" }
  );
  assert.deepEqual(state.index.byId.get("T-002").dependsOn, ["T-001"]);
  assert.match(await fs.readFile(path.join(root, ".worktracker", "entities", "T-002-second-task.md"), "utf8"), /dependsOn: \[T-001\]/);

  assert.deepEqual(
    await executeMcpMutationTool(
      registry,
      "unlink_dependency",
      { projectId: "wt_mutation", from: "T-002", to: "T-001" },
      { now: fixedNow }
    ),
    { from: "T-002", to: "T-001" }
  );
  assert.deepEqual(state.index.byId.get("T-002").dependsOn, []);
  assert.match(await fs.readFile(path.join(root, ".worktracker", "entities", "T-002-second-task.md"), "utf8"), /dependsOn: \[\]/);
});

test("executeMcpMutationTool rejects invalid dependency edits before touching the store", async () => {
  const root = await makeTempRoot("file-kanban-mcp-dependency-rejects-");
  const state = mutationProjectState(root);
  await seedEntityFiles(root, state);
  const registry = resourceRegistry([state]);

  await executeMcpMutationTool(
    registry,
    "create_entity",
    { projectId: "wt_mutation", type: "task", title: "Second task", parent: "S-001" },
    { now: fixedNow }
  );

  const taskPath = path.join(root, ".worktracker", "entities", "T-002-second-task.md");
  await executeMcpMutationTool(
    registry,
    "link_dependency",
    { projectId: "wt_mutation", from: "T-002", to: "T-001" },
    { now: fixedNow }
  );
  const before = await fs.readFile(taskPath, "utf8");

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "link_dependency",
        { projectId: "wt_mutation", from: "T-002", to: "S-001" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "DEP_TYPE_MISMATCH",
        message: "task dependency 'S-001' must also be a task.",
        details: { from: "T-002", to: "S-001", fromType: "task", toType: "story" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "link_dependency",
        { projectId: "wt_mutation", from: "T-002", to: "T-002" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "SELF_DEPENDENCY",
        message: "Entity 'T-002' cannot depend on itself.",
        details: { id: "T-002" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "link_dependency",
        { projectId: "wt_mutation", from: "T-002", to: "T-001" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "DUPLICATE_DEPENDENCY",
        message: "Entity 'T-002' already depends on 'T-001'.",
        details: { from: "T-002", to: "T-001" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "unlink_dependency",
        { projectId: "wt_mutation", from: "T-001", to: "T-002" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "NOT_LINKED",
        message: "Entity 'T-001' does not depend on 'T-002'.",
        details: { from: "T-001", to: "T-002" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "link_dependency",
        { projectId: "wt_mutation", from: "T-001", to: "T-002" },
        { now: fixedNow }
      ),
    (error) => {
      assert.equal(toMcpStructuredError(error).code, "DEP_CYCLE");
      return true;
    }
  );

  assert.equal(await fs.readFile(taskPath, "utf8"), before);
});

test("executeMcpMutationTool rejects invalid proposals before touching the store", async () => {
  const root = await makeTempRoot("file-kanban-mcp-rejects-");
  const state = mutationProjectState(root);
  await seedEntityFiles(root, state);
  const registry = resourceRegistry([state]);
  const taskPath = path.join(root, ".worktracker", "entities", "T-001-task.md");
  const before = await fs.readFile(taskPath, "utf8");

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "set_status",
        { projectId: "wt_mutation", id: "S-001", status: "done" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "NOT_A_TASK",
        message: "Entity 'S-001' is a story; only tasks store status.",
        details: { id: "S-001", type: "story" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "move_entity",
        { projectId: "wt_mutation", id: "T-001", newParent: "E-001" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "INVALID_PARENT_TYPE",
        message: "task parent 'E-001' must be a story.",
        details: { entityId: "T-001" }
      });
      return true;
    }
  );

  await assert.rejects(
    () =>
      executeMcpMutationTool(
        registry,
        "create_entity",
        { projectId: "wt_mutation", type: "story", title: "No parent" },
        { now: fixedNow }
      ),
    (error) => {
      assert.deepEqual(toMcpStructuredError(error), {
        code: "PARENT_REQUIRED",
        message: "story entities must declare a parent.",
        details: { entityId: "S-__new__" }
      });
      return true;
    }
  );

  assert.equal(await fs.readFile(taskPath, "utf8"), before);
  await assert.rejects(() => fs.access(path.join(root, ".worktracker", ".meta", "counters.json")));
});

test("MCP error code registry includes every structured design error", () => {
  assert.deepEqual(MCP_ERROR_CODES, [
    "NOT_FOUND",
    "INVALID_PARENT_TYPE",
    "PARENT_REQUIRED",
    "EPIC_HAS_PARENT",
    "NOT_A_TASK",
    "DEP_NOT_FOUND",
    "DEP_TYPE_MISMATCH",
    "DEP_CYCLE",
    "HIERARCHY_CYCLE",
    "SELF_DEPENDENCY",
    "DUPLICATE_DEPENDENCY",
    "NOT_LINKED",
    "IMMUTABLE_FIELD",
    "INVALID_STATUS",
    "AMBIGUOUS_PROJECT",
    "PROJECT_NOT_FOUND",
    "NOT_A_PROJECT"
  ]);

  assert.equal(isMcpErrorCode("DEP_TYPE_MISMATCH"), true);
  assert.equal(isMcpErrorCode("DANGLING_DEPENDENCY"), false);
});

test("toMcpStructuredError preserves adapter and registry structured details", () => {
  assert.deepEqual(toMcpStructuredError(new McpAdapterError("NOT_A_TASK", "Only tasks store status.", { id: "S-001" })), {
    code: "NOT_A_TASK",
    message: "Only tasks store status.",
    details: { id: "S-001" }
  });

  assert.deepEqual(
    toMcpStructuredError(
      new RegistryError("PROJECT_NOT_FOUND", "Project 'wt_missing' is not registered.", { projectId: "wt_missing" })
    ),
    {
      code: "PROJECT_NOT_FOUND",
      message: "Project 'wt_missing' is not registered.",
      details: { projectId: "wt_missing" }
    }
  );
});

async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeText(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

function resourceRegistry(states) {
  return {
    listProjects() {
      return states
        .map((state) => ({
          projectId: state.projectId,
          title: state.marker.title,
          root: state.root
        }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId) || left.root.localeCompare(right.root));
    },
    resolveProject(projectId) {
      if (projectId === undefined) {
        if (states.length === 1) {
          return states[0];
        }

        if (states.length === 0) {
          throw new RegistryError("PROJECT_NOT_FOUND", "No projects are registered.");
        }

        throw new RegistryError(
          "AMBIGUOUS_PROJECT",
          "Multiple projects are registered; provide projectId to choose one."
        );
      }

      const state = states.find((candidate) => candidate.projectId === projectId);
      if (state === undefined) {
        throw new RegistryError("PROJECT_NOT_FOUND", `Project '${projectId}' is not registered.`, { projectId });
      }

      return state;
    }
  };
}

function projectState(root) {
  const epic = entity({ id: "E-001", type: "epic", title: "Epic", parent: null });
  const story = entity({ id: "S-001", type: "story", title: "Story", parent: "E-001" });
  const task = entity({
    id: "T-001",
    type: "task",
    title: "Read resource",
    parent: "S-001",
    tags: ["mcp"],
    body: "\nHuman-authored body.\n",
    filePath: path.join(root, ".worktracker", "entities", "T-001-read-resource.md")
  });

  return {
    projectId: "wt_resource",
    root,
    marker: {
      projectId: "wt_resource",
      title: "Resource Project",
      created: "2026-06-07T00:00:00Z"
    },
    index: {
      byId: new Map([
        [epic.id, epic],
        [story.id, story],
        [task.id, task]
      ]),
      childrenOf: new Map([
        [epic.id, [story.id]],
        [story.id, [task.id]]
      ])
    },
    eff: new Map([
      [epic.id, "todo"],
      [story.id, "todo"],
      [task.id, "todo"]
    ])
  };
}

function queryProjectState(root) {
  const epic = entity({ id: "E-001", type: "epic", title: "Epic", parent: null });
  const story = entity({ id: "S-001", type: "story", title: "Story", parent: "E-001" });
  const gatedStory = entity({
    id: "S-002",
    type: "story",
    title: "Gated story",
    parent: "E-001",
    dependsOn: ["S-001"]
  });
  const readyTask = entity({
    id: "T-001",
    title: "Ready task",
    parent: "S-001",
    dependsOn: ["T-002"],
    estimate: 2
  });
  const completedPrerequisite = entity({
    id: "T-002",
    title: "Completed prerequisite",
    parent: "S-001",
    status: "done",
    estimate: 3
  });
  const blockedTask = entity({
    id: "T-003",
    title: "Blocked task",
    parent: "S-001",
    dependsOn: ["T-001"],
    estimate: 1
  });
  const activeTask = entity({
    id: "T-004",
    title: "Active task",
    parent: "S-001",
    status: "in-progress"
  });
  const propagatedTask = entity({
    id: "T-005",
    title: "Propagated task",
    parent: "S-002"
  });
  const entities = [epic, story, gatedStory, readyTask, completedPrerequisite, blockedTask, activeTask, propagatedTask];

  return {
    projectId: "wt_query",
    root,
    marker: {
      projectId: "wt_query",
      title: "Query Project",
      created: "2026-06-07T00:00:00Z"
    },
    index: {
      byId: new Map(entities.map((current) => [current.id, current])),
      childrenOf: new Map([
        [epic.id, [story.id, gatedStory.id]],
        [story.id, [readyTask.id, completedPrerequisite.id, blockedTask.id, activeTask.id]],
        [gatedStory.id, [propagatedTask.id]]
      ])
    },
    eff: new Map()
  };
}

function mutationProjectState(root) {
  const epic = entity({
    id: "E-001",
    type: "epic",
    title: "Epic",
    parent: null,
    filePath: path.join(root, ".worktracker", "entities", "E-001-epic.md")
  });
  const story = entity({
    id: "S-001",
    type: "story",
    title: "Story",
    parent: "E-001",
    filePath: path.join(root, ".worktracker", "entities", "S-001-story.md")
  });
  const task = entity({
    id: "T-001",
    type: "task",
    title: "Task",
    parent: "S-001",
    filePath: path.join(root, ".worktracker", "entities", "T-001-task.md")
  });
  const entities = [epic, story, task];

  return {
    projectId: "wt_mutation",
    root,
    marker: {
      projectId: "wt_mutation",
      title: "Mutation Project",
      created: "2026-06-07T00:00:00Z"
    },
    index: {
      byId: new Map(entities.map((current) => [current.id, current])),
      childrenOf: new Map([
        [epic.id, [story.id]],
        [story.id, [task.id]]
      ])
    },
    eff: new Map([
      [epic.id, "todo"],
      [story.id, "todo"],
      [task.id, "todo"]
    ])
  };
}

async function seedEntityFiles(root, state) {
  for (const current of state.index.byId.values()) {
    await writeText(root, path.relative(root, current.filePath), serializeTestEntity(current));
  }
}

function serializeTestEntity(current) {
  return `---
id: ${current.id}
type: ${current.type}
title: ${current.title}
parent: ${current.parent === null ? "null" : current.parent}
${current.type === "task" ? `status: ${current.status}\n` : ""}dependsOn: [${current.dependsOn.join(", ")}]
${current.estimate === undefined ? "" : `estimate: ${current.estimate}\n`}tags: [${current.tags.join(", ")}]
archived: ${current.archived ? "true" : "false"}
created: ${current.created}
updated: ${current.updated}
---
${current.body}`;
}

function fixedNow() {
  return new Date("2026-06-07T12:00:00Z");
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

test("validation issue mapping exposes public MCP error codes", () => {
  assert.equal(validationIssueCodeToMcpErrorCode("DANGLING_PARENT"), "NOT_FOUND");
  assert.equal(validationIssueCodeToMcpErrorCode("DANGLING_DEPENDENCY"), "DEP_NOT_FOUND");
  assert.equal(validationIssueCodeToMcpErrorCode("DEP_TYPE_MISMATCH"), "DEP_TYPE_MISMATCH");

  assert.deepEqual(
    validationIssueToMcpError({
      code: "DEP_TYPE_MISMATCH",
      entityId: "T-001",
      message: "task dependency 'S-001' must also be a task."
    }),
    {
      code: "DEP_TYPE_MISMATCH",
      message: "task dependency 'S-001' must also be a task.",
      details: { entityId: "T-001" }
    }
  );
});
