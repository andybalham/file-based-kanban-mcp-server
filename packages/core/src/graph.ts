import type { EffectiveStatus, Entity, EntityId, EntityType, Index } from "./types.js";

/**
 * Dependency graph for exactly one entity type.
 *
 * The design models dependencies as three independent same-type DAGs: one for epics, one for
 * stories, and one for tasks. This structure keeps both directions because different callers need
 * different traversals: topological ordering walks from dependencies to dependents, while status
 * resolution and future blockers often need the dependencies declared by a single entity.
 */
export interface DepGraph {
  /** Entity type represented by every node in this graph. */
  type: EntityType;
  /** Deterministically sorted ids for every entity of `type` present in the index. */
  nodes: EntityId[];
  /** Declared same-type dependencies keyed by dependent id, sorted for stable traversal. */
  dependenciesOf: Map<EntityId, EntityId[]>;
  /** Reverse same-type edges keyed by prerequisite id, sorted for stable traversal. */
  dependentsOf: Map<EntityId, EntityId[]>;
}

/**
 * Blocked query row used by generated indexes, MCP tools, and the read-only viewer.
 *
 * `blockedBy` is intentionally just ids. Callers that need titles or links can join against the
 * same index without making the graph query depend on presentation concerns.
 */
export interface BlockedEntity {
  /** Blocked entity id. */
  id: EntityId;
  /** Entity layer for grouping and API responses. */
  type: EntityType;
  /** Incomplete same-type dependencies, or the nearest dependency-gated ancestor when propagated. */
  blockedBy: EntityId[];
}

/**
 * Critical-path result for one same-type dependency graph.
 *
 * The path is ordered from prerequisite to dependent because it is computed over the design's DAG
 * direction. `total` is the sum of node weights along that path.
 */
export interface CriticalPathResult {
  /** Longest deterministic dependency chain through the chosen entity type. */
  path: EntityId[];
  /** Sum of task estimates, or node count for stories and epics. */
  total: number;
}

/**
 * Build the dependency graph for one entity layer.
 *
 * Missing and cross-type dependency targets are deliberately ignored here because `graph.ts`
 * remains an algorithm module. The later validator task owns turning those malformed references
 * into `DANGLING_DEPENDENCY` and `DEP_TYPE_MISMATCH` errors before mutation writes are allowed.
 */
export function buildDepGraph(index: Index, type: EntityType): DepGraph {
  const nodes = [...index.byId.values()]
    .filter((entity) => entity.type === type)
    .map((entity) => entity.id)
    .sort((a, b) => a.localeCompare(b));
  const nodeSet = new Set(nodes);
  const dependenciesOf = new Map<EntityId, EntityId[]>();
  const dependentsOf = new Map<EntityId, EntityId[]>();

  for (const id of nodes) {
    dependenciesOf.set(id, []);
    dependentsOf.set(id, []);
  }

  for (const id of nodes) {
    const entity = index.byId.get(id);
    if (entity === undefined) {
      continue;
    }

    const sameTypeDependencies = entity.dependsOn.filter((dependencyId) => nodeSet.has(dependencyId));
    sameTypeDependencies.sort((a, b) => a.localeCompare(b));
    dependenciesOf.set(id, sameTypeDependencies);

    for (const dependencyId of sameTypeDependencies) {
      const dependents = dependentsOf.get(dependencyId) ?? [];
      dependents.push(id);
      dependentsOf.set(dependencyId, dependents);
    }
  }

  for (const dependents of dependentsOf.values()) {
    dependents.sort((a, b) => a.localeCompare(b));
  }

  return { type, nodes, dependenciesOf, dependentsOf };
}

/**
 * Return a concrete dependency cycle path, or null when the per-type graph is acyclic.
 *
 * The returned path repeats the first node at the end, e.g. `["T-001", "T-002", "T-001"]`, so
 * diagnostics and tests can display the exact closed loop without reconstructing it themselves.
 */
export function detectDepCycle(graph: DepGraph): EntityId[] | null {
  return detectCycle(graph.nodes, (id) => graph.dependenciesOf.get(id) ?? []);
}

/**
 * Return a concrete parent-cycle path in the hierarchy forest, or null when no cycle exists.
 *
 * Valid projects should form epic -> story -> task trees, but this function intentionally follows
 * any known parent edge regardless of type. That lets validation report hierarchy cycles even when
 * other parent-shape errors also exist in the same malformed proposal.
 */
