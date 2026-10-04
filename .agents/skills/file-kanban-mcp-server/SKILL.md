---
name: file-kanban-mcp-server
description: Use this skill whenever the user wants to plan, track, or implement work through the File-Based Kanban MCP Server. This includes prompts about file-kanban, `.worktracker` projects, picking up or finishing a task, ready and blocked work, decomposing requirements into epics, stories, and tasks, dependencies, the critical path, or validation errors and warnings. Prefer this skill for any agent workflow that should read or change kanban work through MCP instead of direct Markdown edits.
---

# File-Based Kanban MCP Server

Read and change the board only through the MCP tools and resources. Never edit `.worktracker`
files by hand, including to work around a tool error: entity files are validated as one graph, and
the indexes and graphs are regenerated output.

## Resolve The Project

- `projectId` may be omitted when exactly one project is registered. If a call fails with
  `AMBIGUOUS_PROJECT`, call `list_projects` and pass `projectId` on every later call.
- Call `init` with a `title` and the repository `root` only when `.worktracker/project.json` is
  absent. Optional `intent` seeds the requirements text once, at creation.

## Know The Model

- Hierarchy is `epic -> story -> task`. Stories need an epic parent, tasks need a story parent,
  and epics have none.
- Dependencies are same-type only: epic to epic, story to story, task to task.
- In `link_dependency` and `unlink_dependency`, `from` depends on `to`: `to` must be done first.
- Only tasks store status: `todo`, `in-progress`, or `done`. `set_status` on a story or epic fails
  with `NOT_A_TASK`; their status, and every `blocked` state, is computed.
- A task can be blocked by its own dependencies or by a blocked parent story or epic.
- `update_entity` changes only `title`, `body`, `estimate`, and `tags`. Use `move_entity` for the
  parent, the link tools for dependencies, and `set_status` for status.
- Descriptions and acceptance criteria live in `body`. `estimate` is a task's weight in
  `critical_path`; a task without one counts as 1.
- `archive_entity` is a soft delete: it marks the entity archived and keeps the file.

## Implement Work

1. Call `query_ready` to find actionable tasks. It returns ids only, so read
   `entity://{project}/{id}`, and the parent story when needed, for the description and acceptance
   criteria. Do not infer readiness from files or from the board index.
2. Set the chosen task to `in-progress` with `set_status` before changing code.
3. Do the work and verify it against the acceptance criteria.
4. Set the task to `done` with `set_status`, then call `query_ready` again for the next task.
5. If nothing is ready, call `query_blocked` and report whether each blocker is the task's own
   dependency or one propagated from its parent story or epic.

## Plan Work

1. Read `requirements://{project}/source` before decomposing.
2. Create epics for large outcomes, stories for coherent deliverables, and tasks for concrete
   implementation steps, parents first. Keep task titles imperative and specific, and put
   acceptance criteria in `body`.
3. Add dependencies with `dependsOn` at creation or with `link_dependency` afterwards.
4. Call `validate` after the batch. Fix errors before continuing; report warnings to the user as
   cleanup work.

`critical_path` returns the longest dependency chain for one entity type and defaults to tasks.
`graph://{project}/dependencies` and `graph://{project}/epic/{id}` return Mermaid text, and
`index://{project}/board` returns the Markdown board summary.

## Report And Repair

- Mutations return `changedFiles`. Report them, because the user commits board changes themselves.
- When a tool returns a structured error, fix the call or the underlying board state through
  another tool.
- If the user asked only for a diagnosis, propose the smallest repair sequence without applying
  it. Apply repairs when the user asked for a fix.

Client installation and server configuration are covered in `README.md` and
`docs/operator-workflows.md`.
