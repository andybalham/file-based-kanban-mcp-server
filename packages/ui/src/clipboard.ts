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
  if (clipboard === undefined) {
    throw new Error("Clipboard API is not available.");
  }

  const label = formatCommitLabel(entity);
  await clipboard.writeText(label);
  return label;
}
