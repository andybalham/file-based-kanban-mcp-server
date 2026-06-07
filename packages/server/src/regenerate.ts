import path from "node:path";

import { resolveAll, scan, writeGeneratedArtifacts } from "@file-kanban/core";
import type { EffectiveStatus, EntityId, GeneratedArtifact, Index, ProjectId, ProjectState } from "@file-kanban/core";

/**
 * Destination for paths written by the regeneration pipeline.
 *
 * The Phase 6 watcher will use this information to suppress broadcasts caused by the server's own
 * generated artifact writes. A plain `Set<string>` is enough for the current in-process contract and
 * keeps the pipeline independent of chokidar or WebSocket concerns.
 */
export type WriteSuppressionSet = Set<string>;

/**
 * Options controlling one project-scoped regeneration run.
 */
export interface RegenerateProjectOptions {
  /**
   * Whether to rescan `.worktracker/entities` before rendering generated artifacts.
   *
   * The default is true because mutating tools write Markdown files first, then ask this pipeline to
   * refresh the runtime cache from the authoritative store. Tests and later in-memory mutation code
   * can set this to false when `project.index` is already known to be current.
   */
  refreshIndex?: boolean;

  /**
   * Optional per-project write suppression set that receives every generated artifact path touched
   * by this server-side regeneration run.
   */
  writeSuppressionSet?: WriteSuppressionSet;
}

/**
 * Result of regenerating one project's derived artifacts.
 */
export interface RegenerationResult {
  /** Project id copied from the regenerated state for routing and later broadcast hooks. */
  projectId: ProjectId;
  /** Absolute project root containing the regenerated `.worktracker/` subtree. */
  root: string;
  /** Refreshed index used for rendering this artifact set. */
  index: Index;
  /** Recomputed effective statuses cached back onto the project state. */
  eff: Map<EntityId, EffectiveStatus>;
  /** Deterministic artifact paths returned by the core writer. */
  artifacts: GeneratedArtifact[];
  /** Absolute artifact paths recorded for future watcher write suppression. */
  suppressedPaths: string[];
}

/**
 * Regenerate all derived files for one project after a successful mutation.
 *
 * This function is the server-side orchestration layer from §9.3: it refreshes the selected
 * `ProjectState`, recomputes effective statuses with core status rules, delegates deterministic file
 * output to core, and records the generated paths for later watcher suppression. It intentionally
 * does not perform git commits or WebSocket broadcasts; those are optional/future side effects that
 * can compose around this stable pipeline.
 */
export async function regenerateProject(
  project: ProjectState,
  options: RegenerateProjectOptions = {}
): Promise<RegenerationResult> {
  const refreshIndex = options.refreshIndex ?? true;
  const index = refreshIndex ? await scan(project.root) : project.index;
  const eff = resolveAll(index);

  project.index = index;
  project.eff = eff;

  const artifacts = await writeGeneratedArtifacts(project.root, index, eff);
  const suppressedPaths = recordSuppressedArtifactPaths(project.root, artifacts, options.writeSuppressionSet);

  return {
    projectId: project.projectId,
    root: project.root,
    index,
    eff,
    artifacts,
    suppressedPaths
  };
}

/**
 * Record generated artifact paths in absolute normalized form.
 *
 * Normalizing at the pipeline boundary gives future watcher code one path representation to compare
 * against, regardless of how the core writer or the operating system formats path separators.
 */
function recordSuppressedArtifactPaths(
  root: string,
  artifacts: GeneratedArtifact[],
  writeSuppressionSet: WriteSuppressionSet | undefined
): string[] {
  const suppressedPaths = artifacts.map((artifact) => path.resolve(root, artifact.filePath));

  if (writeSuppressionSet !== undefined) {
    for (const filePath of suppressedPaths) {
      writeSuppressionSet.add(filePath);
    }
  }

  return suppressedPaths;
}
