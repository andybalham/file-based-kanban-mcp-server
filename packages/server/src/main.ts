import type { ProjectState } from "@file-kanban/core";
import { loadRuntimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createProjectRegistry } from "./registry.js";
import type { CreateProjectRegistryOptions, ProjectRegistry } from "./registry.js";
import { createProjectWatcher } from "./watcher.js";
import type { CreateProjectWatcherOptions, ProjectWatcherController } from "./watcher.js";

export type {
  InitProjectArgs,
  InitProjectResult,
  CreateProjectRegistryOptions,
  Clock,
  ProjectRegistry,
  ProjectRegistryOptions,
  ProjectIdFactory,
  ProjectStateBuilder,
  RegisteredProject,
  RegistryErrorCode
} from "./registry.js";
export { createProjectRegistry, RegistryError } from "./registry.js";

export {
  DEFAULT_HTTP_PORT,
  RUNTIME_CONFIG_ENV,
  RuntimeConfigError,
  loadRuntimeConfig
} from "./config.js";
export type { LoadRuntimeConfigOptions, RuntimeConfig, RuntimeConfigErrorCode } from "./config.js";

export {
  MCP_ERROR_CODES,
  MCP_RESOURCE_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  McpAdapterError,
  executeMcpMutationTool,
  executeMcpQueryTool,
  isMcpErrorCode,
  readMcpResource,
  toMcpStructuredError,
  validationIssueCodeToMcpErrorCode,
  validationIssueToMcpError
} from "./mcp.js";
export type {
  ArchiveEntityToolArgs,
  CreateEntityToolArgs,
  CriticalPathToolArgs,
  CriticalPathToolResult,
  DependencyToolArgs,
  DependencyToolResult,
  EntityIdToolResult,
  InitToolArgs,
  InitToolResult,
  ListProjectsToolResult,
  ExecuteMcpMutationToolOptions,
  McpErrorCode,
  McpEntityMutationToolName,
  McpMutationToolRegistry,
  McpResourceDefinition,
  McpResourceKey,
  McpResourceMimeType,
  McpResourceReadArgs,
  McpResourceReadResult,
  McpResourceRegistry,
  McpQueryToolName,
  McpQueryToolRegistry,
  McpStructuredError,
  McpToolArgsByName,
  McpToolDefinition,
  McpToolName,
  McpToolResultByName,
  MoveEntityToolArgs,
  ProjectScopedToolArgs,
  QueryBlockedToolResult,
  QueryBlockedToolRow,
  QueryReadyToolResult,
  SetStatusToolArgs,
  SetStatusToolResult,
  UpdateEntityFields,
  UpdateEntityToolArgs
} from "./mcp.js";

export { regenerateProject } from "./regenerate.js";
export type { RegenerateProjectOptions, RegenerationResult, WriteSuppressionSet } from "./regenerate.js";

export { createChokidarProjectFileWatcher, createProjectWatcher } from "./watcher.js";
export type {
  CreateProjectWatcherOptions,
  ProjectFileWatcher,
  ProjectFileWatcherFactory,
  ProjectFileWatcherOptions,
  ProjectWatcherController,
  ProjectWatcherEventName
} from "./watcher.js";

export {
  HTTP_ROUTE_DEFINITIONS,
  HttpAdapterError,
  createHttpRequestHandler,
  createHttpServer,
  getHttpBoard,
  getHttpEntity,
  getHttpGraph,
  getHttpMermaid,
  listHttpProjects,
  toHttpErrorBody
} from "./http.js";
export type {
  CreateHttpRequestHandlerOptions,
  HttpBoardEpic,
  HttpBoardNodeBase,
  HttpBoardProgress,
  HttpBoardResponse,
  HttpBoardStory,
  HttpBoardTask,
  HttpEntityDetailResponse,
  HttpEntityView,
  HttpGraphEdge,
  HttpGraphResponse,
  HttpProjectsResponse,
  HttpRequestHandler,
  HttpRouteKey,
  HttpRouteMethod,
  HttpViewerServer,
  HttpViewerRegistry,
  HttpWebSocketBroadcaster,
  HttpWebSocketChangedMessage,
  HttpWebSocketReloadMessage,
  HttpWebSocketServerMessage,
  HttpWebSocketSubscribeMessage
} from "./http.js";

