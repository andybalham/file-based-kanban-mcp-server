import { buildDepGraph, topoSort } from "./graph.js";
import type { EffectiveStatus, Entity, EntityId, EntityType, Index } from "./types.js";

/**
 * Effective status values plus the dependency gates that caused downward propagation.
 *
 * Most callers only need `resolveAll()`. The detailed shape is exported so later query,
 * validation, and generator tasks can explain whether an entity is blocked by its own dependency
 * gate or by the nearest gate-blocked ancestor.
 */
export interface StatusResolution {
  /** Effective status per entity after dependency rules and downward gate propagation. */
  effective: Map<EntityId, EffectiveStatus>;
  /** Entities that became blocked specifically because their own same-type dependency was incomplete. */
  gateBlocked: Set<EntityId>;
  /** Propagated blockers keyed by descendant id; values are nearest gate-blocked ancestor ids. */
  propagatedBy: Map<EntityId, EntityId>;
}

/**
 * Resolve the design's three-layer status model for every entity in an index.
 *
 * Resolution intentionally runs from tasks upward to stories and then epics. Each layer applies
 * same-type dependency gates in topological order, so a dependent can see the already-computed
 * effective statuses of its prerequisites. A final pass propagates composite dependency gates down
 * to unfinished descendants, making an effective `todo` task synonymous with workable-now.
 */
export function resolveAll(index: Index): Map<EntityId, EffectiveStatus> {
  return resolveDetailed(index).effective;
}

/**
 * Resolve effective statuses and keep blocker provenance for downstream reporting.
 */
export function resolveDetailed(index: Index): StatusResolution {
  const effective = new Map<EntityId, EffectiveStatus>();
  const gateBlocked = new Set<EntityId>();
  const propagatedBy = new Map<EntityId, EntityId>();

  resolveLayer(index, "task", effective, gateBlocked);
  resolveLayer(index, "story", effective, gateBlocked);
  resolveLayer(index, "epic", effective, gateBlocked);
  propagateCompositeGates(index, effective, gateBlocked, propagatedBy);

  return { effective, gateBlocked, propagatedBy };
}

/**
 * Resolve one same-type dependency graph using intrinsic statuses already available for that layer.
 */
function resolveLayer(
  index: Index,
  type: EntityType,
  effective: Map<EntityId, EffectiveStatus>,
  gateBlocked: Set<EntityId>
): void {
  const graph = buildDepGraph(index, type);
  const orderedIds = topoSortOrStableNodes(graph);

  for (const id of orderedIds) {
    const entity = index.byId.get(id);
    if (entity === undefined) {
      continue;
    }

    const intrinsic = intrinsicStatus(index, entity, effective);
    const dependencies = graph.dependenciesOf.get(id) ?? [];
    const hasIncompleteDependency = dependencies.some((dependencyId) => effective.get(dependencyId) !== "done");
    const resolved = applyDependencyRule(intrinsic, hasIncompleteDependency);

    effective.set(id, resolved);

    if (resolved === "blocked" && hasIncompleteDependency && (intrinsic === "todo" || intrinsic === "empty")) {
      gateBlocked.add(id);
    }
  }
}

/**
 * Use dependency-before-dependent order for valid DAGs, but keep status resolution total.
 *
 * Validation owns rejecting cycles with detailed diagnostics. The resolver may still be called on a
 * malformed in-memory graph during recovery or tests, so it falls back to lexical node order rather
 * than throwing and preventing a full project state from being inspected.
 */
function topoSortOrStableNodes(graph: ReturnType<typeof buildDepGraph>): EntityId[] {
  try {
    return topoSort(graph);
  } catch (error) {
    if (error instanceof Error && error.name === "GraphCycleError") {
      return [...graph.nodes];
    }

    throw error;
  }
}

/**
 * Compute an entity's intrinsic status before same-type dependencies are considered.
 */
function intrinsicStatus(index: Index, entity: Entity, effective: Map<EntityId, EffectiveStatus>): EffectiveStatus {
  if (entity.type === "task") {
    return entity.status;
  }

  return rollupStatus(activeChildStatuses(index, entity.id, effective));
}

/**
 * Return effective statuses for non-archived children only, preserving the design's active rollup.
 */
function activeChildStatuses(
  index: Index,
  parentId: EntityId,
  effective: Map<EntityId, EffectiveStatus>
): EffectiveStatus[] {
  const statuses: EffectiveStatus[] = [];

  for (const childId of index.childrenOf.get(parentId) ?? []) {
    const child = index.byId.get(childId);
    if (child === undefined || child.archived) {
      continue;
    }

    const childStatus = effective.get(childId);
    if (childStatus !== undefined) {
      statuses.push(childStatus);
    }
  }

  return statuses;
}

/**
 * Roll up child effective statuses into the intrinsic status for a story or epic.
 */
function rollupStatus(childStatuses: EffectiveStatus[]): EffectiveStatus {
  if (childStatuses.length === 0) {
    return "empty";
  }

  if (childStatuses.every((status) => status === "done")) {
    return "done";
  }

  if (childStatuses.some((status) => status === "blocked")) {
    return "blocked";
  }

  if (childStatuses.some((status) => status === "in-progress" || status === "done")) {
    return "in-progress";
  }

  return "todo";
}

/**
 * Apply the same-type dependency rule after intrinsic status has been computed.
 */
function applyDependencyRule(intrinsic: EffectiveStatus, hasIncompleteDependency: boolean): EffectiveStatus {
  if (!hasIncompleteDependency) {
    return intrinsic;
  }

  if (intrinsic === "todo" || intrinsic === "empty") {
    return "blocked";
  }

  return intrinsic;
}

/**
 * Push gate-blocked composite statuses to unfinished descendants.
 */
function propagateCompositeGates(
  index: Index,
  effective: Map<EntityId, EffectiveStatus>,
  gateBlocked: Set<EntityId>,
  propagatedBy: Map<EntityId, EntityId>
): void {
  for (const id of sortedIds(gateBlocked)) {
    const entity = index.byId.get(id);
    if (entity === undefined || entity.type === "task") {
      continue;
    }

    blockNonDoneDescendants(index, id, id, effective, propagatedBy);
  }
}

/**
 * Mark each non-done descendant as blocked because a nearest ancestor is dependency-gated.
 */
function blockNonDoneDescendants(
  index: Index,
  currentId: EntityId,
  gateId: EntityId,
  effective: Map<EntityId, EffectiveStatus>,
  propagatedBy: Map<EntityId, EntityId>
): void {
  for (const childId of index.childrenOf.get(currentId) ?? []) {
    const child = index.byId.get(childId);
    if (child === undefined || child.archived) {
      continue;
    }

    if (effective.get(childId) !== "done") {
      effective.set(childId, "blocked");
      propagatedBy.set(childId, gateId);
    }

    blockNonDoneDescendants(index, childId, gateId, effective, propagatedBy);
  }
}

/**
 * Return ids in lexical order so propagation metadata is deterministic when gates overlap.
 */
function sortedIds(ids: Iterable<EntityId>): EntityId[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}
