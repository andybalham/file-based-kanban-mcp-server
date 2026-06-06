# Work-Tracker MCP Server — Design & Implementation Specification

> **Revision note (this version).** Dependencies are generalised from task→task only to
> **same-type dependencies at every level**: epic→epic, story→story, task→task. This required
> defining how a composite's dependency interacts with its computed roll-up status, and a
> **downward gate** rule so a dependency on a composite actually gates the work beneath it. The
> affected sections are §1, §2, §3, §6.2–§6.4, §7.1, §7.3–§7.6, §8, §9.1–§9.4, §10, §11, §13,
> §15, §16, §17. Cross-*type* dependencies (e.g. task→story) remain out of scope (§17).

## 1. Overview

This system lets a coding agent turn a requirements document into a structured, queryable
backlog of **epics → stories → tasks** with **dependencies between entities of the same type**
(epic→epic, story→story, task→task), and tracks **status** as work progresses.

The system is designed around a single principle: **the agent reasons, the server stores,
validates, and renders.** The agent reads requirements, decides the breakdown, and issues
mutations through MCP tools. The server is responsible for persistence, integrity, and the
generation of human-facing views. It does not itself decide how to decompose work.

The data is stored as plain files so two audiences can consume it:

- **Coding agents** plan and process work through the MCP interface (tools + resources).
- **Humans** read the work in two ways: directly via the raw Markdown files in a git
  repository (browsable on GitHub/GitLab/VS Code), and through a read-only React UI that
  renders the same data live.

> Note: this document is itself written to be decomposable. Sections 6–13 define the system;
> Section 16 proposes implementation phases with acceptance criteria that map cleanly onto
> epics, stories, and tasks.

## 2. Goals and Non-Goals

### Goals

- Persist epics, stories, and tasks as human-readable Markdown with YAML frontmatter.
- Track **same-type** dependencies (epic→epic, story→story, task→task) and derive status,
  "ready" work, "blocked" work, and the critical path from that single source of truth.
- Generate navigable, always-correct human views (index Markdown files and Mermaid diagrams).
- Expose an MCP surface so an agent can create, update, link, query, and validate the backlog.
- Provide a live, read-only React UI over the same data.
- Discover managed projects by scanning configured watch roots for a marker file, and let an
  agent bootstrap a new project in place via a single `init` call. One server configuration
  works against any repo.

### Non-Goals (v1)

- Multi-*writer* concurrent writes **to a single project** (single-writer model; see §12.5).
- Editing the backlog from the UI (the UI is strictly a read-only view).
- Server-side decomposition (e.g. MCP sampling) — decomposition is agent-driven.
- Hard deletion of entities from the tool surface (use archiving + git; see §9.2).
- **Cross-type** dependencies — a task depending on a story/epic, or vice-versa. Dependencies
  are **same-type** only: epic→epic, story→story, task→task (§6.3); see §17.

## 3. Core Design Principles

1. **Frontmatter is authoritative; everything else is derived.** The YAML frontmatter of each
   entity file is the single source of truth for identity, hierarchy, dependencies, and stored
   status. Mermaid diagrams, index files, "ready"/"blocked" lists, and roll-up statuses are all
   regenerated from frontmatter and are never hand-authored.
2. **Flat storage, generated navigation.** Entities live in one flat directory. Hierarchy and
   navigation are expressed entirely in *generated index files* — never by directory structure
   and never injected into entity files. This keeps `move_entity` a one-line edit and keeps
   human-authored entity bodies pristine.
3. **Single process, two adapters, one registry.** One Node process hosts a stdio MCP adapter and
   an HTTP/WS adapter that share one in-memory registry of per-project indices (§9.0). Agent
   mutations to a project are instantly visible to the read API for that project with no
   cross-process synchronisation.
4. **Computed status.** Stored status exists only on tasks. Story and epic status, plus the
   `blocked` state — which now reflects same-type dependencies at *every* level (§6.4) — are
   computed on read and never stored.
5. **Determinism.** All generated artifacts are produced deterministically (stable ordering) so
   regeneration yields minimal git diffs and the diffs themselves form a readable changelog.
6. **Validate before commit; write atomically.** A mutation validates the full in-memory graph
   before any file is touched, then writes via temp-file-and-rename so a rejected mutation leaves
   the store untouched.

## 4. Architecture

### 4.1 Process topology

```
  Coding agent  ──MCP / stdio──┐
                               ▼
                    ┌──────────────────────────────────────────┐
                    │            Server process (Node)           │
                    │  ┌──────────────┐   ┌────────────────┐     │
                    │  │ stdio adapter│   │ HTTP+WS adapter │     │
                    │  │ tools+resrc  │   │ read API+push   │     │
                    │  └──────┬───────┘   └───────┬─────────┘     │
                    │         └────────┬──────────┘               │
                    │            ┌─────▼──────┐                   │
                    │            │  registry  │ Map<root,          │
                    │            │ ProjectState│  ProjectState>     │
                    │            └─────┬──────┘                   │
                    │            ┌─────▼──────┐                   │
                    │            │    core    │ index, graph,     │
                    │            │  library   │ status, render    │
                    │            └─────┬──────┘                   │
                    └──────────────────┼─────────────────────────┘
        React viewer  ──HTTP+WS────────┘  │ read / write (per project)
        (browser, read-only)              ▼
                              ┌──────────────────────────────┐
                              │  many project stores          │  ◄── chokidar
                              │  <repo>/.worktracker/ each     │      (discovery +
                              │  flat .md + .mmd + project.json│       external edits)
                              └──────────────────────────────┘
```

- The MCP client (coding agent) spawns the server over **stdio**.
- The same process boots an **HTTP + WebSocket** server for the React UI on a configurable port.
- The server holds a **registry** of `ProjectState`, one per discovered project root (§5.1). Each
  call is resolved to a project, then handled by the shared **core** library against that
  project's `Index`. Only the stdio adapter performs writes.
- A **chokidar** watcher operates at two granularities (§12.4): coarse discovery of new project
  markers across the configured watch roots, and fine per-project detection of external edits.
  Both trigger re-indexing of the affected project plus a project-scoped WS broadcast.

### 4.2 Repository / package structure

npm workspaces monorepo. The `core` package contains all logic and has no knowledge of MCP or
HTTP; this is what makes the logic unit-testable against a temp directory.

```
packages/
  core/                 # pure logic + fs; no MCP, no HTTP; project-agnostic (operates on one root)
    src/
      types.ts          # entity, status, index, marker, error types
      store.ts          # scan, parse, index, atomic write, id counter, move; marker r/w; discovery
      graph.ts          # per-type DAG build, cycle detect, topo sort, ready/blocked, critical path
      status.ts         # task resolution + composite roll-up + same-type dep + gate propagation
      mermaid.ts        # deterministic .mmd render with clickable nodes (per-type bands)
      nav.ts            # INDEX.md, per-epic indexes, READY.md, BLOCKED.md
      validate.ts       # full integrity check (errors + warnings)
      index.ts          # public API barrel
    test/               # fixtures + golden files
  server/               # depends on core
    src/
      registry.ts       # Map<root,ProjectState>; resolveProject(id?); init; discovery wiring
      mcp.ts            # MCP tools + resources (stdio); resolves projectId then calls core
      http.ts           # read API + chokidar + ws broadcast; serves UI build
      regenerate.ts     # per-project post-mutation generation pipeline + optional git commit
      main.ts           # process entrypoint, config (watchRoots, port, git)
  ui/                   # depends on nothing in repo; talks to http.ts over HTTP/WS
    src/                # vite + react, read-only; project picker + per-project views
```

