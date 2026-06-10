import type {
  BoardEpic,
  BoardResponse,
  BoardStory,
  BoardTask,
  EffectiveStatus,
  EntityId,
  EntityType,
  EntityView,
  GraphEdge,
  GraphResponse,
  StoredStatus
} from "./api";

/**
 * Board task annotated with the epic and story that place it in the visible hierarchy.
 *
 * The derived ready and blocked views are flat lists, but the design still shows each task's
 * breadcrumb. Keeping the ancestors next to the task avoids repeated tree walks in React rows.
 */
export interface IndexedBoardTask {
  /** Leaf task returned by `/api/:project/board`. */
  task: BoardTask;
  /** Epic ancestor used for breadcrumbs and graph scoping. */
  epic: BoardEpic;
  /** Story ancestor used for breadcrumbs and graph scoping. */
  story: BoardStory;
}

/**
 * Flattened board lookup used by every read-only derived view.
 *
 * The maps intentionally contain only the active entities exposed by the server board endpoint.
 * Archived rows are omitted by Phase 6 collection endpoints, so UI derivations do not resurrect
 * archived work unless a later direct entity read asks for it.
 */
export interface BoardIndex {
  /** Active entities keyed by id for blocker labels and relation-style lookups. */
  byId: Map<EntityId, BoardEpic | BoardStory | BoardTask>;
  /** Active tasks keyed by id for task-only dependency views. */
  taskById: Map<EntityId, BoardTask>;
  /** Active tasks in deterministic board traversal order with ancestor context. */
  tasks: IndexedBoardTask[];
}

/**
 * Blocked task row with blocker metadata joined from the same board snapshot.
 *
 * Missing blockers are retained so the UI can still show the id that explains the server-computed
 * block even when the referenced entity is outside the active board collection.
 */
export interface BlockedTaskRow extends IndexedBoardTask {
  /** Dependency or propagated gate ids explaining the task's effective blocked status. */
  blockers: Array<{
    /** Blocker id supplied by the server `blockedBy` field. */
    id: EntityId;
    /** Best-effort title when the blocker is in the current board response. */
    title: string | null;
    /** Best-effort effective status when the blocker is in the current board response. */
    status: EffectiveStatus | null;
    /** True when the id was not present in the active board response. */
    missing: boolean;
  }>;
}

/** Counts shown in the shell tab bar and project summary. */
export interface BoardCounts {
  /** Total active tasks present in the board hierarchy. */
  totalTasks: number;
  /** Tasks that are immediately workable according to the server effective status. */
  readyTasks: number;
  /** Tasks whose effective status is blocked by dependencies or propagated gates. */
  blockedTasks: number;
  /** Tasks whose effective status is done. */
  doneTasks: number;
}

/** Graph scope used by the graph toolbar. */
export type GraphScope = { type: "full" } | { type: "epic"; id: EntityId };

/**
 * Status values that the UI status palette can render in graph nodes.
 *
 * The server may return `empty` for composite entities, but task graph nodes use the four design
 * colors. `graphDisplayStatus` maps `empty` to `todo` for visual fallback.
 */
export type GraphDisplayStatus = StoredStatus | "blocked";

/** Graph entity prepared for the task dependency graph views. */
export interface GraphViewEntity {
  /** Stable task id used for labels, click targets, and edge endpoints. */
  id: EntityId;
  /** Human-readable task title. */
  title: string;
  /** Persisted task status from the server read model. */
  status: StoredStatus;
  /** Effective status used for blocker-aware node color and filters. */
  effectiveStatus: EffectiveStatus;
  /** Epic ancestor id used by the scope selector. */
  epicId: EntityId;
  /** Story ancestor id retained for future breadcrumbs and detail affordances. */
  storyId: EntityId;
}

/**
 * Dependency edge in the direction rendered by the UI: prerequisite -> dependent.
 *
 * The HTTP API reports edges as the entity that declares the dependency (`from`) pointing at the
 * prerequisite (`to`). The graph view inverts that into the visual flow promised by the UI design.
 */
export interface GraphViewEdge {
  /** Prerequisite task id. */
  from: EntityId;
  /** Dependent task id that waits on `from`. */
  to: EntityId;
}

/** Summary row for one epic in the graph scope selector. */
export interface GraphScopeEpic {
  /** Epic id. */
  id: EntityId;
  /** Epic title. */
  title: string;
  /** Number of active task graph nodes under the epic. */
  taskCount: number;
}

/** Complete task graph view model consumed by Mermaid and interactive graph components. */
export interface GraphViewModel {
  /** Task nodes in deterministic id order. */
  entities: GraphViewEntity[];
  /** Task dependency edges in prerequisite -> dependent direction. */
  edges: GraphViewEdge[];
  /** Total active task nodes before scoping. */
  totalTasks: number;
  /** Scope selector entries in deterministic epic order. */
  epics: GraphScopeEpic[];
}

