import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { renderDependencies, renderEpicSubgraph } from "./mermaid.js";
import { renderBlocked, renderEpicIndex, renderIndex, renderReady } from "./nav.js";
import type { EffectiveStatus, Entity, EntityId, EntityType, Index, ProjectMarker, StoredStatus } from "./types.js";

/**
 * Root-relative directory that contains all human-authored entity Markdown files.
 *
 * The store treats frontmatter as authoritative and reads only this flat directory during v1 scans,
 * matching the technical design's storage model.
 */
const ENTITIES_DIR = path.join(".worktracker", "entities");

/**
 * Root-relative directory for generated Markdown navigation files.
 *
 * These files are derived from frontmatter and status resolution, are safe to commit, and must be
 * rewritten only when their rendered bytes actually change.
 */
const GENERATED_INDEX_DIR = path.join(".worktracker", "index");

/**
 * Root-relative directory for generated Mermaid graph files.
 *
 * Mermaid output is kept separate from Markdown navigation so MCP resources and the viewer can read
 * the exact artifact family they need without mixing generated formats.
 */
const GENERATED_GRAPHS_DIR = path.join(".worktracker", "graphs");

/**
 * Root-relative path to the authoritative project marker.
 *
 * Discovery, init idempotency, and registry rebuilds all start from this file rather than any
 * machine-local database.
 */
const PROJECT_MARKER_PATH = path.join(".worktracker", "project.json");

/**
 * Root-relative path to the human-authored requirements seed.
 *
 * This file is written only once during init and is intentionally excluded from later generated
 * artifact rewrites.
 */
const REQUIREMENTS_SOURCE_PATH = path.join(".worktracker", "requirements", "source.md");

/**
 * Root-relative path to the per-project id counters.
 *
 * Counters live inside the portable `.worktracker` tree so identity allocation follows the project
 * instead of any machine-local server registry. The value for each type is the highest id number
 * already reserved for that type, not the next number to return.
 */
const COUNTERS_PATH = path.join(".worktracker", ".meta", "counters.json");

/**
 * Directory names skipped by marker discovery.
 *
 * These are intentionally conservative, matching the design's standard ignores so discovery can
 * scan folders of repositories without crawling dependency installs, git internals, or build
 * output that may contain vendored example markers.
 */
const DISCOVERY_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

/**
 * File name whose patterns further prune marker discovery below each scanned directory.
 *
 * Discovery only needs directory-level decisions, but honoring repository-local ignore files keeps
 * cloned fixture trees, vendored examples, and generated folders from accidentally registering
 * projects that the repository has already declared out of scope.
 */
const GITIGNORE_FILE_NAME = ".gitignore";

/**
 * One parsed `.gitignore` rule used by marker discovery.
 *
 * The rule stores paths in POSIX form because `.gitignore` syntax always uses `/` separators even
 * when this package runs on Windows.
 */
interface DiscoveryIgnoreRule {
  /** Directory, relative to the watch root, where the `.gitignore` file that declared this rule lives. */
  baseRelativePath: string;
  /** Pattern text after removing gitignore-only markers such as `!`, leading `/`, and trailing `/`. */
  pattern: string;
  /** Whether this rule re-includes a path ignored by an earlier rule. */
  negated: boolean;
  /** Whether the original pattern ended in `/`, documenting that only directories should match. */
  directoryOnly: boolean;
  /** Whether the original pattern was rooted to the directory containing the `.gitignore` file. */
  rooted: boolean;
  /** Whether matching must use the whole path below the rule base instead of any single segment. */
  hasSlash: boolean;
}

/**
 * Immutable traversal context for one discovery walk.
 */
interface DiscoveryContext {
  /** Absolute watch root currently being scanned. */
  watchRoot: string;
  /** Active ignore rules inherited from ancestor `.gitignore` files. */
  ignoreRules: DiscoveryIgnoreRule[];
}

/**
 * One project found by scanning configured watch roots for authoritative markers.
 */
export interface DiscoveredProject {
  /** Filesystem root that owns the `.worktracker/project.json` marker. */
  root: string;
  /** Parsed marker content used by the server registry to rebuild project state. */
  marker: ProjectMarker;
}

/**
 * Description of one generated artifact produced by the deterministic regeneration primitive.
 *
 * Returning these paths gives server orchestration and tests a precise list of files that belong to
 * the latest generation pass without exposing write internals or filesystem timestamps.
 */
export interface GeneratedArtifact {
  /** Stable artifact family used by future MCP resources and HTTP routes to select the file. */
  kind: "index" | "graph";
  /** Absolute path to the generated file inside the owning project's `.worktracker` subtree. */
  filePath: string;
  /**
   * Whether this generation pass replaced the file bytes.
   *
   * Server mutation results use this flag to tell agents and humans which generated artifacts
   * actually need to be included in a user-controlled commit, while still returning the complete
   * artifact set for resource and watcher bookkeeping.
   */
  changed: boolean;
}