export function detectHierarchyCycle(index: Index): EntityId[] | null {
  const nodes = [...index.byId.keys()].sort((a, b) => a.localeCompare(b));

  return detectCycle(nodes, (id) => {
    const parent = index.byId.get(id)?.parent ?? null;
    return parent !== null && index.byId.has(parent) ? [parent] : [];
  });
}

/**
 * Sort a dependency DAG so every prerequisite appears before every dependent that needs it.
 *
 * This is Kahn's algorithm with lexical tie-breaking. If callers accidentally pass a cyclic graph,
 * the function throws a named error containing the concrete cycle path so tests and later MCP
 * adapters can surface a useful diagnostic instead of a partial order.
 */
export function topoSort(graph: DepGraph): EntityId[] {
  const cycle = detectDepCycle(graph);
  if (cycle !== null) {
    throw graphCycleError(graph.type, cycle);
  }

  const remainingDependencyCounts = new Map<EntityId, number>();
  for (const id of graph.nodes) {
    remainingDependencyCounts.set(id, graph.dependenciesOf.get(id)?.length ?? 0);
  }

  const ready = graph.nodes.filter((id) => remainingDependencyCounts.get(id) === 0);
  const ordered: EntityId[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => a.localeCompare(b));
    const id = ready.shift();
    if (id === undefined) {
      break;
    }

    ordered.push(id);

    for (const dependentId of graph.dependentsOf.get(id) ?? []) {
      const nextCount = (remainingDependencyCounts.get(dependentId) ?? 0) - 1;
      remainingDependencyCounts.set(dependentId, nextCount);
      if (nextCount === 0) {
        ready.push(dependentId);
      }
    }
  }

  return ordered;
}

/**
 * Return currently workable task ids in deterministic order.
 *
 * The status resolver has already applied same-type dependencies and downward gate propagation, so
 * an effective `todo` task is by definition ready for an agent to pick up.
 */