Dependency rule: `core` imports nothing from `server` or `ui`. `server` imports `core`.
`ui` is built to static assets served by `http.ts`. **`core` remains project-agnostic** — every
core function operates on a single project's root or `Index`; all multi-project state (the
registry, watchers, WS subscribers, project resolution) lives in `server/src/registry.ts`. This is
what keeps the core logic unit-testable against a single temp directory.

## 5. Repository layout of the managed work (the data store)

This is the on-disk shape of the project the agent is *managing* (distinct from the source
repo of the tool itself). The store coexists with real code under a dedicated subtree so a
project can live inside an ordinary code repo without collision. The subtree is the unit of
discovery: the presence of its marker file is what makes a directory a project root.

```
<repo-root>/
  ...                            # the repo's own code, unrelated to this tool
  .worktracker/                  # the managed store; presence of project.json marks a project root
    project.json                 # MARKER — canonical id, title, created. Authoritative identity.
    requirements/
      source.md                  # the input requirements document (seeded by init; human + agent readable)
    entities/                    # flat; one file per entity; slug filename, id authoritative
      E-001-user-auth.md
      S-014-login.md
      T-103-login-form.md
    index/                       # GENERATED — do not hand-edit
      INDEX.md                   #   top-level board (links to per-epic files)
      E-001.md                   #   per-epic expansion
      READY.md                   #   tasks workable now
      BLOCKED.md                 #   blocked entities (any type) + their blockers
    graphs/                      # GENERATED — do not hand-edit
      dependencies.mmd           #   full same-type dependency graph (epic/story/task bands; clickable)
      E-001.mmd                  #   per-epic dependency subgraph
    .meta/
      counters.json              # per-project monotonic id counters (atomic writes)
  .gitignore                     # does NOT ignore .worktracker/index/ or graphs/ (they are committed)
```

`project.json` is the marker; its presence defines a project root. Shape:

```json
{
  "projectId": "wt_3f7c1a9e",
  "title": "User-facing auth service",
  "created": "2026-05-31T09:00:00Z"
}
```

> The marker carries identity, consistent with §6.1's treatment of entity `id`: identity lives
> in the artifact, not in any external table. The repo is therefore self-describing and
> portable — clone it, check it out in CI, or move it, and its project identity travels with it.
> `projectId` is minted once and is immutable thereafter.

Generated files (`index/`, `graphs/`) are **committed**, not ignored — the point is that a
human browsing the repo sees the navigable tree and diagrams without running anything, and the
diffs serve as the changelog. All relative links in generated artifacts (Mermaid `click`
targets, `INDEX.md` links) are relative within the `.worktracker/` subtree, so they continue to
resolve on GitHub and in the UI.

### 5.1 Project discovery & `init`

Discovery and bootstrap are **two distinct jobs** that happen to converge on the same back-end
step ("scan a project root, add it to the in-memory registry"):

- **Discovery** is how the server learns which projects exist: it scans its configured watch
  roots (§14) for `.worktracker/project.json` markers. Every marker found is a known project.
  This requires no `init` call and no central registry — a repo that already has a marker
  (cloned, pulled, hand-authored) is discovered automatically.
- **`init`** is the one-time *bootstrap* for a repo that does **not** yet have a marker: it mints
  the id, writes the marker, and optionally seeds requirements. `init` is **not** the discovery
  mechanism; a project can become known without it ever being called.
**Project registry (server state).** The server holds `Map<projectRoot, ProjectState>`. Each
`ProjectState` owns its own `Index`, its own content watcher, its effective-status cache, and its
WS subscriber set. The registry is a **cache over the markers**, never the source of truth: it can
be discarded and rebuilt at any time by rescanning watch roots. Per-project `.meta/counters.json`
keeps id allocation isolated; there is no global counter.

**`init` semantics.** `init` registers the project **in-process, synchronously, within the call**
— it does *not* wait for the watcher to observe its own marker write. (Routing `init` through the
watcher would deadlock against write-suppression, §12.4: the watcher is built to *ignore* paths
the server just wrote.) Steps, in order:

1. Resolve the target root (from the agent's working context / a passed path).
2. **If a marker already exists** at the target: read it, return its existing `projectId`, make no
   further change. `init` is create-if-absent and idempotent — it never re-mints an id and never
   overwrites a seeded `source.md`.
3. Otherwise: mint `projectId`, write `.worktracker/project.json` atomically (§12.2). If `intent`
   text was supplied, seed `requirements/source.md` with it (written **once**; thereafter
   human/agent-owned).
4. `scan()` the new store, build its `ProjectState`, insert it into the registry.
5. Return `{ projectId }`.
The seeded `source.md` and the marker are **seed content, not generated artifacts**: the
regeneration pipeline (§9.3) must never include them in its idempotent regeneration set, or it
would clobber subsequent human edits.

**Project scoping of subsequent calls.** After `init` (or discovery), the agent threads
`projectId` through subsequent tool calls and resource URIs; the server resolves
`projectId → projectRoot` via the registry. Resolution rules:

- Exactly one project active and the call omits `projectId` → use it.
- More than one active and the call omits `projectId` → `AMBIGUOUS_PROJECT` (§9.4).
- `projectId` supplied but no reachable marker carries it → `PROJECT_NOT_FOUND` (§9.4); the agent
  should rescan or `init`. Fully recoverable, since the marker — not the registry — is canonical.

## 6. Data Model

### 6.1 Identity

- Every entity has a stable, immutable `id`: `E-NNN` (epic), `S-NNN` (story), `T-NNN` (task),
  zero-padded to 3+ digits for lexicographic sortability.
- `id` is the only authoritative reference. `parent` and `dependsOn` reference entities by `id`.
- The filename carries a human slug for readability (`T-103-login-form.md`) but is not
  authoritative; renaming the file (or its slug) does not change identity. On scan, entities
  are discovered by frontmatter `id`, not filename.
- **ID generation:** monotonic per-type counters persisted in each project's `.meta/counters.json`
  and written atomically. This guarantees no ID is ever reused even after an entity is removed. On
  first scan of a project, if `counters.json` is missing, initialise each counter from
  `max(existing id of that type)`. Allocation happens in-process and is scoped per project; the
  per-project single-writer model (§12.5) means no allocation contention.

### 6.2 Frontmatter schema

All three entity types share one frontmatter shape so tooling is generic. Fields:

| Field       | Type                                   | Applies to        | Notes |
|-------------|----------------------------------------|-------------------|-------|
| `id`        | string                                 | all (required)    | immutable |
| `type`      | `epic` \| `story` \| `task`            | all (required)    | immutable |
| `title`     | string                                 | all (required)    | free to change |
| `parent`    | id \| null                             | all (required)    | epic→`null`; story→epic id; task→story id |
| `status`    | `todo` \| `in-progress` \| `done`      | task only         | default `todo`; ignored on epic/story |
| `dependsOn` | id[]                                   | all (optional)    | **same-type only** (epic→epic, story→story, task→task); default `[]`; stored sorted |
| `estimate`  | number                                 | task (optional)   | used as critical-path weight; default weight 1 |
| `tags`      | string[]                               | all (optional)    | stored sorted |
| `archived`  | boolean                                | all (optional)    | default `false`; archived entities excluded from views |
| `created`   | ISO-8601 string                        | all               | set on create |
| `updated`   | ISO-8601 string                        | all               | updated only on real content change (see §12.3) |

`dependsOn` may now appear on epics and stories as well as tasks; every referenced id must be the
**same type** as the declaring entity (§6.3). Body (everything after the frontmatter) is
human-authored Markdown and is never modified by the generator. A conventional body skeleton (not
enforced):

```markdown
---
id: T-103
type: task
title: Implement login form
parent: S-014
status: in-progress
dependsOn: [T-099, T-101]
estimate: 3
tags: [frontend]
archived: false
created: 2026-05-28T10:00:00Z
updated: 2026-05-28T12:30:00Z
---
 
## Description
...
 
## Acceptance Criteria
- [ ] ...
```

### 6.3 Two relationship dimensions, three dependency graphs

The model contains two independent relationship dimensions that are validated separately:

- **Hierarchy** (`parent`): a forest of trees rooted at epics. Constraints: epic parent is
  `null`; story parent is an existing epic; task parent is an existing story. Must be acyclic.
- **Dependencies** (`dependsOn`): now **three same-type DAGs** — one over epics, one over
  stories, one over tasks. Each must be acyclic; every reference must exist and be the **same
  type** as the declaring entity; no self-dependency. Cross-type edges (e.g. task→story) are
  rejected (§2, §17).
Because same-type entities are never in an ancestor/descendant relationship (epics have no
parents; a story's only ancestors are epics; a task's only ancestors are a story and an epic), a
same-type dependency can never coincide with a hierarchy edge. Dependencies and hierarchy stay
cleanly orthogonal, which is what keeps the generalisation tractable.

### 6.4 Status model

**Stored status** exists only on tasks: `todo` | `in-progress` | `done`. Stories and epics never
store status.

**Effective status** is computed for every entity and never stored: `todo` | `in-progress` |
`done` | `blocked` (plus `empty` for a childless composite, displayed as `todo`). It is produced
in three stages — an **intrinsic** status per entity, a **same-type dependency rule** applied at
each level, and a final **downward gate propagation**.

**(a) Intrinsic status.**

- Task: its stored status.
- Story / epic: the roll-up of its children's *effective* statuses.
Roll-up `rollup(node)` over child effective statuses `c`:
- no (non-archived) children → `empty` (displayed as `todo`; flagged as a warning by `validate()`).
- `done` if all children are `done`.
- else `blocked` if any child is `blocked`.
- else `in-progress` if any child is `in-progress`, or there is a mix of `done` and not-done.
- else `todo` (all children `todo`).
**(b) Same-type dependency rule.** Given an entity's intrinsic status and the effective statuses
of its same-type dependencies:
- all dependencies effectively `done`, or none declared → effective = intrinsic.
- otherwise (≥1 dependency not effectively `done`):
  - intrinsic `todo`/`empty` → **`blocked`**. This is a *dependency gate*.
  - intrinsic `in-progress` → stays `in-progress`; `validate()` emits
    `IN_PROGRESS_WITH_INCOMPLETE_DEP`. (Silently flipping work the agent believes it is doing is
    worse than a warning.)
  - intrinsic `done` → stays `done`; `validate()` emits `DONE_WITH_INCOMPLETE_DEP`.
  - intrinsic `blocked` → stays `blocked`.
This is the exact generalisation of v1's task-resolution rule to all three types.

**(c) Downward gate propagation.** A dependency on a composite must actually gate the work beneath
it. When an entity is *gate-blocked* — i.e. it became `blocked` in (b) because its own intrinsic
status was `todo`/`empty` and a same-type dependency is incomplete — every non-`done` descendant
of that entity is also set to `blocked`. Propagation flows **only** from a gate, never from a
roll-up: a composite that is `blocked` merely because one child is blocked does **not** block its
other children, so healthy siblings stay workable.

**Resolution order** (memoised over each type's dependency DAG; must terminate even if a cycle
slipped past `validate()` — guard against revisiting nodes):

1. Resolve tasks over the task dependency DAG (rule (b)).
2. Roll up stories from task effective statuses, then apply rule (b) over the story dependency DAG.
3. Roll up epics from story effective statuses, then apply rule (b) over the epic dependency DAG.
4. Apply downward gate propagation (c): for each gate-blocked epic, block its non-`done` stories
   and their non-`done` tasks; for each gate-blocked story, block its non-`done` tasks.
Each layer's roll-up depends only on lower layers, and each layer's dependency rule reads only the
*same* layer's effective statuses (resolved in topological order over that layer's DAG), so there
is no circularity. A not-started (`todo`) composite never contains an `in-progress` descendant, so
propagation in (c) only ever turns `todo` descendants into `blocked`.

**Consequences.**

- An effective-`todo` task is, by definition, **workable now**: all of its own dependencies are
  `done` *and* no ancestor is dependency-gated. This keeps the "ready" query trivial (§7.3).
- `blocked` can now arise three ways: a task's own incomplete dependency; an entity's own
  incomplete same-type dependency at the story or epic level; or propagation from a gate-blocked
  ancestor.

## 7. Core Library Specification

All signatures are indicative TypeScript. Functions are pure where possible; `store` owns all
filesystem effects.

### 7.1 `types.ts`

```ts
export type EntityType = 'epic' | 'story' | 'task';
export type StoredStatus = 'todo' | 'in-progress' | 'done';
export type EffectiveStatus = StoredStatus | 'blocked' | 'empty';
 
export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  parent: string | null;
  status: StoredStatus;       // meaningful only when type === 'task'
  dependsOn: string[];        // same-type ids (epic→epic, story→story, task→task)
  estimate?: number;          // task-only weight for critical path
  tags: string[];
  archived: boolean;
  created: string;            // ISO-8601
  updated: string;            // ISO-8601
  body: string;               // markdown after frontmatter
  filePath: string;           // current location on disk
}
 
export interface Index {
  byId: Map<string, Entity>;
  childrenOf: Map<string, string[]>;   // parent id -> ordered child ids
}
 
export interface ValidationResult {
  errors: ValidationIssue[];           // block mutation
  warnings: ValidationIssue[];         // allowed, surfaced
}
export interface ValidationIssue { code: string; entityId?: string; message: string; }
 
export type ProjectId = string;        // e.g. "wt_3f7c1a9e"; minted once, immutable
 
// Shape of .worktracker/project.json — the authoritative project marker (§5).
export interface ProjectMarker {
  projectId: ProjectId;
  title: string;
  created: string;                     // ISO-8601
}
 
// Runtime per-project state held by the server registry (server-only; defined here for
// reference because it composes core types). Not constructed by core.
export interface ProjectState {
  projectId: ProjectId;
  root: string;                        // path to the repo root that contains .worktracker/
  marker: ProjectMarker;
  index: Index;                        // current in-memory index for this project
  eff: Map<string, EffectiveStatus>;   // cached effective statuses (recomputed on mutation)
  // server-runtime fields (watcher handle, in-flight write paths, ws subscriber set) omitted here
}
```

