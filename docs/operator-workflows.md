# Operator Workflows

This guide covers setup and day-to-day operation for the File-Based Kanban MCP Server. The design
document remains authoritative when behavior is unclear.

## Install And Verify

Use Node.js LTS and npm from the repository root:

```powershell
npm install
npm run build
npm run lint
npm test
```

After Phase 0 scaffolding, those root scripts are the standard verification surface. Package-level
checks are also available when narrowing work:

```powershell
npm run build -w @file-kanban/core
npm run build -w @file-kanban/server
npm run build -w @file-kanban/ui
npm test -w @file-kanban/core
npm test -w @file-kanban/server
npm test -w @file-kanban/ui
npm run lint -w @file-kanban/ui
```

Tests intentionally exercise compiled package artifacts because the public entrypoints and MCP
stdio binary are emitted under `dist`. Root `npm test` and package-level `npm test -w <workspace>`
build before executing tests. The `test:built` scripts are reserved for orchestration after a fresh
build has already completed.

## Configure The Runtime

Configuration is environment-based so the same build can serve different repositories. The Phase 8
configuration work added one shared runtime shape for the MCP stdio startup path, HTTP/WebSocket
viewer startup, boot-time project discovery, and watcher registration.

| Variable | Valid values | Operational notes |
| --- | --- | --- |
| `FILE_KANBAN_WATCH_ROOTS` | One or more paths separated by the platform delimiter | Roots are resolved to absolute paths, de-duplicated, scanned recursively at startup, and watched for `.worktracker/project.json`. Discovery ignores heavy directories such as `.git`, `node_modules`, `dist`, `build`, and `coverage`. When unset or blank, the server uses `FILE_KANBAN_INIT_ROOT`; when that is also unset, it uses the process cwd. |
| `FILE_KANBAN_PORT` | Integer from `1` to `65535` | Controls the read-only HTTP/WebSocket viewer server port. Defaults to `4000`. Invalid values fail configuration loading before the viewer listens. |
| `FILE_KANBAN_INIT_ROOT` | One path | Controls where MCP `init` creates or reuses `.worktracker/`. Defaults to the process cwd. |
| `FILE_KANBAN_GIT` | `true`, `false`, `1`, `0`, `yes`, `no`, `on`, or `off` | Parsed for forward compatibility. Current mutation/regeneration code does not perform git commits. |

On Windows, separate multiple watch roots with `;`:

```powershell
$env:FILE_KANBAN_WATCH_ROOTS = "C:\Users\me\source;D:\client-work"
```

On POSIX shells, separate multiple watch roots with `:`:

```sh
export FILE_KANBAN_WATCH_ROOTS="/home/me/src:/work/repos"
```

Invalid ports, empty watch-root lists, and unrecognized git flags fail startup with structured
configuration errors.

`loadRuntimeConfig()` resolves this environment once per process startup. The stdio startup path
uses `watchRoots` to discover already-marked projects and `initRoot` for the `init` tool. The
HTTP/WebSocket viewer startup path uses `watchRoots` for both boot discovery and live marker/content
watching, then listens on `port`.

## Start MCP For An Agent

Build the server package before launching the stdio binary:

```powershell
npm run build -w @file-kanban/server
```

For a direct local smoke run on Windows, start the workspace bin after setting the runtime
environment:

```powershell
$env:FILE_KANBAN_INIT_ROOT = "C:\Users\me\source\my-repo"
$env:FILE_KANBAN_WATCH_ROOTS = "C:\Users\me\source"
.\node_modules\.bin\file-kanban-mcp.cmd
```

For a direct local smoke run on POSIX shells, use the generated bin shim:

```sh
export FILE_KANBAN_INIT_ROOT="/home/me/src/my-repo"
export FILE_KANBAN_WATCH_ROOTS="/home/me/src"
./node_modules/.bin/file-kanban-mcp
```

The process is an MCP stdio server, so it waits for an MCP client on stdin/stdout rather than
printing an HTTP URL. Stop it with the client shutdown flow or by sending `SIGINT`/`SIGTERM`.

