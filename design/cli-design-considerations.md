# CLI Design Considerations

## Motivation

MCP servers are token heavy. Every session that connects to the stdio server pays for 13 tool schemas and 6 resource templates in context before any work happens, and every tool call returns a full JSON payload whether or not the agent needs all of it.

A command-line interface exposing the same functionality lets an agent pay only for what it uses: no schemas up front, terse output by default, and help text fetched on demand.

This document outlines how the project's existing functionality could be exposed through a CLI. It is a proposal, not a revision of `technical-design-and-implementation.md`. The CLI is not currently part of the public interfaces named in the technical design; adopting it requires revising that document first.

## Why This Is Cheap to Add

The MCP contract layer in `packages/server/src/mcp.ts` is already transport-free. `packages/server/src/stdio.ts` is a thin adapter that registers tools and resources and delegates to:

- `executeMcpQueryTool`
- `executeMcpMutationTool`
- `readMcpResource`
- `registry.init`
- `toMcpStructuredError`

A CLI is a third adapter alongside stdio and HTTP, calling the same contract functions. No changes to `packages/core` are needed for the command surface itself, and the dependency direction (`server` imports `core`) is unchanged.

## Proposed Shape

Add a new binary, `fk`, backed by `packages/server/src/cli.ts`, declared in the `bin` map of `packages/server/package.json` next to `file-kanban-mcp` and `file-kanban-viewer`.

### Command Mapping

| MCP surface | CLI command |
|---|---|
| `list_projects` | `fk projects` |
| `init` | `fk init [root] --name <name>` |
| `create_entity` | `fk add <epic\|story\|task> "<title>" --parent <id> --tags a,b --body-file -` |
| `update_entity` | `fk edit <id> --title … --estimate 3 --tags a,b` |
| `set_status` | `fk status <id> <status>` |
| `link_dependency` | `fk link <from> <to>` |
| `unlink_dependency` | `fk unlink <from> <to>` |
| `move_entity` | `fk move <id> <newParent>` (`--root` for a null parent) |
| `archive_entity` | `fk archive <id>` |
| `query_ready` | `fk ready` |
| `query_blocked` | `fk blocked` |
| `critical_path` | `fk path [--type <epic\|story\|task>]` |
| `validate` | `fk validate` |
| `entity://{project}/{id}` | `fk show <id>` |
| `index://{project}/board` | `fk board` |
| `graph://{project}/dependencies` | `fk graph` |
| `graph://{project}/epic/{id}` | `fk graph --epic <id>` |
| `requirements://{project}/source` | `fk requirements` |
| `project://list` | `fk projects` |
| (none; proposed in `multi-user-considerations.md`) | `fk regenerate` |

Every MCP tool and resource has a CLI equivalent, so the two interfaces stay functionally interchangeable.

## Where Tokens Are Saved

### No schemas in context

The tool schemas and resource templates are never loaded. An agent learns the surface from `fk --help` or `fk <command> --help` only when needed, or from a short cheat sheet in `AGENTS.md`.

### Terse default output

Default output is one line per row, designed for reading rather than parsing:

```
T-12  todo         Wire watcher        [S-3]
T-14  in_progress  Add write lock      [S-3]
```

Mutations print only the affected id and its new effective status. A `--json` flag returns the full structured payload that the MCP tool would have returned, for callers that need it.

### Field selection and filtering

Flags let the caller trim output at the source instead of receiving everything and discarding most of it:

- `fk show <id> --no-body`
- `fk ready --limit 5`
- `fk board --epic <id>`

### Batch application

`fk apply -` reads JSONL operations from stdin, validates the full in-memory project graph once, and writes once. This replaces N round trips with one call and fits the existing rule that the full graph is validated before any file is written and that failed mutations leave the store untouched.

Unlike the other commands, this is not a thin adapter. `executeMcpMutationTool` handles exactly one operation per call: it builds one proposed index, validates, writes, and regenerates. Calling it N times in a loop would give N separate validate-write-regenerate cycles and no atomicity, so a failure at operation 5 would leave operations 1 to 4 applied. An atomic batch needs new work in the contract layer:

