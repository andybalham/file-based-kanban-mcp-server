import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MCP_ERROR_CODES,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  McpAdapterError,
  RegistryError,
  isMcpErrorCode,
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
