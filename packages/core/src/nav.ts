import path from "node:path";

import type { EffectiveStatus, Entity, EntityId, Index } from "./types.js";

/**
 * Render `.worktracker/index/INDEX.md`.
 *
 * This is the top-level generated board. It links each active epic to its per-epic generated page
 * and expands active stories and tasks below it using GitHub task-list syntax.
 */
export function renderIndex(index: Index, eff: Map<EntityId, EffectiveStatus>): string {
  const lines = renderDocumentHeader("Project board");

  for (const epic of activeEntities(index, "epic")) {
    lines.push(`## [${entityLabel(epic)}](./${epic.id}.md) — ${statusOf(eff, epic.id)}`);
    appendStories(lines, index, eff, epic.id);
    lines.push("");
  }

  return withTrailingNewline(trimTrailingBlank(lines));
}

/**
 * Render `.worktracker/index/E-NNN.md` for one epic.
 *
 * The per-epic page keeps the same generated navigation rules as the board index, but scopes the
 * content to one epic so large projects can be reviewed without opening the full dependency board.
 */
export function renderEpicIndex(
  index: Index,
  epicId: EntityId,
  eff: Map<EntityId, EffectiveStatus>
): string {
  const epic = index.byId.get(epicId);
  if (epic === undefined || epic.type !== "epic") {
    throw new Error(`Cannot render epic Markdown index for unknown epic id ${epicId}.`);
  }

  const lines = renderDocumentHeader(entityLabel(epic));
  lines.push(`Status: ${statusOf(eff, epic.id)}`);
  lines.push("");
  appendStories(lines, index, eff, epic.id);

  return withTrailingNewline(trimTrailingBlank(lines));
}

/**
 * Render `.worktracker/index/READY.md`.
 *
 * Effective `todo` tasks are ready because status resolution has already applied same-type
 * dependency gates and downward composite gate propagation.
 */
export function renderReady(index: Index, eff: Map<EntityId, EffectiveStatus>): string {
  const lines = renderDocumentHeader("Ready tasks");
  const tasks = activeEntities(index, "task").filter((task) => eff.get(task.id) === "todo");

  if (tasks.length === 0) {
    lines.push("No ready tasks.");
  } else {
    for (const task of tasks) {
      lines.push(`- [ ] [${entityLabel(task)}](${entityLink(task)}) — todo`);
    }
  }

  return withTrailingNewline(lines);
}

/**
 * Render `.worktracker/index/BLOCKED.md`.
 *
 * Blocked rows include all entity types. Own incomplete same-type dependencies are reported first;
 * propagated blocks report the nearest dependency-gated ancestor so readers can see the real gate.
 */
export function renderBlocked(index: Index, eff: Map<EntityId, EffectiveStatus>): string {
  const lines = renderDocumentHeader("Blocked work");
  const entities = activeEntities(index).filter((entity) => eff.get(entity.id) === "blocked");

  if (entities.length === 0) {
    lines.push("No blocked work.");
  } else {
    for (const entity of entities) {
      lines.push(`- [${entityLabel(entity)}](${entityLink(entity)}) — blocked${waitingOn(index, eff, entity)}`);
    }
  }

  return withTrailingNewline(lines);
}

/**
 * Create the common generated Markdown prelude used by all navigation files.
 */
function renderDocumentHeader(title: string): string[] {
  return [`# ${title}`, "", "_Generated. Do not edit by hand._", ""];
}

/**
 * Append active stories and their task lists for one epic.
 */
function appendStories(
  lines: string[],
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  epicId: EntityId
): void {
  const stories = childEntities(index, epicId, "story");

  if (stories.length === 0) {
    lines.push("- No stories.");
    return;
  }

  for (const story of stories) {
    lines.push(`- ${checkbox(eff, story.id)} **${entityLabel(story)}** — ${statusOf(eff, story.id)}${waitingOn(index, eff, story)}`);
    appendTasks(lines, index, eff, story.id);
  }
}

/**
 * Append active tasks below a story.
 */
