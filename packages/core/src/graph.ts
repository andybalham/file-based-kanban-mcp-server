import type { Entity, EntityId, EntityType, Index } from "./types.js";

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
