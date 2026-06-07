import { buildDepGraph, detectDepCycle, detectHierarchyCycle } from "./graph.js";
import { resolveAll } from "./status.js";
import type { EffectiveStatus, Entity, EntityId, EntityType, Index, ValidationIssue, ValidationResult } from "./types.js";

/**
 * Validate the full in-memory project graph before any mutation is written.
 *
 * This module implements the design's §13 integrity contract at the core boundary. It reports
 * blocking relationship errors separately from warnings that are valid but operationally important,
 * such as a done task whose prerequisite is still incomplete.
 */
export function validate(index: Index): ValidationResult {
  const errors: ValidationIssue[] = [
    ...validateHierarchy(index),
    ...validateDependencies(index)
  ];

  const warnings = validateWarnings(index);

  return {
    errors: sortIssues(errors),
    warnings: sortIssues(warnings)
  };
}

/**
 * Check parent existence, parent shape, and hierarchy cycles independently from dependencies.
 */
function validateHierarchy(index: Index): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const entity of sortedEntities(index)) {
    const expectedParentType = parentTypeFor(entity.type);

    if (entity.type === "epic") {
      if (entity.parent !== null) {
        issues.push(issue("EPIC_HAS_PARENT", entity.id, "Epics must not declare a parent."));
      }
      continue;
    }

    if (entity.parent === null) {
      issues.push(issue("PARENT_REQUIRED", entity.id, `${entity.type} entities must declare a parent.`));
      continue;
    }

    const parent = index.byId.get(entity.parent);
    if (parent === undefined) {
      issues.push(issue("DANGLING_PARENT", entity.id, `Parent '${entity.parent}' does not exist.`));
      continue;
    }

    if (parent.type !== expectedParentType) {
      issues.push(
        issue(
          "INVALID_PARENT_TYPE",
          entity.id,
          `${entity.type} parent '${parent.id}' must be a ${expectedParentType}.`
        )
      );
    }
  }

  const hierarchyCycle = detectHierarchyCycle(index);
  if (hierarchyCycle !== null) {
    issues.push(issue("HIERARCHY_CYCLE", hierarchyCycle[0], `Hierarchy cycle detected: ${hierarchyCycle.join(" -> ")}.`));
  }

  return issues;
}

/**
 * Check dependency references and the three independent same-type DAGs.
 */
function validateDependencies(index: Index): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const entity of sortedEntities(index)) {
    for (const dependencyId of sortedUnique(entity.dependsOn)) {
      if (dependencyId === entity.id) {
        issues.push(issue("SELF_DEPENDENCY", entity.id, `Entity '${entity.id}' must not depend on itself.`));
        continue;
      }

      const dependency = index.byId.get(dependencyId);
      if (dependency === undefined) {
        issues.push(issue("DANGLING_DEPENDENCY", entity.id, `Dependency '${dependencyId}' does not exist.`));
        continue;
      }

      if (dependency.type !== entity.type) {
        issues.push(
          issue(
            "DEP_TYPE_MISMATCH",
            entity.id,
            `${entity.type} dependency '${dependency.id}' must also be a ${entity.type}.`
          )
        );
      }
    }
  }

  for (const type of ENTITY_TYPES) {
    const cycle = detectDepCycle(buildDepGraph(index, type));
    if (cycle !== null) {
      issues.push(issue("DEP_CYCLE", cycle[0], `${type} dependency cycle detected: ${cycle.join(" -> ")}.`));
    }
  }

  return issues;
}

/**
 * Surface allowed-but-suspicious status states after effective status resolution.
 */
function validateWarnings(index: Index): ValidationIssue[] {
  const effective = resolveAll(index);
  const warnings: ValidationIssue[] = [];

  for (const entity of sortedEntities(index)) {
    if (entity.archived) {
      continue;
    }

    if (isEmptyComposite(index, entity)) {
      warnings.push(issue("EMPTY_COMPOSITE", entity.id, `${entity.type} has no active children.`));
    }

    const incompleteDependencies = incompleteSameTypeDependencies(index, effective, entity);
    if (incompleteDependencies.length === 0) {
      continue;
    }

    const status = effective.get(entity.id);
    if (status === "in-progress") {
      warnings.push(
        issue(
          "IN_PROGRESS_WITH_INCOMPLETE_DEP",
          entity.id,
          `Entity '${entity.id}' is in progress with incomplete dependencies: ${incompleteDependencies.join(", ")}.`
        )
      );
    }

    if (status === "done") {
      warnings.push(
        issue(
          "DONE_WITH_INCOMPLETE_DEP",
          entity.id,
          `Entity '${entity.id}' is done with incomplete dependencies: ${incompleteDependencies.join(", ")}.`
        )
      );
    }
  }

  return warnings;
}

/**
 * Map a child layer to the only valid parent layer from the design hierarchy.
 */
function parentTypeFor(type: EntityType): EntityType | null {
  if (type === "task") {
    return "story";
  }

  if (type === "story") {
    return "epic";
  }

  return null;
}

/**
 * Detect childless active composites so the UI and agents can distinguish empty from real todo work.
 */
function isEmptyComposite(index: Index, entity: Entity): boolean {
  if (entity.type === "task") {
    return false;
  }

  return (index.childrenOf.get(entity.id) ?? []).every((childId) => index.byId.get(childId)?.archived !== false);
}

/**
 * Return known same-type dependencies whose effective status has not reached done.
 */
function incompleteSameTypeDependencies(
  index: Index,
  effective: Map<EntityId, EffectiveStatus>,
  entity: Entity
): EntityId[] {
  return sortedUnique(entity.dependsOn).filter((dependencyId) => {
    const dependency = index.byId.get(dependencyId);
    return (
      dependency !== undefined &&
      !dependency.archived &&
      dependency.type === entity.type &&
      effective.get(dependencyId) !== "done"
    );
  });
}

/**
 * Construct a validation issue with a stable code and optional entity location.
 */
function issue(code: string, entityId: EntityId | undefined, message: string): ValidationIssue {
  return entityId === undefined ? { code, message } : { code, entityId, message };
}

/**
 * Return entities in id order so validation output is deterministic.
 */
function sortedEntities(index: Index): Entity[] {
  return [...index.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Remove duplicate dependency references before emitting diagnostics.
 */
function sortedUnique(ids: EntityId[]): EntityId[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Keep validation output stable across platforms and map insertion order.
 */
function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((left, right) => {
    const entityComparison = (left.entityId ?? "").localeCompare(right.entityId ?? "");
    if (entityComparison !== 0) {
      return entityComparison;
    }

    return left.code.localeCompare(right.code);
  });
}

const ENTITY_TYPES: EntityType[] = ["epic", "story", "task"];
