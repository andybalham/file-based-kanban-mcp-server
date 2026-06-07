import type { ProjectState } from "@file-kanban/core";
import { createProjectRegistry } from "./registry.js";
import type { CreateProjectRegistryOptions, ProjectRegistry } from "./registry.js";

export type {
  InitProjectArgs,
  InitProjectResult,
  CreateProjectRegistryOptions,
  Clock,
  ProjectRegistry,
  ProjectRegistryOptions,
  ProjectIdFactory,
  ProjectStateBuilder,
  RegisteredProject,
  RegistryErrorCode
} from "./registry.js";
export { createProjectRegistry, RegistryError } from "./registry.js";

export {
  MCP_ERROR_CODES,
  MCP_RESOURCE_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  McpAdapterError,
  executeMcpQueryTool,
  isMcpErrorCode,
  readMcpResource,
  toMcpStructuredError,
  validationIssueCodeToMcpErrorCode,
  validationIssueToMcpError
} from "./mcp.js";
export type {
  ArchiveEntityToolArgs,
  CreateEntityToolArgs,
  CriticalPathToolArgs,
  CriticalPathToolResult,
  DependencyToolArgs,
  DependencyToolResult,
  EntityIdToolResult,
  InitToolArgs,
  InitToolResult,
  ListProjectsToolResult,
  McpErrorCode,
  McpResourceDefinition,
  McpResourceKey,
  McpResourceMimeType,
  McpResourceReadArgs,
  McpResourceReadResult,
  McpResourceRegistry,
  McpQueryToolName,
  McpQueryToolRegistry,
  McpStructuredError,
  McpToolArgsByName,
  McpToolDefinition,
  McpToolName,
  McpToolResultByName,
  MoveEntityToolArgs,
  ProjectScopedToolArgs,
  QueryBlockedToolResult,
  QueryBlockedToolRow,
  QueryReadyToolResult,
  SetStatusToolArgs,
  SetStatusToolResult,
  UpdateEntityFields,
  UpdateEntityToolArgs
} from "./mcp.js";

export { regenerateProject } from "./regenerate.js";
export type { RegenerateProjectOptions, RegenerationResult, WriteSuppressionSet } from "./regenerate.js";

/**
 * Create the process-wide project registry and immediately populate it from configured watch roots.
 *
 * This is the server startup path described in the technical design: already-marked repositories
 * become routable because their `.worktracker/project.json` markers are found during boot, without
 * requiring agents to call `init`. The lower-level registry still exposes `discover()` separately
 * for tests, future watcher refreshes, and explicit rescan flows.
 */
export async function bootstrapProjectRegistry(options: CreateProjectRegistryOptions): Promise<ProjectRegistry> {
  const registry = createProjectRegistry(options);
  await registry.discover();
  return registry;
}

/**
 * Produce a compact human-readable label for a project.
 *
 * This helper is intentionally small in Phase 0: it proves the server package can consume the
 * core public type surface while later registry and MCP work are still unimplemented.
 */
export function describeProject(state: ProjectState): string {
  // The marker title is user-facing, while the project id disambiguates projects with similar names.
  return `${state.marker.title} (${state.projectId})`;
}
