---
name: file-kanban-mcp-server
description: Use this skill whenever the user wants to configure, operate, troubleshoot, or delegate work through the File-Based Kanban MCP Server. This includes prompts about file-kanban, `.worktracker` projects, MCP tools or resources, ready and blocked work, validation warnings, same-type dependencies, generated board or graph artifacts, the read-only viewer, or setting up `file-kanban-mcp` in an agent coding client. Prefer this skill for any multi-step agent workflow that should mutate kanban work through MCP instead of direct Markdown edits.
---

# File-Based Kanban MCP Server

Use the MCP tools for writes and queries. Treat `.worktracker` Markdown as the persisted source of
truth and its indexes and graphs as generated output; do not edit them to perform a mutation.

## Resolve The Project

- Call `list_projects` when the project is unknown or ambiguous.
- Keep the returned portable `projectId` in working context.
- Pass `projectId` explicitly when more than one project is registered.
- Call `init` with the repository `root` only when `.worktracker/project.json` is absent. Retain the
  returned `projectId` for later calls.

## Select The Interface

Use the narrowest tool or resource that answers the request:

- `project://list` or `list_projects`: discover registered projects.
- `requirements://{project}/source`: read the source requirements before decomposing work.
- `entity://{project}/{id}`: inspect one epic, story, or task.
- `index://{project}/board`: read the generated board summary.
- `graph://{project}/dependencies`: inspect project-wide dependency context.
- `graph://{project}/epic/{id}`: inspect one epic and its descendants.
- `query_ready`: find actionable tasks; do not infer readiness from Markdown files.
- `query_blocked`: find blocked entities and their direct or propagated blockers.
- `critical_path`: find the longest dependency path for the requested entity type.
- `validate`: obtain current errors and warnings.

Use mutation tools according to intent:

- `create_entity` for a new epic, story, or task.
- `update_entity` for mutable metadata.
- `set_status` for task status; epic and story status is computed.
- `link_dependency` and `unlink_dependency` for dependency changes.
- `move_entity` for parent changes.
- `archive_entity` for archival.

## Preserve Domain Constraints

- Build only `epic -> story -> task` parent relationships.
- Link dependencies only between entities of the same type.
- Store status only on tasks: `todo`, `in-progress`, or `done`.
- Treat epic and story status, including downward blocking gates, as computed results.
- Preserve structured errors for cycles, cross-type dependencies, dangling parents, invalid
  statuses, and immutable-field updates. Do not bypass them with manual file edits.

## Execute Multi-Step Work

When decomposing requirements:

1. Read the requirements resource.
2. Create epics for large outcomes, stories for coherent deliverables, and tasks for concrete
   implementation steps.
3. Keep task titles imperative and specific.
4. Add only same-type dependencies.
5. Call `validate` after the mutation batch.

When changing existing work:

1. Read the relevant entity or graph when current state affects the mutation.
2. Apply the smallest appropriate mutation tool sequence.
3. Call `validate` after manual edits or a substantial mutation batch.
4. Report the `changedFiles` returned by successful mutations.

When explaining blocked work, use `query_blocked` and distinguish an entity's own dependency from
a blocker propagated by its parent story or epic. When reporting ready work, use `query_ready` and
state why the task is actionable.

## Handle Safety And Recovery

- Keep the HTTP/browser viewer read-only; perform mutations through MCP.
- Avoid running more than one mutating MCP stdio process against the same project.
- Treat validation errors as blocking and warnings as human-visible cleanup work.
- If the user asked only for diagnosis, propose the smallest repair sequence without applying it.
  Apply repairs when the user explicitly asked for a fix.

For client installation or runtime configuration details, consult `README.md` and
`docs/operator-workflows.md` rather than reproducing those instructions in this skill.
