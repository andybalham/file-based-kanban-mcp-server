import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { discoverProjects, readMarker, resolveAll, scan, seedRequirements, writeMarker } from "@file-kanban/core";
import type { ProjectId, ProjectMarker, ProjectState } from "@file-kanban/core";

/**
 * Root-relative directory containing entity Markdown files.
 *
 * Init creates this directory before the first scan so a newly bootstrapped project can register as
 * an empty project without waiting for the first entity creation.
 */
const ENTITIES_DIR = path.join(".worktracker", "entities");

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
 * `initialProjects` is deliberately a list of fully built states. That lets tests and future
 * adapters seed known projects while boot discovery still uses the same resolution implementation
 * after scanning configured watch roots.
 */
export interface CreateProjectRegistryOptions extends ProjectRegistryOptions {
  /** Optional project states already built by discovery or tests and ready for immediate lookup. */
  initialProjects?: ProjectState[];
  /** Optional state builder used by init/discovery tests or future watcher orchestration. */
  buildProjectState?: ProjectStateBuilder;
  /** Optional id factory for deterministic init tests. */
  createProjectId?: ProjectIdFactory;
  /** Optional clock for deterministic marker creation tests. */
  now?: Clock;
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
 * Function used by init to mint portable project ids.
 *
 * Tests can inject this dependency so idempotency and marker serialization are deterministic while
 * production keeps using random ids that match the design's `wt_<hex>` shape.
 */
export type ProjectIdFactory = () => ProjectId;

/**
 * Function used by init to timestamp a newly created marker.
 *
 * The timestamp is injected for tests because init must not rewrite existing markers merely because
 * time has advanced.
 */
export type Clock = () => Date;

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
   * Scan configured watch roots for project markers and register every discovered project.
   *
   * Server startup uses this instead of `init`; pre-marked projects must become available solely
   * because their portable marker exists under a watched root.
   */
  discover(): Promise<ProjectState[]>;

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
 * Phase 4 registry implementation for project resolution, listing, and init bootstrap.
 *
 * Marker discovery and boot scanning remain separate tasks, but `init` now performs the full
 * create-if-absent flow and registers the resulting state synchronously within the call.
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
   * Project state builder used after marker creation or existing-marker lookup.
   */
  private readonly buildProjectState: ProjectStateBuilder;

  /**
   * Id factory used only when init creates a new marker.
   */
  private readonly createProjectId: ProjectIdFactory;

  /**
   * Clock used only when init creates a new marker.
   */
  private readonly now: Clock;

  /**
   * Seed the registry with already-built project states.
   */
  constructor(options: CreateProjectRegistryOptions) {
    this.watchRoots = [...options.watchRoots];
    this.buildProjectState = options.buildProjectState ?? buildProjectStateFromCore;
    this.createProjectId = options.createProjectId ?? createRandomProjectId;
    this.now = options.now ?? (() => new Date());

    for (const project of options.initialProjects ?? []) {
      this.projectsByRoot.set(path.resolve(project.root), { ...project, root: path.resolve(project.root) });
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
   * Rebuild registry state from markers found below the configured watch roots.
   *
   * The core discovery walker owns marker traversal rules, including ignore handling and stopping
   * at the first marker under a project root. The registry's job is to turn each marker into fresh
   * runtime state and cache it by root.
   */
  async discover(): Promise<ProjectState[]> {
    const discoveredProjects = await discoverProjects(this.watchRoots);
    const states: ProjectState[] = [];

    for (const discoveredProject of discoveredProjects) {
      states.push(await this.registerDiscovered(discoveredProject.root, discoveredProject.marker));
    }

    return states;
  }

  /**
   * Bootstrap a project root and register it before returning the project id.
   *
   * Existing markers are treated as authoritative: init returns their id, performs no marker or
   * requirements writes, and still refreshes in-memory state so callers can immediately resolve the
   * project through this registry.
   */
  async init(args: InitProjectArgs): Promise<InitProjectResult> {
    const root = path.resolve(args.root);
    const existingMarker = await readMarker(root);

    if (existingMarker !== null) {
      await this.registerInitializedRoot(root, existingMarker);
      return { projectId: existingMarker.projectId };
    }

    const marker: ProjectMarker = {
      projectId: this.createProjectId(),
      title: args.title,
      created: this.now().toISOString().replace(".000Z", "Z")
    };

    await writeMarker(root, marker);
    await this.ensureEntityDirectory(root);

    if (args.intent !== undefined) {
      await seedRequirements(root, args.intent);
    }

    await this.registerInitializedRoot(root, marker);
    return { projectId: marker.projectId };
  }

  /**
   * Register a marker found by boot discovery or by the future marker watcher.
   *
   * Discovery never writes seed content. A discovered marker is already the source of truth, so the
   * operation only normalizes the root, scans current project content, computes effective statuses,
   * and replaces any stale cached state for that root.
   */
  async registerDiscovered(root: string, marker: ProjectMarker): Promise<ProjectState> {
    return this.registerProjectRoot(path.resolve(root), marker);
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

  /**
   * Build and cache runtime state for an initialized root.
   */
  private async registerInitializedRoot(root: string, marker: ProjectMarker): Promise<ProjectState> {
    return this.registerProjectRoot(root, marker);
  }

  /**
   * Shared "scan root -> build ProjectState -> insert" step for init and discovered markers.
   *
   * Keeping the insertion logic in one place enforces the design invariant that init-created
   * projects and externally discovered projects converge on identical runtime state.
   */
  private async registerProjectRoot(root: string, marker: ProjectMarker): Promise<ProjectState> {
    const state = await this.buildProjectState(root, marker);
    const registeredState = { ...state, root };
    this.projectsByRoot.set(root, registeredState);
    return registeredState;
  }

  /**
   * Ensure the empty entity directory exists before scanning a freshly initialized project.
   */
  private async ensureEntityDirectory(root: string): Promise<void> {
    await fs.mkdir(path.join(root, ENTITIES_DIR), { recursive: true });
  }
}

/**
 * Build one runtime project state using the core scan and status resolver.
 */
async function buildProjectStateFromCore(root: string, marker: ProjectMarker): Promise<ProjectState> {
  const index = await scan(root);

  return {
    projectId: marker.projectId,
    root,
    marker,
    index,
    eff: resolveAll(index)
  };
}

/**
 * Mint a portable project id with the `wt_<hex>` shape shown in the technical design.
 */
function createRandomProjectId(): ProjectId {
  return `wt_${randomBytes(4).toString("hex")}`;
}
