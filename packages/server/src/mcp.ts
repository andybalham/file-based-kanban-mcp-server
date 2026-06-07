import type {
  EffectiveStatus,
  EntityId,
  EntityType,
  ProjectId,
  StoredStatus,
  ValidationIssue,
  ValidationResult
} from "@file-kanban/core";

import { RegistryError } from "./registry.js";
import type { RegisteredProject } from "./registry.js";

/**
 * Resource URI templates exposed by the MCP adapter.
 *
 * These strings mirror §9.1 exactly. The concrete adapter can register them with the MCP SDK while
 * tests and downstream modules can depend on this contract without importing SDK-specific types.
 */
export const MCP_RESOURCE_TEMPLATES = {
  projectList: "project://list",
  requirementsSource: "requirements://{project}/source",
  entity: "entity://{project}/{id}",
  dependenciesGraph: "graph://{project}/dependencies",
  epicGraph: "graph://{project}/epic/{id}",
  boardIndex: "index://{project}/board"
} as const;

/**
 * Stable MCP tool names from §9.2.
 *
 * Keeping the names centralized prevents later adapter code, tests, and documentation from drifting
 * when a tool implementation is added or refactored.
 */
export const MCP_TOOL_NAMES = [
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
] as const;

/**
 * Machine-readable MCP error codes promised by §9.4.
 *
 * Adapter code should return these codes verbatim in structured tool errors so agents can recover
 * programmatically instead of parsing prose.
 */
export const MCP_ERROR_CODES = [
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
] as const;

/** One registered resource key in {@link MCP_RESOURCE_TEMPLATES}. */
export type McpResourceKey = keyof typeof MCP_RESOURCE_TEMPLATES;

/** One registered MCP tool name in {@link MCP_TOOL_NAMES}. */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** One structured MCP error code in {@link MCP_ERROR_CODES}. */
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/**
 * Common optional project selector used by every project-scoped tool except `init` and
 * `list_projects`.
 */
export interface ProjectScopedToolArgs {
  /**
   * Optional project id resolved through the server registry.
   *
   * Omission is valid only when the registry contains exactly one project; otherwise the adapter
   * must surface `AMBIGUOUS_PROJECT`.
   */
  projectId?: ProjectId;
}

/** Arguments for the idempotent project bootstrap tool. */
export interface InitToolArgs {
  /** Human-readable title persisted to a newly created marker. */
  title: string;
  /** Optional requirements text seeded once when the project marker is first created. */
  intent?: string;
}

/** Result returned by `init`. */
export interface InitToolResult {
  /** Existing or newly created project id. */
  projectId: ProjectId;
}

/** Arguments accepted by `create_entity`. */
export interface CreateEntityToolArgs extends ProjectScopedToolArgs {
  /** Entity layer being created; controls id allocation, parent rules, and dependency type rules. */
  type: EntityType;
  /** Human-readable entity title. */
  title: string;
  /** Required epic parent for stories, required story parent for tasks, and forbidden for epics. */
  parent?: EntityId | null;
  /** Same-type dependencies to apply at creation time. */
  dependsOn?: EntityId[];
  /** Optional task estimate used by critical-path queries. */
  estimate?: number;
  /** Optional tags sorted by core serialization before persistence. */
  tags?: string[];
  /** Optional Markdown body written after frontmatter without generator rewrites. */
  body?: string;
}

/** Result returned by tools that create, update, move, or archive one entity. */
export interface EntityIdToolResult {
  /** Entity id affected by the operation. */
  id: EntityId;
}

/** Mutatable fields accepted by `update_entity`. */
export interface UpdateEntityFields {
  /** Replacement title, if the title is being changed. */
  title?: string;
  /** Replacement Markdown body, if the human-authored body is being changed. */
  body?: string;
  /** Replacement task estimate. */
  estimate?: number;
  /** Replacement tag set. */
  tags?: string[];
}

