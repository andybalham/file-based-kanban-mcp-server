---
name: file-kanban-mcp-server
description: Use this skill whenever the user wants to configure, operate, troubleshoot, or delegate work through the File-Based Kanban MCP Server. This includes prompts about file-kanban, `.worktracker` projects, MCP tools or resources, ready and blocked work, validation warnings, same-type dependencies, generated board or graph artifacts, the read-only viewer, or setting up `file-kanban-mcp` in an agent coding client. Prefer this skill for any multi-step agent workflow that should mutate kanban work through MCP instead of direct Markdown edits.
---

# File-Based Kanban MCP Server

Use this skill to help agents operate the File-Based Kanban MCP Server through its MCP tools and
resources. The server stores epics, stories, and tasks as Markdown files in a repository-owned
`.worktracker/` directory, but agents should normally use the MCP surface as the write path. That
keeps validation, deterministic regeneration, and status computation in one place.

For implementation-specific setup details, consult `README.md` and `docs/operator-workflows.md`.

## First Principles

- Prefer MCP tools and resources over manual `.worktracker` edits when creating, changing,
  linking, moving, archiving, or validating work.
- Treat frontmatter as authoritative and generated indexes or graphs as derived outputs.
- Keep the browser and HTTP viewer read-only. Do not add mutation controls, browser write
  endpoints, drag-to-reorder behavior, or optimistic status updates. Use the viewer only for
  inspection, live refresh, and validation warnings.
- Run only one mutating MCP stdio process per `.worktracker/` project at a time. Multiple viewers
  are fine because they do not write files.
- When more than one project is registered, pass `projectId` explicitly so tool calls do not rely
  on ambiguous project resolution.
- After manual file edits, call `validate` before trusting the project state or proposing further
  mutations.
- Successful mutations regenerate `.worktracker/index/` and `.worktracker/graphs/`; report changed
  paths and leave git commits to the operator's normal workflow.

## Runtime Setup

Keep setup guidance short unless the user asks for a full client config. The agent usually needs
only the entrypoint shape and environment variable meanings.

Build the server package before configuring an MCP client:

```powershell
npm run build -w @file-kanban/server
```

Configure the MCP client to launch the built stdio server. Prefer one of these entrypoint shapes:

- Package bin shim: `node_modules/.bin/file-kanban-mcp` or `node_modules\.bin\file-kanban-mcp.cmd`.
- Direct Node entrypoint: `node packages/server/dist/stdio.js`.

Use this minimal client shape when an example is useful:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "node",
      "args": ["C:\\path\\to\\file-based-kanban-mcp-server\\packages\\server\\dist\\stdio.js"],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "C:\\path\\to\\target-repo",
        "FILE_KANBAN_WATCH_ROOTS": "C:\\path\\to"
      }
    }
  }
}
```

Key environment variables:

- `FILE_KANBAN_INIT_ROOT`: repository root targeted by the MCP `init` tool.
- `FILE_KANBAN_WATCH_ROOTS`: platform-delimited roots scanned for `.worktracker/project.json`
  markers and watched for project discovery.
- `FILE_KANBAN_PORT`: read-only HTTP/WebSocket viewer port, defaulting to `4000`.
- `FILE_KANBAN_GIT`: parsed as a boolean for forward compatibility; current mutation code does
  not perform automatic commits.

On Windows, separate multiple watch roots with `;`. On POSIX systems, use `:`. For client-specific
examples, use `README.md` or `docs/operator-workflows.md` instead of expanding this skill.

## Data Model

Keep the model compact in your working memory:

- Hierarchy is `epic -> story -> task`; epics have no parent, stories parent to epics, and tasks
  parent to stories.
- Only tasks store status: `todo`, `in-progress`, or `done`. Epic and story status is computed.
- Dependencies are same-type only: epic-to-epic, story-to-story, or task-to-task.
- Blocked composite work gates descendants: blocked stories block unfinished tasks, and blocked
  epics block unfinished stories and tasks.
- Preserve structured mutation errors for cycles, cross-type dependencies, dangling parents,
  invalid statuses, or immutable-field updates. Do not repair them by hand-editing files.

## Common Agent Workflows

### Bootstrap A Repository

Use `init` only when `.worktracker/project.json` is absent. It creates or reuses the marker,
optionally seeds requirements, registers the project in the current server process, and returns
the portable `projectId`. Keep that id in working context, read requirements if present, create
epics/stories/tasks through MCP mutation tools, add only same-type dependencies, then call
`validate`.

Discovery is marker-based. Use `list_projects` whenever the current project is unclear.

### Decompose Requirements

Read `requirements://{project}/source` when available. Create a small, implementation-oriented
backlog:

- Use epics for large outcomes.
- Use stories for coherent deliverables under an epic.
- Use tasks for concrete implementation steps that can carry status.
- Keep task titles imperative and specific.
- Link dependencies only within the same entity type.
- Validate before stopping.

### Find Ready Work

Use `query_ready` instead of inferring readiness from files. Ready work should account for task
status, task dependencies, and any story or epic gate propagation. When presenting a next task,
include why it is ready and whether a project id was assumed.

### Explain Blocked Work

Use `query_blocked` and, when helpful, read the relevant entity or graph resource. Explain whether
each blocker comes from:

- the entity's own same-type dependency;
- a blocked parent story; or
- a blocked parent epic.

Do not flatten these cases into a generic "dependency is not done" answer when gate propagation is
the real reason.

### Change Work State

Use mutation tools for create, update, status, dependency, move, and archive operations. After a
successful mutation, report the changed `.worktracker/` paths returned by the MCP result so the
operator can review and commit them.

### Validate And Recover

Use `validate` after manual edits, after larger mutation batches, and before relying on a project
summary. Validation can return blocking errors and non-blocking warnings. Treat warnings as
human-visible cleanup work even when they do not prevent rendering.

If validation finds errors, propose the smallest MCP tool sequence that would repair the project.
Wait for confirmation before applying repairs unless the user has clearly asked you to fix them.

### Prepare A Human Summary

For status reporting, combine:

- `list_projects` for available projects;
- `index://{project}/board` for board overview;
- `query_ready` for actionable task work;
- `query_blocked` for blocked work and blockers;
- `graph://{project}/dependencies` or per-epic graph resources for dependency context;
- `validate` for warnings and errors.

Summaries should distinguish stored task status from computed epic or story status.