/**
 * Entity type values accepted by the persisted frontmatter schema.
 *
 * Keeping this as data, rather than scattered string comparisons, makes field validation and future
 * exhaustive checks line up with the public `EntityType` union.
 */
const ENTITY_TYPES = new Set<EntityType>(["epic", "story", "task"]);

/**
 * Task status values accepted by persisted frontmatter.
 *
 * Only task status is meaningful, but the parser normalizes non-task entities to `todo` so every
 * `Entity` has the stable shape promised by the core public types.
 */
const STORED_STATUSES = new Set<StoredStatus>(["todo", "in-progress", "done"]);

/**
 * Prefixes used by the public human-readable entity id scheme.
 *
 * Keeping the mapping centralized lets allocation, filename generation, and future validators agree
 * on the same E/S/T namespace split.
 */
const ENTITY_ID_PREFIX_BY_TYPE: Record<EntityType, string> = {
  epic: "E",
  story: "S",
  task: "T"
};

/**
 * Persisted shape of `.worktracker/.meta/counters.json`.
 *
 * Each value stores the last allocated number for the corresponding entity type. Missing files are
 * reconstructed from existing entity frontmatter; malformed present files are rejected because they
 * could otherwise cause id reuse.
 */
interface IdCounters {
  /** Highest epic id number reserved for this project. */
  epic: number;
  /** Highest story id number reserved for this project. */
  story: number;
  /** Highest task id number reserved for this project. */
  task: number;
}

/**
 * Bound filesystem operations for one work-tracker project root.
 *
 * Later Phase 1 tasks extend this object with write, counter, and move operations. Keeping scan and
 * parse behind the same factory now gives server code a stable project-scoped store boundary.
 */
export interface Store {
  /**
   * Read every Markdown entity under `.worktracker/entities/` and return a deterministic index.
   *
   * Archived entities remain present and marked in the index because validation and future MCP
   * resource reads need a faithful view of storage, not only the active board.
   */
  scan(): Promise<Index>;

  /**
   * Parse one entity Markdown file into the canonical in-memory representation.
   *
   * The body is preserved exactly as `gray-matter` returns it so human-authored Markdown is not
   * rewritten by scan or generator code.
   */
  parse(filePath: string): Promise<Entity>;

  /**
   * Convert an in-memory entity into the canonical Markdown file representation.
   *
   * This is exposed on the bound store so later write and move primitives can compare the exact
   * bytes they would persist before touching the filesystem.
   */
  serialize(entity: Entity): string;

  /**
   * Atomically write one entity Markdown file if its canonical bytes changed.
   *
   * Callers own semantic mutation rules and validation. The store only resolves the target within
   * this project's entity directory, serializes deterministically, and suppresses byte-identical
   * writes so `updated` timestamps do not churn on no-op mutations.
   */
  write(entity: Entity): Promise<boolean>;

  /**
   * Reserve and return the next id for one entity type.
   *
   * The first allocation in an existing project initializes `.worktracker/.meta/counters.json` from
   * scanned frontmatter ids. Later allocations use the persisted counter so archived or removed
   * entities never cause an id to be reused.
   */
  allocateId(type: EntityType): Promise<EntityId>;

  /**
   * Change one entity's parent frontmatter without relocating its Markdown file.
   *
   * Higher layers own hierarchy validation. The store primitive only finds the entity by
   * authoritative id, preserves the human-authored body and filename, and suppresses no-op moves so
   * filesystem timestamps do not churn.
   */
  move(id: EntityId, newParent: EntityId | null): Promise<void>;

  /**
   * Read the marker for this project root, returning null when the root has not been initialized.
   */
  readMarker(): Promise<ProjectMarker | null>;

  /**
   * Atomically persist the marker for this project root.
   *
   * The caller enforces create-if-absent init semantics; this primitive focuses only on canonical
   * marker serialization and durable replacement.
   */
  writeMarker(marker: ProjectMarker): Promise<void>;

  /**
   * Write `.worktracker/requirements/source.md` once and preserve any existing human-authored file.
   */
  seedRequirements(intent: string): Promise<void>;

  /**
   * Render and atomically persist all generated navigation and graph artifacts for this project.
   *
   * The caller provides the already-resolved effective status map so this primitive stays a pure
   * filesystem commit step and does not decide graph semantics itself.
   */
  writeGeneratedArtifacts(index: Index, eff: Map<EntityId, EffectiveStatus>): Promise<GeneratedArtifact[]>;
}

/**
 * Create store operations bound to a single project root.
 *
 * All relative paths are resolved from this root, which prevents callers from accidentally mixing
 * entities from different work-tracker projects in one index.
 */
export function createStore(root: string): Store {
  return {
    scan: () => scan(root),
    parse,
    serialize: serializeEntity,
    write: (entity) => write(root, entity),
    allocateId: (type) => allocateId(root, type),
    move: (id, newParent) => move(root, id, newParent),
    readMarker: () => readMarker(root),
    writeMarker: (marker) => writeMarker(root, marker),
    seedRequirements: (intent) => seedRequirements(root, intent),
    writeGeneratedArtifacts: (index, eff) => writeGeneratedArtifacts(root, index, eff)
  };
}

