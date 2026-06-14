# File-Based Kanban MCP Server

File-Based Kanban MCP Server stores agent work plans as Markdown files in a repository-owned
`.worktracker/` directory. Agents mutate the backlog through MCP tools. Humans can inspect the
same project through generated Markdown/Mermaid files and the read-only React viewer.

The architecture and behavior are defined by `design/technical-design-and-implementation.md`.
The React viewer is defined by `design/ui-design/README.md` and the annotated screenshots in
`design/ui-design/screenshots/`.

## Repository Layout

- `packages/core`: pure project logic, validation, status resolution, graph helpers, filesystem
  store operations, and deterministic Markdown/Mermaid generation.
- `packages/server`: project registry, discovery, MCP stdio adapter, HTTP/WebSocket viewer API,
  watcher orchestration, regeneration, and runtime configuration.
- `packages/ui`: Vite React read-only viewer that talks only to the HTTP/WebSocket API.
- `design/`: authoritative technical and UI design documents.

The dependency direction is intentional: `core` imports neither `server` nor `ui`; `server` may
import `core`; `ui` uses the HTTP/WebSocket API rather than importing workspace packages.

## Setup From Source

Install dependencies with Node.js LTS and npm:

```powershell
npm install
```

Build, lint, and test the workspace:

```powershell
npm run build
npm run lint
npm test
```

The test suite imports compiled package entrypoints under `dist` and UI type output under
`dist-types` to verify the built artifacts agents and operators actually run. `npm test` performs
a fresh build first; package-level `npm test -w <workspace>` does the same for focused work. Use
`test:built` only when a fresh build has already completed and you intentionally want to run tests
against the existing build output.

The package currently exposes the MCP stdio binary as `file-kanban-mcp` from
`@file-kanban/server`. During local development, build first so the binary and package entrypoints
exist under `packages/server/dist/`.

## Run The MCP Server

The MCP server uses stdio transport. Build the server package, set the runtime environment for the
repo or watch root you want the server to manage, then launch the `file-kanban-mcp` binary:

```powershell
npm run build -w @file-kanban/server
$env:FILE_KANBAN_INIT_ROOT = "C:\src\my-repo"
$env:FILE_KANBAN_WATCH_ROOTS = "C:\src"
.\node_modules\.bin\file-kanban-mcp.cmd
```

When an MCP client launches the server for you, configure the command as the built workspace bin
and pass the same environment values through that client's MCP server configuration. The stdio
process discovers already-initialized projects from `FILE_KANBAN_WATCH_ROOTS`; the `init` MCP tool
targets `FILE_KANBAN_INIT_ROOT`.

Most agent coding clients use one of these MCP stdio configuration shapes.

JSON-style clients such as Claude Desktop, Cursor, and many VS Code MCP extensions generally use a
server map like this:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "C:\\src\\file-based-kanban-mcp-server\\node_modules\\.bin\\file-kanban-mcp.cmd",
      "args": [],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "C:\\src\\my-repo",
        "FILE_KANBAN_WATCH_ROOTS": "C:\\src",
        "FILE_KANBAN_PORT": "4000"
      }
    }
  }
}
```

If a client does not execute package-manager shims reliably, run the built stdio entrypoint through
Node instead:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "node",
      "args": ["C:\\src\\file-based-kanban-mcp-server\\packages\\server\\dist\\stdio.js"],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "C:\\src\\my-repo",
        "FILE_KANBAN_WATCH_ROOTS": "C:\\src"
      }
    }
  }
}
```

### Agent Skill

This repository includes an agent-facing skill at
`.agents/skills/file-kanban-mcp-server/SKILL.md`. Load or install that skill in compatible agent
clients when you want the agent to operate this server through MCP tools and resources, preserve
same-type dependency rules, explain ready/blocked work, and avoid direct `.worktracker` edits.

Example prompts to use after the MCP server is configured:

- "Use the file-kanban MCP server to list known projects and summarize the ready tasks."
- "Initialize this repository as a work-tracker project with the title `Payments Refactor` and seed the requirements from `docs/requirements.md`."
- "Create an epic, two stories, and implementation tasks for the requirements source, then link same-type dependencies where ordering matters."
- "Show blocked work in the current project and explain whether each item is directly blocked or blocked by a propagated story or epic gate."
- "Validate the current project, fix any MCP-reported graph errors, and regenerate the derived indexes."

## Runtime Configuration

The Phase 8 runtime configuration is implemented in `packages/server/src/config.ts` and is loaded
from environment variables. The loader returns one shared `RuntimeConfig` object for stdio, boot
discovery, the project watcher, and the HTTP/WebSocket viewer.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILE_KANBAN_WATCH_ROOTS` | `FILE_KANBAN_INIT_ROOT`, or process cwd when `FILE_KANBAN_INIT_ROOT` is unset | Platform-delimited roots scanned at startup and watched for `.worktracker/project.json` markers. Use `;` on Windows and `:` on POSIX. Paths are resolved to absolute paths and duplicates are removed. |
| `FILE_KANBAN_PORT` | `4000` | HTTP/WebSocket viewer listen port. Must be an integer from `1` to `65535`. |
| `FILE_KANBAN_INIT_ROOT` | process cwd | Repository root targeted by the MCP `init` tool. |
| `FILE_KANBAN_GIT` | `false` | Reserved git side-effect flag. The current implementation parses it but does not commit changes. |

`runStdioServer()` uses the resolved `watchRoots` for startup discovery and `initRoot` for the
MCP `init` tool. `runHttpViewerServer()` uses the same resolved `watchRoots` for boot discovery and
live marker/content watching, and listens on the resolved `port`.

Example Windows configuration:

```powershell
$env:FILE_KANBAN_INIT_ROOT = "C:\src\my-repo"
$env:FILE_KANBAN_WATCH_ROOTS = "C:\src;D:\work"
$env:FILE_KANBAN_PORT = "4000"
$env:FILE_KANBAN_GIT = "false"
```

More operational detail is in `docs/operator-workflows.md`.

## Data Model

A managed project is any repository root that contains `.worktracker/project.json`.
The project marker owns the portable `projectId`, title, and creation timestamp. Entities are
stored as flat Markdown files under `.worktracker/entities/` with YAML frontmatter.

The supported entity hierarchy is:

- Epics have no parent.
- Stories must have an epic parent.
- Tasks must have a story parent.

Only tasks store status in frontmatter: `todo`, `in-progress`, or `done`. Story and epic statuses
are computed from their descendants. The effective status can additionally be `blocked` or `empty`.

Dependencies are same-type only:

- epic depends on epic
- story depends on story
- task depends on task

Cross-type dependencies are out of scope for v1. A dependency on an unfinished entity blocks the
dependent entity. When an epic or story is blocked by its own same-type dependency, that gate
propagates downward to unfinished descendants, keeping child work out of the ready set.

## Generated Artifacts

The generated files under `.worktracker/index/` and `.worktracker/graphs/` are intended to be
committed. They are derived from frontmatter and regenerated deterministically after successful
mutations.

The generators preserve human-authored entity Markdown bodies and use stable ordering so a no-op
regeneration remains byte-identical.

## Public Surfaces

The MCP adapter exposes resources for project lists, requirements, entities, generated indexes,
and generated Mermaid graphs. It exposes tools for initialization, entity mutation, dependency
linking, status changes, validation, ready/blocked queries, critical path, and project listing.

The viewer API is read-only:

- `GET /api/projects`
- `GET /api/:project/board`
- `GET /api/:project/graph`
- `GET /api/:project/entity/:id`
- `GET /api/:project/mermaid/:view`
- `WS /ws`

The UI must not add browser write endpoints, mutation controls, drag-to-reorder behavior, or
optimistic updates.

## Single-Writer Constraint

The v1 design assumes one MCP writer per project at a time. The HTTP/WebSocket adapter and React
viewer are read-only, so multiple viewers are fine. Avoid running multiple MCP stdio server
instances that mutate the same `.worktracker/` project concurrently.
