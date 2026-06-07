#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_RESOURCE_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  executeMcpMutationTool,
  executeMcpQueryTool,
  readMcpResource,
  toMcpStructuredError
} from "./mcp.js";
import type {
  McpEntityMutationToolName,
  McpMutationToolRegistry,
  McpQueryToolName,
  McpResourceKey,
  McpResourceReadArgs,
  McpResourceRegistry,
  McpStructuredError,
  McpToolArgsByName,
  McpToolName,
  McpToolResultByName
} from "./mcp.js";
import { bootstrapProjectRegistry } from "./main.js";
import type { ProjectRegistry } from "./registry.js";

/** Package version advertised in the MCP server identity until release automation owns it. */
const SERVER_VERSION = "0.0.0";

/** Tool names whose handlers must use the validate-before-commit mutation path. */
const MUTATION_TOOL_NAMES = new Set<McpToolName>([
  "create_entity",
  "update_entity",
  "set_status",
  "link_dependency",
  "unlink_dependency",
  "move_entity",
  "archive_entity"
]);

/** Tool names whose handlers are pure reads over the registry and selected project state. */
const QUERY_TOOL_NAMES = new Set<McpToolName>([
  "query_ready",
  "query_blocked",
  "critical_path",
  "validate",
  "list_projects"
]);

/**
 * Small runtime shape used by this module instead of importing SDK types directly.
 *
 * The production entrypoint loads the official SDK dynamically, while tests inject a fake server
 * with this same surface. Keeping the boundary narrow makes registration behavior verifiable
 * without coupling unit tests to protocol transport internals.
 */
export interface McpServerRuntime {
  /** Register one callable MCP tool. */
  registerTool(
    name: string,
    options: { description: string; annotations?: Record<string, boolean> },
    handler: (args: Record<string, unknown>) => Promise<McpToolResponse>
  ): void;

  /** Register one readable MCP resource or resource template. */
  registerResource(
    name: string,
    template: unknown,
    options: { description: string; mimeType: string },
    handler: (uri: URL, variables?: Record<string, string | string[]>) => Promise<McpResourceResponse>
  ): void;

  /** Attach the fully registered server to a concrete transport. */
  connect?(transport: unknown): Promise<void>;

  /** Close any transport/server resources during graceful shutdown. */
  close?(): Promise<void>;
}

