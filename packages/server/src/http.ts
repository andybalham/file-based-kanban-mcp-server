import { createServer } from "node:http";
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import type { EffectiveStatus, Entity, EntityId, EntityType, ProjectId, ProjectState, ValidationIssue } from "@file-kanban/core";
import { buildDepGraph, validate } from "@file-kanban/core";

import { RegistryError } from "./registry.js";
import type { RegisteredProject } from "./registry.js";

/**
 * Read-only HTTP routes promised by §10 of the technical design.
 *
 * The concrete Node HTTP adapter will register these paths later. Keeping the route table
 * transport-neutral makes the public viewer surface testable before a socket listener exists.
 */
export const HTTP_ROUTE_DEFINITIONS = {
  projects: {
    key: "projects",
    method: "GET",
    path: "/api/projects",
    description: "List registered work-tracker projects for the viewer project picker.",
    mutates: false
  },
  graph: {
    key: "graph",
    method: "GET",
    path: "/api/:project/graph",
    description: "Return active entities and typed same-type dependency edges for one project.",
    mutates: false
  },
  entity: {
    key: "entity",
    method: "GET",
    path: "/api/:project/entity/:id",
    description: "Return one full entity payload with body Markdown and relationship ids.",
    mutates: false
  },
  board: {
    key: "board",
    method: "GET",
    path: "/api/:project/board",
    description: "Return the active epic-story-task hierarchy with computed effective statuses.",
    mutates: false
  },
  mermaid: {
    key: "mermaid",
    method: "GET",
    path: "/api/:project/mermaid/:view",
    description: "Return generated Mermaid text for the full dependency graph or one epic graph.",
    mutates: false
  },
  websocket: {
    key: "websocket",
    method: "WS",
    path: "/ws",
    description: "Accept per-project subscriptions and emit changed or reload events.",
    mutates: false
  }
} as const;

/**
 * Project-scoped WebSocket subscribe message sent by the browser after connecting to `/ws`.
 */
export interface HttpWebSocketSubscribeMessage {
  /** Project id whose change events should be delivered to this client connection. */
  subscribe: ProjectId;
}

/**
 * WebSocket message emitted after entity or generated artifact changes within one project.
 */
export interface HttpWebSocketChangedMessage {
  /** Discriminant used by the UI to refetch changed project views without guessing payload shape. */
  type: "changed";
  /** Project id whose in-memory state changed. */
  project: ProjectId;
  /** Entity ids known to have changed, or an empty list when only generated/read-model files changed. */
  ids: EntityId[];
}

/**
 * WebSocket message emitted when the selected project should be fully reloaded.
 */
export interface HttpWebSocketReloadMessage {
  /** Discriminant used when marker discovery or broad refresh means fine-grained ids are unavailable. */
  type: "reload";
  /** Project id whose viewer data should be refetched. */
  project: ProjectId;
}

/** Server-to-client WebSocket messages promised by the viewer API design. */
export type HttpWebSocketServerMessage = HttpWebSocketChangedMessage | HttpWebSocketReloadMessage;

/**
 * Broadcast surface used by later watcher and regeneration orchestration code.
 *
 * The concrete socket set is intentionally hidden behind project-scoped methods so file-watching
 * tasks cannot accidentally fan out one project's refresh notification to every browser tab.
 */
export interface HttpWebSocketBroadcaster {
  /** Emit a fine-grained changed event to clients subscribed to `projectId`. */
  broadcastChanged(projectId: ProjectId, ids?: EntityId[]): void;
  /** Emit a broad reload event to clients subscribed to `projectId`. */
  broadcastReload(projectId: ProjectId): void;
}

/**
 * HTTP server returned by the viewer adapter.
 *
 * It remains a normal Node HTTP server for listen/close semantics, with the project-scoped
 * broadcast hooks attached for server-side change producers.
 */
export type HttpViewerServer = NodeHttpServer & HttpWebSocketBroadcaster;

/** One key in {@link HTTP_ROUTE_DEFINITIONS}. */
export type HttpRouteKey = keyof typeof HTTP_ROUTE_DEFINITIONS;

/** HTTP method or WebSocket pseudo-method used by the route definition table. */
export type HttpRouteMethod = "GET" | "WS";

/**
 * Narrow registry surface needed by read-only HTTP projections.
 *
 * The full `ProjectRegistry` satisfies this interface, but tests can provide a small fake registry
 * without importing watcher, stdio, or server startup concerns.
 */