Point the agent's MCP configuration at the built server binary or package bin. In this workspace,
the package bin is `file-kanban-mcp` from `@file-kanban/server`, which resolves to
`packages/server/dist/stdio.js` after build. Set `FILE_KANBAN_INIT_ROOT` to the repository the
agent should initialize when it calls `init`. Set `FILE_KANBAN_WATCH_ROOTS` to the same repo, or to
a parent directory that contains several managed repos.

The MCP stdio server discovers existing projects at startup from `FILE_KANBAN_WATCH_ROOTS`.
Every tool except `init` resolves an optional `projectId` against the in-memory registry. When more
than one project is registered, pass `projectId` explicitly to avoid ambiguous project selection.

## Configure Agent Coding Clients

Most agent coding clients configure MCP stdio servers with the same four fields: `command`, `args`,
`env`, and sometimes `cwd`. The exact settings file location varies by client, but the server entry
should always point at the built `file-kanban-mcp` bin or directly at
`packages/server/dist/stdio.js`.

Use the package-bin form when the client can run local npm bin shims. This shape works for
JSON-style MCP clients such as Claude Desktop, Cursor, and many VS Code extensions:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "C:\\Users\\me\\source\\file-based-kanban-mcp-server\\node_modules\\.bin\\file-kanban-mcp.cmd",
      "args": [],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "C:\\Users\\me\\source\\my-repo",
        "FILE_KANBAN_WATCH_ROOTS": "C:\\Users\\me\\source",
        "FILE_KANBAN_PORT": "4000",
        "FILE_KANBAN_GIT": "false"
      }
    }
  }
}
```

Use the direct Node form when the client cannot run `.cmd` or shell shims. This is also the most
portable option for clients that separate `command` and `args` strictly:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "node",
      "args": [
        "C:\\Users\\me\\source\\file-based-kanban-mcp-server\\packages\\server\\dist\\stdio.js"
      ],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "C:\\Users\\me\\source\\my-repo",
        "FILE_KANBAN_WATCH_ROOTS": "C:\\Users\\me\\source",
        "FILE_KANBAN_PORT": "4000"
      }
    }
  }
}
```

For POSIX clients, use forward-slash paths and the generated bin shim:

```json
{
  "mcpServers": {
    "file-kanban": {
      "command": "/home/me/src/file-based-kanban-mcp-server/node_modules/.bin/file-kanban-mcp",
      "args": [],
      "env": {
        "FILE_KANBAN_INIT_ROOT": "/home/me/src/my-repo",
        "FILE_KANBAN_WATCH_ROOTS": "/home/me/src",
        "FILE_KANBAN_PORT": "4000"
      }
    }
  }
}
```

For TOML-based clients, translate the same fields directly:

```toml
[mcp_servers.file-kanban]
command = "node"
args = ["C:\\Users\\me\\source\\file-based-kanban-mcp-server\\packages\\server\\dist\\stdio.js"]

[mcp_servers.file-kanban.env]
FILE_KANBAN_INIT_ROOT = "C:\\Users\\me\\source\\my-repo"
FILE_KANBAN_WATCH_ROOTS = "C:\\Users\\me\\source"
FILE_KANBAN_PORT = "4000"
FILE_KANBAN_GIT = "false"
```

Client-specific notes:

- Claude Desktop and similar JSON MCP clients usually expect the `mcpServers` map shown above.
- Cursor and VS Code MCP extensions may store the same JSON shape in a workspace or user settings
  file; prefer workspace settings when the watch roots are repo-specific.
- Clients that invoke commands without a shell should use the direct Node form, because it avoids
  relying on Windows `.cmd` handling or POSIX executable-bit behavior.
- Keep one mutating MCP client connected to a project at a time. Multiple clients can read, but v1
  assumes a single writer per `.worktracker/` project.

## Example Agent Prompts

Use prompts like these after the MCP server is configured in an agent coding client. They are
written to steer the agent toward the MCP tools instead of ad hoc file edits.