/** Layout options ported from the prototype graph logic. */
export interface GraphLayoutOptions {
  /** Fixed node width in SVG units. */
  nodeW?: number;
  /** Fixed node height in SVG units. */
  nodeH?: number;
  /** Horizontal gap between dependency layers. */
  hGap?: number;
  /** Vertical gap between rows within one layer. */
  vGap?: number;
}

/** Position and bounds returned by the deterministic graph layout. */
export interface GraphLayout {
  /** Top-left node coordinates keyed by task id. */
  pos: Record<EntityId, { x: number; y: number }>;
  /** Width needed to contain all layers. */
  width: number;
  /** Height needed to contain the largest centered layer. */
  height: number;
  /** Node width used for the layout. */
  nodeW: number;
  /** Node height used for the layout. */
  nodeH: number;
  /** Longest-path layer keyed by task id. */
  layer: Record<EntityId, number>;
}

/** Hex colors that must match the design token status palette and Mermaid class definitions. */
const STATUS_COLORS: Record<GraphDisplayStatus, { fill: string; ink: string; className: string }> = {
  blocked: { fill: "#fed7d7", ink: "#742a2a", className: "blocked" },
  done: { fill: "#c6f6d5", ink: "#22543d", className: "done" },
  "in-progress": { fill: "#feebc8", ink: "#744210", className: "inprogress" },
  todo: { fill: "#e2e8f0", ink: "#2d3748", className: "todo" }
};

/**
 * Flatten a board response into deterministic lookup structures.
 */
export function indexBoard(board: BoardResponse): BoardIndex {
  const byId = new Map<EntityId, BoardEpic | BoardStory | BoardTask>();
  const taskById = new Map<EntityId, BoardTask>();
  const tasks: IndexedBoardTask[] = [];

  for (const epic of board.epics) {
    byId.set(epic.id, epic);

    for (const story of epic.children) {
      byId.set(story.id, story);

      for (const task of story.children) {
        byId.set(task.id, task);
        taskById.set(task.id, task);
        tasks.push({ task, epic, story });
      }
    }
  }

  return { byId, taskById, tasks };
}

/**
 * Return the current Ready tab rows.
 *
 * The server has already applied dependency and downward gate propagation. A task is ready when it
 * is still stored as `todo` and its effective status is also `todo`.
 */
export function readyTasks(board: BoardResponse): IndexedBoardTask[] {
  return indexBoard(board).tasks
    .filter(({ task }) => task.status === "todo" && task.effectiveStatus === "todo")
    .sort(compareIndexedTasks);
}

/**
 * Return the current Blocked tab rows.
 *
 * This follows the repository's current contract where `blocked` is computed, not stored. The
 * server-provided `blockedBy` ids are joined against the active board so later UI rows can render
 * blocker chips without reaching back into transport data.
 */
export function blockedTasks(board: BoardResponse): BlockedTaskRow[] {
  const index = indexBoard(board);

  return index.tasks
    .filter(({ task }) => task.effectiveStatus === "blocked")
    .map((row) => ({
      ...row,
      blockers: taskBlockers(row.task, index)
    }))
    .sort(compareIndexedTasks);
}

/**
 * Return shell counts from the same ready/blocked rules used by the detailed views.
 */
export function summarizeBoard(board: BoardResponse | null): BoardCounts {
  if (board === null) {
    return { totalTasks: 0, readyTasks: 0, blockedTasks: 0, doneTasks: 0 };
  }

  const indexed = indexBoard(board);

  return {
    totalTasks: indexed.tasks.length,
    readyTasks: indexed.tasks.filter(({ task }) => task.status === "todo" && task.effectiveStatus === "todo").length,
    blockedTasks: indexed.tasks.filter(({ task }) => task.effectiveStatus === "blocked").length,
    doneTasks: indexed.tasks.filter(({ task }) => task.effectiveStatus === "done").length
  };
}

/**
 * Return epic/story ids that have visible children and therefore can participate in local collapse.
 *
 * Empty composites are not included because collapsing them would create local state with no visible
 * effect, which makes "Collapse all / Expand all" drift away from what the user can see.
 */
export function collapsibleBoardIds(board: BoardResponse | null): EntityId[] {
  if (board === null) {
    return [];
  }

  return board.epics.flatMap((epic) => [
    ...(epic.children.length > 0 ? [epic.id] : []),
    ...epic.children.flatMap((story) => (story.children.length > 0 ? [story.id] : []))
  ]);
}