/**
 * Options for the configured HTTP/WebSocket viewer process.
 */
export interface RunHttpViewerServerOptions {
  /**
   * Runtime config to use instead of reading the process environment.
   *
   * Tests and alternate hosts can inject this directly; production callers typically omit it and
   * let `loadRuntimeConfig()` read `FILE_KANBAN_WATCH_ROOTS` and `FILE_KANBAN_PORT`.
   */
  config?: RuntimeConfig;
  /** Existing registry for tests or composed hosts; omitted production startup bootstraps one. */
  registry?: ProjectRegistry;
  /** Existing write-suppression set shared with mutation/regeneration code. */
  writeSuppressionSet?: Set<string>;
  /** Optional static viewer build directory passed through to the read-only HTTP adapter. */
  staticRoot?: string;
  /** Optional watcher factory for deterministic tests. */
  watcherFactory?: CreateProjectWatcherOptions["watcherFactory"];
}

/**
 * Running HTTP viewer runtime with an explicit close hook for graceful shutdown.
 */
export interface HttpViewerRuntime {
  /** Parsed runtime configuration used for boot discovery, watching, and HTTP listen. */
  config: RuntimeConfig;
  /** Shared project registry serving all read-only HTTP requests. */
  registry: ProjectRegistry;
  /** HTTP/WebSocket server instance listening on `config.port`. */
  server: ReturnType<typeof createHttpServer>;
  /** Marker and content watcher using the same configured watch roots as boot discovery. */
  watcher: ProjectWatcherController;
  /** Stop watcher handles and close the HTTP listener. */
  close(): Promise<void>;
}

/**
 * Create the process-wide project registry and immediately populate it from configured watch roots.
 *
 * This is the server startup path described in the technical design: already-marked repositories
 * become routable because their `.worktracker/project.json` markers are found during boot, without
 * requiring agents to call `init`. The lower-level registry still exposes `discover()` separately
 * for tests, future watcher refreshes, and explicit rescan flows.
 */
export async function bootstrapProjectRegistry(options: CreateProjectRegistryOptions): Promise<ProjectRegistry> {
  const registry = createProjectRegistry(options);
  await registry.discover();
  return registry;
}

/**
 * Start the configured read-only HTTP/WebSocket viewer runtime.
 *
 * This is the concrete process wiring for §14.1 configuration: one resolved `watchRoots` list feeds
 * boot discovery and live marker/content watching, and `port` controls the viewer listener.
 */
export async function runHttpViewerServer(options: RunHttpViewerServerOptions = {}): Promise<HttpViewerRuntime> {
  const config = options.config ?? loadRuntimeConfig();
  const registry = options.registry ?? (await bootstrapProjectRegistry({ watchRoots: config.watchRoots }));
  const server = createHttpServer(registry, { staticRoot: options.staticRoot });
  const watcher = createProjectWatcher({
    registry,
    watchRoots: config.watchRoots,
    broadcaster: server,
    writeSuppressionSet: options.writeSuppressionSet,
    watcherFactory: options.watcherFactory
  });

  await listen(server, config.port);

  try {
    await watcher.start();
  } catch (error) {
    await closeHttpServer(server);
    throw error;
  }

  return {
    config,
    registry,
    server,
    watcher,
    async close() {
      await watcher.close();
      await closeHttpServer(server);
    }
  };
}

/**
 * Produce a compact human-readable label for a project.
 *
 * This helper is intentionally small in Phase 0: it proves the server package can consume the
 * core public type surface while later registry and MCP work are still unimplemented.
 */
export function describeProject(state: ProjectState): string {
  // The marker title is user-facing, while the project id disambiguates projects with similar names.
  return `${state.marker.title} (${state.projectId})`;
}

/**
 * Await the callback-style Node listen API.
 */
function listen(server: ReturnType<typeof createHttpServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * Await HTTP listener shutdown while tolerating already-closed servers.
 */
function closeHttpServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error !== undefined && "code" in error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