Bootstrap a repository:

```text
Use the file-kanban MCP server to initialize this repository as a project named "Checkout
Modernization". Seed the requirements from docs/requirements.md if that file exists, then tell me
the projectId.
```

Discover existing work:

```text
Use the file-kanban MCP server to list all discovered projects. For each project, show the project
id, title, and root. If there is exactly one project, also summarize its ready and blocked work.
```

Decompose requirements into tracked work:

```text
Read the requirements source through the file-kanban MCP server and create a small backlog: epics,
stories, and tasks. Use same-type dependencies only, keep task titles implementation-oriented, and
validate the project before you stop.
```

Plan the next implementation session:

```text
Use the file-kanban MCP server to query ready tasks for the current project. Pick the highest-value
ready task, explain why it is ready, and list the files you expect to touch before making changes.
```

Explain blocking:

```text
Use the file-kanban MCP server to query blocked work. For every blocked epic, story, and task,
explain the blocker ids and whether the block is from its own same-type dependency or from downward
gate propagation.
```

Update status after work:

```text
Use the file-kanban MCP server to set task T-012 to done, then validate the project and summarize
which generated index and graph files changed.
```

Add ordering constraints:

```text
Use the file-kanban MCP server to link task T-018 as depending on task T-014. If the link would
create a cycle or cross-type dependency, report the structured MCP error and do not edit files
manually.
```

Inspect one entity:

```text
Use the file-kanban MCP server to read entity T-021. Summarize its frontmatter, Markdown body,
same-type dependencies, dependents, and effective status.
```

Recover after manual edits:

```text
Use the file-kanban MCP server to validate the current project after my manual Markdown edits. Show
all errors and warnings, propose the minimal MCP tool calls needed to repair errors, and wait before
making changes.
```

Prepare a human review summary:

```text
Use the file-kanban MCP server to read the board index, ready list, blocked list, and dependency
graph for the current project. Produce a concise review summary with changed priorities, blockers,
and the next three ready implementation tasks.
```

## Initialize A Project

`init` is the bootstrap operation for a repository that does not yet have `.worktracker/project.json`.
It mints a portable project id, writes the marker atomically, optionally seeds
`.worktracker/requirements/source.md`, registers the project in the current process, and returns
the `projectId`.

`init` is idempotent. If the marker already exists, it returns the existing id and does not rewrite
the marker or seed requirements again.

After initialization, keep the returned `projectId` in the agent's working context and pass it on
later MCP calls.

## Discovery Without Init

Discovery is marker-based. Any repository under a configured watch root that already contains
`.worktracker/project.json` is available after boot discovery. The watcher also notices newly added
markers and registers those projects for the running process.

The marker is the source of truth. There is no central registry file to copy between machines.

## Operate The Data Model

Entity Markdown files live flat under `.worktracker/entities/`. The filename can contain a human
slug, but identity comes from the `id` frontmatter field.

Authoritative frontmatter fields include:

- `id`: stable entity id.
- `type`: `epic`, `story`, or `task`.
- `title`: human-readable title.
- `parent`: `null` for epics, an epic id for stories, or a story id for tasks.
- `status`: stored only for tasks; story and epic status is computed.
- `dependsOn`: sorted same-type dependency ids.
- `estimate`: optional task weight for critical path.
- `tags`: sorted human-authored labels.
- `archived`: soft-delete flag.

Agents should use MCP mutation tools rather than editing frontmatter directly. The server validates
the full in-memory graph before writing and rejects mutations that would leave dangling parents,
cross-type dependencies, hierarchy cycles, dependency cycles, invalid statuses, or immutable-field
updates.

## Understand Same-Type Dependencies And Gates

Dependencies form three separate DAGs: one for epics, one for stories, and one for tasks. An entity
is blocked when one of its own same-type dependencies is not done.