/**
 * Scan a project root using the same implementation exposed by `createStore(root).scan()`.
 *
 * This free function supports bootstrap code that needs to load a project before it has built a
 * full server-side `ProjectState`.
 */
export async function scan(root: string): Promise<Index> {
  const entitiesRoot = path.join(root, ENTITIES_DIR);
  const entries = await fs.readdir(entitiesRoot, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(entitiesRoot, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const entities = await Promise.all(markdownFiles.map((filePath) => parse(filePath)));
  entities.sort((a, b) => a.id.localeCompare(b.id));

  const byId = new Map<EntityId, Entity>();
  const childrenOf = new Map<EntityId, EntityId[]>();

  for (const entity of entities) {
    if (byId.has(entity.id)) {
      throw entityParseError(entity.filePath, `Duplicate entity id '${entity.id}' discovered during scan.`);
    }

    byId.set(entity.id, entity);

    if (entity.parent !== null) {
      const children = childrenOf.get(entity.parent) ?? [];
      children.push(entity.id);
      childrenOf.set(entity.parent, children);
    }
  }

  for (const childIds of childrenOf.values()) {
    childIds.sort((a, b) => a.localeCompare(b));
  }

  return { byId, childrenOf };
}

/**
 * Parse one Markdown entity file and normalize optional frontmatter defaults.
 *
 * This is deliberately schema-aware instead of returning raw frontmatter data, because downstream
 * graph and status code should be able to rely on stable arrays, booleans, parent nullability, and
 * status defaults without rechecking every field.
 */
export async function parse(filePath: string): Promise<Entity> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const id = readRequiredString(filePath, data, "id");
  const type = readEntityType(filePath, data.type);
  const title = readRequiredString(filePath, data, "title");
  const parent = readParent(filePath, data.parent);
  const status = type === "task" ? readStoredStatus(filePath, data.status) : "todo";
  const dependsOn = readStringArray(filePath, data.dependsOn, "dependsOn").sort((a, b) => a.localeCompare(b));
  const tags = readStringArray(filePath, data.tags, "tags").sort((a, b) => a.localeCompare(b));
  const archived = readOptionalBoolean(filePath, data.archived, "archived", false);
  const estimate = readOptionalNumber(filePath, data.estimate, "estimate");
  const created = readRequiredTimestampString(filePath, data, "created");
  const updated = readRequiredTimestampString(filePath, data, "updated");

  return {
    id,
    type,
    title,
    parent,
    status,
    dependsOn,
    ...(estimate === undefined ? {} : { estimate }),
    tags,
    archived,
    created,
    updated,
    body: parsed.content,
    filePath
  };
}

/**
 * Serialize one entity using the canonical frontmatter shape from the technical design.
 *
 * The field order is intentionally hand-authored here instead of delegated to a generic YAML
 * dumper. Deterministic byte output is a storage invariant: no-op updates, generated artifacts,
 * and git diffs all rely on semantically equal entities producing exactly the same Markdown.
 */
export function serializeEntity(entity: Entity): string {
  const frontmatter: string[] = [
    `id: ${formatYamlString(entity.id)}`,
    `type: ${entity.type}`,
    `title: ${formatYamlString(entity.title)}`,
    `parent: ${entity.parent === null ? "null" : formatYamlString(entity.parent)}`
  ];

  if (entity.type === "task") {
    frontmatter.push(`status: ${entity.status}`);
  }

  frontmatter.push(`dependsOn: ${formatYamlStringArray(entity.dependsOn)}`);

  if (entity.estimate !== undefined) {
    frontmatter.push(`estimate: ${formatYamlNumber(entity.estimate)}`);
  }

  frontmatter.push(
    `tags: ${formatYamlStringArray(entity.tags)}`,
    `archived: ${entity.archived ? "true" : "false"}`,
    `created: ${formatYamlString(entity.created)}`,
    `updated: ${formatYamlString(entity.updated)}`
  );

  return `---\n${frontmatter.join("\n")}\n---\n${entity.body}`;
}

/**
 * Atomically write one entity using its canonical serialized representation.
 *
 * Entity bodies remain caller-owned; this function writes the exact body supplied on the entity and
 * never derives or edits Markdown content. The on-disk comparison happens before opening a temp
 * file so semantic no-ops leave timestamps and filesystem watcher state untouched.
 */
export async function write(root: string, entity: Entity): Promise<boolean> {
  const filePath = resolveEntityWritePath(root, entity.filePath);
  const serialized = serializeEntity({ ...entity, filePath });

  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === serialized) {
      return false;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await atomicWriteFile(filePath, serialized);
  return true;
}

/**
 * Allocate the next project-scoped entity id and persist the updated counter atomically.
 *
 * This function is intentionally root-bound at the call site through `createStore(root)` because
 * counters are not global. When no counter file exists yet, the store scans current entity
 * frontmatter and seeds counters to the highest existing id number per type before incrementing the
 * requested type.
 */
export async function allocateId(root: string, type: EntityType): Promise<EntityId> {
  const counters = await readOrInitializeCounters(root);
  const nextNumber = counters[type] + 1;
  const nextCounters = { ...counters, [type]: nextNumber };

  await writeCounters(root, nextCounters);

  return formatEntityId(type, nextNumber);
}

/**
 * Update an entity's parent field in place.
 *
 * The entity is resolved from a fresh scan so callers can pass the stable frontmatter id rather than
 * a filename. The write target remains the original `filePath`, which preserves the design rule
 * that moves edit hierarchy metadata only and do not rename or relocate Markdown files.
 */
export async function move(root: string, id: EntityId, newParent: EntityId | null): Promise<void> {
  const index = await scan(root);
  const entity = index.byId.get(id);

  if (entity === undefined) {
    throw entityMoveError(root, `Entity '${id}' was not found.`);
  }

  if (entity.parent === newParent) {
    return;
  }

  await write(root, { ...entity, parent: newParent });
}

/**
 * Read a project marker from `.worktracker/project.json`.
 *
 * Absence is a normal bootstrap state, so only missing files return null. Malformed JSON or schema
 * mismatches surface as errors because a bad marker means discovery cannot safely identify the
 * project.
 */
export async function readMarker(root: string): Promise<ProjectMarker | null> {
  const markerPath = path.join(root, PROJECT_MARKER_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    projectId: readMarkerString(markerPath, parsed, "projectId"),
    title: readMarkerString(markerPath, parsed, "title"),
    created: readMarkerString(markerPath, parsed, "created")
  };
}

/**
 * Atomically write the authoritative project marker in canonical JSON form.
 *
 * Stable two-space formatting keeps marker diffs predictable and avoids noise when a marker is
 * rewritten with semantically identical data by init or tests.
 */
export async function writeMarker(root: string, marker: ProjectMarker): Promise<void> {
  const markerPath = path.join(root, PROJECT_MARKER_PATH);
  const canonical = `${JSON.stringify(
    {
      projectId: marker.projectId,
      title: marker.title,
      created: marker.created
    },
    null,
    2
  )}\n`;

  await atomicWriteFile(markerPath, canonical);
}

/**
 * Seed `.worktracker/requirements/source.md` once.
 *
 * Requirements are user-owned after init, so an existing file is left byte-for-byte untouched even
 * when a later call provides different intent text.
 */
export async function seedRequirements(root: string, intent: string): Promise<void> {
  const requirementsPath = path.join(root, REQUIREMENTS_SOURCE_PATH);

  try {
    await fs.access(requirementsPath);
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await atomicWriteFile(requirementsPath, intent.endsWith("\n") ? intent : `${intent}\n`);
}

/**
 * Render and write the complete Phase 3 generated artifact set.
 *
 * The file list mirrors §8 of the technical design: top-level board Markdown, per-epic Markdown,
 * ready and blocked lists, the full dependency Mermaid graph, and one Mermaid graph per active
 * epic. Entity Markdown bodies, project markers, requirements, and counters are intentionally
 * outside this regeneration set.
 */
export async function writeGeneratedArtifacts(
  root: string,
  index: Index,
  eff: Map<EntityId, EffectiveStatus>
): Promise<GeneratedArtifact[]> {
  const artifacts = generatedArtifactContents(root, index, eff);
  const writtenArtifacts: GeneratedArtifact[] = [];

  for (const artifact of artifacts) {
    writtenArtifacts.push({
      kind: artifact.kind,
      filePath: artifact.filePath,
      changed: await writeGeneratedTextFileIfChanged(artifact.filePath, artifact.content)
    });
  }

  return writtenArtifacts;
}

/**
 * Build generated artifact contents in the deterministic write order used by regeneration.
 *
 * The top-level board is written first, followed by per-epic drilldowns, query lists, the full
 * graph, and per-epic graphs. Active epics are sorted by id so repeated generation produces the
 * same file order regardless of Map insertion order.
 */
function generatedArtifactContents(
  root: string,
  index: Index,
  eff: Map<EntityId, EffectiveStatus>
): Array<Omit<GeneratedArtifact, "changed"> & { content: string }> {
  const indexDirectory = path.join(root, GENERATED_INDEX_DIR);
  const graphsDirectory = path.join(root, GENERATED_GRAPHS_DIR);
  const activeEpics = activeEpicsForGeneration(index);
  const artifacts: Array<Omit<GeneratedArtifact, "changed"> & { content: string }> = [
    {
      kind: "index",
      filePath: path.join(indexDirectory, "INDEX.md"),
      content: renderIndex(index, eff)
    }
  ];

  for (const epic of activeEpics) {
    artifacts.push({
      kind: "index",
      filePath: path.join(indexDirectory, `${epic.id}.md`),
      content: renderEpicIndex(index, epic.id, eff)
    });
  }

  artifacts.push(
    {
      kind: "index",
      filePath: path.join(indexDirectory, "READY.md"),
      content: renderReady(index, eff)
    },
    {
      kind: "index",
      filePath: path.join(indexDirectory, "BLOCKED.md"),
      content: renderBlocked(index, eff)
    },
    {
      kind: "graph",
      filePath: path.join(graphsDirectory, "dependencies.mmd"),
      content: renderDependencies(index, eff)
    }
  );

  for (const epic of activeEpics) {
    artifacts.push({
      kind: "graph",
      filePath: path.join(graphsDirectory, `${epic.id}.mmd`),
      content: renderEpicSubgraph(index, epic.id, eff)
    });
  }

  return artifacts;
}

/**
 * Return active epics in id order for per-epic generated Markdown and Mermaid files.
 */
function activeEpicsForGeneration(index: Index): Entity[] {
  return [...index.byId.values()]
    .filter((entity) => entity.type === "epic" && !entity.archived)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Atomically write generated text unless the existing file already has identical bytes.
 *
 * This preserves the design's idempotency guarantee at the filesystem level: a semantic no-op
 * regeneration produces no timestamp-only diff and avoids confusing later watcher suppression.
 */
async function writeGeneratedTextFileIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await atomicWriteFile(filePath, content);
  return true;
}

/**
 * Read the persisted counters, or initialize them from existing entity ids when absent.
 *
 * Initialization is a write because the design requires future allocations to use the durable
 * project counter instead of rescanning, which is what prevents reuse after entity archival or
 * deletion.
 */
async function readOrInitializeCounters(root: string): Promise<IdCounters> {
  const existing = await readCounters(root);
  if (existing !== null) {
    return existing;
  }

  const initialized = await initializeCountersFromEntities(root);
  await writeCounters(root, initialized);
  return initialized;
}

/**
 * Read `.worktracker/.meta/counters.json` and validate every counter value.
 *
 * A missing file is a normal pre-allocation state. A malformed file is not recoverable by guessing:
 * accepting it could move a counter backwards and violate the no-reuse identity invariant.
 */
async function readCounters(root: string): Promise<IdCounters | null> {
  const countersPath = path.join(root, COUNTERS_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(countersPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    epic: readCounterValue(countersPath, parsed, "epic"),
    story: readCounterValue(countersPath, parsed, "story"),
    task: readCounterValue(countersPath, parsed, "task")
  };
}

/**
 * Persist counters in canonical JSON order.
 *
 * Stable formatting keeps counter diffs readable and makes repeated writes with the same semantic
 * value byte-identical, matching the repository's deterministic storage rules.
 */
async function writeCounters(root: string, counters: IdCounters): Promise<void> {
  const countersPath = path.join(root, COUNTERS_PATH);
  const canonical = `${JSON.stringify(
    {
      epic: counters.epic,
      story: counters.story,
      task: counters.task
    },
    null,
    2
  )}\n`;

  await atomicWriteFile(countersPath, canonical);
}

/**
 * Build initial counters by scanning entity frontmatter ids.
 *
 * Invalid id shapes are ignored here because parse/scan already validates storage shape, while
 * graph validation will later report semantic id issues. Allocation only needs the maximum numeric
 * suffix in the recognized namespace for each persisted type.
 */
async function initializeCountersFromEntities(root: string): Promise<IdCounters> {
  const counters: IdCounters = { epic: 0, story: 0, task: 0 };

  let index: Index;
  try {
    index = await scan(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return counters;
    }

    throw error;
  }

  for (const entity of index.byId.values()) {
    const numericId = parseEntityIdNumber(entity.type, entity.id);
    if (numericId !== null && numericId > counters[entity.type]) {
      counters[entity.type] = numericId;
    }
  }

  return counters;
}

/**
 * Read one counter value from JSON and reject values that cannot represent a monotonic id suffix.
 */
function readCounterValue(filePath: string, data: Record<string, unknown>, key: keyof IdCounters): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw counterParseError(filePath, `Counter '${key}' must be a non-negative integer.`);
  }

  return value;
}

/**
 * Extract the numeric suffix from an id only when it belongs to the requested entity type.
 */
function parseEntityIdNumber(type: EntityType, id: EntityId): number | null {
  const prefix = ENTITY_ID_PREFIX_BY_TYPE[type];
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  if (match === null) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

/**
 * Format a public entity id using the design's zero-padded E/S/T scheme.
 */
function formatEntityId(type: EntityType, value: number): EntityId {
  return `${ENTITY_ID_PREFIX_BY_TYPE[type]}-${String(value).padStart(3, "0")}`;
}

/**
 * Discover all marked projects below a set of watch roots.
 *
 * Discovery treats `.worktracker/project.json` as the only source of project identity. Once a
 * marker is found, traversal stops below that project root so a nested fixture or vendored marker
 * cannot create a second active project from inside an already discovered project.
 */
export async function discoverProjects(watchRoots: string[]): Promise<DiscoveredProject[]> {
  const discovered = new Map<string, DiscoveredProject>();

  for (const watchRoot of watchRoots) {
    const resolvedRoot = path.resolve(watchRoot);
    await discoverProjectsUnder(resolvedRoot, discovered, { watchRoot: resolvedRoot, ignoreRules: [] });
  }

  return [...discovered.values()].sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * Recursively scan one directory for project markers while preserving discovery invariants.
 */
async function discoverProjectsUnder(
  root: string,
  discovered: Map<string, DiscoveredProject>,
  context: DiscoveryContext
): Promise<void> {
  if (shouldIgnoreDiscoveryDirectory(path.basename(root))) {
    return;
  }

  const marker = await readMarker(root);
  if (marker !== null) {
    discovered.set(root, { root, marker });
    return;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const ignoreRules = [
    ...context.ignoreRules,
    ...(await readDiscoveryIgnoreRules(root, toPosixRelativePath(context.watchRoot, root)))
  ];

  const childDirectories = entries
    .filter((entry) => {
      if (!entry.isDirectory() || shouldIgnoreDiscoveryDirectory(entry.name)) {
        return false;
      }

      return !isDiscoveryPathIgnored(toPosixRelativePath(context.watchRoot, path.join(root, entry.name)), ignoreRules);
    })
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  for (const childDirectory of childDirectories) {
    await discoverProjectsUnder(childDirectory, discovered, { watchRoot: context.watchRoot, ignoreRules });
  }
}

/**
 * Apply the design's coarse discovery ignore rules to directory names.
 */
function shouldIgnoreDiscoveryDirectory(name: string): boolean {
  return DISCOVERY_IGNORED_DIRECTORIES.has(name);
}

/**
 * Resolve an entity write target while preserving the project boundary.
 *
 * The public `Entity.filePath` records the current file path discovered by scan, so callers may pass
 * an absolute path for existing files. Future create flows may pass a path relative to the project
 * root. In both cases the write target must stay inside `.worktracker/entities/` and use Markdown
 * storage, preventing a malformed mutation from writing arbitrary repository files.
 */
function resolveEntityWritePath(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const entitiesRoot = path.resolve(resolvedRoot, ENTITIES_DIR);
  const resolvedFilePath = path.resolve(resolvedRoot, filePath);

  if (!isPathInsideDirectory(resolvedFilePath, entitiesRoot)) {
    throw entityWriteError(filePath, `Entity file path must be inside ${ENTITIES_DIR}.`);
  }

  if (path.extname(resolvedFilePath).toLowerCase() !== ".md") {
    throw entityWriteError(filePath, "Entity file path must use the .md extension.");
  }

  return resolvedFilePath;
}

/**
 * Check whether a resolved candidate path is inside a resolved parent directory.
 */
function isPathInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Read `.gitignore` rules that affect marker discovery below one directory.
 *
 * Missing ignore files are expected for most directories, so only absent files are swallowed. Other
 * read failures are propagated because silently scanning past an unreadable ignore file could make
 * discovery register projects the user intended to exclude.
 */
async function readDiscoveryIgnoreRules(root: string, baseRelativePath: string): Promise<DiscoveryIgnoreRule[]> {
  const ignorePath = path.join(root, GITIGNORE_FILE_NAME);

  let content: string;
  try {
    content = await fs.readFile(ignorePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return content
    .split(/\r?\n/)
    .map((line) => parseDiscoveryIgnoreRule(line, baseRelativePath))
    .filter((rule): rule is DiscoveryIgnoreRule => rule !== null);
}

/**
 * Parse the subset of `.gitignore` syntax needed for deterministic directory traversal.
 *
 * The implementation intentionally ignores file-only concerns because marker discovery only
 * descends through directories. It still preserves core gitignore behavior that matters here:
 * comments, negation, rooted patterns, directory-only patterns, and simple glob wildcards.
 */
function parseDiscoveryIgnoreRule(line: string, baseRelativePath: string): DiscoveryIgnoreRule | null {
  let pattern = line.trim();
  if (pattern.length === 0 || pattern.startsWith("#")) {
    return null;
  }

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1).trim();
  }

  if (pattern.length === 0) {
    return null;
  }

  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }

  const rooted = pattern.startsWith("/");
  if (rooted) {
    pattern = pattern.slice(1);
  }

  pattern = normalizeGitignorePattern(pattern);
  if (pattern.length === 0) {
    return null;
  }

  return {
    baseRelativePath,
    pattern,
    negated,
    directoryOnly,
    rooted,
    hasSlash: pattern.includes("/")
  };
}

/**
 * Decide whether a directory should be skipped by the active `.gitignore` rules.
 *
 * Rules are evaluated in file order across ancestors, with the last matching rule winning. That
 * mirrors the behavior agents expect from Git while keeping traversal deterministic and local to
 * the current watch root.
 */
function isDiscoveryPathIgnored(relativeDirectoryPath: string, rules: DiscoveryIgnoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (matchesDiscoveryIgnoreRule(relativeDirectoryPath, rule)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

/**
 * Match one directory path against one parsed `.gitignore` rule.
 */
function matchesDiscoveryIgnoreRule(relativeDirectoryPath: string, rule: DiscoveryIgnoreRule): boolean {
  const pathBelowRuleBase = getPathBelowRuleBase(relativeDirectoryPath, rule.baseRelativePath);
  if (pathBelowRuleBase === null || pathBelowRuleBase.length === 0) {
    return false;
  }

  if (rule.rooted || rule.hasSlash) {
    return matchesGitignorePathPattern(rule.pattern, pathBelowRuleBase);
  }

  return pathBelowRuleBase.split("/").some((segment) => matchesGitignoreSegmentPattern(rule.pattern, segment));
}

/**
 * Return the candidate path relative to the directory where a `.gitignore` rule was declared.
 */
function getPathBelowRuleBase(relativeDirectoryPath: string, baseRelativePath: string): string | null {
  if (baseRelativePath.length === 0) {
    return relativeDirectoryPath;
  }

  if (relativeDirectoryPath === baseRelativePath) {
    return "";
  }

  const basePrefix = `${baseRelativePath}/`;
  if (!relativeDirectoryPath.startsWith(basePrefix)) {
    return null;
  }

  return relativeDirectoryPath.slice(basePrefix.length);
}

/**
 * Match a path-scoped gitignore pattern against a directory path below the rule base.
 */
function matchesGitignorePathPattern(pattern: string, value: string): boolean {
  if (pattern.endsWith("/**") && value === pattern.slice(0, -3)) {
    return true;
  }

  return gitignorePatternToRegExp(pattern, true).test(value);
}

/**
 * Match a single path segment against an unrooted gitignore pattern.
 */
function matchesGitignoreSegmentPattern(pattern: string, value: string): boolean {
  return gitignorePatternToRegExp(pattern, false).test(value);
}

/**
 * Convert a small, deterministic subset of gitignore globs to a regular expression.
 *
 * `*` and `?` never cross directory separators unless they are part of `**`, which is the one glob
 * form that can intentionally span multiple path segments.
 */
function gitignorePatternToRegExp(pattern: string, pathPattern: boolean): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const nextCharacter = pattern[index + 1];

    if (character === "*" && nextCharacter === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      source += pathPattern ? "[^/]*" : ".*";
      continue;
    }

    if (character === "?") {
      source += pathPattern ? "[^/]" : ".";
      continue;
    }

    source += escapeRegExp(character);
  }

  return new RegExp(`^${source}$`);
}

/**
 * Normalize `.gitignore` pattern separators to the platform-independent form used internally.
 */
function normalizeGitignorePattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

/**
 * Convert an absolute child path to a POSIX-style path relative to the watch root.
 */
function toPosixRelativePath(root: string, child: string): string {
  return path.relative(root, child).split(path.sep).filter(Boolean).join("/");
}

/**
 * Escape regular expression syntax while translating glob patterns.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Read a required string field and attach the source file to any schema error.
 */
function readRequiredString(filePath: string, data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw entityParseError(filePath, `Frontmatter field '${key}' must be a non-empty string.`);
  }

  return value;
}

/**
 * Read an ISO-like timestamp field from YAML frontmatter.
 *
 * `gray-matter` delegates YAML parsing to a loader that resolves unquoted timestamps as `Date`
 * instances. The public core model deliberately exposes timestamps as strings, so the parser
 * converts Date values back to deterministic UTC strings while preserving already-quoted strings.
 */
function readRequiredTimestampString(filePath: string, data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().replace(".000Z", "Z");
  }

  return readRequiredString(filePath, data, key);
}

/**
 * Validate the persisted entity type against the v1 entity layers.
 */
function readEntityType(filePath: string, value: unknown): EntityType {
  if (typeof value !== "string" || !ENTITY_TYPES.has(value as EntityType)) {
    throw entityParseError(filePath, "Frontmatter field 'type' must be one of epic, story, or task.");
  }

  return value as EntityType;
}

/**
 * Normalize the required hierarchy parent field.
 *
 * `null` is preserved for epics; strings are preserved for stories and tasks. Type-specific
 * hierarchy validity is checked by later graph validation so parse remains a storage concern.
 */
function readParent(filePath: string, value: unknown): EntityId | null {
  if (value === null || typeof value === "string") {
    return value;
  }

  throw entityParseError(filePath, "Frontmatter field 'parent' must be an entity id string or null.");
}

/**
 * Read the persisted task status, defaulting missing task status to `todo` per the design.
 */
function readStoredStatus(filePath: string, value: unknown): StoredStatus {
  if (value === undefined) {
    return "todo";
  }

  if (typeof value !== "string" || !STORED_STATUSES.has(value as StoredStatus)) {
    throw entityParseError(filePath, "Frontmatter field 'status' must be todo, in-progress, or done.");
  }

  return value as StoredStatus;
}

/**
 * Normalize optional list fields to arrays of strings.
 *
 * YAML frontmatter may omit `dependsOn` and `tags`; callers should still see stable empty arrays.
 */
function readStringArray(filePath: string, value: unknown, key: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw entityParseError(filePath, `Frontmatter field '${key}' must be an array of strings.`);
  }

  return [...value] as string[];
}