/** Arguments accepted by `update_entity`. */
export interface UpdateEntityToolArgs extends ProjectScopedToolArgs {
  /** Entity id to update within the selected project. */
  id: EntityId;
  /** Mutable fields; id, type, parent, status, and dependencies are intentionally absent. */
  fields: UpdateEntityFields;
}

/** Arguments accepted by `set_status`. */
export interface SetStatusToolArgs extends ProjectScopedToolArgs {
  /** Task id to update; story and epic ids must surface `NOT_A_TASK`. */
  id: EntityId;
  /** New stored status value. */
  status: StoredStatus;
}

/** Result returned by `set_status` after recomputing effective status. */
export interface SetStatusToolResult extends EntityIdToolResult {
  /** Effective status after dependency and hierarchy propagation. */
  effectiveStatus: EffectiveStatus;
}

/** Arguments accepted by `link_dependency` and `unlink_dependency`. */
export interface DependencyToolArgs extends ProjectScopedToolArgs {
  /** Entity that declares the dependency edge. */
  from: EntityId;
  /** Entity that must be completed before `from` can proceed. */
  to: EntityId;
}

/** Result returned by dependency edge tools. */
export interface DependencyToolResult {
  /** Entity that declares the dependency edge. */
  from: EntityId;
  /** Entity depended on by `from`. */
  to: EntityId;
}

/** Arguments accepted by `move_entity`. */
export interface MoveEntityToolArgs extends ProjectScopedToolArgs {
  /** Entity whose parent field should change. */
  id: EntityId;
  /** New parent id, or null when moving an epic to the root position. */
  newParent: EntityId | null;
}

/** Arguments accepted by `archive_entity`. */
export interface ArchiveEntityToolArgs extends ProjectScopedToolArgs {
  /** Entity to soft-delete by setting `archived: true`. */
  id: EntityId;
}

/** Result returned by `query_ready`. */
export interface QueryReadyToolResult {
  /** Effective-`todo` task ids that are currently workable. */
  tasks: EntityId[];
}

/** One blocked row returned by `query_blocked`. */
export interface QueryBlockedToolRow {
  /** Blocked entity id. */
  id: EntityId;
  /** Blocked entity layer. */
  type: EntityType;
  /** Same-type dependency or propagated ancestor ids explaining the block. */
  blockedBy: EntityId[];
}

/** Result returned by `query_blocked`. */
export interface QueryBlockedToolResult {
  /** Blocked entities across epics, stories, and tasks. */
  blocked: QueryBlockedToolRow[];
}

/** Arguments accepted by `critical_path`. */
export interface CriticalPathToolArgs extends ProjectScopedToolArgs {
  /** Same-type dependency graph to inspect; defaults to `task` in the implementation. */
  type?: EntityType;
}

/** Result returned by `critical_path`. */
export interface CriticalPathToolResult {
  /** Longest deterministic dependency chain. */
  path: EntityId[];
  /** Total path weight. */
  total: number;
}

/** Result returned by `list_projects`. */
export interface ListProjectsToolResult {
  /** Registered projects in deterministic order. */
  projects: RegisteredProject[];
}

/**
 * Argument contract for every MCP tool.
 *
 * This mapped type is the compile-time source of truth for adapter implementation signatures.
 */
export interface McpToolArgsByName {
  init: InitToolArgs;
  create_entity: CreateEntityToolArgs;
  update_entity: UpdateEntityToolArgs;
  set_status: SetStatusToolArgs;
  link_dependency: DependencyToolArgs;
  unlink_dependency: DependencyToolArgs;
  move_entity: MoveEntityToolArgs;
  archive_entity: ArchiveEntityToolArgs;
  query_ready: ProjectScopedToolArgs;
  query_blocked: ProjectScopedToolArgs;
  critical_path: CriticalPathToolArgs;
  validate: ProjectScopedToolArgs;
  list_projects: Record<string, never>;
}

/**
 * Result contract for every MCP tool.
 *
 * Mutating implementations must still validate before writing and trigger regeneration on success;
 * this type only fixes the public return shape.
 */