function appendTasks(
  lines: string[],
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  storyId: EntityId
): void {
  const tasks = childEntities(index, storyId, "task");

  if (tasks.length === 0) {
    lines.push("  - No tasks.");
    return;
  }

  for (const task of tasks) {
    lines.push(
      `  - ${checkbox(eff, task.id)} [${entityLabel(task)}](${entityLink(task)}) — ${statusOf(eff, task.id)}${waitingOn(index, eff, task)}`
    );
  }
}

/**
 * Return a GitHub task-list checkbox matching the entity's effective completion state.
 */
function checkbox(eff: Map<EntityId, EffectiveStatus>, id: EntityId): string {
  return eff.get(id) === "done" ? "[x]" : "[ ]";
}

/**
 * Format an entity as the design's stable `ID · Title` display label.
 */
function entityLabel(entity: Entity): string {
  return `${entity.id} · ${entity.title}`;
}

/**
 * Return the effective status string shown in generated Markdown.
 */
function statusOf(eff: Map<EntityId, EffectiveStatus>, id: EntityId): EffectiveStatus {
  return eff.get(id) ?? "empty";
}

/**
 * Return a generated-index-relative entity link.
 *
 * Generated Markdown files live in `.worktracker/index/`, so entity links point to the sibling
 * `.worktracker/entities/` folder and use forward slashes for GitHub rendering on every platform.
 */
function entityLink(entity: Entity): string {
  const normalizedPath = entity.filePath.replaceAll("\\", "/");
  const marker = ".worktracker/";
  const markerIndex = normalizedPath.lastIndexOf(marker);
  const relativeToWorktracker =
    markerIndex === -1 ? `entities/${path.posix.basename(normalizedPath)}` : normalizedPath.slice(markerIndex + marker.length);

  return `../${relativeToWorktracker}`;
}

/**
 * Format blocker text when an entity is blocked by dependencies or propagation.
 */
function waitingOn(index: Index, eff: Map<EntityId, EffectiveStatus>, entity: Entity): string {
  const blockers = blockerIds(index, eff, entity);
  return blockers.length === 0 ? "" : ` · waiting on ${blockers.join(", ")}`;
}

/**
 * Find blockers for generated navigation without requiring status provenance as an input.
 *
 * The first pass reports the entity's own incomplete same-type dependencies. If none exist, the
 * hierarchy walk finds the nearest blocked ancestor that does have incomplete dependencies, matching
 * the downward gate propagation rule from the status resolver.
 */
function blockerIds(index: Index, eff: Map<EntityId, EffectiveStatus>, entity: Entity): EntityId[] {
  const ownBlockers = ownIncompleteDependencies(index, eff, entity);
  if (ownBlockers.length > 0) {
    return ownBlockers;
  }

  const ancestor = nearestDependencyGatedAncestor(index, eff, entity);
  return ancestor === null ? [] : [ancestor.id];
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
 * Walk parents until the nearest ancestor with its own dependency gate is found.
 */
function nearestDependencyGatedAncestor(
  index: Index,
  eff: Map<EntityId, EffectiveStatus>,
  entity: Entity
): Entity | null {
  let parentId = entity.parent;

  while (parentId !== null) {
    const parent = index.byId.get(parentId);
    if (parent === undefined || parent.archived) {
      return null;
    }

    if (eff.get(parent.id) === "blocked" && ownIncompleteDependencies(index, eff, parent).length > 0) {
      return parent;
    }

    parentId = parent.parent;
  }

  return null;
}

/**
 * Return active entities, optionally constrained by type, in deterministic id order.
 */
function activeEntities(index: Index, type?: Entity["type"]): Entity[] {
  return [...index.byId.values()]
    .filter((entity) => !entity.archived && (type === undefined || entity.type === type))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Return active direct children of the expected type in deterministic id order.
 */
function childEntities(index: Index, parentId: EntityId, type: Entity["type"]): Entity[] {
  return (index.childrenOf.get(parentId) ?? [])
    .map((childId) => index.byId.get(childId))
    .filter((entity): entity is Entity => entity !== undefined && !entity.archived && entity.type === type)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Remove trailing blank lines while preserving intentional interior spacing.
 */
function trimTrailingBlank(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }

  return trimmed;
}

/**
 * Join generated lines with a final newline so repeated generation is byte-identical.
 */
function withTrailingNewline(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}
