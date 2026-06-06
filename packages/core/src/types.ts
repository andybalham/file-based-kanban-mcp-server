/**
 * Stable identity for a discovered work-tracker project.
 *
 * This value comes from `.worktracker/project.json` and travels with the repo so project
 * identity does not depend on machine-local registry state.
 */
export type ProjectId = string;

/**
 * Stable identity for an epic, story, or task.
 *
 * Entity ids are the authoritative references used by `parent` and `dependsOn`; filenames may
 * contain human-readable slugs, but filenames do not define identity.
 */
export type EntityId = string;

/**
 * The three entity layers supported by v1.
 *
 * These map directly to the design's epic -> story -> task hierarchy, while dependency edges
 * remain same-type only.
 */
export type EntityType = "epic" | "story" | "task";

/**
 * Status values that are persisted in task frontmatter.
 *
 * Only tasks store this value. Story and epic status are derived later by the status resolver,
 * which keeps rollups deterministic and prevents conflicting hand-authored status values.
 */
export type StoredStatus = "todo" | "in-progress" | "done";

/**
 * Status value after graph and hierarchy rules have been applied.
 *
 * `blocked` represents dependency or ancestor gate propagation. `empty` represents a story or
 * epic with no unarchived child work from which a rollup status can be computed.
 */
export type EffectiveStatus = StoredStatus | "blocked" | "empty";

/**
 * Authoritative marker stored at `.worktracker/project.json`.
 *
 * The server registry caches this information at runtime, but this marker remains the source of
 * truth for discovery, portability, and project resolution.
 */
export interface ProjectMarker {
  /** Immutable project id minted once during init and reused on every later scan. */
  projectId: ProjectId;
  /** Human-readable project title shown in generated indexes and viewer project lists. */
  title: string;
  /** ISO-8601 timestamp recording when the work-tracker project was initialized. */
  created: string;
}

/**
 * In-memory representation of one Markdown entity file.
 *
 * The frontmatter fields are authoritative for metadata and relationships. The Markdown body is
 * human-authored content that generators must preserve exactly rather than rewriting.
 */
export interface Entity {
  /** Stable id from frontmatter, not inferred from the file path. */
  id: EntityId;
  /** Entity layer; controls parent rules, dependency type checks, and status semantics. */
  type: EntityType;
  /** Human-readable title that can change without changing identity. */
  title: string;
  /** Parent id for stories and tasks, or null for top-level epics. */
  parent: EntityId | null;
  /** Persisted task status; ignored for stories and epics because their status is computed. */
  status: StoredStatus;
  /** Same-type dependency ids, sorted before serialization for deterministic output. */
  dependsOn: EntityId[];
  /** Optional task weight used by critical-path calculation; non-task entities ignore it. */
  estimate?: number;
  /** Human-authored tags, sorted before serialization so no-op writes remain byte-identical. */
  tags: string[];
  /** Soft-delete flag; archived entities stay in storage but are omitted from active views. */
  archived: boolean;
  /** ISO-8601 creation timestamp from frontmatter. */
  created: string;
  /** ISO-8601 update timestamp that changes only when semantic content changes. */
  updated: string;
  /** Markdown body after frontmatter, preserved as human-authored content. */
  body: string;
  /** Current on-disk file path used for reads, moves, and generated links. */
  filePath: string;
}

/**
 * Derived in-memory index for a scanned project.
 *
 * The store builds this from entity files. Downstream graph, status, navigation, and API code read
 * this structure instead of crawling the filesystem repeatedly.
 */
export interface Index {
  /** Entity lookup by authoritative id. */
  byId: Map<EntityId, Entity>;
  /** Ordered child ids keyed by parent id for deterministic hierarchy rendering. */
  childrenOf: Map<EntityId, EntityId[]>;
}

/**
 * One validation finding.
 *
 * Errors block mutations. Warnings are allowed but surfaced to agents and the read-only viewer.
 */
export interface ValidationIssue {
  /** Stable machine-readable code used by MCP errors, tests, and UI grouping. */
  code: string;
  /** Human-readable explanation of the validation problem. */
  message: string;
  /** Optional entity id when the issue can be tied to one specific entity. */
  entityId?: EntityId;
}

/**
 * Complete validation result for a project graph or proposed mutation.
 *
 * Mutating tools validate the full in-memory graph before writing so failed mutations leave the
 * store untouched.
 */
export interface ValidationResult {
  /** Blocking issues that prevent a mutation from being committed. */
  errors: ValidationIssue[];
  /** Non-blocking issues that should still be visible to agents and users. */
  warnings: ValidationIssue[];
}

/**
 * Runtime state for one discovered project.
 *
 * The server owns instances of this shape. Core defines it because server registries, MCP tools,
 * HTTP handlers, and UI projections all compose the same core data structures.
 */
export interface ProjectState {
  /** Project id copied from the authoritative marker for quick routing and display. */
  projectId: ProjectId;
  /** Repository root containing the `.worktracker/` subtree. */
  root: string;
  /** Parsed project marker from `.worktracker/project.json`. */
  marker: ProjectMarker;
  /** Current in-memory project index built from entity Markdown files. */
  index: Index;
  /** Cached effective status per entity, recomputed after successful mutations or rescans. */
  eff: Map<EntityId, EffectiveStatus>;
}