/** MCP response shape returned by registered resource handlers. */
export interface McpResourceResponse {
  /** Resource bodies returned to the client. */
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

/** MCP response shape returned by registered tool handlers. */
export interface McpToolResponse {
  /** Human-readable JSON payload for clients that do not consume structured content. */
  content: Array<{ type: "text"; text: string }>;
  /** Machine-readable successful result or structured error. */
  structuredContent: unknown;
  /** Marks tool-level failures without crashing the transport. */
  isError?: boolean;
}

/** Options for building the SDK-neutral stdio MCP server registration. */
export interface BuildStdioMcpServerOptions {
  /** Registry used by every resource and tool call. */
  registry: ProjectRegistry;
  /** Root used by `init`, which intentionally creates or reuses a project before resolution. */
  initRoot: string;
  /** Optional factory for converting design resource templates into SDK runtime objects. */
  resourceTemplateFactory?: (key: McpResourceKey, template: string) => unknown;
}

/**
 * Register the full design MCP surface on an SDK-compatible server instance.
 *
 * This function contains no process or transport work. Production startup calls it before
 * connecting stdio, and tests use it to assert the adapter exposes exactly the design resources
 * and tools while delegating behavior to the already-tested contract functions.
 */
export function registerStdioMcpSurface(server: McpServerRuntime, options: BuildStdioMcpServerOptions): McpServerRuntime {
  registerResources(server, options.registry, options.resourceTemplateFactory);
  registerTools(server, options.registry, options.initRoot);
  return server;
}

/**
 * Create and register the production MCP server with dynamically loaded SDK constructors.
 *
 * Dynamic loading keeps the rest of the server package testable without importing transport classes
 * at module evaluation time. The package dependency still declares the official SDK for production
 * installs and the exported binary.
 */
export async function createStdioMcpServer(options: BuildStdioMcpServerOptions): Promise<McpServerRuntime> {
  const { McpServer, ResourceTemplate } = await importSdkMcpModule();
  const server = new McpServer({ name: "file-kanban-mcp-server", version: SERVER_VERSION });

  return registerStdioMcpSurface(server, {
    ...options,
    registry: options.registry,
    resourceTemplateFactory: (key, template) =>
      key === "projectList" ? template : new ResourceTemplate(template, { list: undefined })
  });
}

/**
 * Start the stdio MCP server for the current Node process.
 *
 * The process root defaults to `process.cwd()` so `init` targets the repository that spawned the
 * MCP server. Watch roots default to that same root and can be expanded with
 * `FILE_KANBAN_WATCH_ROOTS`, separated by the platform path delimiter.
 */
export async function runStdioServer(options: Partial<BuildStdioMcpServerOptions> = {}): Promise<McpServerRuntime> {
  const initRoot = options.initRoot ?? process.cwd();
  const registry =
    options.registry ??
    (await bootstrapProjectRegistry({
      watchRoots: watchRootsFromEnvironment(initRoot)
    }));
  const server = await createStdioMcpServer({ registry, initRoot });
  const { StdioServerTransport } = await importSdkStdioModule();
  const transport = new StdioServerTransport();

  await server.connect?.(transport);
  installShutdownHandlers(server);
  return server;
}

/**
 * Register every §9.1 resource against the supplied server instance.
 */
function registerResources(
  server: McpServerRuntime,
  registry: McpResourceRegistry,
  resourceTemplateFactory?: BuildStdioMcpServerOptions["resourceTemplateFactory"]
): void {
  for (const definition of Object.values(MCP_RESOURCE_DEFINITIONS)) {
    server.registerResource(
      definition.key,
      resourceTemplateForRuntime(definition.key, resourceTemplateFactory),
      { description: definition.description, mimeType: definition.mimeType },
      async (uri, variables) => toResourceResponse(await readMcpResource(registry, parseResourceReadArgs(definition.key, uri, variables)))
    );
  }
}

/**
 * Register every §9.2 tool and route calls to the correct project-resolution/write path.
 */
function registerTools(server: McpServerRuntime, registry: ProjectRegistry, initRoot: string): void {
  for (const name of MCP_TOOL_NAMES) {
    const definition = MCP_TOOL_DEFINITIONS[name];
    server.registerTool(
      name,
      {
        description: definition.description,
        annotations: {
          readOnlyHint: !definition.mutates,
          destructiveHint: false,
          idempotentHint: !definition.mutates || name === "init"
        }
      },
      async (args) => toolResponse(await executeTool(registry, initRoot, name, args))
    );
  }
}

/**
 * Execute a registered tool and convert known contract failures into MCP tool errors.
 */
async function executeTool(
  registry: ProjectRegistry,
  initRoot: string,
  name: McpToolName,
  args: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; error: McpStructuredError }> {
  try {
    if (name === "init") {
      return {
        ok: true,
        result: await registry.init({
          ...(args as unknown as McpToolArgsByName["init"]),
          root: initRoot
        })
      };
    }

    if (MUTATION_TOOL_NAMES.has(name)) {
      return {
        ok: true,
        result: await executeMcpMutationTool(
          registry,
          name as McpEntityMutationToolName,
          args as unknown as McpToolArgsByName[McpEntityMutationToolName]
        )
      };
    }

    if (QUERY_TOOL_NAMES.has(name)) {
      return {
        ok: true,
        result: executeMcpQueryTool(registry, name as McpQueryToolName, args as unknown as McpToolArgsByName[McpQueryToolName])
      };
    }

    throw new Error(`Unhandled MCP tool '${name}'.`);
  } catch (error) {
    return { ok: false, error: toMcpStructuredError(error) };
  }
}

/**
 * Convert one resource read into the high-level SDK response envelope.
 */
function toResourceResponse(result: Awaited<ReturnType<typeof readMcpResource>>): McpResourceResponse {
  return {
    contents: [
      {
        uri: result.uri,
        mimeType: result.mimeType,
        text: result.text
      }
    ]
  };
}

/**
 * Convert a tool result or structured tool error into the high-level SDK response envelope.
 */
function toolResponse(result: { ok: true; result: unknown } | { ok: false; error: McpStructuredError }): McpToolResponse {
  const structuredContent = result.ok ? (result.result as McpToolResultByName[McpToolName]) : { error: result.error };

  return {
    content: [{ type: "text", text: `${JSON.stringify(structuredContent, null, 2)}\n` }],
    structuredContent,
    ...(result.ok ? {} : { isError: true })
  };
}

/**
 * Parse SDK resource callback data into the SDK-neutral resource reader contract.
 */
export function parseResourceReadArgs(
  key: McpResourceKey,
  uri: URL,
  variables: Record<string, string | string[]> = {}
): McpResourceReadArgs {
  const variable = (name: string): string | undefined => {
    const value = variables[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const projectId = variable("project") ?? uri.hostname;
  const id = variable("id") ?? pathSegment(uri, key === "epicGraph" ? 1 : 0);

  switch (key) {
    case "projectList":
      return { key };
    case "requirementsSource":
    case "dependenciesGraph":
    case "boardIndex":
      return { key, projectId };
    case "entity":
    case "epicGraph":
      return { key, projectId, id };
  }
}

/**
 * Return the path segment at the requested index after trimming the URL's leading slash.
 */
function pathSegment(uri: URL, index: number): string | undefined {
  return uri.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    [index];
}

/**
 * Return the resource template object used for registration.
 *
 * Tests do not need the SDK's `ResourceTemplate` class, so this returns the literal design template.
 * The high-level SDK also accepts string URIs for static resources and template instances for
 * dynamic resources; production currently relies on the SDK's compatibility with URI-template-like
 * registration strings.
 */
function resourceTemplateForRuntime(
  key: McpResourceKey,
  resourceTemplateFactory?: BuildStdioMcpServerOptions["resourceTemplateFactory"]
): unknown {
  const template = MCP_RESOURCE_TEMPLATES[key];
  return resourceTemplateFactory === undefined ? template : resourceTemplateFactory(key, template);
}

/**
 * Read watch roots from the environment with the current root as the deterministic fallback.
 */
function watchRootsFromEnvironment(initRoot: string): string[] {
  const configured = process.env.FILE_KANBAN_WATCH_ROOTS;
  if (configured === undefined || configured.trim().length === 0) {
    return [initRoot];
  }

  return configured
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

/**
 * Install graceful shutdown hooks once stdio is connected.
 */
function installShutdownHandlers(server: McpServerRuntime): void {
  const shutdown = async (): Promise<void> => {
    await server.close?.();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

/**
 * Dynamically import the official SDK MCP module.
 */
async function importSdkMcpModule(): Promise<{
  McpServer: new (identity: { name: string; version: string }) => McpServerRuntime;
  ResourceTemplate: new (template: string, options: { list: undefined }) => unknown;
}> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport("@modelcontextprotocol/sdk/server/mcp.js") as Promise<{
    McpServer: new (identity: { name: string; version: string }) => McpServerRuntime;
    ResourceTemplate: new (template: string, options: { list: undefined }) => unknown;
  }>;
}

/**
 * Dynamically import the official SDK stdio transport module.
 */
async function importSdkStdioModule(): Promise<{ StdioServerTransport: new () => unknown }> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport("@modelcontextprotocol/sdk/server/stdio.js") as Promise<{ StdioServerTransport: new () => unknown }>;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdioServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
