import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import type { Entity, EntityId, EntityType, Index, ProjectMarker, StoredStatus } from "./types.js";

/**
 * Root-relative directory that contains all human-authored entity Markdown files.
 *
 * The store treats frontmatter as authoritative and reads only this flat directory during v1 scans,
 * matching the technical design's storage model.
 */
const ENTITIES_DIR = path.join(".worktracker", "entities");

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
    readMarker: () => readMarker(root),
    writeMarker: (marker) => writeMarker(root, marker),
    seedRequirements: (intent) => seedRequirements(root, intent)
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