### 7.2 `store.ts`

Responsibilities: scan a project's `.worktracker/entities/` directory, parse frontmatter (via
`gray-matter`), build the `Index`, allocate IDs, perform atomic writes and moves, and read/write
the project marker. Store operations are **bound to a single project root**: `createStore(root)`
returns the bound functions below, and a project's `ProjectState` (§7.1) holds one store. The
free `scan(root)`, `readMarker(root)`, and `discoverProjects(...)` functions are the bootstrap
entry points used before a store/`ProjectState` exists.

```ts
// per-project, root-bound (via createStore(root))
scan(): Promise<Index>;                                // full read; archived included and marked
parse(filePath: string): Promise<Entity>;
write(entity: Entity): Promise<void>;                  // atomic temp+rename; skips write if unchanged
allocateId(type: EntityType): Promise<string>;         // increments + persists this project's counter atomically
move(id: string, newParent: string | null): Promise<void>;  // edits parent frontmatter only; no file relocation
 
// project marker + discovery (bootstrap; fs-level, testable against temp dirs)
readMarker(root: string): Promise<ProjectMarker | null>;     // null if .worktracker/project.json absent
writeMarker(root: string, m: ProjectMarker): Promise<void>;  // atomic; create-if-absent enforced by caller (§5.1)
seedRequirements(root: string, intent: string): Promise<void>; // writes source.md once; no-op if present
discoverProjects(watchRoots: string[]):                      // walk roots for markers (§12.4 rules)
  Promise<Array<{ root: string; marker: ProjectMarker }>>;
```

Notes:

- **Atomic write:** serialise frontmatter + body to a temp file in the same directory, `fsync`,
  then `rename` over the target. Applies to entity files, the marker, and seeded requirements.
- `move` under flat storage is a single frontmatter edit; the file does not relocate.
- Serialisation is canonical: frontmatter key order fixed, `dependsOn` and `tags` sorted, so two
  semantically-equal entities serialise byte-identically (supports the "skip write if unchanged"
  rule and determinism).
- `discoverProjects` does **not** descend past a marker and applies the ignore rules in §12.4;
  it is pure with respect to a list of roots, so it is unit-testable against temp fixtures.

### 7.3 `graph.ts`

Operates over the three same-type dependency DAGs (one per type) and the hierarchy.

```ts
buildDepGraph(index: Index, type: EntityType): DepGraph;   // adjacency over ids of one type
detectDepCycle(g: DepGraph): string[] | null;             // returns a cycle path or null
detectHierarchyCycle(index: Index): string[] | null;
topoSort(g: DepGraph): string[];                          // dependency order
ready(index: Index, eff: Map<string,EffectiveStatus>): string[];     // tasks with effective 'todo'
blocked(index: Index, eff: Map<string,EffectiveStatus>):             // blocked entities of any type
  Array<{ id: string; type: EntityType; blockedBy: string[] }>;
criticalPath(index: Index, type?: EntityType):                       // default 'task'
  { path: string[]; total: number };
```

- **Cycle detection** runs once per type DAG (`buildDepGraph(index, 'task' | 'story' | 'epic')`),
  so a cycle in any of the three is caught.
- **`ready`** is `tasks where eff(id) === 'todo'` (see §6.4). Tasks are the directly workable
  unit, so `ready` stays tasks-only; it already excludes tasks under a gate-blocked ancestor,
  because §6.4(c) resolves those to `blocked`.
- **`blocked`** reports every blocked entity with its `type`. `blockedBy` lists the entity's own
  incomplete same-type dependencies, or — when the entity is blocked through hierarchy
  propagation (§6.4c) — the nearest gate-blocked ancestor.
- **`criticalPath`** is computed per dependency DAG and defaults to the task graph. `estimate` is
  task-only, so the task graph is the weighted one (`estimate ?? 1`); the story and epic graphs
  weight every node as 1 (longest-by-count). Ties broken by id for determinism.

### 7.4 `status.ts`

```ts
resolveAll(index: Index): Map<string, EffectiveStatus>;   // §6.4: tasks → stories → epics, then gate propagation
```

Implements §6.4: resolve tasks over the task DAG, roll up and resolve stories over the story DAG,
roll up and resolve epics over the epic DAG, then run downward gate propagation. Memoised over
each type's dependency DAG, with revisit guards so it terminates even if a cycle exists upstream
(cycle detection in `graph.ts` runs in `validate` before this is trusted).

### 7.5 `mermaid.ts`

