/**
 * Public API barrel for the core package.
 *
 * Phase 0 exports only the shared data model. Later phases should add store, validation, graph,
 * status, and generator exports here so server code imports through one stable boundary.
 */
export type {
  EffectiveStatus,
  Entity,
  EntityId,
  EntityType,
  Index,
  ProjectId,
  ProjectMarker,
  ProjectState,
  StoredStatus,
  ValidationIssue,
  ValidationResult
} from "./types.js";

export {
  allocateId,
  createStore,
  discoverProjects,
  move,
  parse,
  readMarker,
  scan,
  seedRequirements,
  serializeEntity,
  write,
  writeMarker
} from "./store.js";
export type { DiscoveredProject, Store } from "./store.js";
export {
  blocked,
  buildDepGraph,
  criticalPath,
  detectDepCycle,
  detectHierarchyCycle,
  ready,
  topoSort
} from "./graph.js";
export type { BlockedEntity, CriticalPathResult, DepGraph } from "./graph.js";
export { resolveAll, resolveDetailed } from "./status.js";
export type { StatusResolution } from "./status.js";
export { validate } from "./validate.js";