export interface McpToolResultByName {
  init: InitToolResult;
  create_entity: EntityIdToolResult;
  update_entity: EntityIdToolResult;
  set_status: SetStatusToolResult;
  link_dependency: DependencyToolResult;
  unlink_dependency: DependencyToolResult;
  move_entity: EntityIdToolResult;
  archive_entity: EntityIdToolResult;
  query_ready: QueryReadyToolResult;
  query_blocked: QueryBlockedToolResult;
  critical_path: CriticalPathToolResult;
  validate: ValidationResult;
  list_projects: ListProjectsToolResult;
}

/**
 * SDK-neutral tool definition used by tests and the future adapter registration loop.
 */
export interface McpToolDefinition<Name extends McpToolName = McpToolName> {
  /** Stable MCP tool name. */
  name: Name;
  /** Short description of the contract and its primary invariant. */
  description: string;
  /** Field names expected on the input object. */
  inputFields: readonly (keyof McpToolArgsByName[Name] & string)[];
  /** Field names returned on success. */
  resultFields: readonly (keyof McpToolResultByName[Name] & string)[];
  /** Whether the tool mutates project storage and therefore must run validation before commit. */
  mutates: boolean;
}

/**
 * Contract metadata for all §9.2 tools.
 *
 * Input and result field lists are intentionally simple. Runtime validation will be implemented by
 * the concrete adapter, while this metadata keeps the public surface auditable and deterministic.
 */
export const MCP_TOOL_DEFINITIONS: { [Name in McpToolName]: McpToolDefinition<Name> } = {
  init: {
    name: "init",
    description: "Create or reuse the current root's work-tracker project marker.",
    inputFields: ["title", "intent"],
    resultFields: ["projectId"],
    mutates: true
  },
  create_entity: {
    name: "create_entity",
    description: "Create an epic, story, or task with project-local ids and same-type dependencies.",
    inputFields: ["projectId", "type", "title", "parent", "dependsOn", "estimate", "tags", "body"],
    resultFields: ["id"],
    mutates: true
  },
  update_entity: {
    name: "update_entity",
    description: "Update mutable entity fields while preserving immutable identity and relationship fields.",
    inputFields: ["projectId", "id", "fields"],
    resultFields: ["id"],
    mutates: true
  },
  set_status: {
    name: "set_status",
    description: "Set the stored status for a task and return its recomputed effective status.",
    inputFields: ["projectId", "id", "status"],
    resultFields: ["id", "effectiveStatus"],
    mutates: true
  },
  link_dependency: {
    name: "link_dependency",
    description: "Create a same-type dependency edge inside one selected project.",
    inputFields: ["projectId", "from", "to"],
    resultFields: ["from", "to"],
    mutates: true
  },
  unlink_dependency: {
    name: "unlink_dependency",
    description: "Remove an existing same-type dependency edge inside one selected project.",
    inputFields: ["projectId", "from", "to"],
    resultFields: ["from", "to"],
    mutates: true
  },
  move_entity: {
    name: "move_entity",
    description: "Change an entity parent while preserving hierarchy invariants.",
    inputFields: ["projectId", "id", "newParent"],
    resultFields: ["id"],
    mutates: true
  },
  archive_entity: {
    name: "archive_entity",
    description: "Soft-delete an entity by marking it archived.",
    inputFields: ["projectId", "id"],
    resultFields: ["id"],
    mutates: true
  },
  query_ready: {
    name: "query_ready",
    description: "Return currently workable task ids for the selected project.",
    inputFields: ["projectId"],
    resultFields: ["tasks"],
    mutates: false
  },
  query_blocked: {
    name: "query_blocked",
    description: "Return blocked entities and blockers for the selected project.",
    inputFields: ["projectId"],
    resultFields: ["blocked"],
    mutates: false
  },
  critical_path: {
    name: "critical_path",
    description: "Return the longest weighted dependency path for a same-type graph.",
    inputFields: ["projectId", "type"],
    resultFields: ["path", "total"],
    mutates: false
  },
  validate: {
    name: "validate",
    description: "Return full graph validation errors and warnings for the selected project.",
    inputFields: ["projectId"],
    resultFields: ["errors", "warnings"],
    mutates: false
  },
  list_projects: {
    name: "list_projects",
    description: "Return all registered projects in deterministic order.",
    inputFields: [],
    resultFields: ["projects"],
    mutates: false
  }
};