export interface HttpViewerRegistry {
  /** Return deterministic project summaries for `GET /api/projects`. */
  listProjects(): RegisteredProject[];
  /** Resolve a project id, raising structured registry errors for unknown or ambiguous selection. */
  resolveProject(projectId?: ProjectId): ProjectState;
}

/**
 * Optional filesystem settings for the concrete viewer HTTP adapter.
 */
export interface CreateHttpRequestHandlerOptions {
  /**
   * Directory containing the Vite-built read-only React viewer.
   *
   * The default points at `packages/ui/dist` from the compiled server package, matching the
   * workspace layout required by the technical design while still letting tests inject a temp tree.
   */
  staticRoot?: string;
}

/**
 * Minimal request handler shape used by Node's `http.createServer`.
 *
 * The implementation returns a promise so tests can await route logic directly if needed, while
 * Node is free to ignore the returned promise when it invokes the handler for real sockets.
 */
export type HttpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * HTTP-friendly error raised by the read-side contract helpers.
 *
 * Future transport code can map this directly to status code and JSON body while preserving a
 * machine-readable `code` for UI and integration tests.
 */
export class HttpAdapterError extends Error {
  /** HTTP response status that should be sent by the concrete adapter. */
  readonly status: number;

  /** Stable machine-readable error code for the viewer API. */
  readonly code: string;

  /** Optional structured context that can be serialized in the JSON error body. */
  readonly details?: unknown;

  /**
   * Create a structured read-side error.
   */
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpAdapterError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Public response body for `GET /api/projects`.
 *
 * The design names the body as a bare array rather than an envelope, so the helper returns exactly
 * the deterministic registry list.
 */
export type HttpProjectsResponse = RegisteredProject[];

/**
 * Create the concrete read-only HTTP request handler for the viewer API.
 *
 * This is intentionally small and framework-free because the design allows a minimal Node HTTP
 * adapter. All project state and status computation still flows through the transport-neutral
 * helpers below, which keeps the public API contract testable without opening sockets.
 */
export function createHttpRequestHandler(
  registry: HttpViewerRegistry,
  options: CreateHttpRequestHandlerOptions = {}
): HttpRequestHandler {
  const staticRoot = path.resolve(options.staticRoot ?? defaultStaticRoot());

  return async (request, response) => {
    try {
      if (request.method !== "GET") {
        writeJson(response, 405, {
          code: "METHOD_NOT_ALLOWED",
          message: "The viewer API is read-only and accepts GET requests only."
        });
        return;
      }

      const route = parseHttpRoute(request);

      if (route === null) {
        if (isApiRequest(request)) {
          writeJson(response, 404, {
            code: "NOT_FOUND",
            message: "Viewer API route was not found."
          });
          return;
        }

        await serveStaticViewerAsset(request, response, staticRoot);
        return;
      }

      switch (route.kind) {
        case "projects":
          writeJson(response, 200, listHttpProjects(registry));
          return;
        case "graph":
          writeJson(response, 200, getHttpGraph(registry, route.projectId));
          return;
        case "entity":
          writeJson(response, 200, getHttpEntity(registry, route.projectId, route.id));
          return;
        case "board":
          writeJson(response, 200, getHttpBoard(registry, route.projectId));
          return;
        case "mermaid":
          writeText(response, 200, await getHttpMermaid(registry, route.projectId, route.view), "text/plain; charset=utf-8");
          return;
      }
    } catch (error) {
      const { status, body } = toHttpErrorBody(error);
      writeJson(response, status, body);
    }
  };
}

/**
 * Create a Node HTTP server that exposes only the project-scoped read endpoints.
 *
 * The same listener owns `/ws` upgrades for live viewer notifications. Browser clients subscribe
 * by sending `{ "subscribe": "<projectId>" }`; server-side producers call the attached broadcast
 * methods to deliver `changed` or `reload` messages only to clients for that project.
 */
export function createHttpServer(
  registry: HttpViewerRegistry,
  options: CreateHttpRequestHandlerOptions = {}
): HttpViewerServer {
  const handler = createHttpRequestHandler(registry, options);
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      const { status, body } = toHttpErrorBody(error);
      writeJson(response, status, body);
    });
  });

  const websocketHub = attachHttpWebSocketHub(server, registry);
  return Object.assign(server, websocketHub);
}

/**
 * Compact entity row shared by graph, board, and relationship views.
 */