/**
 * Format the inline blocked note used on Board task rows.
 *
 * The note is tied to the server-computed effective status. A todo task with no blockers should not
 * imply it is waiting, and a future direct archived row can still be dimmed without blocker copy.
 */
export function blockedByNote(task: BoardTask): string | null {
  if (task.effectiveStatus !== "blocked" || task.blockedBy.length === 0) {
    return null;
  }

  return `waiting on ${task.blockedBy.join(", ")}`;
}

/**
 * Count descendant task progress for a board node.
 *
 * The server already supplies progress, but this helper mirrors the prototype rule for future UI
 * components that need to derive progress from an isolated subtree in tests or memoized state.
 */
export function progress(node: BoardEpic | BoardStory | BoardTask): { done: number; total: number } {
  if (node.type === "task") {
    return { done: node.effectiveStatus === "done" ? 1 : 0, total: 1 };
  }

  const childProgress = node.children.map(progress);
  return childProgress.reduce(
    (total, child) => ({ done: total.done + child.done, total: total.total + child.total }),
    { done: 0, total: 0 }
  );
}

/**
 * Build the scoped task dependency graph consumed by the Graph tab.
 *
 * Board data supplies the epic/story membership that the graph endpoint intentionally does not
 * duplicate. The graph endpoint supplies typed dependency edges and computed statuses.
 */