/**
 * Read an optional boolean field with the design's default value.
 */
function readOptionalBoolean(filePath: string, value: unknown, key: string, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw entityParseError(filePath, `Frontmatter field '${key}' must be a boolean.`);
  }

  return value;
}

/**
 * Read an optional numeric field used by task weighting.
 */
function readOptionalNumber(filePath: string, value: unknown, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw entityParseError(filePath, `Frontmatter field '${key}' must be a finite number.`);
  }

  return value;
}

/**
 * Format one YAML string scalar in the most readable deterministic form that remains unambiguous.
 *
 * Plain scalars keep fixture files easy for humans to edit. Values that would be ambiguous or
 * syntactically meaningful in YAML are emitted as JSON strings, which YAML accepts and parses back
 * to the same JavaScript string through `gray-matter`.
 */
function formatYamlString(value: string): string {
  if (isSafePlainYamlScalar(value)) {
    return value;
  }

  return JSON.stringify(value);
}

/**
 * Format string arrays as sorted YAML flow sequences.
 *
 * The caller's array order is never trusted because `dependsOn` and `tags` are set-like metadata
 * where stable lexical order prevents churn from equivalent update requests.
 */
function formatYamlStringArray(values: string[]): string {
  const sorted = [...values].sort((a, b) => a.localeCompare(b));
  return `[${sorted.map((value) => formatYamlString(value)).join(", ")}]`;
}

