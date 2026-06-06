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
  write(entity: Entity): Promise<void>;

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
    serialize: serializeEntity,
    write: (entity) => write(root, entity),
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
export async function write(root: string, entity: Entity): Promise<void> {
  const filePath = resolveEntityWritePath(root, entity.filePath);
  const serialized = serializeEntity({ ...entity, filePath });

  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === serialized) {
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  await atomicWriteFile(filePath, serialized);
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
