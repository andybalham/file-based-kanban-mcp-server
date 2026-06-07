import path from "node:path";

import { buildDepGraph } from "./graph.js";
import type { EffectiveStatus, Entity, EntityId, EntityType, Index } from "./types.js";

/**
 * Status class names used in Mermaid node suffixes and `classDef` declarations.
 *
 * Mermaid class identifiers are intentionally normalized instead of using the raw status strings
 * because `in-progress` contains a hyphen. The generated labels still keep the canonical entity
 * ids and titles from the authoritative frontmatter.
 */
const STATUS_CLASS_BY_STATUS: Record<EffectiveStatus, string> = {
  blocked: "blocked",
  done: "done",
  empty: "empty",
  "in-progress": "inprogress",
  todo: "todo"
};

/**
 * Stable visual styles for every effective status emitted by the status resolver.
 *
 * These class definitions keep status out of the graph structure, which preserves the design's
 * rule that dependency edges are same-type relationships rather than visual state transitions.
 */
const STATUS_CLASS_DEFINITIONS: Array<[string, string]> = [
  ["done", "fill:#c6f6d5,stroke:#22543d;"],
  ["blocked", "fill:#fed7d7,stroke:#742a2a;"],
  ["inprogress", "fill:#feebc8,stroke:#744210;"],
  ["todo", "fill:#e2e8f0,stroke:#2d3748;"],
  ["empty", "fill:#edf2f7,stroke:#718096,stroke-dasharray: 3 3;"]
];

/**
 * Entity layers rendered by the full dependency graph.
 *
 * The order mirrors the design document's bands so people reading `dependencies.mmd` see the
 * high-level plan before drilling into stories and tasks.
 */
const FULL_GRAPH_BANDS: Array<{ type: EntityType; label: string }> = [
  { type: "epic", label: "Epics" },
  { type: "story", label: "Stories" },
  { type: "task", label: "Tasks" }
];

/**
 * Render `.worktracker/graphs/dependencies.mmd`.
 *
 * The diagram contains three independent Mermaid subgraphs, one for each same-type dependency DAG.
 * No cross-band edges are emitted because cross-type dependencies are out of scope for v1.
 */
export function renderDependencies(index: Index, eff: Map<EntityId, EffectiveStatus>): string {
  const lines = renderHeader();

  for (const band of FULL_GRAPH_BANDS) {
    appendBand(lines, index, eff, band.label, activeEntitiesOfType(index, band.type));
  }

  appendClicks(lines, activeEntities(index));
  return withTrailingNewline(lines);
}

/**
 * Render `.worktracker/graphs/E-NNN.mmd` for one epic.
 *
 * Per-epic diagrams focus on the epic's own story and task work. They include story dependency
 * edges among that epic's stories and task dependency edges among tasks under those stories.
 */
export function renderEpicSubgraph(
  index: Index,
  epicId: EntityId,
  eff: Map<EntityId, EffectiveStatus>
): string {
  const epic = index.byId.get(epicId);
  if (epic === undefined || epic.type !== "epic") {
    throw new Error(`Cannot render epic Mermaid graph for unknown epic id ${epicId}.`);
  }

  const stories = childEntities(index, epicId, "story");
  const storyIds = new Set(stories.map((story) => story.id));
  const tasks = stories.flatMap((story) => childEntities(index, story.id, "task"));
  const taskIds = new Set(tasks.map((task) => task.id));
  const lines = renderHeader();

  appendBand(lines, index, eff, "Stories", stories, storyIds);
  appendBand(lines, index, eff, "Tasks", tasks, taskIds);
  appendClicks(lines, [...stories, ...tasks]);
  return withTrailingNewline(lines);
}

/**
 * Create the fixed Mermaid graph prelude and status class declarations.
 */
function renderHeader(): string[] {
  const lines = ["graph LR"];

  for (const [className, definition] of STATUS_CLASS_DEFINITIONS) {
    lines.push(`  classDef ${className} ${definition}`);
  }

  return lines;
}

/**
 * Append one labelled subgraph containing nodes followed by same-type edges.
 *
 * `allowedEdgeIds` lets per-epic graphs suppress same-type dependencies that point outside the
 * epic's own work while preserving the full graph's complete same-type DAGs.
 */
