# AGENTS.md

## Project Source of Truth

This repository implements the File-Based Kanban MCP Server described in `design/technical-design-and-implementation.md`.

Treat that design document as authoritative for architecture, data model, MCP tools/resources, HTTP/WS API, validation rules, status semantics, generated artifacts, testing strategy, and implementation phase order.

Treat `design/ui-design/README.md` and `design/ui-design/screenshots/*` as authoritative for the read-only React viewer UX, layout, visual behavior, and interaction model.

If implementation details conflict with these design files, stop and resolve the conflict explicitly instead of silently inventing a new behavior.

## Required Kanban-First Workflow

All work is driven from the local agent kanban board.

- Project: `File-Based Kanban MCP Server`
- Repo path: `C:\Users\MONTEITH\source\repos\file-based-kanban-mcp-server`

Before doing implementation work, convert `design/technical-design-and-implementation.md` into kanban board tasks.

Use Section 16 of the technical design as the primary decomposition guide:

1. Create board work for each implementation phase.
2. Break phase deliverables into small, verifiable stories/tasks.
3. Copy or adapt the phase acceptance criteria into task acceptance criteria.
4. Preserve phase dependencies so downstream tasks are not ready before prerequisite work exists.
5. Include UI tasks from `design/ui-design/README.md` when planning the React viewer phase.
6. Mark tasks as groomed only when they are specific enough for an agent to implement without making product decisions.

Do not start coding from the design document directly. Implementation must start by claiming a ready kanban task.

## Task Naming and Size

Name implementation tasks with the phase first:

- `Phase N: Imperative task title`
- Example: `Phase 0: Scaffold npm workspaces monorepo`

Use the phase number from `design/technical-design-and-implementation.md`. Keep the title short, specific, and outcome-oriented. Prefer verbs such as `Scaffold`, `Define`, `Add`, `Wire`, `Implement`, `Validate`, or `Document`.

Size tasks so one agent can complete and verify the work in one focused session. A good task should:

- Produce one coherent implementation outcome.
- Have concrete acceptance criteria that can be checked without interpreting product intent.
- Touch a small, related set of files or one package boundary.
- Avoid mixing scaffolding, feature implementation, UI work, and CI hardening unless the phase acceptance criteria require them together.
- Be small enough that follow-on work can depend on it cleanly.

Split a task when it spans multiple packages, introduces multiple public interfaces, requires unrelated test strategies, or would force the implementer to make product decisions not already settled by the design document.

## Task Lifecycle

For implementation work:

- Claim a ready task before changing code.
- Move claimed tasks to `in_progress`.
- Keep changes scoped to the claimed task.
- Record meaningful artifacts such as changed files, test output, build output, or commits.
- Submit completed work for review and release claims.
- If new work is discovered, add or update board tasks instead of silently expanding scope.

Do not create broad, ambiguous tasks when the design document already provides phase deliverables and acceptance criteria.

## Implementation Order

Work in the phase order from `design/technical-design-and-implementation.md`:

1. Foundations
2. Core store
3. Graph and status
4. Generators
5. Registry, discovery, and init
6. MCP adapter
7. HTTP/WS viewer API
8. React UI
9. Hardening and ergonomics

Do not implement later phases in a way that forces architectural shortcuts around earlier phase contracts.

## Architecture Rules

Use an npm workspaces TypeScript monorepo:

- `packages/core`: pure project logic plus filesystem store operations.
- `packages/server`: MCP stdio, HTTP, WebSocket, registry, discovery, watcher, regeneration orchestration, and optional git integration.
- `packages/ui`: React + Vite read-only viewer.

Dependency direction is strict:

- `core` must not import from `server` or `ui`.
- `server` may import from `core`.
- `ui` talks to the HTTP/WS API only.

## Domain Rules

Preserve these invariants:

- Entities are epics, stories, and tasks stored as Markdown files with YAML frontmatter.
- Frontmatter is authoritative; generated indexes and graphs are derived.
- Dependencies are same-type only: epic->epic, story->story, task->task.
- Cross-type dependencies are out of scope for v1.
- Only tasks store status.
- Story and epic status are computed.
- `blocked` is computed from task state, same-type dependencies, rollups, and downward gate propagation.
- The UI is strictly read-only. Do not add browser write endpoints, mutation controls, drag-to-reorder, status toggles, or optimistic updates.

## Persistence and Generation Rules

Preserve deterministic file behavior:

- Use canonical frontmatter serialization with stable key order.
- Sort `dependsOn` and `tags`.
- Generate stable ordering by id.
- Regenerating without input changes must be byte-identical.
- Do not update timestamps for semantic no-op writes.
- Validate the full in-memory project graph before writing files.
- Failed mutations must leave the store untouched.
- Use atomic temp-file + fsync + rename writes for markers, entities, seeded requirements, counters, and generated artifacts.
- Entity Markdown bodies are human-authored and must not be rewritten by generators.

Generated `.worktracker/index/*` and `.worktracker/graphs/*` files are intended to be committed.

## Public Interfaces

Preserve the public interfaces named in the design unless the design is intentionally revised.

Core types include:

- `Entity`
- `Index`
- `ValidationResult`
- `ProjectMarker`
- `ProjectState`
- `EffectiveStatus`

MCP resources include:

- `project://list`
- `requirements://{project}/source`
- `entity://{project}/{id}`
- `graph://{project}/dependencies`
- `graph://{project}/epic/{id}`
- `index://{project}/board`

MCP tools include:

- `init`
- `create_entity`
- `update_entity`
- `set_status`
- `link_dependency`
- `unlink_dependency`
- `move_entity`
- `archive_entity`
- `query_ready`
- `query_blocked`
- `critical_path`
- `validate`
- `list_projects`

HTTP/WS API includes:

- `GET /api/projects`
- `GET /api/:project/graph`
- `GET /api/:project/entity/:id`
- `GET /api/:project/board`
- `GET /api/:project/mermaid/:view`
- `WS /ws`

## Technology Defaults

Use these defaults unless the design document is revised:

- Runtime: Node.js LTS
- Language: TypeScript
- Package manager: npm
- Workspaces: npm workspaces
- Frontmatter: `gray-matter`
- File watching: `chokidar`
- WebSocket: `ws`
- UI: React + Vite
- Graph algorithms: local deterministic implementations, not a graph dependency

## Verification

After Phase 0 creates scripts, use:

- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`

If actual script names differ after scaffolding, update this file and the local kanban project context together.

Testing should cover:

- Core graph/status resolution, including same-type dependencies at all three levels.
- Downward gate propagation.
- Validation errors and warnings.
- Canonical serialization and no-op write behavior.
- Generated Markdown and Mermaid determinism.
- MCP tool/resource behavior and structured errors.
- Project registry and resolution.
- HTTP endpoints and WS refresh behavior.
- Watcher discovery and write suppression.
- Read-only UI behavior.

## Editing Discipline

Keep changes scoped to the active kanban task.

Do not rewrite design documents, UI references, generated artifacts, or task metadata unless the active task requires it.

Do not revert user changes. If unrelated local changes are present, work around them. If they directly block the task, ask for direction.

Prefer implementation that follows the existing design over inventing abstractions early.