export interface HttpEntityView {
  /** Authoritative entity id from frontmatter. */
  id: EntityId;
  /** Entity layer used by the UI for grouping and filtering. */
  type: EntityType;
  /** Human-readable title from frontmatter. */
  title: string;
  /** Parent id for hierarchy navigation, or null for epics. */
  parent: EntityId | null;
  /** Stored status for tasks, retained so the UI can distinguish persisted task state from rollups. */
  status: Entity["status"];
  /** Computed status from the core resolver, including blocked and empty rollups. */
  effectiveStatus: EffectiveStatus;
  /** Same-type dependency ids declared by this entity. */
  dependsOn: EntityId[];
  /** Same-type dependent ids that point at this entity. */
  dependents: EntityId[];
  /** Optional estimate used by task critical-path and display surfaces. */
  estimate?: number;
  /** Tags copied from frontmatter for display and filtering. */
  tags: string[];
  /** Soft-delete marker; active collection views omit archived entities. */
  archived: boolean;
  /** Project-relative or absolute entity file path retained for diagnostics and linking. */
  filePath: string;
}

/**
 * One typed dependency edge returned by `GET /api/:project/graph`.
 */
export interface HttpGraphEdge {
  /** Dependent entity that declares the edge. */
  from: EntityId;
  /** Prerequisite entity required before `from` can proceed. */
  to: EntityId;
  /** Entity type shared by both ends of this same-type dependency edge. */
  type: EntityType;
}

/**
 * Response body for the interactive graph endpoint.
 */
export interface HttpGraphResponse {
  /** Active non-archived entity nodes in deterministic id order. */
  entities: HttpEntityView[];
  /** Active same-type dependency edges in deterministic type/from/to order. */
  edges: HttpGraphEdge[];
}

/**
 * Full drawer payload for `GET /api/:project/entity/:id`.
 */
export interface HttpEntityDetailResponse extends HttpEntityView {
  /** Human-authored Markdown body preserved from the entity file. */
  body: string;
  /** Creation timestamp from frontmatter. */
  created: string;
  /** Last semantic update timestamp from frontmatter. */
  updated: string;
}

/**
 * Progress summary used by the board for epics and stories.
 */
export interface HttpBoardProgress {
  /** Number of non-archived descendant tasks effectively done. */
  done: number;
  /** Number of non-archived descendant tasks included in the rollup. */
  total: number;
}

/**
 * Shared fields for active board nodes.
 */
export interface HttpBoardNodeBase {
  /** Authoritative entity id. */
  id: EntityId;
  /** Entity layer used by the viewer row renderer. */
  type: EntityType;
  /** Human-readable row title. */
  title: string;
  /** Computed effective status from the selected project state. */
  effectiveStatus: EffectiveStatus;
  /** Dependency or propagated gate ids explaining a blocked status. */
  blockedBy: EntityId[];
  /** Descendant task progress for row meters. */
  progress: HttpBoardProgress;
}

/** Active task node in the board hierarchy. */
export interface HttpBoardTask extends HttpBoardNodeBase {
  /** Task rows are always leaf nodes. */
  type: "task";
  /** Persisted task status before dependency and ancestor gates are applied. */
  status: Entity["status"];
  /** Same-type task dependencies displayed as prerequisite chips. */
  dependsOn: EntityId[];
  /** Task estimates are optional and omitted when absent. */
  estimate?: number;
  /** Tags copied for viewer filters and detail affordances. */
  tags: string[];
}

/** Active story node in the board hierarchy. */
export interface HttpBoardStory extends HttpBoardNodeBase {
  /** Story rows contain active task children. */
  type: "story";
  /** Active task children sorted by id. */
  children: HttpBoardTask[];
}

/** Active epic node in the board hierarchy. */
export interface HttpBoardEpic extends HttpBoardNodeBase {
  /** Epic rows contain active story children. */
  type: "epic";
  /** Active story children sorted by id. */
  children: HttpBoardStory[];
}

/** Response body for the hierarchical board endpoint. */
export interface HttpBoardResponse {
  /** Active top-level epics sorted by id. */
  epics: HttpBoardEpic[];
  /**
   * Non-blocking integrity findings returned by `validate()`.
   *
   * Errors should not survive into a routable project state, but warnings are explicitly allowed by
   * the design and must be visible to humans in the read-only viewer.
   */
  validationWarnings?: ValidationIssue[];
}

