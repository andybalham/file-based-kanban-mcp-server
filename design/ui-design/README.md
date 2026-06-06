# Handoff: Read-Only Project Board (File-based Kanban / MCP Server)

## Overview
This is the **read-only web viewer** for a file-based Kanban / MCP server. The server tracks
work as a tree of **Epics → Stories → Tasks** stored on disk, exposes it over a small HTTP API
(and a WebSocket for live updates), and this UI renders it.

The defining characteristic of this product is that it is **strictly read-only**. The UI never
mutates state — there are no create/edit/delete affordances, no drag-to-reorder, no status
toggles. Everything the user sees is either stored data or a **derived view** of it.

### Where this UI sits in the larger system
This viewer is **one half of the product**. The full app is:

1. **An MCP server** that owns the entities. It is the *write path* — agents (and tooling) create,
   update, re-parent, set status, manage dependencies, and archive Epics / Stories / Tasks through
   MCP tools, which it persists to the file-based store on disk.
2. **This web UI** — the *read path* — a live window onto that same store, for humans to watch and
   navigate the work as agents and people manipulate it.

So the data this UI renders is **authored elsewhere, through the MCP server and the files it
writes**. That is *why* the UI is read-only by design: mutation is the MCP server's job, and the
two halves stay decoupled. The board file the UI fetches and the entities the MCP server mutates
are the same source of truth; the WebSocket "updated" ping is how a write on the MCP side becomes a
re-render on the UI side. When implementing, treat the API shapes below as the read-side view over
that shared store — don't add write endpoints to this surface.

The viewer offers four ways to look at the same board:

1. **Board** — the canonical Epic → Story → Task tree, collapsible.
2. **Ready** — a flat list of tasks workable *right now* (todo with all dependencies done).
3. **Blocked** — a flat list of stored-blocked tasks, each showing its blockers.
4. **Graph** — the task dependency DAG, rendered two ways (Mermaid + interactive pan/zoom SVG).

Clicking any entity anywhere opens a **read-only detail drawer** (Markdown body, relations,
metadata) that you can navigate through via relation chips.

## About the Design Files
The files in this bundle are **design references created in HTML/React (via in-browser Babel)** —
a working prototype that demonstrates intended look, layout, and behavior. **They are not the
production codebase.** The task is to **recreate this design in your target environment** (your
existing React/Vue/Svelte/etc. app, using its component library, router, data-fetching, and build
tooling) — or, if there is no environment yet, to pick an appropriate stack and implement it there.

In particular:
- The prototype loads React + Babel from a CDN and uses inline-transpiled `.jsx`. **Do not ship
  that.** Use your real build pipeline.
- Data is mocked in `data.js` / `entities.js`. **Replace with real API calls** (see "Data & API"
  below — the mock shapes deliberately mirror the intended endpoints).
- The "live" WebSocket is **simulated** (a timer that flashes a dot). Wire it to a real socket.
- All board math (rollups, ready/blocked derivation, graph building, layout) lives in `logic.js`
  as **pure functions**. This is the part most worth porting faithfully / reusing as-is — see
  "Derived-view logic" — because getting these rules subtly wrong changes what the user sees.

## Fidelity
**High-fidelity.** Colors, typography, spacing, status semantics, and interactions are all final
and intentional. Recreate the UI to match, using your codebase's primitives where they exist
(buttons, popovers, drawers) but preserving the exact tokens and status semantics documented here.
The status badge palette in particular is a contract — it is kept in sync between the CSS, the
React components, and the Mermaid `classDef`s, and must stay consistent across all four views.

---

## Data & API

The mock data shapes mirror the intended server API. Implement against these endpoints (or your
equivalents) and keep the shapes:

```
GET /api/projects
  -> [{ projectId, title, root }]            // root is a filesystem path string, shown in mono

GET /api/:project/board
  -> { epics: [ Epic ] }

GET /api/:project/entity/:id
  -> EntityDetail                            // full payload for the drawer

WebSocket (per project)
  -> push "updated" pings; UI refetches the board and flashes the live indicator
```