Composite gates matter. If a story is blocked by a story dependency, unfinished tasks under that
story are also effectively blocked. If an epic is blocked by an epic dependency, unfinished stories
and tasks beneath that epic are also effectively blocked. This downward propagation keeps the
`query_ready` result restricted to tasks whose own dependencies are done and whose ancestors are
not dependency-gated.

`query_blocked` returns blocked entities at all three levels and includes blockers. For propagation
cases, the blocker is the nearest gate-blocked ancestor so humans can see why descendant work is
not ready.

## Validate And Surface Warnings

Use the MCP `validate` tool before relying on a project state after manual file edits. Validation
returns blocking errors and non-blocking warnings. Blocking errors prevent mutations. Warnings are
intended to be visible to humans through the read-only viewer and read-side API payloads.

The HTTP board and graph views include validation warnings so operators can see issues without
running an agent tool. Treat warnings as cleanup work even when they do not stop the server from
rendering the project.

## Generated Files And Git

Successful mutations regenerate deterministic human-facing artifacts:

- `.worktracker/index/INDEX.md`
- `.worktracker/index/E-NNN.md`
- `.worktracker/index/READY.md`
- `.worktracker/index/BLOCKED.md`
- `.worktracker/graphs/dependencies.mmd`
- `.worktracker/graphs/E-NNN.mmd`

These files are designed to be committed with the entity files. Requirements source and entity
Markdown bodies are human-authored inputs and are not rewritten by generators.

The current implementation parses `FILE_KANBAN_GIT` but does not perform automatic `git add` or
commit steps. Operators should review and commit `.worktracker/` changes with their normal git
workflow.

## Run The Read-Only Viewer

The HTTP/WebSocket viewer runtime uses the same discovered project registry as the MCP server
package. It serves read-only project data over:

- `GET /api/projects`
- `GET /api/:project/board`
- `GET /api/:project/graph`
- `GET /api/:project/entity/:id`
- `GET /api/:project/mermaid/:view`
- `WS /ws`

The React UI consumes those endpoints and must remain read-only. It should not expose mutation
controls, browser write endpoints, drag-to-reorder behavior, or optimistic status updates.

From the repository root, build and start the viewer with one command:

```powershell
$env:FILE_KANBAN_WATCH_ROOTS = "C:\Users\me\source"
$env:FILE_KANBAN_PORT = "4000"
npm run viewer
```

`npm run viewer` performs a fresh workspace build before launching
`@file-kanban/server`'s `file-kanban-viewer` entrypoint. When the current `dist` artifacts are
already known to be fresh, use the shorter built-artifact command:

```powershell
npm run viewer:built
```

The package binary can also be launched directly after a build:

```powershell
.\node_modules\.bin\file-kanban-viewer.cmd
```

On POSIX shells, use the generated bin shim:

```sh
./node_modules/.bin/file-kanban-viewer
```

The command prints the local URL it is listening on and the watch roots it discovered from the
runtime environment. Stop it with `Ctrl+C`; shutdown closes the watcher and HTTP listener.

## Single-Writer Operation

Run at most one mutating MCP stdio process against a given project at a time. The design assumes a
single writer per `.worktracker/` project, with validation and atomic writes protecting each
accepted mutation. Multiple read-only HTTP viewers are safe because they do not write files.

If two agents need to work in parallel, assign them different projects or coordinate so only one
process mutates a project while the other reads. A future shared daemon transport could centralize
multi-agent writes, but that is out of scope for v1.

## Recovery Checklist

When a project is not visible:

1. Confirm `.worktracker/project.json` exists under one configured watch root.
2. Confirm `FILE_KANBAN_WATCH_ROOTS` uses the correct platform delimiter.
3. Restart the stdio or HTTP process to force boot discovery.
4. Use `init` only when the repository does not already have a marker.

When work is unexpectedly blocked:

1. Run or inspect `validate`.
2. Check same-type dependencies on the task, its story, and its epic.
3. Look for downward gate propagation from a blocked story or epic.
4. Review `.worktracker/index/BLOCKED.md` and the dependency Mermaid graph.