Deterministic render of the dependency graphs. Status maps to node styling via `classDef`, not to
graph structure. Nodes are **clickable**, linking to the entity file (relative path that resolves
on GitHub and in the UI's served file route).

```ts
renderDependencies(index: Index, eff: Map<string,EffectiveStatus>): string;  // dependencies.mmd (3 bands)
renderEpicSubgraph(index: Index, epicId: string, eff): string;               // E-xxx.mmd
```

`renderDependencies` now emits **three labelled `subgraph` bands** — Epics, Stories, Tasks — each
containing that type's nodes and that type's same-type dependency edges. There are no cross-band
edges, because dependencies are same-type. `renderEpicSubgraph` renders the task dependency
subgraph for that epic, plus the story-dependency edges among the epic's own stories.

Output rules: within each band, nodes emitted in `id` order; edges sorted by `(from, to)`; one
`classDef` per status; a `click` directive per node. Example (task band shown):

```
graph LR
  classDef done fill:#c6f6d5,stroke:#22543d;
  classDef blocked fill:#fed7d7,stroke:#742a2a;
  classDef inprogress fill:#feebc8,stroke:#744210;
  classDef todo fill:#e2e8f0,stroke:#2d3748;
 
  subgraph Tasks
    T099["T-099 DB schema"]:::done
    T101["T-101 Session model"]:::done
    T103["T-103 Login form"]:::inprogress
    T099 --> T103
    T101 --> T103
  end
 
  click T099 "../entities/T-099-db-schema.md"
  click T101 "../entities/T-101-session-model.md"
  click T103 "../entities/T-103-login-form.md"
```

For graphs beyond ~30 nodes in a band, prefer the per-epic subgraphs over the single full diagram.

### 7.6 `nav.ts`

Generates all navigation as separate index files. Entity files are never modified.

```ts
renderIndex(index: Index, eff: Map<string,EffectiveStatus>): string;              // INDEX.md
renderEpicIndex(index: Index, epicId: string, eff): string;                       // index/E-xxx.md
renderReady(index: Index, eff): string;                                           // READY.md
renderBlocked(index: Index, eff): string;                                         // BLOCKED.md
```

`INDEX.md` is the top-level board, linking down to per-epic index files and out to entity files,
using GitHub task-list syntax for free rendered checkboxes. All lists sorted by `id`. Archived
entities are omitted. Example fragment:

```markdown
# Project board
 
_Generated. Do not edit by hand._
 
## [E-001 · User auth](./E-001.md) — in-progress
- [ ] **S-014 · Login** — in-progress
  - [x] [T-101 Session model](../entities/T-101-session-model.md) — done
  - [ ] [T-103 Login form](../entities/T-103-login-form.md) — blocked · waiting on T-099
- [ ] **S-020 · Password reset** — blocked · waiting on S-014
```

`READY.md` lists only effective-`todo` tasks. `BLOCKED.md` lists **all** blocked entities (tasks,
stories, and epics) with their blockers — for an entity blocked by its own dependencies, the
incomplete same-type deps; for one blocked through propagation, the gate-blocked ancestor. Both
are sorted by `id`.

## 8. Generated Artifacts — Summary

| File                            | Source         | When regenerated        | Committed |
|---------------------------------|----------------|-------------------------|-----------|
| `.worktracker/index/INDEX.md`   | `nav.ts`       | every mutation          | yes |
| `.worktracker/index/E-NNN.md`   | `nav.ts`       | every mutation          | yes |
| `.worktracker/index/READY.md`   | `nav.ts`       | every mutation          | yes |
| `.worktracker/index/BLOCKED.md` | `nav.ts`       | every mutation          | yes |
| `.worktracker/graphs/dependencies.mmd`| `mermaid.ts` | every mutation       | yes |
| `.worktracker/graphs/E-NNN.mmd` | `mermaid.ts`   | every mutation          | yes |

`dependencies.mmd` now contains the three same-type dependency bands (epic/story/task) in one
file; URIs and filenames are unchanged. All paths are within the affected project's
`.worktracker/` subtree. All regeneration is deterministic and **idempotent**: regenerating twice
with no data change produces byte-identical output (a required test, §15). The marker
(`project.json`) and seeded `requirements/source.md` are **not** in this set — they are seed
content, never regenerated (§5.1).

## 9. MCP Server Surface

The MCP adapter (`server/src/mcp.ts`) exposes resources (reads) and tools (writes/queries).
Every mutating tool triggers the regeneration pipeline (§9.3) on success.

### 9.0 Project resolution (`server/src/registry.ts`)

The registry owns `Map<root, ProjectState>` and is the single place that turns a `projectId` into
a `ProjectState`. Every resource read and every tool call (except `init`) is resolved through it
first; the resolved `ProjectState.index` is then passed to core.

```ts
// server-only
resolveProject(projectId?: ProjectId): ProjectState;   // applies the rules below; throws structured error
listProjects(): Array<{ projectId: ProjectId; title: string; root: string }>;
init(args: { title: string; intent?: string; root: string }): Promise<{ projectId: ProjectId }>;
registerDiscovered(root: string, marker: ProjectMarker): ProjectState;  // watcher/discovery path
```

`resolveProject` rules (these define exactly when `projectId` may be omitted on the surface below):

- registry has exactly one project and `projectId` is omitted → that project.
- registry has more than one project and `projectId` is omitted → throw `AMBIGUOUS_PROJECT`.
- `projectId` supplied and present in the registry → that project.
- `projectId` supplied but absent → throw `PROJECT_NOT_FOUND` (agent should rescan or `init`).
`init` is the only entry that does not call `resolveProject` (it creates the project; §5.1).
`registerDiscovered` is the watcher's entry for externally-appearing markers (§12.4); both
`init` and `registerDiscovered` are idempotent on an existing marker and converge on the same
"scan root → build `ProjectState` → insert" step.

### 9.1 Resources

All resource URIs carry the project as their first path segment. `{project}` is a `projectId`.

| URI                                | Returns |
|------------------------------------|---------|
| `project://list`                   | JSON array of `{ projectId, title, root }` for all registered projects |
| `requirements://{project}/source`  | raw text of that project's `requirements/source.md` |
| `entity://{project}/{id}`          | the entity's raw Markdown (frontmatter + body) |
| `graph://{project}/dependencies`   | that project's `graphs/dependencies.mmd` text (three same-type bands) |
| `graph://{project}/epic/{id}`      | that project's `graphs/E-{id}.mmd` text |
| `index://{project}/board`          | that project's `index/INDEX.md` text |

`project://list` is the discovery resource an agent reads first to learn which projects exist and
their ids; the remaining resources require a `{project}` segment and resolve through §9.0.
Resources let the agent read current state cheaply without a tool round-trip.

### 9.2 Tools

Each tool returns a structured result or a structured error (see §9.4). Validation runs against
the full in-memory graph *before* any write (§12.1).

Every tool except `init` takes an optional `projectId`, resolved per §9.0. `init` instead
*returns* the `projectId`. `projectId?` is shown first on each signature for emphasis.

```
init({ title, intent? })                                                           -> { projectId }
create_entity({ projectId?, type, title, parent?, dependsOn?, estimate?, tags?, body? }) -> { id }
update_entity({ projectId?, id, fields: { title?, body?, estimate?, tags? } })     -> { id }
set_status({ projectId?, id, status })                                             -> { id, effectiveStatus }
link_dependency({ projectId?, from, to })                                          -> { from, to }
unlink_dependency({ projectId?, from, to })                                        -> { from, to }
move_entity({ projectId?, id, newParent })                                         -> { id }
archive_entity({ projectId?, id })                                                 -> { id }   // soft delete
query_ready({ projectId? })                                                        -> { tasks: string[] }
query_blocked({ projectId? })                                                      -> { blocked: Array<{ id, type, blockedBy: string[] }> }
critical_path({ projectId?, type? })                                               -> { path: string[], total: number }
validate({ projectId? })                                                           -> ValidationResult
list_projects()                                                                    -> { projects: Array<{ projectId, title, root }> }
```

Tool rules:

- `init`: bootstraps a project in the current root (§5.1). Create-if-absent and idempotent — on
  an already-marked root it returns the existing `projectId` unchanged and seeds nothing.
  `title` is recorded in the marker; `intent` (if given) seeds `requirements/source.md` once.
  This is the only tool that does not resolve an existing project.
- `list_projects`: the tool-surface equivalent of the `project://list` resource (§9.1); returns
  every registered project. An agent that does not yet hold a `projectId` calls this (or reads the
  resource) first.
- All other tools resolve their target project via §9.0 before doing anything. `projectId` may be
  omitted only when exactly one project is registered; otherwise omitting it yields
  `AMBIGUOUS_PROJECT`. An unknown `projectId` yields `PROJECT_NOT_FOUND`. Entity ids (`id`,
  `parent`, `from`, `to`, `newParent`) are resolved **within the selected project**; ids are not
  global across projects.
- `create_entity`: `parent` required for stories (an epic) and tasks (a story); rejected for
  epics. `dependsOn` is now allowed for **all** types, but each referenced id must be the **same
  type** as the entity being created. Allocates the id from the project's counter.
- `update_entity`: `id` and `type` are immutable and cannot be set here. `status`, `parent`, and
  `dependsOn` are changed only via `set_status`, `move_entity`, and the link tools respectively.
- `set_status`: valid only on tasks; rejected on stories/epics (their status is computed).
- `link_dependency` / `unlink_dependency`: valid for **all** types. `from` and `to` must be the
  **same type** (`DEP_TYPE_MISMATCH` otherwise) and belong to the same project. Linking validates
  no self-dependency (`SELF_DEPENDENCY`), no duplicate (`DUPLICATE_DEPENDENCY`), and that the edge
  keeps that type's dependency DAG acyclic (`DEP_CYCLE`). Unlinking a non-existent edge yields
  `NOT_LINKED`.
- `move_entity`: changes `parent`; validates new parent type and that the hierarchy stays acyclic.
  `newParent` must belong to the same project.
- `archive_entity`: sets `archived: true` (soft delete). Hard deletion is intentionally **not**
  exposed; humans remove files and rely on git history.
- `query_ready`: effective-`todo` tasks (workable now). `query_blocked`: all blocked entities of
  any type with their blockers. `critical_path`: longest weighted path through the chosen type's
  dependency DAG (default `task`).

### 9.3 Regeneration pipeline (post-mutation side effect)

On every successful mutating tool call, against the resolved project's `ProjectState` (§9.0):

1. Recompute `resolveAll` over that project's updated in-memory index; cache it in `ProjectState.eff`.
2. Regenerate all artifacts in §8 within that project's `.worktracker/` subtree.
3. Write all changed files atomically (skip unchanged), recording paths in that project's
   write-suppression set (§12.4).
4. (Optional, config-gated) `git add` the changed files and commit with a structured message,
   e.g. `feat(T-103): set status in-progress`. The commit is made in that project's repo.
5. Broadcast a project-scoped WS message to that project's subscribers (§10).
Regeneration is a side effect of the tools, never a separate tool the agent must remember.

### 9.4 Error contract

Tools fail with a structured error `{ code, message, details? }` so the agent can self-correct.
Defined error codes:

| Code                  | Raised when |
|-----------------------|-------------|
| `NOT_FOUND`           | referenced id does not exist |
| `INVALID_PARENT_TYPE` | parent is the wrong type for the child (e.g. task parented to an epic) |
| `PARENT_REQUIRED`     | story/task created or moved without a parent |
| `EPIC_HAS_PARENT`     | epic given a non-null parent |
| `NOT_A_TASK`          | task-only operation attempted on a story/epic (e.g. `set_status`) |
| `DEP_NOT_FOUND`       | dependency target does not exist |
| `DEP_TYPE_MISMATCH`   | a dependency references an entity of a different type than the declaring entity |
| `DEP_CYCLE`           | a dependency edge would create a cycle in that type's dependency DAG |
| `HIERARCHY_CYCLE`     | a move would create a cycle in the hierarchy |
| `SELF_DEPENDENCY`     | `from === to` in a link |
| `DUPLICATE_DEPENDENCY`| edge already exists |
| `NOT_LINKED`          | `unlink_dependency` on a non-existent edge |
| `IMMUTABLE_FIELD`     | attempt to change `id` or `type` |
| `INVALID_STATUS`      | status not in the allowed set |
| `AMBIGUOUS_PROJECT`   | more than one project is active and the call did not specify `projectId` |
| `PROJECT_NOT_FOUND`   | a supplied `projectId` matches no reachable marker under the watch roots |
| `NOT_A_PROJECT`       | a path expected to be a project root has no `.worktracker/project.json` marker |

`DEP_TYPE_MISMATCH` replaces v1's `DEP_NOT_A_TASK`: the rule is no longer "must be a task" but
"must be the same type as the source." `NOT_A_TASK` now covers only stored-status operations
(`set_status`), since dependency operations are valid on every type.

## 10. HTTP + WebSocket Viewer API

`server/src/http.ts` serves the built React app statically and exposes a read-only API plus a
live channel. It performs **no writes**. A browser has no MCP roots channel, so the project is
carried as a path segment (`:project` is a `projectId`); `GET /api/projects` enumerates them.

| Method / path                      | Returns |
|------------------------------------|---------|
| `GET /api/projects`                | `[{ projectId, title, root }]` for all registered projects |
| `GET /api/:project/graph`          | `{ entities: EntityView[], edges: { from, to, type }[] }` where `EntityView` includes `type` and computed `effectiveStatus` |
| `GET /api/:project/entity/:id`     | full entity including `body` Markdown and its `dependsOn` / dependents |
| `GET /api/:project/board`          | hierarchical board structure with computed statuses |
| `GET /api/:project/mermaid/:view`  | raw `.mmd` text (`dependencies` or `epic/:id`) |
| `WS  /ws`                          | client sends `{ subscribe: projectId }`; server emits `{ type: 'changed', project, ids: string[] }` or `{ type: 'reload', project }` |

Each edge in `/api/:project/graph` carries its `type` so the UI can band or filter dependencies by
level. Unknown `:project` returns HTTP 404 (the read-side analogue of `PROJECT_NOT_FOUND`). The UI
calls `GET /api/projects` on load to populate its project picker, then fetches the selected
project's endpoints and subscribes to that project on `/ws`, refetching on change for that
project. The API derives `effectiveStatus` from the same `core` functions over the selected
project's `ProjectState`, so the UI and the agent always agree.

## 11. React UI Scope (read-only)

- **Project picker:** loads `GET /api/projects` and lets the human choose the active project; all
  views below operate on the selected project, and the `/ws` subscription is scoped to it.
- **Board view:** epic → story → task tree with computed status badges, including `blocked` badges
  that originate from epic/story dependencies or ancestor gates.
- **Graph view:** render the generated Mermaid (with clickable nodes opening the entity view), and
  /or an interactive graph built from `/api/graph` (e.g. React Flow). Same-type dependency edges
  can be grouped or filtered by level (epic / story / task) using each edge's `type`.
- **Entity panel:** render an entity's Markdown body plus its relations (parent, same-type
  `dependsOn`, same-type "blocks", and — when blocked by propagation — the gating ancestor).