- **A batch contract function** that applies all operations to one in-memory index, validates the result once, writes every changed file, and regenerates once.
- **Placeholder ids**, so a later operation can refer to an entity created earlier in the same batch (for example, create a story and then create tasks under it) before any real id has been returned to the caller.
- **Multi-file write failure handling.** A single mutation writes one entity file atomically. A batch writes several, so "failed mutations leave the store untouched" needs a defined behaviour if a write fails part-way through.
- **Error reporting** that identifies which operation in the batch failed.

If the batch function is added to the contract layer, the MCP server could expose it as a tool as well, which would be a change to the MCP tool list in the technical design. Batch apply should be treated as a separate, later piece of work from the rest of the CLI.

### Measuring the saving

The premise of this proposal has not been measured. Before building, compare:

- **MCP cost:** the tokens taken by the 13 tool definitions (names, descriptions, input schemas, annotations) and 6 resource templates as a client loads them, plus the JSON results of a representative session.
- **CLI cost:** the cheat sheet added to `AGENTS.md` (paid every session, like the schemas), any `--help` output an agent fetches, the command text of each call, and the terse results of the same representative session.

Two things could narrow the gap. Clients that defer tool schemas until they are needed already avoid most of the up-front MCP cost. And if the larger share of the cost turns out to be result payloads, not schemas, some of the saving could be had more cheaply by trimming MCP tool results. The measurement decides whether the CLI is worth building and which of its features matter.

## Design Points

### Project resolution

Resolve the project by walking up from the current working directory to the nearest `.worktracker` marker, with a `--project` flag as an override. The CLI should avoid the watch-root discovery scan performed by `bootstrapProjectRegistry`, otherwise every invocation pays the discovery cost that the long-lived stdio server pays once.

The existing registry supports this without changes. The contract functions take a registry, and one holding a single project can be built from a known root:

1. Read the marker at the resolved root with core's `readMarker`.
2. Create a registry with `createProjectRegistry({ watchRoots: [root] })`. Construction does not scan; only `discover()` does.
3. Call `registerDiscovered(root, marker)` to load that one project.

`resolveProject()` with no project id then returns the sole registered project, so the contract functions work as they do under stdio.

Three commands cannot use the single-project path:

- **`fk projects`** has to list every project, so it runs full discovery over `FILE_KANBAN_WATCH_ROOTS` as the server does.
- **`--project <id>` from outside the project's directory** also needs discovery to find the root for that id.
- **`fk init`** has no marker to walk up to. The registry requires the init root to be inside a watch root, so the CLI passes the configured watch roots, or the target root itself when none are configured.

### Errors

Failures exit with a non-zero code and write the structured error code and message to stderr, for example:

```
E_CYCLE: T-12 -> T-9 -> T-12
```

Reuse `toMcpStructuredError` so error codes are identical across MCP and CLI. With `--json`, emit the full `McpStructuredError` object.

### Regeneration

There is no long-lived process, so generated `.worktracker/index/*` and `.worktracker/graphs/*` artifacts must be regenerated as part of each mutating command. This already happens: `executeMcpMutationTool` calls `regenerateProject` after each successful write, so the CLI inherits it by calling the same function.

A running viewer's file watcher will pick up CLI writes to entity files. The write-suppression set is in-process, so a CLI write is treated as an external edit and causes a normal refresh and reload broadcast, which is the correct behaviour here.

`multi-user-considerations.md` (Proposal 2) adds further regeneration triggers that bear on the CLI:

- **Explicit regeneration.** That note calls for a `regenerate` command that runs without the server, for CI publishing and offline browsing. The CLI is the natural home for it: `fk regenerate`.
- **Reads of generated files.** `readMcpResource` serves the board index and the Mermaid graphs straight from disk. Once those files are git-ignored, a fresh clone has none and a pull leaves them stale. The server covers this with regeneration on registration and after watcher refreshes, but a one-shot CLI process has neither. `fk board` and `fk graph` should therefore regenerate before reading (cheap, since regeneration is deterministic and skips unchanged files) or render from the in-memory project state they have just loaded.

### Concurrency

The stdio server serialises writes within one process. Separate CLI processes do not, and the code has no cross-process lock today. There are three places parallel CLI invocations can race. The id proposal in `multi-user-considerations.md` removes the worst of them.