/**
 * Format a finite numeric scalar without allowing `NaN` or infinities into persisted frontmatter.
 */
function formatYamlNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Entity estimate must be a finite number before serialization.");
  }

  return String(value);
}

/**
 * Decide whether a scalar can be written without quotes while preserving the same parsed value.
 *
 * The guard rejects empty values, YAML keywords, leading punctuation, and characters that commonly
 * alter YAML parsing. Timestamps are intentionally allowed because the parser already normalizes
 * YAML Date instances back to ISO strings.
 */
function isSafePlainYamlScalar(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _./:-]*$/.test(value)) {
    return false;
  }

  if (value.includes(": ")) {
    return false;
  }

  const lower = value.toLowerCase();
  return !["null", "true", "false", "nan", "inf", "infinity"].includes(lower);
}

/**
 * Create a parse error that preserves enough context for tests, MCP errors, and future diagnostics.
 */
function entityParseError(filePath: string, message: string): Error {
  const error = new Error(`${filePath}: ${message}`);
  error.name = "EntityParseError";
  return error;
}

/**
 * Read a required marker string field with file context in the error.
 */
function readMarkerString(filePath: string, data: Record<string, unknown>, key: keyof ProjectMarker): string {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    throw markerParseError(filePath, `Marker field '${key}' must be a non-empty string.`);
  }

  return value;
}

