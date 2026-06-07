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
 * Construction options for the in-memory registry implementation.
 *
 * `initialProjects` is deliberately a list of fully built states. That lets boot discovery, tests,
 * and future watcher code share the same resolution implementation without making this module scan
 * files before the Phase 4 discovery/init tasks wire those paths in.
 */
export interface CreateProjectRegistryOptions extends ProjectRegistryOptions {
  /** Optional project states already built by discovery or tests and ready for immediate lookup. */
  initialProjects?: ProjectState[];
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

/**
 * Create the server's in-memory project registry.
 *
 * The registry stores projects by root, matching the design's `Map<root, ProjectState>`, and builds
 * project-id lookup results from that source map. Keeping root as the primary key ensures repeated
 * registration of the same root replaces stale runtime state instead of creating duplicates.
 */
export function createProjectRegistry(options: CreateProjectRegistryOptions): ProjectRegistry {
  return new InMemoryProjectRegistry(options);
}

/**
 * Minimal Phase 4 registry implementation for project resolution and listing.
 *
 * Filesystem-backed `init`, marker discovery, and boot scanning are intentionally left as guarded
 * extension points for their specific tasks. The resolution behavior here is complete and shared by
 * those future paths once they populate `projectsByRoot`.
 */
class InMemoryProjectRegistry implements ProjectRegistry {
  /**
   * Runtime cache keyed by project root, exactly as required by §9.0.
   */
  private readonly projectsByRoot = new Map<string, ProjectState>();

  /**
   * Watch roots are retained for future boot discovery and watcher wiring.
   */
  private readonly watchRoots: string[];

  /**
   * Seed the registry with already-built project states.
   */
  constructor(options: CreateProjectRegistryOptions) {
    this.watchRoots = [...options.watchRoots];

    for (const project of options.initialProjects ?? []) {
      this.projectsByRoot.set(project.root, project);
    }
  }

  /**
   * Resolve an optional project id according to the exact §9.0 surface rules.
   */
  resolveProject(projectId?: ProjectId): ProjectState {
    if (projectId !== undefined) {
      const state = this.findProjectById(projectId);
      if (state === undefined) {
        throw new RegistryError("PROJECT_NOT_FOUND", `Project '${projectId}' is not registered.`, { projectId });
      }

      return state;
    }

    const states = this.sortedStates();
    if (states.length === 1) {
      return states[0] as ProjectState;
    }

    if (states.length === 0) {
      throw new RegistryError("PROJECT_NOT_FOUND", "No projects are registered.");
    }

    throw new RegistryError(
      "AMBIGUOUS_PROJECT",
      "Multiple projects are registered; provide projectId to choose one."
    );
  }

  /**
   * Return deterministic public project summaries for discovery resources and viewer APIs.
   */
  listProjects(): RegisteredProject[] {
    return this.sortedStates().map((state) => ({
      projectId: state.projectId,
      title: state.marker.title,
      root: state.root
    }));
  }

  /**
   * Placeholder for the queued init bootstrap task.
   */
  async init(_args: InitProjectArgs): Promise<InitProjectResult> {
    throw new Error("Project registry init is not implemented yet.");
  }

  /**
   * Placeholder for the queued discovered-registration task.
   */
  async registerDiscovered(_root: string, _marker: ProjectMarker): Promise<ProjectState> {
    throw new Error("Project discovery registration is not implemented yet.");
  }

  /**
   * Search registered states by marker id while preserving root as the source map key.
   */
  private findProjectById(projectId: ProjectId): ProjectState | undefined {
    return this.sortedStates().find((state) => state.projectId === projectId);
  }

  /**
   * Sort registry state by project id first, then root, so list output is stable across platforms.
   */
  private sortedStates(): ProjectState[] {
    return [...this.projectsByRoot.values()].sort(
      (left, right) => left.projectId.localeCompare(right.projectId) || left.root.localeCompare(right.root)
    );
  }
}