### Core entity tree

```
Epic   = { kind:"epic",  id, title, children: Story[] }
Story  = { kind:"story", id, title, children: Task[] }
Task   = { kind:"task",  id, title, status, deps: string[], archived?: boolean }
```

**Critical modeling rule:** only **Tasks** carry a *stored* `status` and `deps`.
**Stories and Epics have NO stored status** — their badge is always a **computed rollup** of their
descendants (see logic). Do not add a stored status to stories/epics.

- `status` (tasks only) ∈ `"todo" | "in-progress" | "blocked" | "done"`
- `deps` (tasks only) = array of task ids this task depends on (prerequisites)
- `archived` (tasks only) = excluded from rollups, progress, ready/blocked lists, and the graph,
  but **still shown** in the Board tree, visually de-emphasized.

### Entity detail payload (drawer)

```
EntityDetail = {
  id, title, kind, status,
  parent:     { id, title, kind } | null,
  dependsOn:  Rel[],     // tasks only — this task's deps
  blocks:     Rel[],     // tasks only — inverse: tasks that depend on this one
  body:       string,    // Markdown (GFM, incl. task-list checkboxes — rendered READ-ONLY)
  created, updated,      // ISO date strings or null
  estimate:   string|null,
  tags:       string[],
  archived:   boolean,
}
Rel = { id, title|null, status|null, missing:boolean }   // missing = id not found in this project
```

---

## Derived-view logic (port this faithfully — `logic.js`)

All of the following are **pure, read-only** computations. Reproduce the rules exactly; they
determine what each view shows.

- **`indexTasks(board)`** — flatten to `{ byId, all:[{task, epic, story}] }`.

- **`effectiveStatus(task, byId)`** — a stored `"todo"` whose deps are **not all done** is
  *effectively* `"blocked-implicit"` (distinct from a stored `"blocked"`). Everything else passes
  through unchanged. Used by the graph.

- **Rollup → story/epic status.** Map each child status to `done` / `todo` / `active`
  (`in-progress`, stored `blocked` → active; `todo` and `blocked-implicit` → todo). Then:
  all children `done` → **done**; all `todo` → **todo**; otherwise → **in-progress**.
  - `storyStatus`: rolls up its non-archived task children (a stored-`blocked` task counts as
    active work in flight).
  - `epicStatus`: rolls up its stories' rolled-up statuses.

- **`readyTasks(board)`** — non-archived tasks with stored status `todo` AND (no deps OR every dep
  is `done`). Sorted by id ascending. This is the **Ready** tab.

- **`blockedTasks(board)`** — non-archived tasks with **stored** status `blocked`, each annotated
  with its blockers `[{id, title, status}]`. Sorted by id. This is the **Blocked** tab.
  (Note: Ready uses *implicit* readiness; Blocked uses the *stored* blocked flag. They are
  intentionally different — a `todo` with unfinished deps is "not ready" but is NOT listed under
  Blocked.)

- **`progress(node)`** — `{done, total}` count of non-archived task descendants (done vs total).
  Drives the faint progress meter on epic/story rows.