/**
 * Return the project picker response exactly as `GET /api/projects` should serialize it.
 */
export function listHttpProjects(registry: HttpViewerRegistry): HttpProjectsResponse {
  return registry.listProjects();
}

/**
 * Build the active dependency graph response for a selected project.
 */
export function getHttpGraph(registry: HttpViewerRegistry, projectId: ProjectId): HttpGraphResponse {
  const project = resolveHttpProject(registry, projectId);
  const entities = activeEntities(project).map((entity) => entityView(project, entity));
  const edges = dependencyEdges(project);

  return { entities, edges };
}

/**
 * Build one full entity drawer payload for a selected project.
 *
 * Direct entity reads intentionally include archived entities because archival is a soft delete and
 * existing links should remain inspectable even when active collection views omit the row.
 */
export function getHttpEntity(
  registry: HttpViewerRegistry,
  projectId: ProjectId,
  id: EntityId
): HttpEntityDetailResponse {
  const project = resolveHttpProject(registry, projectId);
  const entity = project.index.byId.get(id);

  if (entity === undefined) {
    throw new HttpAdapterError(404, "NOT_FOUND", `Entity '${id}' was not found.`, { projectId, id });
  }

  return {
    ...entityView(project, entity),
    body: entity.body,
    created: entity.created,
    updated: entity.updated
  };
}

/**
 * Build the active epic -> story -> task board response for a selected project.
 */
export function getHttpBoard(registry: HttpViewerRegistry, projectId: ProjectId): HttpBoardResponse {
  const project = resolveHttpProject(registry, projectId);
  const epics = childEntities(project, null, "epic").map((epic) => epicBoardNode(project, epic));
  const warnings = validate(project.index).warnings;

  return {
    epics,
    ...(warnings.length === 0 ? {} : { validationWarnings: warnings })
  };
}

/**
 * Read generated Mermaid text for the selected project and design view.
 *
 * `dependencies` maps to `.worktracker/graphs/dependencies.mmd`; `epic/<id>` maps to the generated
 * per-epic graph file. This helper stays read-only and does not regenerate missing artifacts.
 */
export async function getHttpMermaid(
  registry: HttpViewerRegistry,
  projectId: ProjectId,
  view: string
): Promise<string> {
  const project = resolveHttpProject(registry, projectId);
  const filePath = mermaidFilePath(project, view);

  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new HttpAdapterError(404, "NOT_FOUND", `Mermaid view '${view}' was not found.`, {
        projectId,
        view,
        filePath
      });
    }

    throw error;
  }
}

/**
 * Attach a no-server WebSocket endpoint to the existing HTTP listener.
 *
 * Keeping the WebSocket server in `noServer` mode makes `/ws` an explicit member of the viewer API
 * surface instead of accepting upgrades on arbitrary HTTP paths.
 */
function attachHttpWebSocketHub(server: NodeHttpServer, registry: HttpViewerRegistry): HttpWebSocketBroadcaster {
  const websocketServer = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, ProjectId>();

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    if (pathname !== HTTP_ROUTE_DEFINITIONS.websocket.path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    websocket.on("message", (data) => {
      const subscribeMessage = parseWebSocketSubscribeMessage(data);

      if (subscribeMessage === null) {
        websocket.close(1008, "Expected JSON subscribe message.");
        return;
      }

      try {
        registry.resolveProject(subscribeMessage.subscribe);
        subscriptions.set(websocket, subscribeMessage.subscribe);
      } catch {
        websocket.close(1008, "Unknown project subscription.");
      }
    });

    websocket.on("close", () => {
      subscriptions.delete(websocket);
    });
  });

  server.on("close", () => {
    for (const websocket of websocketServer.clients) {
      websocket.terminate();
    }

    websocketServer.close();
    subscriptions.clear();
  });

  return {
    broadcastChanged(projectId, ids = []) {
      broadcastToProject(subscriptions, projectId, {
        type: "changed",
        project: projectId,
        ids: [...ids].sort((a, b) => a.localeCompare(b))
      });
    },
    broadcastReload(projectId) {
      broadcastToProject(subscriptions, projectId, {
        type: "reload",
        project: projectId
      });
    }
  };
}

/**
 * Parse and validate the single client-to-server WebSocket control message supported by v1.
 */
