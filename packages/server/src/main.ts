import type { ProjectState } from "@file-kanban/core";

export type {
  InitProjectArgs,
  InitProjectResult,
  ProjectRegistry,
  ProjectRegistryOptions,
  ProjectStateBuilder,
  RegisteredProject,
  RegistryErrorCode
} from "./registry.js";
export { RegistryError } from "./registry.js";

/**
 * Produce a compact human-readable label for a project.
 *
 * This helper is intentionally small in Phase 0: it proves the server package can consume the
 * core public type surface while later registry and MCP work are still unimplemented.
 */
export function describeProject(state: ProjectState): string {
  // The marker title is user-facing, while the project id disambiguates projects with similar names.
  return `${state.marker.title} (${state.projectId})`;
}
