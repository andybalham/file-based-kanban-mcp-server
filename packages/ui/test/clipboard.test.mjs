import assert from "node:assert/strict";
import { test } from "node:test";

import {
  copyCommitLabel,
  copyImplementationPrompt,
  formatCommitLabel,
  formatImplementationPrompt
} from "../dist-types/clipboard.js";

/** Task fixture with the only fields the pointer-based implementation prompt reads. */
const promptTask = { id: "T-103", type: "task", title: "Login form" };

/** Project fixture carrying an id the prompt must never print: projects are named by title only. */
const promptProject = { projectId: "wt_demo", title: "Demo Project" };

test("task implementation prompts point at the MCP server, delegate to a sub-agent, and never commit", () => {
  assert.equal(
    formatImplementationPrompt(promptTask, promptProject),
    [
      'Implement task T-103 "Login form" from the kanban project "Demo Project".',
      "",
      "Use the file-based Kanban MCP server for every board read and update.",
      "",
      "1. Read `T-103: Login form` and its parent through the MCP server for the description, dependencies, and acceptance criteria.",
      "2. Check that every dependency is done; if any is not, stop and report instead of starting.",
      "3. Set T-103 to `in-progress` with `set_status`.",
      "4. Delegate the implementation to a sub-agent, choosing a model suited to the task's complexity, and have it follow the repository's agent instructions.",
      "5. Run the project's build, tests, and lint, and fix any failures.",
      "6. Once the checks pass, set T-103 to `done` with `set_status`.",
      "7. Never commit: committing is my responsibility, not yours. Report what changed and leave the changes uncommitted for me to review and commit."
    ].join("\n")
  );
});

test("story implementation prompts work through every child task before reporting", () => {
  const prompt = formatImplementationPrompt({ id: "S-014", type: "story", title: "Sign in" }, promptProject);

  assert.match(prompt, /^Implement story S-014 "Sign in" from the kanban project "Demo Project"\./);
  assert.match(prompt, /Use the file-based Kanban MCP server for every board read and update\./);
  assert.match(prompt, /1\. Read `S-014: Sign in` and its children through the MCP server/);
  assert.doesNotMatch(prompt, /entity:\/\/|wt_demo/);
  assert.match(prompt, /Use `query_ready` to pick the next ready task under S-014/);
  assert.match(prompt, /delegate its implementation to a sub-agent, choosing a model suited to the task's complexity/);
  assert.match(prompt, /Once the checks pass, set that task to `done` with `set_status`\./);
  assert.match(prompt, /Repeat from step 2 until every task under S-014 is done\./);
  assert.match(
    prompt,
    /Never commit: committing is my responsibility, not yours\. Report what changed and leave the changes uncommitted for me to review and commit\.$/
  );
  assert.doesNotMatch(prompt, /Set S-014 to/);
});

test("epic implementation prompts stop for confirmation after each story", () => {
  assert.equal(
    formatImplementationPrompt({ id: "E-001", type: "epic", title: "Authentication" }, promptProject),
    [
      'Implement epic E-001 "Authentication" from the kanban project "Demo Project".',
      "",
      "Use the file-based Kanban MCP server for every board read and update.",
      "",
      "1. Read `E-001: Authentication` and its stories and tasks through the MCP server for the descriptions, dependencies, and acceptance criteria.",
      "2. Use `query_ready` to choose a story under E-001 that has a ready task, and work on that story only; if no task is ready, stop and report what is blocking.",
      "3. Pick the next ready task in that story, set it to `in-progress` with `set_status`, then delegate its implementation to a sub-agent, choosing a model suited to the task's complexity, and have it follow the repository's agent instructions.",
      "4. Run the project's build, tests, and lint, and fix any failures.",
      "5. Once the checks pass, set that task to `done` with `set_status`.",
      "6. Repeat from step 3 until every task in that story is done; if the remaining tasks are blocked, stop and report what is blocking.",
      "7. Never commit: committing is my responsibility, not yours. Stop after the story, report what changed, leave the changes uncommitted for me to review and commit, and wait for my confirmation before starting the next story."
    ].join("\n")
  );
});

test("copy implementation prompt writes the formatted prompt to the supplied clipboard", async () => {
  const writes = [];
  const copied = await copyImplementationPrompt(promptTask, promptProject, {
    async writeText(value) {
      writes.push(value);
    }
  });

  assert.equal(copied, formatImplementationPrompt(promptTask, promptProject));
  assert.deepEqual(writes, [copied]);
});

test("copy implementation prompt rejects when no clipboard is available", async () => {
  await assert.rejects(copyImplementationPrompt(promptTask, promptProject, undefined), /Clipboard API is not available/);
});

test("commit labels use the current drawer entity id and title", () => {
  assert.equal(formatCommitLabel({ id: "T-103", title: "Login form" }), "T-103: Login form");
});

test("copy commit label writes the formatted label to the supplied clipboard", async () => {
  const writes = [];
  const copied = await copyCommitLabel(
    { id: "S-014", title: "Document runtime configuration" },
    {
      async writeText(value) {
        writes.push(value);
      }
    }
  );

  assert.equal(copied, "S-014: Document runtime configuration");
  assert.deepEqual(writes, ["S-014: Document runtime configuration"]);
});
