import type { ProjectState } from "@file-kanban/core";

export function describeProject(state: ProjectState): string {
  return `${state.marker.title} (${state.id})`;
}