export function ready(index: Index, eff: Map<EntityId, EffectiveStatus>): EntityId[] {
  return [...index.byId.values()]
    .filter((entity) => entity.type === "task" && !entity.archived && eff.get(entity.id) === "todo")
    .map((entity) => entity.id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Return blocked entities with the ids that explain the block.
 *
 * Own same-type dependency blockers take precedence because they are the direct gate for that
 * entity. If callers provide status propagation metadata from `resolveDetailed()`, entities blocked
 * through hierarchy propagation report the nearest gate-blocked ancestor. Roll-up-only blocked
 * composites have no direct dependency blocker, so they are returned with an empty `blockedBy` list.
 */
export function blocked(
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  propagatedBy: Map<EntityId, EntityId> = new Map()
): BlockedEntity[] {
  const blockedEntities: BlockedEntity[] = [];

  for (const entity of sortedEntities(index)) {
    if (entity.archived || eff.get(entity.id) !== "blocked") {
      continue;
    }

    blockedEntities.push({
      id: entity.id,
      type: entity.type,
      blockedBy: blockersFor(index, eff, propagatedBy, entity)
    });
  }

  return blockedEntities;
}

/**
 * Compute the deterministic longest path for one same-type dependency DAG.
 *
 * Task nodes use `estimate ?? 1` because only tasks carry estimated effort in v1. Composite nodes
 * use weight 1 so story and epic paths represent longest dependency chains by count.
 */
export function criticalPath(index: Index, type: EntityType = "task"): CriticalPathResult {
  const graph = activeDepGraph(index, type);
  const orderedIds = topoSort(graph);
  const bestById = new Map<EntityId, CriticalPathResult>();
  let bestOverall: CriticalPathResult = { path: [], total: 0 };

  for (const id of orderedIds) {
    const entity = index.byId.get(id);
    if (entity === undefined) {
      continue;
    }

    const ownWeight = nodeWeight(entity, type);
    const dependencyBest = bestDependencyPath(graph.dependenciesOf.get(id) ?? [], bestById);
    const current = {
      path: [...dependencyBest.path, id],
      total: dependencyBest.total + ownWeight
    };

    bestById.set(id, current);

    if (comparePathResults(current, bestOverall) < 0) {
      bestOverall = current;
    }
  }

  return bestOverall;
}

/**
 * Build a per-type graph that excludes archived entities from active query results.
 */
function activeDepGraph(index: Index, type: EntityType): DepGraph {
  const activeById = new Map(
    [...index.byId.entries()].filter(([, entity]) => !entity.archived)
  );

  return buildDepGraph({ byId: activeById, childrenOf: index.childrenOf }, type);
}

/**
 * Choose the strongest completed dependency path feeding a node.
 */
function bestDependencyPath(
  dependencyIds: EntityId[],
  bestById: Map<EntityId, CriticalPathResult>
): CriticalPathResult {
  let best: CriticalPathResult = { path: [], total: 0 };

  for (const dependencyId of dependencyIds) {
    const candidate = bestById.get(dependencyId);
    if (candidate !== undefined && comparePathResults(candidate, best) < 0) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Weight a node for critical-path math while preserving the design's task-only estimate rule.
 */
function nodeWeight(entity: Entity, type: EntityType): number {
  if (type !== "task") {
    return 1;
  }

  return entity.estimate ?? 1;
}

/**
 * Compare path results with higher total first and lexical path tie-breaking for determinism.
 */
function comparePathResults(left: CriticalPathResult, right: CriticalPathResult): number {
  if (left.total !== right.total) {
    return right.total - left.total;
  }

  return compareIdPaths(left.path, right.path);
}

/**
 * Lexically compare two id paths, preferring the stable non-empty path over the initial empty best.
 */
function compareIdPaths(left: EntityId[], right: EntityId[]): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return left.length - right.length;
}

/**
 * Return active entities in id order so query outputs are stable across platforms.
 */
function sortedEntities(index: Index): Entity[] {
  return [...index.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Find the blocker ids that best explain one blocked entity.
 */
function blockersFor(
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  propagatedBy: Map<EntityId, EntityId>,
  entity: Entity
): EntityId[] {
  const ownBlockers = ownIncompleteDependencies(index, eff, entity);
  if (ownBlockers.length > 0) {
    return ownBlockers;
  }

  const propagatedBlocker = propagatedBy.get(entity.id) ?? null;
  return propagatedBlocker === null ? [] : [propagatedBlocker];
}

/**
 * Return known same-type dependencies that are not effectively done.
 */
function ownIncompleteDependencies(index: Index, eff: Map<EntityId, EffectiveStatus>, entity: Entity): EntityId[] {
  return entity.dependsOn
    .filter((dependencyId) => {
      const dependency = index.byId.get(dependencyId);
      return (
        dependency !== undefined &&
        !dependency.archived &&
        dependency.type === entity.type &&
        eff.get(dependencyId) !== "done"
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Shared deterministic DFS cycle detector.
 *
 * `visiting` tracks the active recursion stack, while `visited` records nodes whose outgoing edges
 * have already been proven acyclic. Neighbor ids are sorted at each step so the same malformed graph
 * always reports the same cycle path.
 */
function detectCycle(nodes: EntityId[], getNeighbors: (id: EntityId) => EntityId[]): EntityId[] | null {
  const visiting = new Set<EntityId>();
  const visited = new Set<EntityId>();
  const stack: EntityId[] = [];

  for (const id of nodes) {
    const cycle = visitForCycle(id, getNeighbors, visiting, visited, stack);
    if (cycle !== null) {
      return cycle;
    }
  }

  return null;
}

/**
 * Visit one node for DFS cycle detection and return the closed cycle path when a back edge appears.
 */
function visitForCycle(
  id: EntityId,
  getNeighbors: (id: EntityId) => EntityId[],
  visiting: Set<EntityId>,
  visited: Set<EntityId>,
  stack: EntityId[]
): EntityId[] | null {
  if (visited.has(id)) {
    return null;
  }

  const existingStackIndex = stack.indexOf(id);
  if (visiting.has(id) && existingStackIndex !== -1) {
    return [...stack.slice(existingStackIndex), id];
  }

  visiting.add(id);
  stack.push(id);

  const neighbors = [...getNeighbors(id)].sort((a, b) => a.localeCompare(b));
  for (const neighborId of neighbors) {
    const cycle = visitForCycle(neighborId, getNeighbors, visiting, visited, stack);
    if (cycle !== null) {
      return cycle;
    }
  }

  stack.pop();
  visiting.delete(id);
  visited.add(id);
  return null;
}

/**
 * Create the named error thrown when a topological sort is requested for a cyclic dependency graph.
 */
function graphCycleError(type: EntityType, cycle: EntityId[]): Error {
  const error = new Error(`Cannot topologically sort cyclic ${type} dependency graph: ${cycle.join(" -> ")}.`);
  error.name = "GraphCycleError";
  return error;
}