function parseWebSocketSubscribeMessage(data: WebSocket.RawData): HttpWebSocketSubscribeMessage | null {
  try {
    const parsed = JSON.parse(data.toString());

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { subscribe?: unknown }).subscribe === "string" &&
      (parsed as { subscribe: string }).subscribe.length > 0
    ) {
      return { subscribe: (parsed as { subscribe: ProjectId }).subscribe };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Send one serialized message to live clients subscribed to exactly one project.
 */
function broadcastToProject(
  subscriptions: Map<WebSocket, ProjectId>,
  projectId: ProjectId,
  message: HttpWebSocketServerMessage
): void {
  const serialized = JSON.stringify(message);

  for (const [websocket, subscribedProjectId] of subscriptions) {
    if (subscribedProjectId === projectId && websocket.readyState === WebSocket.OPEN) {
      websocket.send(serialized);
    }
  }
}

/**
 * Convert an arbitrary thrown error into the JSON body a concrete HTTP adapter should send.
 */
export function toHttpErrorBody(error: unknown): { status: number; body: { code: string; message: string; details?: unknown } } {
  if (error instanceof HttpAdapterError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }

  if (error instanceof RegistryError) {
    const status = error.code === "PROJECT_NOT_FOUND" ? 404 : 400;
    return {
      status,
      body: {
        code: error.code,
        message: error.message,
        ...(error.projectId === undefined ? {} : { details: { projectId: error.projectId } })
      }
    };
  }

  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown server error."
    }
  };
}

/**
 * Resolve a project and translate registry selection failures into HTTP adapter errors.
 */
function resolveHttpProject(registry: HttpViewerRegistry, projectId: ProjectId): ProjectState {
  try {
    return registry.resolveProject(projectId);
  } catch (error) {
    const converted = toHttpErrorBody(error);
    throw new HttpAdapterError(converted.status, converted.body.code, converted.body.message, converted.body.details);
  }
}

/**
 * Create a compact entity view with computed status and reverse dependency ids.
 */
function entityView(project: ProjectState, entity: Entity): HttpEntityView {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    parent: entity.parent,
    status: entity.status,
    effectiveStatus: project.eff.get(entity.id) ?? "empty",
    dependsOn: [...entity.dependsOn].sort((a, b) => a.localeCompare(b)),
    dependents: dependentsOf(project, entity).map((dependent) => dependent.id),
    ...(entity.estimate === undefined ? {} : { estimate: entity.estimate }),
    tags: [...entity.tags].sort((a, b) => a.localeCompare(b)),
    archived: entity.archived,
    filePath: entity.filePath
  };
}

/**
 * Return active entities in deterministic id order for collection views.
 */
function activeEntities(project: ProjectState): Entity[] {
  return [...project.index.byId.values()]
    .filter((entity) => !entity.archived)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Return active same-type dependency edges across all three entity layers.
 */
function dependencyEdges(project: ProjectState): HttpGraphEdge[] {
  const edges: HttpGraphEdge[] = [];

  for (const type of ["epic", "story", "task"] as const) {
    const graph = buildDepGraph(activeIndex(project), type);

    for (const from of graph.nodes) {
      for (const to of graph.dependenciesOf.get(from) ?? []) {
        edges.push({ from, to, type });
      }
    }
  }

  return edges.sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to)
  );
}

/**
 * Build an index-like structure containing only active entities for active graph projections.
 */
function activeIndex(project: ProjectState): ProjectState["index"] {
  const byId = new Map<EntityId, Entity>();
  const childrenOf = new Map<EntityId, EntityId[]>();

  for (const entity of activeEntities(project)) {
    byId.set(entity.id, entity);

    if (entity.parent !== null && !isArchived(project, entity.parent)) {
      const children = childrenOf.get(entity.parent) ?? [];
      children.push(entity.id);
      children.sort((a, b) => a.localeCompare(b));
      childrenOf.set(entity.parent, children);
    }
  }

  return { byId, childrenOf };
}

/**
 * Return active same-type entities that depend on the supplied entity.
 */
function dependentsOf(project: ProjectState, entity: Entity): Entity[] {
  return activeEntities(project).filter(
    (candidate) => candidate.type === entity.type && candidate.dependsOn.includes(entity.id)
  );
}

/**
 * Build one epic board node and recursively attach active stories.
 */
function epicBoardNode(project: ProjectState, epic: Entity): HttpBoardEpic {
  return {
    ...boardNodeBase(project, epic),
    type: "epic",
    children: childEntities(project, epic.id, "story").map((story) => storyBoardNode(project, story))
  };
}

