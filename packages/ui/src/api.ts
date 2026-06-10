/**
 * Typed read-only API client for the React viewer.
 *
 * The UI package deliberately does not import `@file-kanban/core` or server internals. These types
 * mirror the public HTTP/WS contract from the technical design and from `packages/server/src/http.ts`,
 * keeping the browser coupled only to the transport surface it is allowed to read from.
 */
export type ProjectId = string;

/** Authoritative entity id surfaced by the read API. */
export type EntityId = string;

/** Entity layers shown by the board and graph views. */
export type EntityType = "epic" | "story" | "task";

/** Persisted task status; epics and stories expose this only as a transport compatibility field. */
export type StoredStatus = "todo" | "in-progress" | "done";

/** Computed status after dependency and hierarchy gates are applied by the server. */
export type EffectiveStatus = StoredStatus | "blocked" | "empty";

/** Project summary used by the top-level project picker. */
export interface ProjectSummary {
  /** Immutable project id copied from `.worktracker/project.json`. */
  projectId: ProjectId;
  /** Human-readable project title from the project marker. */
  title: string;
  /** Filesystem root shown as read-only context for humans. */
  root: string;
}

/** Common graph and drawer entity shape returned by the HTTP read model. */
export interface EntityView {
  /** Stable id used for navigation, dependency chips, and graph nodes. */
  id: EntityId;
  /** Layer of the entity in the epic -> story -> task hierarchy. */
  type: EntityType;
  /** Human-readable title from frontmatter. */
  title: string;
  /** Parent id, or null for epics. */
  parent: EntityId | null;
  /** Stored task status, retained so task rows can distinguish stored state from computed state. */
  status: StoredStatus;
  /** Computed status from the server's core status resolver. */
  effectiveStatus: EffectiveStatus;
  /** Same-type prerequisites declared by this entity. */
  dependsOn: EntityId[];
  /** Same-type dependents that point at this entity. */
  dependents: EntityId[];
  /** Optional task estimate copied from frontmatter. */
  estimate?: number;
  /** Sorted tag list copied from frontmatter. */
  tags: string[];
  /** Soft-delete marker; collection endpoints normally omit archived entities. */
  archived: boolean;
  /** Entity file path retained for diagnostics and future read-only links. */
  filePath: string;
}

/** Typed dependency edge returned by `/api/:project/graph`. */
export interface GraphEdge {
  /** Dependent entity that declares the dependency. */
  from: EntityId;
  /** Prerequisite entity that must complete first. */
  to: EntityId;
  /** Same entity type shared by both endpoints. */
  type: EntityType;
}

/** Response body for the graph endpoint. */
export interface GraphResponse {
  /** Active nodes in deterministic server order. */
  entities: EntityView[];
  /** Same-type dependency edges in deterministic server order. */
  edges: GraphEdge[];
}

/** Full entity detail payload used by the future read-only drawer. */
export interface EntityDetail extends EntityView {
  /** Human-authored Markdown body, rendered read-only by the UI. */
  body: string;
  /** Creation timestamp copied from frontmatter. */
  created: string;
  /** Last semantic update timestamp copied from frontmatter. */
  updated: string;
}

/** Progress rollup used by epic and story rows. */
export interface BoardProgress {
  /** Completed non-archived descendant tasks. */
  done: number;
  /** Total non-archived descendant tasks. */
  total: number;
}

/** Fields shared by every board hierarchy node. */
export interface BoardNodeBase {
  /** Stable entity id. */
  id: EntityId;
  /** Entity layer used by row indentation and labels. */
  type: EntityType;
  /** Human-readable title. */
  title: string;
  /** Computed status from the server. */
  effectiveStatus: EffectiveStatus;
  /** Dependency or ancestor gate ids explaining a blocked status. */
  blockedBy: EntityId[];
  /** Descendant task completion summary. */
  progress: BoardProgress;
}

/** Active task leaf in the board hierarchy. */
export interface BoardTask extends BoardNodeBase {
  /** Task nodes are leaves. */
  type: "task";
  /** Persisted task status before computed dependency gates are applied. */
  status: StoredStatus;
  /** Same-type task dependencies. */
  dependsOn: EntityId[];
  /** Optional estimate displayed by later task detail surfaces. */
  estimate?: number;
  /** Tags copied from the entity frontmatter. */
  tags: string[];
}

/** Active story node containing task children. */
export interface BoardStory extends BoardNodeBase {
  /** Story nodes group tasks. */
  type: "story";
  /** Active task children sorted by id. */
  children: BoardTask[];
}