| Race | With counters (today) | With random ids (Proposal 1 of the multi-user note) |
|---|---|---|
| Id allocation | Two processes read `counters.json`, both mint `T-104`, and one entity file overwrites the other or the store fails with `DUPLICATE_ID`. Likely under any parallel creation. | No shared counter. Each process mints independently; a clash needs both to draw the same five-character id, about 1 in 33.5M per pair. Creating the entity file with an exclusive-create flag turns even that into a clean retry. |
| Generated artifacts | Two processes regenerate from different snapshots; the later rename wins and may be stale. | Unchanged, but self-healing: output is deterministic, so the next regeneration corrects it. Less costly again if the files are git-ignored (Proposal 2). |
| Validate-before-write | Each process validates its own proposed graph. Two mutations that are valid alone can combine into an invalid store, for example `fk link A B` and `fk link B A` forming a cycle, or two edits to the same entity losing one update. | Unchanged. |

So with random ids, the id race, which was the main reason to want a lock, goes away. What is left is the same class of problem the multi-user note already accepts across clones: individually valid edits that conflict when combined, caught afterwards by `validate`.

That note also places several agents writing to one working tree out of scope and lists file locking under "Not needed under this model". The CLI should follow the same position:

- **If random ids are adopted:** no lock is required for the CLI. Use exclusive-create when writing a new entity file, and document that concurrent mutations of the same entity or of related dependencies in one working tree are unsupported, with `fk validate` as the check.
- **If counters stay:** a lock around counter allocation (for example an exclusive-create `.worktracker/.lock` with a stale timeout) is required before the CLI can be used by more than one process at a time.
- **If the usage model widens** to several agents in one working tree, a lock around the whole read-validate-write sequence becomes necessary regardless of id scheme.

This makes the CLI work dependent on the id decision: landing random ids first avoids building a lock that would then be removed.

### Id input

If the Crockford base32 ids from the multi-user note are adopted, the CLI is where lenient parsing matters most, since ids are typed or pasted as arguments. Accept lowercase and the confusable characters (`O` as `0`, `I` and `L` as `1`) on input, and always print the canonical uppercase form. The examples in this document use counter-style ids such as `T-12` for brevity; under that proposal they would look like `T-7K3F9`.

### Startup time

Each invocation pays a Node cold start. Keep `cli.ts` imports lazy so the CLI path does not load the MCP SDK, `zod`, `chokidar`, or `ws`.

### Argument parsing

Use `parseArgs` from `node:util`. No new dependency is required.

### Read-only UI unaffected

The CLI is a write-capable agent interface like the MCP server. It does not add browser write endpoints and does not change the read-only viewer.

## Relationship to the MCP Server

Keep the MCP server. The CLI is an alternative interface over the same contract layer, not a replacement. Clients that benefit from MCP resources and tool annotations continue to use stdio; token-sensitive agents with shell access use `fk`.

## Open Questions

- Is the id change from `multi-user-considerations.md` adopted, and does it land before the CLI? The answer decides whether a counter lock is needed at all.
- Should `fk board` and `fk graph` regenerate before reading, or render from in-memory state?
- Should the binary be named `fk`, or something less likely to collide on `PATH`?
- Should the terse output format be specified as a stable contract, or only `--json`?
- What does the token measurement show? See "Measuring the saving".
- Is batch apply in scope, and if so is the batch function also exposed as an MCP tool? What is the placeholder id syntax, and what happens when a multi-file write fails part-way?
- With no watch roots configured, should `fk projects` list only the project containing the current directory, or report that discovery is not configured?

## Suggested Board Tasks

If adopted, revise `technical-design-and-implementation.md` first, then add tasks along these lines (phase number to be confirmed against the revised design):

1. Measure MCP and CLI token cost for a representative session
2. Define CLI command surface in the design doc
3. Add a counter allocation lock (only if counters are kept; not needed with random ids)
4. Add single-project registry bootstrap for the CLI
5. Implement CLI read commands
6. Implement CLI mutation commands
7. Add CLI `regenerate` command
8. Document CLI agent usage
9. Add batch mutation contract function (separate, later)
10. Add CLI batch apply (depends on 9)

Task 1 gates the rest. The multi-user id and generated-file changes should be sequenced ahead of tasks 3 to 7 if they are adopted.