/**
 * Structured error payload returned by MCP tools when a call fails.
 */
export interface McpStructuredError {
  /** Stable machine-readable code from §9.4. */
  code: McpErrorCode;
  /** Human-readable message intended to help an agent correct its next call. */
  message: string;
  /** Optional structured context such as ids, validation issues, or filesystem paths. */
  details?: unknown;
}

/**
 * Internal adapter error that already carries a §9.4 code.
 *
 * Tool implementations should throw this for contract-level failures they detect directly, then
 * use `toMcpStructuredError` at the adapter boundary.
 */
export class McpAdapterError extends Error {
  /** Stable machine-readable error code returned to the MCP client. */
  readonly code: McpErrorCode;

  /** Optional structured context returned as `details`. */
  readonly details?: unknown;

  /** Create a coded MCP adapter error. */
  constructor(code: McpErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "McpAdapterError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Convert known server/core errors into the structured MCP error payload.
 *
 * Unknown errors become `NOT_FOUND` only when they are entity lookup style errors raised by core
 * store primitives; all other unknown failures are rethrown so programming bugs are not disguised
 * as recoverable agent input errors.
 */
export function toMcpStructuredError(error: unknown): McpStructuredError {
  if (error instanceof McpAdapterError) {
    return withOptionalDetails(error.code, error.message, error.details);
  }

  if (error instanceof RegistryError) {
    return withOptionalDetails(error.code, error.message, error.projectId === undefined ? undefined : { projectId: error.projectId });
  }

  if (isNamedCoreLookupError(error)) {
    return { code: "NOT_FOUND", message: error.message };
  }

  throw error;
}

/**
 * Convert a core validation issue into the closest public MCP error code.
 *
 * Core validation names dangling references by graph role. The MCP surface exposes those as the
 * tool-oriented `NOT_FOUND` and `DEP_NOT_FOUND` codes promised in §9.4.
 */
export function validationIssueToMcpError(issue: ValidationIssue): McpStructuredError {
  const code = validationIssueCodeToMcpErrorCode(issue.code);
  return withOptionalDetails(code, issue.message, issue.entityId === undefined ? undefined : { entityId: issue.entityId });
}

/**
 * Convert a validation issue code into a §9.4 MCP code.
 */
export function validationIssueCodeToMcpErrorCode(code: string): McpErrorCode {
  switch (code) {
    case "DANGLING_PARENT":
      return "NOT_FOUND";
    case "DANGLING_DEPENDENCY":
      return "DEP_NOT_FOUND";
    case "INVALID_PARENT_TYPE":
    case "PARENT_REQUIRED":
    case "EPIC_HAS_PARENT":
    case "DEP_TYPE_MISMATCH":
    case "DEP_CYCLE":
    case "HIERARCHY_CYCLE":
    case "SELF_DEPENDENCY":
      return code;
    default:
      return "NOT_FOUND";
  }
}

/**
 * Return true when a string is one of the public MCP error codes.
 */
export function isMcpErrorCode(code: string): code is McpErrorCode {
  return (MCP_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Attach `details` only when there is useful structured context to return.
 */
function withOptionalDetails(code: McpErrorCode, message: string, details: unknown): McpStructuredError {
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Identify current core store lookup errors without coupling MCP contracts to private core classes.
 */
function isNamedCoreLookupError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "EntityMoveError" || error.name === "EntityParseError" || error.name === "ProjectMarkerParseError")
  );
}