/**
 * Create a marker parse error that identifies the broken marker file.
 */
function markerParseError(filePath: string, message: string): Error {
  const error = new Error(`${filePath}: ${message}`);
  error.name = "ProjectMarkerParseError";
  return error;
}

/**
 * Create a counter parse error that identifies the broken counter file.
 */
function counterParseError(filePath: string, message: string): Error {
  const error = new Error(`${filePath}: ${message}`);
  error.name = "CounterParseError";
  return error;
}

/**
 * Create a move error that identifies the project root involved in the failed move.
 */
function entityMoveError(root: string, message: string): Error {
  const error = new Error(`${root}: ${message}`);
  error.name = "EntityMoveError";
  return error;
}

/**
 * Create a write error that identifies the unsafe or invalid entity path.
 */
function entityWriteError(filePath: string, message: string): Error {
  const error = new Error(`${filePath}: ${message}`);
  error.name = "EntityWriteError";
  return error;
}

/**
 * Durably replace one file using a temp file in the same directory.
 *
 * Writing the temp file beside the target keeps `rename` atomic on the same filesystem. The file is
 * fsynced before rename, and the directory fsync is attempted after rename so metadata is flushed on
 * platforms that support opening directories.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await removeTempFileIfPresent(tempPath);
    throw error;
  }
}

/**
 * Best-effort directory fsync for metadata durability.
 *
 * Windows and some filesystems reject directory handles; the temp-file fsync plus rename still
 * preserves atomic replacement, so unsupported directory fsync is ignored rather than making writes
 * unusable on those platforms.
 */
async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error) || !["EISDIR", "EINVAL", "EPERM", "EACCES"].includes(error.code ?? "")) {
      throw error;
    }
  }
}

/**
 * Clean up an abandoned temp file without masking the write failure that caused cleanup.
 */
async function removeTempFileIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Narrow unknown filesystem errors to Node's code-carrying error shape.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