- **Ready / Blocked filters:** surface `READY` (tasks) and `BLOCKED` (all types) directly.
- **Live updates:** refetch on WS events.
- **No editing.** No write path exists from the browser; this is what removes all multi-writer
  concurrency concerns.

## 12. Cross-Cutting Concerns

### 12.1 Validate-before-commit

A mutation applies its change to the **resolved project's** in-memory index, runs `validate()`
over that project's whole graph, and only proceeds to write if there are no errors. Warnings do
not block. This guarantees a rejected mutation never leaves a partial or invalid state on disk.
Validation is scoped to a single project; ids in one project never reference another.

### 12.2 Atomic writes

Every file write is temp-file + `fsync` + `rename` within the same directory. The regeneration
pipeline stages all writes and applies them after validation passes.

### 12.3 Determinism & churn control

- Canonical serialisation (fixed key order; sorted `dependsOn`/`tags`).
- Generators emit stable ordering (by `id`; edges by `(from, to)`; bands by type).
- `updated` timestamp changes only when an entity's content actually changes (compare canonical
  serialisation before writing; skip identical writes). This prevents timestamp-only diffs.

### 12.4 File watcher & write-suppression

The watcher serves two granularities, and watches **narrowly** at each — it does *not* watch
every file under the recursive roots.

**Marker discovery (coarse, across watch roots).** The server watches its configured roots (§14)
recursively, but only to find and notice `.worktracker/project.json` markers. Discovery rules:

- A marker defines a project **root**; the watcher does **not** descend past a marker looking for
  nested projects. Projects do not nest.
- Standard ignores apply (`node_modules`, `.git` internals, build output such as `dist`) so a
  folder of repos or a monorepo does not produce a noisy or slow scan, and so a marker vendored
  inside a dependency never creates a spurious project.
**Content watching (fine, per project).** For each *discovered* project, a content watcher is
attached only to that project's `.worktracker/entities/` and `.worktracker/requirements/` — never
to the whole recursive root. This keeps watcher cost proportional to the active projects, not to
the size of the watched trees.

**Two trigger paths, one back end.** Both end in "scan project root, refresh `ProjectState`,
broadcast" but are reached differently:

1. **`init` (server-originated).** The project is registered **synchronously within the `init`
   call** (§5.1). The marker write is a server write and is therefore suppressed here exactly as
   any other server write — the watcher must *not* be the path by which an `init` project becomes
   known.
2. **External marker appears (not server-originated).** A `git pull`, a manual clone into a watch
   root, or a copied-in project produces a marker the server did not write. The watcher scans that
   project root, builds its `ProjectState`, and broadcasts. This is the natural extension of the
   "external change → re-index" behaviour, lifted from entity granularity to project granularity.
**Write-suppression (per project).** Each `ProjectState` maintains the set of paths the server is
currently writing; its content-watcher handler ignores events for those paths, clearing entries
after a short debounce once the write settles. Genuine external edits to a known project's
entities/requirements trigger a re-index (full rescan of that project in v1 for simplicity) and a
WS `reload` for that project's subscribers.

### 12.5 Concurrency model

**Single writer per project:** only the MCP server process writes to a given project's store. The
HTTP adapter is read-only. Therefore no file locking is required. Note the dependency on transport:
under stdio-per-session, two server processes pointed at the *same* project are still two writers
and remain out of scope for v1. A shared long-running daemon (HTTP/streamable MCP transport) would
make the daemon the sole writer across sessions and resolve this; that is a separate, larger
change. Concurrent external writers are out of scope for v1; if introduced later they require a
locking or transaction strategy not covered here.

### 12.6 Git integration

Config-gated. When enabled, each successful mutation commits the changed entity file(s) and all
regenerated artifacts together, giving history, blame, and undo for free, with the generated
diffs serving as a human-readable activity log.

## 13. Validation Rules (`validate()` contract)

**Errors** (block mutation):

- `DUPLICATE_ID` — two files claim the same `id`.
- `DANGLING_PARENT` — `parent` references a non-existent entity.
- `INVALID_PARENT_TYPE` — wrong parent type for the child.
- `PARENT_REQUIRED` — story/task with `parent: null`.
- `EPIC_HAS_PARENT` — epic with non-null `parent`.
- `HIERARCHY_CYCLE` — cycle in the parent forest.
- `DANGLING_DEPENDENCY` — `dependsOn` references a non-existent entity.
- `DEP_TYPE_MISMATCH` — `dependsOn` references an entity of a different type than the declaring
  entity (dependencies must be same-type).
- `SELF_DEPENDENCY` — an entity depends on itself.
- `DEP_CYCLE` — cycle in any of the three same-type dependency DAGs (epic, story, or task).
**Warnings** (allowed, surfaced in UI and in `validate()` output):
- `IN_PROGRESS_WITH_INCOMPLETE_DEP` — an `in-progress` entity (task, story, or epic) has a
  same-type dependency not yet effectively `done`.
- `DONE_WITH_INCOMPLETE_DEP` — a `done` entity has a same-type dependency not yet effectively
  `done`.
- `EMPTY_COMPOSITE` — a story or epic has no (non-archived) children.

## 14. Technology Choices

- Runtime: Node.js (LTS), TypeScript, npm workspaces.
- MCP: `@modelcontextprotocol/sdk` (stdio transport).
- Frontmatter: `gray-matter`.
- File watching: `chokidar`.
- WebSocket: `ws`.
- HTTP: a minimal framework (e.g. Fastify/Express) or Node `http`.
- UI: React + Vite; optionally `mermaid` (browser render) and React Flow.
- Graph algorithms: hand-rolled in `graph.ts` (topological sort, DFS cycle detection,
  longest-weighted-path), applied per type — well under ~100 lines; no graph library dependency.

### 14.1 Configuration

- **`watchRoots: string[]`** (required) — folders watched recursively for
  `.worktracker/project.json` markers. May be a single folder containing many repos. Discovery is
  automatic from these roots; there is no project-root config value and no central registry file.
- `port` — HTTP/WS listen port.
- `git` on/off — config-gates the commit step of the regeneration pipeline (§9.3, §12.6).

## 15. Testing Strategy

- **Core unit tests** against temp directories with fixtures:
  - status resolution truth table — task resolution, composite roll-up, the same-type dependency
    rule at all three levels, and downward gate propagation — across all combinations;
  - per-type dependency cycle detection (epic/story/task) and hierarchy cycle detection, each
    returning a concrete cycle path;
  - `ready` (tasks only; excludes tasks under a gate-blocked ancestor), `blocked` (all types with
    correct blockers), and `criticalPath` per type, against hand-computed expectations;
  - canonical serialisation round-trip (`parse → write → parse` equality) with `dependsOn` on
    epics and stories as well as tasks.
- **Determinism / idempotency:** golden-file snapshots of `INDEX.md`, `READY.md`, `BLOCKED.md`,
  and `.mmd` (three bands); regenerating twice yields byte-identical output (no diff).
- **MCP integration:** spawn the server, exercise each tool, assert (a) on-disk result, (b) tool
  return value, (c) structured errors for each error code in §9.4 — including `DEP_TYPE_MISMATCH`
  on a cross-type link and `DEP_CYCLE` on a story-level and epic-level cycle.
- **Registry & resolution:** `resolveProject` returns the sole project when `projectId` is omitted,
  raises `AMBIGUOUS_PROJECT` with two projects registered, and `PROJECT_NOT_FOUND` for an unknown
  id; ids resolve within the selected project only; the registry rebuilds identically from markers.
- **HTTP/WS:** read endpoints return computed statuses for the named project; graph edges carry
  `type`; unknown `:project` returns 404; an external edit to one project triggers a single WS
  broadcast scoped to that project and none to others; write-suppression prevents the server's own
  writes from broadcasting.
- **Discovery & init:** a pre-marked repo under a watch root is discovered without `init`; `init`
  registers synchronously and its own marker write triggers no discovery event; an externally
  added marker triggers one discovery + broadcast; `init` on an already-marked repo is idempotent.

## 16. Proposed Implementation Phases

Each phase lists a deliverable and acceptance criteria, sized to decompose into stories/tasks.
Phases are ordered by dependency: store primitives → graph/status → generators → the multi-project
registry → the MCP adapter that wires resolution and `init` → the viewer → the UI → hardening.

### Phase 0 — Foundations

**Deliverable:** monorepo scaffold (`core`, `server`, `ui`), shared `types.ts` (including
`ProjectId`, `ProjectMarker`, `ProjectState`), test fixtures, CI running lint + tests.
**Acceptance:** all three packages build; CI green on an empty test suite; fixtures for a small
project (1 epic, 2 stories, 4 tasks with one task dependency, and at least one story→story
dependency) exist under a `.worktracker/` subtree.