/** Active epic node containing story children. */
export interface BoardEpic extends BoardNodeBase {
  /** Epic nodes sit at the top of the board. */
  type: "epic";
  /** Active story children sorted by id. */
  children: BoardStory[];
}

/** Hierarchical board endpoint response. */
export interface BoardResponse {
  /** Active epics sorted by id. */
  epics: BoardEpic[];
}

/** Server-to-browser change notification from `/ws`. */
export type ViewerWebSocketMessage =
  | {
      /** Fine-grained entity/generated-artifact change. */
      type: "changed";
      /** Project whose read model changed. */
      project: ProjectId;
      /** Entity ids known to have changed, sorted by the server. */
      ids: EntityId[];
    }
  | {
      /** Broad project refresh, usually after discovery or external edits. */
      type: "reload";
      /** Project whose read model should be refetched. */
      project: ProjectId;
    };

/** Fetch implementation shape, injectable so tests can verify paths without opening a browser. */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Browser WebSocket constructor shape, injectable for deterministic subscription tests. */
type WebSocketConstructor = new (url: string | URL, protocols?: string | string[]) => WebSocket;

/** Optional dependencies for the viewer client. */
export interface ViewerApiClientOptions {
  /** API origin or base path; defaults to the current browser origin. */
  baseUrl?: string;
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** WebSocket constructor; defaults to `globalThis.WebSocket` when available. */
  WebSocketCtor?: WebSocketConstructor;
}

/** Callbacks for a project-scoped WebSocket subscription. */
export interface ProjectSubscriptionHandlers {
  /** Invoked for each valid server change/reload message. */
  onMessage(message: ViewerWebSocketMessage): void;
  /** Invoked after the socket opens and the subscribe command has been sent. */
  onOpen?(): void;
  /** Invoked when the socket closes, including expected teardown. */
  onClose?(event: CloseEvent): void;
  /** Invoked for transport errors. */
  onError?(event: Event): void;
}

/** Disposable subscription handle returned by `subscribeToProject`. */
export interface ProjectSubscription {
  /** Close the underlying socket and prevent future events from this subscription. */
  close(): void;
}

/** Public read-only viewer client used by React components. */
export interface ViewerApiClient {
  /** Fetch project summaries for the picker. */
  listProjects(signal?: AbortSignal): Promise<ProjectSummary[]>;
  /** Fetch the active board hierarchy for one project. */
  getBoard(projectId: ProjectId, signal?: AbortSignal): Promise<BoardResponse>;
  /** Fetch the active dependency graph for one project. */
  getGraph(projectId: ProjectId, signal?: AbortSignal): Promise<GraphResponse>;
  /** Fetch one entity detail payload for the read-only drawer. */
  getEntity(projectId: ProjectId, entityId: EntityId, signal?: AbortSignal): Promise<EntityDetail>;
  /** Fetch generated Mermaid text for the full graph or a per-epic graph. */
  getMermaid(projectId: ProjectId, view: string, signal?: AbortSignal): Promise<string>;
  /** Subscribe to project-scoped live updates and return a teardown handle. */
  subscribeToProject(projectId: ProjectId, handlers: ProjectSubscriptionHandlers): ProjectSubscription;
}

/** Structured error emitted for non-2xx HTTP responses and malformed API payloads. */
export class ViewerApiError extends Error {
  /** HTTP status code when a response reached the browser. */
  readonly status: number;

  /** Stable machine-readable error code from the server error envelope when present. */
  readonly code: string;

  /** Optional server-supplied details object. */
  readonly details?: unknown;

  /** Create a browser-side API error with the server contract preserved. */
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ViewerApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Create a read-only client for the server viewer API.
 *
 * The returned object intentionally exposes only GET endpoints plus a WebSocket subscription.
 * There are no mutation helpers here, which makes accidental browser write paths harder to add.
 */
export function createViewerApiClient(options: ViewerApiClientOptions = {}): ViewerApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);

  if (fetchImpl === undefined) {
    throw new Error("A fetch implementation is required to create the viewer API client.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return {
    listProjects(signal) {
      return fetchJson<ProjectSummary[]>(fetchImpl, urlFor(baseUrl, "/api/projects"), signal);
    },
    getBoard(projectId, signal) {
      return fetchJson<BoardResponse>(fetchImpl, urlFor(baseUrl, `/api/${encodePath(projectId)}/board`), signal);
    },
    getGraph(projectId, signal) {
      return fetchJson<GraphResponse>(fetchImpl, urlFor(baseUrl, `/api/${encodePath(projectId)}/graph`), signal);
    },
    getEntity(projectId, entityId, signal) {
      return fetchJson<EntityDetail>(
        fetchImpl,
        urlFor(baseUrl, `/api/${encodePath(projectId)}/entity/${encodePath(entityId)}`),
        signal
      );
    },
    getMermaid(projectId, view, signal) {
      return fetchText(fetchImpl, urlFor(baseUrl, `/api/${encodePath(projectId)}/mermaid/${encodeView(view)}`), signal);
    },
    subscribeToProject(projectId, handlers) {
      return subscribeToProject(baseUrl, projectId, handlers, options.WebSocketCtor);
    }
  };
}