- **`buildGraph(projectId, scope)`** — emits `{entities, edges, totalTasks, epics}`.
  Scope is `{type:"full"}` or `{type:"epic", id}`. Archived tasks excluded. **Edge direction:
  prerequisite → dependent** (from a task's dep TO the task). Edges only included if both endpoints
  are in scope. Each entity carries both stored `status` and `effectiveStatus`.

- **`layoutGraph(entities, edges, opts)`** — Sugiyama-style layered DAG layout via **longest-path
  layering** (with a cycle guard), columns ordered by id for stability, each column vertically
  centered. Defaults: `nodeW 172, nodeH 48, hGap 64, vGap 22`. Returns `{pos, width, height,...}`.

- **`toMermaid(entities, edges)`** — generates a `graph LR` Mermaid definition with per-status
  `classDef`s. Mirrors the server's `.mmd` export. Node ids are sanitized to `n<id>`; labels are
  `id<br/>title`.

---

## Design Tokens

Defined as CSS custom properties on `:root`, with a `.dark` override class and a
`.density-compact` override class. **Theme, accent, density, and font are applied by toggling
classes / setting CSS vars on `<html>`** — mirror that approach.

### Color — Light (default)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#ffffff` | Surface (cards, header, drawer, rows) |
| `--canvas` | `#f6f8fa` | App background behind cards |
| `--elevated` | `#ffffff` | Popovers / menus |
| `--border` | `#d8dee4` | Primary borders |
| `--border-soft` | `#eaeef2` | Row dividers, subtle borders |
| `--fg` | `#1f2328` | Primary text |
| `--fg-muted` | `#636c76` | Secondary text |
| `--fg-faint` | `#8c959f` | Tertiary / metadata / mono ids |
| `--hover` | `#f6f8fa` | Row & control hover |
| `--accent` | `#7c5cff` (default) | Brand accent — selectable: `#7c5cff`, `#3b82f6`, `#10b981`, `#f97316` |
| `--accent-soft` | `accent @ 14% (oklab mix)` | Selected/active tints |
| `--shadow` | `0 1px 2px rgba(31,35,40,.06), 0 6px 24px rgba(31,35,40,.08)` | Card/popover elevation |

### Color — Dark (`.dark`)
| Token | Value |
|---|---|
| `--bg` | `#0d1117` |
| `--canvas` | `#010409` |
| `--elevated` | `#161b22` |
| `--border` | `#30363d` |
| `--border-soft` | `#21262d` |
| `--fg` | `#e6edf3` |
| `--fg-muted` | `#9198a1` |
| `--fg-faint` | `#6e7681` |
| `--hover` | `#161b22` |
| `--shadow` | `0 1px 2px rgba(1,4,9,.5), 0 8px 24px rgba(1,4,9,.6)` |

Live-update dot color is fixed green `#3fb950` in both themes.

### Status palette (CONTRACT — identical across CSS / React / Mermaid)
| Status | Fill | Ink (text/border/dot) |
|---|---|---|
| `done` | `#c6f6d5` | `#22543d` |
| `in-progress` | `#feebc8` | `#744210` |
| `blocked` | `#fed7d7` | `#742a2a` |
| `todo` | `#e2e8f0` | `#2d3748` |

Badge border = `1px solid color-mix(in oklab, <ink> 22%, transparent)`. These hex values are
hard-coded into the Mermaid `classDef`s and the SVG graph nodes — keep them in sync.

### Typography
- **Sans:** `Geist` (default), with selectable alternates `IBM Plex Sans` and `system-ui`.
- **Mono:** `Geist Mono` (default) / `IBM Plex Mono` / system mono — used for **all entity ids**,
  filesystem paths, counts, timestamps, and tags.
- Base body `14px`. Row font `--row-fs` (`13.5px` comfortable / `12.5px` compact). Entity id
  `--id-fs` (`12.5px` / `11.5px`). Drawer title `19px/600`. Section labels `11px/600` uppercase,
  letter-spacing `.05–.06em`.
- Smoothing: `-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility`.

### Density (`.density-compact`)
| Token | Comfortable | Compact |
|---|---|---|
| `--row-py` | `9px` | `5px` |
| `--row-fs` | `13.5px` | `12.5px` |
| `--id-fs` | `12.5px` | `11.5px` |

### Radius / spacing
- Cards & main containers: radius `12px`. Popovers: `10px`. Buttons/chips: `6–8px`. Pills/badges:
  `999px`. Checkbox: `4px`.
- Main content column max-width `940px` (board/ready/blocked), `1180px` (graph), centered.
- Row padding: `var(--row-py) 16px` with **left indent `16 + depth*22px`** per tree level.
- Custom scrollbar (`.scroll`): `11px`, thumb `--border` with a `3px` `--canvas` border, hover
  `--fg-faint`.

---

## Screens / Views

### 0. App shell
- **Top bar** (`--bg`, bottom border): **Project picker** (left) · **live indicator** · spacer ·
  **"read-only" lock chip** (right, mono, with padlock icon).
- **Tab bar** (`--bg`, bottom border): `Board` · `Ready`(count) · `Blocked`(count) · `Graph`.
  Active tab = `--fg` bold with a `2px` accent underline; counts are mono pills (accent-tinted when
  active). On the Board tab only, a right-aligned **"Collapse all / Expand all"** text button.
- **Main scroll region** (`--canvas`): holds the active view's centered card.

#### Project picker
- Trigger button: small accent square + project title (`13.5/600`) + filesystem `root` (mono,
  faint) stacked, chevron that rotates `180°` when open.
- Popover (`--elevated`, radius `10`, `--shadow`, fade-in `.12s`): "PROJECTS" label, then a row per
  project (accent square, title, mono root, check on the selected one). Selected row uses
  `--accent-soft`. Closes on outside click.

#### Live indicator
- Green dot + mono relative-time text ("updated just now / 12s ago / 2m ago"). On a (simulated)
  push, the dot fires a one-shot **`pulse-ring`** animation (~1.1s). Replace the timer with a real
  WebSocket; flash on each received update and recompute "x ago" every second.

### 1. Board view (default)
The Epic → Story → Task tree.
- **Epic row** (depth 0): chevron toggle · mono id · `·` separator · title (`600`, size
  `--row-fs + .5`) · spacer · progress meter · rollup status badge.
- **Story row** (depth 1): chevron · id · title (`600`) · spacer · progress meter · rollup badge.
- **Task row** (depth 2): a `12px` spacer (no chevron) · **read-only checkbox** (checked = done) ·
  id · `·` · title · optional `archived` chip / `waiting on …` note · spacer · status badge.
- Rows: `gap 9px`, hover = `--hover` (interactive rows only), bottom divider `--border-soft`.
- **Collapsed state** is local UI state held in a `Set` of collapsed ids (NOT persisted, NOT sent
  to server). Chevron rotates `0°→90°`. "Collapse/Expand all" sets/clears the whole set.
- **Done / archived tasks**: title gets `line-through` (faint color); archived rows also drop
  opacity (~.5 on the checkbox, full title struck) and show a dashed uppercase `archived` chip.
- **Blocked task** (stored): shows an italic faint `waiting on T-x, T-y` note inline.
- **Progress meter**: `44px` track (`--border-soft`) with an accent fill (turns `--done-ink` at
  100%), then mono `done/total`. Hidden when total is 0.
- **Empty project** → centered `EmptyState` (dashed-border icon tile, heading, sub-copy).

### 2. Ready view
- A `ViewHint` strip explaining the rule, then a **flat** list (`FlatRow`, `18px` h-padding).
- Each row: unchecked checkbox · id · title · faint mono `EPIC › STORY` breadcrumb · spacer · a
  `todo` badge.
- Empty → "Nothing is ready to start." with explanatory sub-copy.

### 3. Blocked view
- `ViewHint` strip, then one block per blocked task (`flex-column`, hover highlights the whole
  block):
  - Line 1: unchecked checkbox · id · title · mono `EPIC › STORY` · spacer · `blocked` badge.
  - Line 2: italic faint "waiting on" + a wrapped row of **blocker chips** — each chip = a status
    dot (colored by blocker's status) + mono blocker id + optional title.
- Empty → "No blocked tasks."

### 4. Graph view
Container card with a toolbar; canvas fills remaining height.
- **Toolbar**: a segmented `Mermaid | Interactive` control; a **scope selector** popover
  (`Full graph` or per-epic subgraph, each with a task count / title); a divider; **status filter
  chips** (`todo / in-progress / blocked / done`, each with live count) that toggle visibility;
  and (interactive mode only) a **Fit** button.
- **Density hint**: if full graph has > 30 tasks, an accent-tinted strip suggests scoping to one
  epic.
- **Mermaid mode** (canonical): renders `graph LR` via mermaid@10, `theme:"base"`, transparent
  background, `htmlLabels`, `curve:"basis"`, node spacing 38 / rank 64. Nodes are made clickable →
  open the drawer. Re-renders on theme change.
- **Interactive mode**: hand-rolled SVG.
  - Layered layout from `layoutGraph`. Nodes = rounded rect (`rx 9`) filled by **stored status**,
    with a status dot, mono id, and truncated title (≤18 chars). Edges = bezier curves
    prerequisite→dependent with arrowheads.
  - **Pan** (drag), **zoom** (wheel, cursor-anchored; clamp `0.18–2.4`), **fit-to-view** (auto on
    data/size change and via Fit button), and a zoom-control cluster (in / out / fit) bottom-right.
    Bottom-left mono readout: "NN% · drag to pan · scroll to zoom".
  - Status filter **dims** out-of-filter nodes (opacity ~.16) and their edges rather than removing
    them. A node click that wasn't a drag → opens the drawer.
- Empty scope → `GraphEmpty` placeholder.

### 5. Entity detail drawer (read-only)
Opens from any entity click, anchored right over a dimmed backdrop.
- **Backdrop**: `rgba(12,16,22,.42)`, click to close, fade in/out.
- **Panel**: `min(480px, 92vw)` wide, full height, `--bg`, left border, big left shadow. Slides in
  from the right (`drawer-in .26s cubic-bezier(.32,.72,0,1)`), slides out on close
  (`drawer-out .2s`). **Important:** the visible/open position is the *base* CSS state so the panel
  is never stuck off-screen if the entrance animation fails to fire; only the entrance translates
  *from* off-screen. Respect `prefers-reduced-motion`.
- **Sticky header**: optional Back button (shown when navigated deep) · `KIND` chip (Epic/Story/
  Task) · optional `archived` chip · spacer · Close (✕). Below: mono id, title (`19/600`, struck
  if archived), and the status badge.
- **Relations** (omit the whole section if none): `Parent`, `Depends on`, `Blocks` groups. Each is
  a label + wrapped **relation chips**. A chip = status dot + mono id + title; clicking a non-
  missing chip **navigates the drawer** to that entity. `missing` chips are disabled & faded.
- **Body**: GFM **Markdown** rendered read-only (via `marked`). Task-list checkboxes render but are
  **never interactive** (`cursor:default`, checked = `--done-ink` fill). Code/pre/blockquote/links
  styled per the `.md` rules in the HTML `<style>` block.
- **Metadata footer** (omit if empty): Created / Updated (formatted dates) / Estimate, plus mono
  tag pills.

## Interactions & Behavior
- **Navigation stack in the drawer**: relation chips push onto an internal stack; **Backspace** (or
  the Back button) pops; **Esc** closes. Scroll resets to top on entity change.
- **Keyboard**: `Esc` closes drawer; `Backspace` goes back when stack depth > 1.
- **Outside-click** closes the project picker and the graph scope popover.
- **Project switch** resets: closes the drawer, resets graph scope to full + all status filters on,
  re-registers the live subscription (and flashes the dot).
- **No mutation anywhere.** No optimistic updates, no PATCH/POST. Re-fetch on WebSocket ping only.

## State Management
Per the prototype (`App`), the state you need:
- `projectId` (selected project), `tab` (`board|ready|blocked|graph`).
- `collapsed`: `Set<id>` of collapsed epics/stories — **local view state**, ephemeral.
- `selectedId`: open drawer entity (null = closed). Drawer keeps its own **navigation stack**.
- `updatedAt` / `pulse`: live-indicator state, driven by the WebSocket.
- Graph-local: `mode`, `scope`, `active` status set, `fitToken`, `view {x,y,z}`.
- **Tweaks** (appearance prefs — see below): `dark`, `accent`, `density`, `font`, `showIds`.
- Derived data (`byId`, `readyTasks`, `blockedTasks`, counts, graph) is **memoized** from the
  board — never stored as independent state.

## Appearance preferences ("Tweaks")
The prototype exposes appearance controls via a dev-only "Tweaks" panel; in production these map to
**user/display preferences** (persist however you persist prefs):
- **Dark mode** (toggles `.dark` on `<html>`).
- **Accent** (`#7c5cff` / `#3b82f6` / `#10b981` / `#f97316`) → sets `--accent`.
- **Density** (`comfortable` / `compact`) → toggles `.density-compact`.
- **Font** (`Geist` / `IBM Plex` / `System UI`) → sets `--font-sans` / `--font-mono`.
- **Show entity ids** (toggle the mono id + separator throughout).

## Animations & transitions
| Name | Spec | Where |
|---|---|---|
| `drawer-in` | `translateX(100%)→0`, `.26s cubic-bezier(.32,.72,0,1)` | Drawer entrance |
| `drawer-out` | `0→translateX(100%)`, `.2s ease` | Drawer exit |
| `backdrop-in/out` | opacity, `.22s / .2s ease` | Drawer backdrop |
| `pulse-ring` | expanding accent box-shadow ring, `1.1s ease-out` | Live update ping |
| `fade-in` | opacity, `.12s ease` | Popovers |
| chevron | `transform .14s ease` (rotate to 90°/180°) | Tree toggles, dropdowns |
| graph node opacity | `.18s` | Status-filter dim |
All decorative animation is gated behind `@media (prefers-reduced-motion: no-preference)`.

## Annotated screenshots
Each view is captured with numbered callouts + an explanatory side panel in `screenshots/`:

| File | View |
|---|---|
| `01-board-annotated.png` | Board — Epic → Story → Task tree |
| `02-ready-annotated.png` | Ready — tasks workable now |
| `03-blocked-annotated.png` | Blocked — stored-blocked tasks + blockers |
| `04-graph-mermaid-annotated.png` | Graph — Mermaid (canonical) |
| `05-graph-interactive-annotated.png` | Graph — interactive pan/zoom SVG |
| `06-drawer-annotated.png` | Entity detail drawer (read-only) |

These show final colors, spacing, and layout — use them to match the visual intent alongside the
token tables above.

## Assets
No raster/image assets. All icons are **inline SVG** drawn in code (chevrons, close/back, padlock,
graph/node glyphs, zoom controls, empty-state glyphs). Fonts load from **Google Fonts** (Geist,
Geist Mono, IBM Plex Sans, IBM Plex Mono) — swap to your own font hosting/self-host in production.
Third-party libs in the prototype: `marked@12` (Markdown), `mermaid@10.9` (graph) — substitute your
codebase's equivalents if you have them.

## Files
Design reference sources (in `design_files/`):
- `Project Board.html` — entry point: CSS tokens, `.md` styles, animations, script load order.
- `data.js` — mock board data + the API shapes it stands in for (`PROJECTS`, `BOARDS`).
- `entities.js` — mock per-entity detail payloads (`ENTITY_META`) incl. Markdown bodies.
- `logic.js` — **all pure derived-view logic** (rollups, ready/blocked, graph build/layout,
  Mermaid). Port faithfully.
- `app.jsx` — shell, top bar, tabs, tree rows, Board/Ready/Blocked views, badges, Tweaks.
- `drawer.jsx` — read-only entity detail drawer + relation chips + Markdown render.
- `graph.jsx` — graph view: Mermaid mode, interactive pan/zoom SVG, toolbar, scope & filters.
- `tweaks-panel.jsx` — the dev-only appearance panel (maps to user prefs in production).

To run the prototype as-is: serve the folder over any static HTTP server and open
`Project Board.html` (it needs the sibling `.js`/`.jsx` files; opening via `file://` may be blocked
by CORS).
