import type { EntityDetail } from "./api";

/** Minimal Clipboard shape used by the drawer so tests can inject a deterministic fake. */
export interface ClipboardWriter {
  /** Browser clipboard write method used for the operator-only commit label action. */
  writeText(text: string): Promise<void>;
}

/**
 * Format the read-only commit label copied from the entity drawer.
 *
 * Keeping this in a pure helper makes the exact `<id>: <title>` contract testable without mounting
 * React or reaching for browser APIs in Node's test runner.
 */
export function formatCommitLabel(entity: Pick<EntityDetail, "id" | "title">): string {
  return `${entity.id}: ${entity.title}`;
}

/**
 * Copy the current entity's commit label through the browser Clipboard API.
 *
 * The helper deliberately receives the clipboard object instead of looking it up globally. That
 * keeps the UI read-only and lets tests prove the success path without mutating browser state.
 */
export async function copyCommitLabel(entity: Pick<EntityDetail, "id" | "title">, clipboard: ClipboardWriter | undefined): Promise<string> {
  return writeToClipboard(formatCommitLabel(entity), clipboard);
}

/** Entity fields the implementation prompt needs; a subset of the drawer's detail payload. */
export type ImplementationPromptEntity = Pick<EntityDetail, "id" | "type" | "title">;

/**
 * Format a prompt that asks an LLM coding agent to implement the drawer's current entity.
 *
 * The prompt is deliberately pointer-based: it names the entity and tells the agent to fetch the
 * description, dependencies, and children from the file-based Kanban MCP server, so the copied text
 * can never go stale against the frontmatter that is authoritative for the project. Three operator
 * rules are always present: use the MCP server for board access, delegate the implementation to a
 * sub-agent on a model that fits the task, and never commit without confirmation. Status is the
 * agent's to update (`in-progress` on start, `done` once checks pass); only the commit is held.
 *
 * Only tasks store status, so stories and epics are phrased as "work through the child tasks"
 * instead of asking the agent to set a status on a composite. A story runs to completion before
 * the agent reports; an epic stops after each story so work is reviewed one story at a time.
 *
 * This stays a pure string builder: the viewer remains read-only and the exact wording is covered
 * by tests without mounting React.
 */
export function formatImplementationPrompt(entity: ImplementationPromptEntity, projectId: string): string {
  const entityResource = `entity://${projectId}/${entity.id}`;
  // Per-task work shared by the story and epic prompts, so both delegate and verify identically.
  const delegateStep =
    "then delegate its implementation to a sub-agent, choosing a model suited to the task's complexity, and have it follow the repository's agent instructions.";
  const checkSteps = [
    "Run the project's build, tests, and lint, and fix any failures.",
    "Once the checks pass, set that task to `done` with `set_status`."
  ];

  const steps =
    entity.type === "epic"
      ? [
          // Epics pause at every story boundary so the operator reviews and commits one story at a time.
          `Read \`${entityResource}\` and its stories and tasks through the MCP server for the descriptions, dependencies, and acceptance criteria.`,
          `Use \`query_ready\` to choose a story under ${entity.id} that has a ready task, and work on that story only; if no task is ready, stop and report what is blocking.`,
          `Pick the next ready task in that story, set it to \`in-progress\` with \`set_status\`, ${delegateStep}`,
          ...checkSteps,
          "Repeat from step 3 until every task in that story is done; if the remaining tasks are blocked, stop and report what is blocking.",
          "Never commit. Stop after the story, report what changed, and wait for my confirmation before committing or starting the next story."
        ]
      : entity.type === "task"
      ? [
          `Read \`${entityResource}\` and its parent through the MCP server for the description, dependencies, and acceptance criteria.`,
          "Check that every dependency is done; if any is not, stop and report instead of starting.",
          `Set ${entity.id} to \`in-progress\` with \`set_status\`.`,
          "Delegate the implementation to a sub-agent, choosing a model suited to the task's complexity, and have it follow the repository's agent instructions.",
          "Run the project's build, tests, and lint, and fix any failures.",
          `Once the checks pass, set ${entity.id} to \`done\` with \`set_status\`.`,
          "Never commit. Report what changed and wait for my confirmation before committing."
        ]
      : [
          `Read \`${entityResource}\` and its children through the MCP server for the descriptions, dependencies, and acceptance criteria.`,
          `Use \`query_ready\` to pick the next ready task under ${entity.id}; if none is ready, stop and report what is blocking.`,
          `Set that task to \`in-progress\` with \`set_status\`, ${delegateStep}`,
          ...checkSteps,
          `Repeat from step 2 until every task under ${entity.id} is done.`,
          "Never commit. Report what changed and wait for my confirmation before committing."
        ];

  return [
    `Implement ${entity.type} ${entity.id} "${entity.title}" from the kanban project \`${projectId}\`.`,
    "",
    "Use the file-based Kanban MCP server for every board read and update.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n");
}

/**
 * Copy the implementation prompt for the current entity through the browser Clipboard API.
 *
 * Like `copyCommitLabel`, the clipboard is injected so tests can observe the write.
 */
export async function copyImplementationPrompt(
  entity: ImplementationPromptEntity,
  projectId: string,
  clipboard: ClipboardWriter | undefined
): Promise<string> {
  return writeToClipboard(formatImplementationPrompt(entity, projectId), clipboard);
}

/** Write text to the supplied clipboard, failing loudly when the browser exposes none. */
async function writeToClipboard(text: string, clipboard: ClipboardWriter | undefined): Promise<string> {
  if (clipboard === undefined) {
    throw new Error("Clipboard API is not available.");
  }

  await clipboard.writeText(text);
  return text;
}
