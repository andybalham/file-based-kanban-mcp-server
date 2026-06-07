import type { ProjectId, ProjectMarker, ProjectState } from "@file-kanban/core";

/**
 * Structured registry error codes promised by the project resolution design.
 *
 * MCP tools, resources, HTTP handlers, and future watcher code should branch on these codes
 * instead of parsing human-readable error messages.
 */
export type RegistryErrorCode = "AMBIGUOUS_PROJECT" | "PROJECT_NOT_FOUND";

/**
 * Public project list item returned by registry discovery surfaces.
 *
 * The shape intentionally mirrors `project://list` and `GET /api/projects` so adapters can expose
 * registry state without leaking mutable `ProjectState` internals.
 */
export interface RegisteredProject {
  /** Stable portable id copied from `.worktracker/project.json`. */
  projectId: ProjectId;
  /** Human-readable title copied from the authoritative marker. */
  title: string;
  /** Absolute project root containing the `.worktracker/` subtree. */
  root: string;
}

/**
 * Inputs for bootstrapping a work-tracker project through the `init` tool.
 *
 * `init` is the only registry operation that does not first resolve an existing project. It either
 * returns the id from an existing marker or creates a marker, optionally seeds requirements, scans
 * immediately, and registers the new project in-process.
 */
export interface InitProjectArgs {
  /** Human-readable project title persisted into a newly created marker. */
  title: string;
  /** Optional initial requirements text written once to `.worktracker/requirements/source.md`. */
  intent?: string;
  /** Target repository root that should own the `.worktracker/` subtree. */
  root: string;
}

/**
 * Result returned from the idempotent `init` operation.
 */
export interface InitProjectResult {
  /** Existing or newly minted project id from the target root's marker. */
  projectId: ProjectId;
}

/**
 * Options used to create a server registry.
 *
 * The registry is a cache over markers discovered below these roots. It is deliberately not a
 * persistent database, so dropping and rebuilding it from watch roots must preserve the same
 * project identities.
 */
export interface ProjectRegistryOptions {
  /** Root directories scanned at boot and watched later for `.worktracker/project.json` markers. */
  watchRoots: string[];
}

/**
 * Contract for building the runtime state for one marked project.
 *
 * Registry implementation code will call this after `init` or marker discovery. Keeping the
 * builder as an explicit dependency makes the registry testable without coupling the contract to
 * concrete filesystem orchestration.
 */
export type ProjectStateBuilder = (root: string, marker: ProjectMarker) => Promise<ProjectState>;

/**
 * Server-owned in-memory registry for all discovered projects.
 *
 * This interface is the Phase 4 boundary consumed by future MCP, HTTP, watcher, and regeneration
 * modules. It follows the §9.0 resolution rules while acknowledging that project scanning is async,
 * so registration paths return promises even though lookup of already registered projects is sync.
 */
export interface ProjectRegistry {
  /**
   * Resolve a project id into its current runtime state.
   *
   * If `projectId` is omitted, exactly one registered project is required. Multiple projects raise
   * `AMBIGUOUS_PROJECT`; a supplied but unknown id raises `PROJECT_NOT_FOUND`.
   */
  resolveProject(projectId?: ProjectId): ProjectState;

  /**
   * List registered projects in deterministic order for MCP resources and HTTP project pickers.
   */
  listProjects(): RegisteredProject[];

  /**
   * Bootstrap or reuse a project marker, then synchronously register the resulting project state
   * within this process before returning to the caller.
   */
  init(args: InitProjectArgs): Promise<InitProjectResult>;

  /**
   * Register a project discovered by boot scanning or watcher marker detection.
   *
   * Existing markers converge on the same scan-and-insert path as `init`, preserving the design rule
   * that the registry can be rebuilt from markers without relying on machine-local state.
   */
  registerDiscovered(root: string, marker: ProjectMarker): Promise<ProjectState>;
}

/**
 * Error thrown when registry project resolution cannot produce one unambiguous project.
 *
 * Adapters should map `code` to their transport-specific structured error shape while preserving
 * `projectId` when a caller supplied an unknown id.
 */
export class RegistryError extends Error {
  /** Stable machine-readable registry error code from the technical design. */
  readonly code: RegistryErrorCode;

  /** Project id involved in a `PROJECT_NOT_FOUND` failure, when supplied by the caller. */
  readonly projectId?: ProjectId;

  /**
   * Create a structured registry error.
   */
  constructor(code: RegistryErrorCode, message: string, options: { projectId?: ProjectId } = {}) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.projectId = options.projectId;
  }
}