function appendBand(
  lines: string[],
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  label: string,
  entities: Entity[],
  allowedEdgeIds: Set<EntityId> = new Set(entities.map((entity) => entity.id))
): void {
  lines.push(`  subgraph ${label}`);

  for (const entity of entities) {
    lines.push(`    ${nodeKey(entity.id)}["${escapeMermaidLabel(`${entity.id} ${entity.title}`)}"]:::${statusClass(eff, entity.id)}`);
  }

  for (const edge of edgesFor(index, entities, allowedEdgeIds)) {
    lines.push(`    ${nodeKey(edge.from)} --> ${nodeKey(edge.to)}`);
  }

  lines.push("  end");
}

/**
 * Return dependency edges as prerequisite -> dependent pairs sorted by `(from, to)`.
 */
function edgesFor(
  index: Index,
  entities: Entity[],
  allowedEdgeIds: Set<EntityId>
): Array<{ from: EntityId; to: EntityId }> {
  const type = entities[0]?.type ?? null;
  if (type === null) {
    return [];
  }

  const graph = buildDepGraph(index, type);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const edges: Array<{ from: EntityId; to: EntityId }> = [];

  for (const dependentId of [...entityIds].sort((a, b) => a.localeCompare(b))) {
    for (const dependencyId of graph.dependenciesOf.get(dependentId) ?? []) {
      if (allowedEdgeIds.has(dependencyId)) {
        edges.push({ from: dependencyId, to: dependentId });
      }
    }
  }

  edges.sort((left, right) => {
    const fromComparison = left.from.localeCompare(right.from);
    return fromComparison === 0 ? left.to.localeCompare(right.to) : fromComparison;
  });

  return edges;
}

/**
 * Emit one Mermaid click directive per rendered node.
 */
function appendClicks(lines: string[], entities: Entity[]): void {
  for (const entity of entities) {
    lines.push(`  click ${nodeKey(entity.id)} "${clickTarget(entity)}"`);
  }
}

/**
 * Build a generated-file-relative link that works from `.worktracker/graphs/*.mmd`.
 *
 * Entity paths may be absolute or relative depending on how tests or store scans constructed the
 * index. The generated graph files always live one level below `.worktracker`, so links target the
 * sibling `entities/` folder and are normalized to forward slashes for Mermaid/GitHub.
 */
function clickTarget(entity: Entity): string {
  const normalizedPath = entity.filePath.replaceAll("\\", "/");
  const marker = ".worktracker/";
  const markerIndex = normalizedPath.lastIndexOf(marker);
  const relativeToWorktracker =
    markerIndex === -1 ? `entities/${path.posix.basename(normalizedPath)}` : normalizedPath.slice(markerIndex + marker.length);

  return `../${relativeToWorktracker}`;
}

/**
 * Return active entities of a type in deterministic id order.
 */
function activeEntitiesOfType(index: Index, type: EntityType): Entity[] {
  return activeEntities(index).filter((entity) => entity.type === type);
}

/**
 * Return active entities in deterministic id order.
 */
function activeEntities(index: Index): Entity[] {
  return [...index.byId.values()]
    .filter((entity) => !entity.archived)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Return active direct children of the expected type in deterministic child order.
 */
function childEntities(index: Index, parentId: EntityId, type: EntityType): Entity[] {
  return (index.childrenOf.get(parentId) ?? [])
    .map((childId) => index.byId.get(childId))
    .filter((entity): entity is Entity => entity !== undefined && !entity.archived && entity.type === type)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Convert an entity id into a Mermaid-safe node key.
 */
function nodeKey(id: EntityId): string {
  return id.replace(/[^A-Za-z0-9_]/g, "");
}

/**
 * Resolve the Mermaid class name for an entity, defaulting to `empty` when status is absent.
 */
function statusClass(eff: Map<EntityId, EffectiveStatus>, id: EntityId): string {
  return STATUS_CLASS_BY_STATUS[eff.get(id) ?? "empty"];
}

/**
 * Escape text used inside Mermaid's quoted node label.
 */
function escapeMermaidLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

/**
 * Join generated lines with a final newline so snapshot files and write checks are byte-stable.
 */
function withTrailingNewline(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}