### Phase 1 — Core store

**Deliverable:** `store.ts` — `createStore(root)` binding, scan, parse, index build, canonical
serialise, atomic write, per-project id allocation, `move`; plus marker primitives
(`readMarker`, `writeMarker`, `seedRequirements`) and `discoverProjects(watchRoots)` with the
no-descend / ignore rules.
**Acceptance:** can scan the fixture into an `Index`; `parse→write→parse` is lossless and
byte-stable with `dependsOn` present on every type; ids allocate from the project's
`.meta/counters.json` with no reuse after archival; `move` edits only frontmatter;
`discoverProjects` finds a fixture marker, ignores `node_modules`/`.git`/`dist`, and does not
descend past a marker.

### Phase 2 — Graph & status

**Deliverable:** `graph.ts` (per-type DAGs), `status.ts` (three-layer resolution + gate
propagation), `validate.ts`.
**Acceptance:** the three-layer status truth table passes, including composite same-type
dependencies and downward gate propagation; per-type cycle detection returns a concrete cycle
path; `ready`/`blocked`/`criticalPath` match hand-computed expectations on the fixture;
`validate()` emits the correct error and warning codes (including `DEP_TYPE_MISMATCH` and
story/epic `DEP_CYCLE`) for crafted-bad fixtures.

### Phase 3 — Generators

**Deliverable:** `mermaid.ts` (three same-type bands, clickable nodes) and `nav.ts` (`INDEX.md`,
per-epic, `READY.md`, `BLOCKED.md`), emitting within a project's `.worktracker/` subtree.
**Acceptance:** generated files match golden snapshots; `dependencies.mmd` renders epic/story/task
bands with same-type edges; regeneration is idempotent; Mermaid renders on GitHub with working
`click` links; index links resolve to entity files; `BLOCKED.md` lists blocked entities of all
types with their blockers.

### Phase 4 — Registry, discovery & init

**Deliverable:** `server/src/registry.ts` — `Map<root,ProjectState>`, `resolveProject(id?)` with
the §9.0 rules, `listProjects()`, `init()` (synchronous in-process registration, create-if-absent,
optional `source.md` seed), and `registerDiscovered()` for the watcher path; boot-time discovery
from `watchRoots`.
**Acceptance:** boot discovers all pre-marked repos under the watch roots with no `init` call;
`init` on an unmarked repo mints an id, writes the marker, and registers synchronously without
relying on the watcher; `init` on an already-marked repo returns the existing id and seeds nothing;
`resolveProject` returns the sole project when id is omitted, and raises `AMBIGUOUS_PROJECT` /
`PROJECT_NOT_FOUND` correctly; the registry can be dropped and rebuilt from markers identically.

### Phase 5 — MCP adapter

**Deliverable:** `mcp.ts` resources + tools + error contract (every signature in §9.1/§9.2,
project-scoped, with same-type dependency rules); `regenerate.ts` per-project pipeline; optional
git commit.
**Acceptance:** every tool works end-to-end against a resolved project; `link_dependency` works for
all three types and rejects cross-type links with `DEP_TYPE_MISMATCH`; `projectId` omission rules
hold (single vs. multiple projects); ids resolve within the selected project and never across
projects; validate-before-commit leaves the store untouched on a rejected mutation; mutations
regenerate that project's artifacts; each §9.4 error code (including `DEP_TYPE_MISMATCH` and the
three project codes) is reachable via an integration test.

### Phase 6 — HTTP/WS viewer API

**Deliverable:** `http.ts` project-scoped read API (`/api/projects`, `/api/:project/*`, graph edges
typed), chokidar watcher (coarse marker-discovery + fine per-project content watching), per-project
write-suppression, project-scoped WS broadcast; serves UI build.
**Acceptance:** read endpoints return computed statuses identical to core for the named project;
graph edges carry `type`; unknown `:project` returns 404; an external edit to one project triggers a
single WS broadcast scoped to that project and none to others; an externally added marker is
discovered and broadcast; the server's own writes trigger no broadcast.

### Phase 7 — React UI

**Deliverable:** project picker, read-only board, graph (Mermaid + interactive, dependency edges
groupable by type), entity panel, ready/blocked filters, live refresh — all scoped to the selected
project.
**Acceptance:** picker lists all projects; selecting one populates the views; UI reflects a
mutation issued via MCP against that project within one WS cycle; a `blocked` epic/story is shown
as such, with its blocker; clicking a Mermaid node opens the entity; no write path exists.

### Phase 8 — Hardening & ergonomics

**Deliverable:** `validate()` surfacing in UI; an optional `decompose_requirements` MCP prompt
template; README and operator docs; configuration (`watchRoots`, port, git on/off).
**Acceptance:** warnings are visible to humans; docs cover setup, the data model, same-type
dependencies and gate propagation, discovery/`init`, and the per-project single-writer constraint.

## 17. Open Questions / Deferred Decisions

- **Cross-type dependencies.** Same-type dependencies (epic→epic, story→story, task→task) are
  supported as of this revision (§6.3–§6.4). Allowing a task to depend on a story/epic (resolved
  via that composite's roll-up) is a coherent extension but reintroduces the resolution-ordering
  circularity that the same-type model specifically avoids — a composite's effective status would
  depend on a task's, which could depend on that composite's. Deferred.
- **Dependency gate propagation.** This revision makes a composite dependency *gate* all work
  beneath it: a gate-blocked epic/story blocks its non-`done` descendants (§6.4c), so an
  epic→epic dependency keeps the dependent epic's tasks out of `READY`. The alternative —
  treating composite `blocked` as report-only and leaving descendant readiness untouched — is
  simpler, but renders epic/story dependencies toothless for the `ready` and `critical_path`
  queries (their main purpose). Gating is chosen for v1; the report-only variant is noted here in
  case execution semantics need revisiting.
- **Critical path across levels.** `critical_path` is computed per type, defaulting to tasks
  (the only type carrying `estimate`). Whether a cross-level "scheduling" view that interleaves
  epic/story/task chains is worthwhile is out of scope.
- **Multi-writer support.** The single-writer-per-project model is assumed throughout (§12.5).
  Supporting concurrent writers to one project would require locking/transactions and conflict
  handling.
- **Shared daemon transport.** v1 uses stdio, where each client session spawns its own process, so
  "single configuration" means one config entry that works in any repo — not one shared process.
  Moving the MCP surface onto the HTTP/streamable transport (a long-running daemon clients connect
  to) would let one process serve many sessions and make that daemon the genuine sole writer across
  agents, resolving the per-project multi-writer caveat. It folds into the existing HTTP adapter but
  is a larger change; deferred.
- **ID scheme.** Per-type zero-padded counters are proposed; ULIDs are an alternative if
  human-friendly ids are not required and counter persistence is undesirable.
- **Estimates & critical path.** Critical path uses `estimate ?? 1` as weight; whether to support
  richer scheduling (durations, parallelism limits) is out of scope.
- **Requirements ingestion.** The requirements document is provided as a resource the agent
  reads; whether to track provenance links from entities back to requirement sections is a
  possible future enhancement.
  