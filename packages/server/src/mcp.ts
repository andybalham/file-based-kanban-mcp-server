import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  EffectiveStatus,
  Entity,
  EntityId,
  EntityType,
  ProjectId,
  ProjectState,
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
 * Human-readable resource definitions used by the SDK registration layer.
 *
 * These definitions are intentionally SDK-neutral for the same reason the tool definitions below
 * are SDK-neutral: tests can verify the public MCP surface without depending on transport classes,
 * while the eventual stdio adapter can register the same metadata in a simple loop.
 */
export const MCP_RESOURCE_DEFINITIONS: { [Key in McpResourceKey]: McpResourceDefinition<Key> } = {
  projectList: {
    key: "projectList",
    uriTemplate: MCP_RESOURCE_TEMPLATES.projectList,
    description: "List registered work-tracker projects in deterministic order.",
    mimeType: "application/json"
  },
  requirementsSource: {
    key: "requirementsSource",
    uriTemplate: MCP_RESOURCE_TEMPLATES.requirementsSource,
    description: "Read the human-authored requirements source for a selected project.",
    mimeType: "text/markdown"
  },
  entity: {
    key: "entity",
    uriTemplate: MCP_RESOURCE_TEMPLATES.entity,
    description: "Read one entity with authoritative frontmatter fields and Markdown body.",
    mimeType: "application/json"
  },
  dependenciesGraph: {
    key: "dependenciesGraph",
    uriTemplate: MCP_RESOURCE_TEMPLATES.dependenciesGraph,
    description: "Read the generated full same-type dependency Mermaid graph.",
    mimeType: "text/plain"
  },
  epicGraph: {
    key: "epicGraph",
    uriTemplate: MCP_RESOURCE_TEMPLATES.epicGraph,
    description: "Read the generated Mermaid dependency subgraph for one epic.",
    mimeType: "text/plain"
  },
  boardIndex: {
    key: "boardIndex",
    uriTemplate: MCP_RESOURCE_TEMPLATES.boardIndex,
    description: "Read the generated top-level board Markdown index.",
    mimeType: "text/markdown"
  }
};

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

/** Media type returned for an MCP resource body. */
export type McpResourceMimeType = "application/json" | "text/markdown" | "text/plain";

/**
 * SDK-neutral definition for one public MCP resource.
 */
export interface McpResourceDefinition<Key extends McpResourceKey = McpResourceKey> {
  /** Stable resource key used by tests and registration loops. */
  key: Key;
  /** URI template from §9.1. */
  uriTemplate: (typeof MCP_RESOURCE_TEMPLATES)[Key];
  /** Short description of the resource contract. */
  description: string;
  /** Content type returned when this resource is read. */
  mimeType: McpResourceMimeType;
}

/**
 * Parsed parameters for a concrete resource read.
 */
export interface McpResourceReadArgs {
  /** Concrete resource key being read. */
  key: McpResourceKey;
  /** Optional project id extracted from the URI for project-scoped resources. */
  projectId?: ProjectId;
  /** Optional entity or epic id extracted from the URI. */
  id?: EntityId;
}

/**
 * Text response returned by a resource read.
 */
export interface McpResourceReadResult {
  /** Concrete URI that was read by the adapter. */
  uri: string;
  /** MIME type matching the resource definition. */
  mimeType: McpResourceMimeType;
  /** Resource body returned as UTF-8 text. JSON resources are already serialized. */
  text: string;
}

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
 * Minimal registry surface needed by read-only MCP resources.
 *
 * Using this narrow interface keeps resource tests lightweight while remaining compatible with the
 * full `ProjectRegistry` implementation from `registry.ts`.
 */
export interface McpResourceRegistry {
  /** Return deterministic public project summaries for `project://list`. */
  listProjects(): RegisteredProject[];
  /** Resolve a project id or raise the registry's structured project-selection error. */
  resolveProject(projectId?: ProjectId): ProjectState;
}

/**
 * Read one MCP resource without depending on MCP SDK transport classes.
 *
 * Project resources are deliberately side-effect free. They read the current in-memory state or the
 * generated/user-authored file that the design names in §9.1; they do not rescan, regenerate, or
 * normalize entity Markdown bodies during a read.
 */