export function buildTaskGraph(board: BoardResponse, graph: GraphResponse, scope: GraphScope = { type: "full" }): GraphViewModel {
  const indexed = indexBoard(board);
  const graphEntityById = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const activeTaskRows = indexed.tasks.filter(({ task }) => graphEntityById.get(task.id)?.type === "task");
  const scopedRows = scope.type === "epic" ? activeTaskRows.filter(({ epic }) => epic.id === scope.id) : activeTaskRows;
  const scopedIds = new Set(scopedRows.map(({ task }) => task.id));
  const epics = board.epics
    .map((epic) => ({
      id: epic.id,
      title: epic.title,
      taskCount: indexed.tasks.filter((row) => row.epic.id === epic.id && graphEntityById.get(row.task.id)?.type === "task").length
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const entities = scopedRows
    .map(({ task, epic, story }) => graphEntity(task, epic, story, graphEntityById.get(task.id)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = graph.edges
    .filter((edge) => edge.type === "task" && scopedIds.has(edge.from) && scopedIds.has(edge.to))
    .map((edge) => ({ from: edge.to, to: edge.from }))
    .sort(compareGraphEdges);

  return {
    entities,
    edges,
    totalTasks: activeTaskRows.length,
    epics
  };
}

/**
 * Layout a DAG with the prototype's stable longest-path layering.
 *
 * Cycles should already be rejected by validation, but the recursion guard preserves a finite
 * layout if an invalid graph somehow reaches the browser.
 */
export function layoutGraph(
  entities: ReadonlyArray<{ id: EntityId }>,
  edges: ReadonlyArray<GraphViewEdge>,
  options: GraphLayoutOptions = {}
): GraphLayout {
  const nodeW = options.nodeW ?? 172;
  const nodeH = options.nodeH ?? 48;
  const hGap = options.hGap ?? 64;
  const vGap = options.vGap ?? 22;
  const ids = entities.map((entity) => entity.id).sort((left, right) => left.localeCompare(right));
  const idSet = new Set(ids);
  const predecessors = Object.fromEntries(ids.map((id) => [id, [] as EntityId[]]));

  for (const edge of edges) {
    if (idSet.has(edge.from) && idSet.has(edge.to)) {
      predecessors[edge.to].push(edge.from);
    }
  }

  for (const id of ids) {
    predecessors[id].sort((left, right) => left.localeCompare(right));
  }

  const layer: Record<EntityId, number> = {};
  const visiting = new Set<EntityId>();

  function computeLayer(id: EntityId): number {
    if (layer[id] !== undefined) {
      return layer[id];
    }

    if (visiting.has(id)) {
      return 0;
    }

    visiting.add(id);
    layer[id] = Math.max(0, ...predecessors[id].map((predecessorId) => computeLayer(predecessorId) + 1));
    visiting.delete(id);
    return layer[id];
  }

  ids.forEach(computeLayer);

  const maxLayer = Math.max(0, ...ids.map((id) => layer[id]));
  const byLayer = new Map<number, EntityId[]>();
  for (const id of ids) {
    const idsForLayer = byLayer.get(layer[id]) ?? [];
    idsForLayer.push(id);
    byLayer.set(layer[id], idsForLayer);
  }

  for (const idsForLayer of byLayer.values()) {
    idsForLayer.sort((left, right) => left.localeCompare(right));
  }

  const maxRows = Math.max(0, ...Array.from(byLayer.values()).map((idsForLayer) => idsForLayer.length));
  const fullHeight = maxRows === 0 ? 0 : maxRows * nodeH + (maxRows - 1) * vGap;
  const pos: Record<EntityId, { x: number; y: number }> = {};

  for (let columnIndex = 0; columnIndex <= maxLayer; columnIndex += 1) {
    const column = byLayer.get(columnIndex) ?? [];
    const columnHeight = column.length === 0 ? 0 : column.length * nodeH + (column.length - 1) * vGap;
    const offsetY = (fullHeight - columnHeight) / 2;

    column.forEach((id, rowIndex) => {
      pos[id] = {
        x: columnIndex * (nodeW + hGap),
        y: offsetY + rowIndex * (nodeH + vGap)
      };
    });
  }

  return {
    pos,
    width: ids.length === 0 ? 0 : (maxLayer + 1) * nodeW + maxLayer * hGap,
    height: fullHeight,
    nodeW,
    nodeH,
    layer
  };
}

/**
 * Generate browser-side Mermaid text for the currently scoped task graph.
 *
 * Server-generated Mermaid remains canonical for persisted artifacts. This helper exists so the
 * Graph tab can render filtered/scoped browser views while preserving the same status palette.
 */
export function toMermaid(entities: ReadonlyArray<GraphViewEntity>, edges: ReadonlyArray<GraphViewEdge>): string {
  const lines = ["graph LR"];

  for (const entity of [...entities].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `  ${mermaidNodeKey(entity.id)}["${escapeMermaidLabel(`${entity.id}<br/>${entity.title}`)}"]:::${statusClass(
        entity.effectiveStatus
      )}`
    );
  }

  for (const edge of [...edges].sort(compareGraphEdges)) {
    lines.push(`  ${mermaidNodeKey(edge.from)} --> ${mermaidNodeKey(edge.to)}`);
  }

  for (const status of ["done", "in-progress", "blocked", "todo"] as const) {
    const colors = STATUS_COLORS[status];
    lines.push(`  classDef ${colors.className} fill:${colors.fill},stroke:${colors.ink},color:${colors.ink},stroke-width:1px;`);
  }

  return lines.join("\n");
}

/**
 * Return the Mermaid class for an effective status using the four-color UI contract.
 */
export function statusClass(status: EffectiveStatus): string {
  return STATUS_COLORS[graphDisplayStatus(status)].className;
}

/**
 * Return the graph palette status, collapsing `empty` to the neutral todo style.
 */
export function graphDisplayStatus(status: EffectiveStatus): GraphDisplayStatus {
  return status === "empty" ? "todo" : status;
}

/**
 * Join blocker ids to titles and statuses from the current active board snapshot.
 */
function taskBlockers(task: BoardTask, index: BoardIndex): BlockedTaskRow["blockers"] {
  return task.blockedBy.map((id) => {
    const blocker = index.byId.get(id);

    return {
      id,
      title: blocker?.title ?? null,
      status: blocker?.effectiveStatus ?? null,
      missing: blocker === undefined
    };
  });
}

/**
 * Prefer graph endpoint entity status/title when present, while preserving board ancestry.
 */
function graphEntity(
  task: BoardTask,
  epic: BoardEpic,
  story: BoardStory,
  graphEntityFromApi: EntityView | undefined
): GraphViewEntity {
  return {
    id: task.id,
    title: graphEntityFromApi?.title ?? task.title,
    status: graphEntityFromApi?.status ?? task.status,
    effectiveStatus: graphEntityFromApi?.effectiveStatus ?? task.effectiveStatus,
    epicId: epic.id,
    storyId: story.id
  };
}

/**
 * Deterministic task row ordering for flat views.
 */
function compareIndexedTasks(left: IndexedBoardTask, right: IndexedBoardTask): number {
  return left.task.id.localeCompare(right.task.id);
}

/**
 * Deterministic edge ordering for graph renderers.
 */
function compareGraphEdges(left: GraphViewEdge, right: GraphViewEdge): number {
  const fromComparison = left.from.localeCompare(right.from);
  return fromComparison === 0 ? left.to.localeCompare(right.to) : fromComparison;
}

/**
 * Convert an entity id into a Mermaid-safe key without allowing an empty identifier.
 */
function mermaidNodeKey(id: EntityId): string {
  const sanitized = id.replace(/[^A-Za-z0-9]/g, "");
  return `n${sanitized.length === 0 ? "node" : sanitized}`;
}

/**
 * Escape text used inside Mermaid's quoted HTML label.
 */
function escapeMermaidLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("\"", "&quot;");
}