/**
 * Fetch JSON and translate server envelopes into `ViewerApiError`.
 */
async function fetchJson<T>(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchImpl(url, { method: "GET", signal, headers: { accept: "application/json" } });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return (await response.json()) as T;
}

/**
 * Fetch text endpoints such as generated Mermaid without trying to parse them as JSON.
 */
async function fetchText(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchImpl(url, { method: "GET", signal, headers: { accept: "text/plain" } });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response.text();
}

/**
 * Preserve the server's structured error fields when the response body follows the API envelope.
 */
async function errorFromResponse(response: Response): Promise<ViewerApiError> {
  try {
    const parsed = (await response.json()) as { code?: unknown; message?: unknown; details?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : "HTTP_ERROR";
    const message = typeof parsed.message === "string" ? parsed.message : response.statusText;
    return new ViewerApiError(response.status, code, message, parsed.details);
  } catch {
    return new ViewerApiError(response.status, "HTTP_ERROR", response.statusText);
  }
}

/**
 * Subscribe to project-scoped live updates.
 *
 * The first socket message is always the subscribe command required by the server. Incoming
 * messages are ignored after `close()` so a late event cannot update an unmounted React tree.
 */
function subscribeToProject(
  baseUrl: string,
  projectId: ProjectId,
  handlers: ProjectSubscriptionHandlers,
  WebSocketCtor?: WebSocketConstructor
): ProjectSubscription {
  const SocketCtor = WebSocketCtor ?? globalThis.WebSocket;

  if (SocketCtor === undefined) {
    throw new Error("A WebSocket implementation is required for live project subscriptions.");
  }

  let closed = false;
  const socket = new SocketCtor(webSocketUrlFor(baseUrl, "/ws"));

  socket.addEventListener("open", () => {
    if (closed) {
      return;
    }

    socket.send(JSON.stringify({ subscribe: projectId }));
    handlers.onOpen?.();
  });

  socket.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") {
      return;
    }

    const message = parseViewerWebSocketMessage(event.data);
    if (message !== null) {
      handlers.onMessage(message);
    }
  });

  socket.addEventListener("error", (event) => {
    if (!closed) {
      handlers.onError?.(event);
    }
  });

  socket.addEventListener("close", (event) => {
    if (!closed) {
      handlers.onClose?.(event);
    }
  });

  return {
    close() {
      closed = true;
      socket.close();
    }
  };
}

/**
 * Validate the small server-to-client message union before the app reacts to it.
 */
function parseViewerWebSocketMessage(serialized: string): ViewerWebSocketMessage | null {
  try {
    const parsed = JSON.parse(serialized) as Partial<ViewerWebSocketMessage>;

    if (
      parsed.type === "changed" &&
      typeof parsed.project === "string" &&
      Array.isArray(parsed.ids) &&
      parsed.ids.every((id) => typeof id === "string")
    ) {
      return { type: "changed", project: parsed.project, ids: parsed.ids };
    }

    if (parsed.type === "reload" && typeof parsed.project === "string") {
      return { type: "reload", project: parsed.project };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Normalize an optional API base URL while preserving the empty string for same-origin requests.
 */
function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl === "") {
    return "";
  }

  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Build a fetch URL, allowing relative same-origin paths in the browser and absolute URLs in tests.
 */
function urlFor(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

/**
 * Build a WebSocket URL that follows the configured HTTP origin or the current browser origin.
 */
function webSocketUrlFor(baseUrl: string, path: string): string {
  const fallbackBase = globalThis.location?.href ?? "http://localhost/";
  const url = new URL(urlFor(baseUrl, path), fallbackBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Encode one URL path segment without allowing ids to create accidental route segments.
 */
function encodePath(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Encode Mermaid view paths while preserving the designed `epic/:id` nested route.
 */
function encodeView(view: string): string {
  return view
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodePath)
    .join("/");
}