export async function readMcpResource(
  registry: McpResourceRegistry,
  args: McpResourceReadArgs
): Promise<McpResourceReadResult> {
  switch (args.key) {
    case "projectList":
      return jsonResource(MCP_RESOURCE_TEMPLATES.projectList, "projectList", {
        projects: registry.listProjects()
      });
    case "requirementsSource":
      return textFileResource(
        concreteResourceUri(args),
        "requirementsSource",
        path.join(resolveResourceProject(registry, args).root, ".worktracker", "requirements", "source.md")
      );
    case "entity":
      return jsonResource(concreteResourceUri(args), "entity", serializeResourceEntity(resolveResourceEntity(registry, args)));
    case "dependenciesGraph":
      return textFileResource(
        concreteResourceUri(args),
        "dependenciesGraph",
        path.join(resolveResourceProject(registry, args).root, ".worktracker", "graphs", "dependencies.mmd")
      );
    case "epicGraph":
      return textFileResource(
        concreteResourceUri(args),
        "epicGraph",
        path.join(resolveResourceProject(registry, args).root, ".worktracker", "graphs", `${requiredResourceId(args)}.mmd`)
      );
    case "boardIndex":
      return textFileResource(
        concreteResourceUri(args),
        "boardIndex",
        path.join(resolveResourceProject(registry, args).root, ".worktracker", "index", "INDEX.md")
      );
  }
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
 * Resolve a concrete project for project-scoped resource reads.
 */
function resolveResourceProject(registry: McpResourceRegistry, args: McpResourceReadArgs): ProjectState {
  return registry.resolveProject(requiredResourceProjectId(args));
}

/**
 * Resolve one entity from the selected project.
 */
function resolveResourceEntity(registry: McpResourceRegistry, args: McpResourceReadArgs): Entity {
  const project = resolveResourceProject(registry, args);
  const id = requiredResourceId(args);
  const entity = project.index.byId.get(id);

  if (entity === undefined) {
    throw new McpAdapterError("NOT_FOUND", `Entity '${id}' was not found.`, { projectId: project.projectId, id });
  }

  return entity;
}

/**
 * Return the project id required by every project-scoped resource except `project://list`.
 */
function requiredResourceProjectId(args: McpResourceReadArgs): ProjectId {
  if (args.projectId === undefined || args.projectId.length === 0) {
    throw new McpAdapterError("PROJECT_NOT_FOUND", `Resource '${args.key}' requires a project id.`);
  }

  return args.projectId;
}

/**
 * Return the id required by entity and per-epic graph resources.
 */
function requiredResourceId(args: McpResourceReadArgs): EntityId {
  if (args.id === undefined || args.id.length === 0) {
    throw new McpAdapterError("NOT_FOUND", `Resource '${args.key}' requires an entity id.`);
  }

  return args.id;
}

/**
 * Serialize one entity as JSON without leaking Map instances or relying on filesystem parsing.
 */
function serializeResourceEntity(entity: Entity): Record<string, unknown> {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    parent: entity.parent,
    status: entity.status,
    dependsOn: entity.dependsOn,
    ...(entity.estimate === undefined ? {} : { estimate: entity.estimate }),
    tags: entity.tags,
    archived: entity.archived,
    created: entity.created,
    updated: entity.updated,
    body: entity.body,
    filePath: entity.filePath
  };
}

/**
 * Create a JSON resource response with stable pretty-printing for tests and agent readability.
 */
function jsonResource(uri: string, key: McpResourceKey, value: unknown): McpResourceReadResult {
  return {
    uri,
    mimeType: MCP_RESOURCE_DEFINITIONS[key].mimeType,
    text: `${JSON.stringify(value, null, 2)}\n`
  };
}

/**
 * Read a UTF-8 text file for generated Markdown, generated Mermaid, or seeded requirements.
 */
async function textFileResource(uri: string, key: McpResourceKey, filePath: string): Promise<McpResourceReadResult> {
  try {
    return {
      uri,
      mimeType: MCP_RESOURCE_DEFINITIONS[key].mimeType,
      text: await fs.readFile(filePath, "utf8")
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new McpAdapterError("NOT_FOUND", `Resource file '${filePath}' was not found.`, { filePath });
    }

    throw error;
  }
}

/**
 * Materialize the concrete URI for the already-parsed resource arguments.
 */
function concreteResourceUri(args: McpResourceReadArgs): string {
  switch (args.key) {
    case "projectList":
      return MCP_RESOURCE_TEMPLATES.projectList;
    case "requirementsSource":
      return `requirements://${requiredResourceProjectId(args)}/source`;
    case "entity":
      return `entity://${requiredResourceProjectId(args)}/${requiredResourceId(args)}`;
    case "dependenciesGraph":
      return `graph://${requiredResourceProjectId(args)}/dependencies`;
    case "epicGraph":
      return `graph://${requiredResourceProjectId(args)}/epic/${requiredResourceId(args)}`;
    case "boardIndex":
      return `index://${requiredResourceProjectId(args)}/board`;
  }
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

/**
 * Narrow unknown filesystem errors to Node errors with a stable `code` field.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