/**
 * Build one story board node and recursively attach active tasks.
 */
function storyBoardNode(project: ProjectState, story: Entity): HttpBoardStory {
  return {
    ...boardNodeBase(project, story),
    type: "story",
    children: childEntities(project, story.id, "task").map((task) => taskBoardNode(project, task))
  };
}

/**
 * Build one active task board leaf.
 */
function taskBoardNode(project: ProjectState, task: Entity): HttpBoardTask {
  return {
    ...boardNodeBase(project, task),
    type: "task",
    status: task.status,
    dependsOn: [...task.dependsOn].sort((a, b) => a.localeCompare(b)),
    ...(task.estimate === undefined ? {} : { estimate: task.estimate }),
    tags: [...task.tags].sort((a, b) => a.localeCompare(b))
  };
}

/**
 * Build board fields shared across every hierarchy layer.
 */
function boardNodeBase(project: ProjectState, entity: Entity): HttpBoardNodeBase {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    effectiveStatus: project.eff.get(entity.id) ?? "empty",
    blockedBy: blockerIds(project, entity),
    progress: progress(project, entity)
  };
}

/**
 * Return active children of a parent in deterministic id order.
 */
function childEntities(project: ProjectState, parentId: EntityId | null, type: EntityType): Entity[] {
  return [...project.index.byId.values()]
    .filter((entity) => entity.parent === parentId && entity.type === type && !entity.archived)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Compute non-archived descendant task progress for a board node.
 */
function progress(project: ProjectState, entity: Entity): HttpBoardProgress {
  const tasks = descendantTasks(project, entity);

  return {
    done: tasks.filter((task) => project.eff.get(task.id) === "done").length,
    total: tasks.length
  };
}

/**
 * Return the active task descendants for any board entity.
 */
function descendantTasks(project: ProjectState, entity: Entity): Entity[] {
  if (entity.type === "task") {
    return entity.archived ? [] : [entity];
  }

  const children = [...project.index.byId.values()]
    .filter((candidate) => candidate.parent === entity.id && !candidate.archived)
    .sort((a, b) => a.id.localeCompare(b.id));

  return children.flatMap((child) => descendantTasks(project, child));
}

/**
 * Return dependency ids that explain an entity's blocked status.
 *
 * Own incomplete same-type dependencies are preferred. When the entity is blocked only by downward
 * propagation, the nearest dependency-gated ancestor is returned so the UI can show the gate.
 */
function blockerIds(project: ProjectState, entity: Entity): EntityId[] {
  if (project.eff.get(entity.id) !== "blocked") {
    return [];
  }

  const ownBlockers = ownIncompleteDependencies(project, entity);
  if (ownBlockers.length > 0) {
    return ownBlockers;
  }

  const ancestor = nearestDependencyGatedAncestor(project, entity);
  return ancestor === null ? [] : [ancestor.id];
}

/**
 * Return same-type dependencies that are still active and not effectively done.
 */
function ownIncompleteDependencies(project: ProjectState, entity: Entity): EntityId[] {
  return entity.dependsOn
    .filter((dependencyId) => {
      const dependency = project.index.byId.get(dependencyId);
      return (
        dependency !== undefined &&
        !dependency.archived &&
        dependency.type === entity.type &&
        project.eff.get(dependencyId) !== "done"
      );
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Find the nearest active ancestor whose own dependency gate explains propagated blocking.
 */
function nearestDependencyGatedAncestor(project: ProjectState, entity: Entity): Entity | null {
  let parentId = entity.parent;

  while (parentId !== null) {
    const parent = project.index.byId.get(parentId);
    if (parent === undefined || parent.archived) {
      return null;
    }

    if (project.eff.get(parent.id) === "blocked" && ownIncompleteDependencies(project, parent).length > 0) {
      return parent;
    }

    parentId = parent.parent;
  }

  return null;
}

/**
 * Return whether an id is known and archived.
 */
function isArchived(project: ProjectState, id: EntityId): boolean {
  return project.index.byId.get(id)?.archived === true;
}

/**
 * Resolve the generated Mermaid file path for a route `:view` value.
 */
function mermaidFilePath(project: ProjectState, view: string): string {
  if (view === "dependencies") {
    return path.join(project.root, ".worktracker", "graphs", "dependencies.mmd");
  }

  if (view.startsWith("epic/")) {
    const epicId = view.slice("epic/".length);
    if (epicId.length > 0) {
      return path.join(project.root, ".worktracker", "graphs", `${epicId}.mmd`);
    }
  }

  throw new HttpAdapterError(404, "NOT_FOUND", `Mermaid view '${view}' was not found.`, {
    projectId: project.projectId,
    view
  });
}

/**
 * Narrow unknown filesystem errors to Node errors with a stable `code` field.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Resolve the built UI output directory from the compiled server module location.
 */
function defaultStaticRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

/**
 * Return whether a request path is intended for the JSON viewer API.
 */
function isApiRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Serve the Vite-built viewer shell or one of its static assets.
 *
 * Unknown extensionless routes fall back to `index.html` so the browser app can own client-side
 * routing. Extension-bearing misses return a normal 404 to avoid disguising broken asset links.
 */
async function serveStaticViewerAsset(
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string
): Promise<void> {
  const requestedPath = staticRequestPath(request);
  const assetPath = path.resolve(staticRoot, `.${requestedPath}`);

  if (!isPathInside(staticRoot, assetPath)) {
    writeText(response, 403, "Forbidden\n", "text/plain; charset=utf-8");
    return;
  }

  const filePath = await existingStaticFilePath(staticRoot, assetPath, requestedPath);

  if (filePath === null) {
    writeText(response, 404, "Not found\n", "text/plain; charset=utf-8");
    return;
  }

  const body = await fs.readFile(filePath);
  writeBinary(response, 200, body, contentTypeForPath(filePath));
}

/**
 * Decode the URL pathname into a normalized absolute-style request path for static lookup.
 */
function staticRequestPath(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const decoded = decodeURIComponent(pathname);
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/**
 * Resolve a real asset path or SPA fallback path without rewriting missing compiled assets.
 */
async function existingStaticFilePath(staticRoot: string, assetPath: string, requestedPath: string): Promise<string | null> {
  const directPath = await readableFilePath(assetPath);
  if (directPath !== null) {
    return directPath;
  }

  if (path.extname(requestedPath) !== "") {
    return null;
  }

  return readableFilePath(path.join(staticRoot, "index.html"));
}

/**
 * Return the path only when it exists and is a regular file.
 */
async function readableFilePath(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? filePath : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * Verify a resolved path remains under the configured static root.
 */
function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Map the small set of Vite asset extensions the viewer currently emits to browser MIME types.
 */
function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * Parsed viewer API route variants understood by the read-only request handler.
 */
type ParsedHttpRoute =
  | { kind: "projects" }
  | { kind: "graph"; projectId: ProjectId }
  | { kind: "entity"; projectId: ProjectId; id: EntityId }
  | { kind: "board"; projectId: ProjectId }
  | { kind: "mermaid"; projectId: ProjectId; view: string };

/**
 * Match a URL path against the exact Phase 6 viewer API surface.
 *
 * The Mermaid route deliberately captures all remaining path segments after `/mermaid/` so
 * `/api/:project/mermaid/epic/:id` maps to the design's logical `epic/:id` view value.
 */
function parseHttpRoute(request: IncomingMessage): ParsedHttpRoute | null {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const segments = pathname.split("/").filter((segment) => segment.length > 0).map(decodeURIComponent);

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "projects") {
    return { kind: "projects" };
  }

  if (segments.length < 3 || segments[0] !== "api") {
    return null;
  }

  const projectId = segments[1] as ProjectId;
  const resource = segments[2];

  if (segments.length === 3 && resource === "graph") {
    return { kind: "graph", projectId };
  }

  if (segments.length === 3 && resource === "board") {
    return { kind: "board", projectId };
  }

  if (segments.length === 4 && resource === "entity") {
    return { kind: "entity", projectId, id: segments[3] as EntityId };
  }

  if (segments.length >= 4 && resource === "mermaid") {
    return { kind: "mermaid", projectId, view: segments.slice(3).join("/") };
  }

  return null;
}

/**
 * Serialize a JSON response body with deterministic viewer API headers.
 */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  writeText(response, status, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

/**
 * Finish a text response unless another error path has already written headers.
 */
function writeText(response: ServerResponse, status: number, body: string, contentType: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

/**
 * Finish a static asset response with the same conservative cache policy as JSON during v1.
 */
function writeBinary(response: ServerResponse, status: number, body: Buffer, contentType: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(body);
}
