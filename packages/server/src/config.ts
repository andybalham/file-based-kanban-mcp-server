import path from "node:path";

/**
 * Stable environment variable names understood by the server runtime.
 *
 * Keeping the names in one exported table gives docs, tests, and future binaries one source of
 * truth for the operational configuration promised by the Phase 8 hardening work.
 */
export const RUNTIME_CONFIG_ENV = {
  /** Platform-delimited list of folders scanned and watched for `.worktracker/project.json`. */
  watchRoots: "FILE_KANBAN_WATCH_ROOTS",
  /** TCP port used by the read-only HTTP/WebSocket viewer server. */
  port: "FILE_KANBAN_PORT",
  /** Optional root used by the stdio `init` tool when a process cwd is not the intended target. */
  initRoot: "FILE_KANBAN_INIT_ROOT",
  /** Optional future gate for git side effects in the regeneration pipeline. */
  git: "FILE_KANBAN_GIT"
} as const;

/** Default read-only viewer port used when no runtime environment value is supplied. */
export const DEFAULT_HTTP_PORT = 4000;

/**
 * Process-level configuration shared by stdio, HTTP, and watcher startup.
 */
export interface RuntimeConfig {
  /**
   * Absolute root passed to the `init` tool.
   *
   * This is intentionally separate from `watchRoots`: a server process may initialize the current
   * repository while also discovering projects across a broader parent folder.
   */
  initRoot: string;
  /**
   * Absolute folders watched recursively for project markers.
   *
   * The registry and watcher both consume this same resolved list so boot discovery and live marker
   * discovery cannot drift.
   */
  watchRoots: string[];
  /** TCP port used by the HTTP/WebSocket viewer runtime. */
  port: number;
  /**
   * Future git integration switch.
   *
   * The current regeneration pipeline does not yet commit changes, but parsing the flag now keeps
   * the public runtime config aligned with §14.1 without enabling side effects.
   */
  git: boolean;
}

/** Options for deterministic runtime config loading in tests and alternate process hosts. */
export interface LoadRuntimeConfigOptions {
  /** Environment object to parse; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory fallback for `initRoot` and default `watchRoots`. */
  cwd?: string;
}

/** Stable machine-readable configuration error codes. */
export type RuntimeConfigErrorCode = "INVALID_PORT" | "INVALID_WATCH_ROOTS" | "INVALID_GIT";

/**
 * Error raised when environment configuration cannot be interpreted safely.
 */
export class RuntimeConfigError extends Error {
  /** Machine-readable code suitable for tests and process startup logging. */
  readonly code: RuntimeConfigErrorCode;

  /** Environment variable responsible for the failure, when one specific key caused it. */
  readonly variable?: string;

  /** Create a structured runtime configuration error. */
  constructor(code: RuntimeConfigErrorCode, message: string, variable?: string) {
    super(message);
    this.name = "RuntimeConfigError";
    this.code = code;
    this.variable = variable;
  }
}

/**
 * Load server runtime configuration from environment variables.
 *
 * Defaults are intentionally local and deterministic: with no environment, the server discovers the
 * current working directory and serves the viewer on port 4000. Operators can widen discovery with
 * `FILE_KANBAN_WATCH_ROOTS`, using Node's platform path delimiter (`;` on Windows, `:` on POSIX).
 */
export function loadRuntimeConfig(options: LoadRuntimeConfigOptions = {}): RuntimeConfig {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const initRoot = path.resolve(valueOrDefault(env[RUNTIME_CONFIG_ENV.initRoot], cwd));
  const watchRoots = parseWatchRoots(env[RUNTIME_CONFIG_ENV.watchRoots], initRoot);

  return {
    initRoot,
    watchRoots,
    port: parsePort(env[RUNTIME_CONFIG_ENV.port]),
    git: parseGitFlag(env[RUNTIME_CONFIG_ENV.git])
  };
}

/**
 * Return a fallback when an optional environment value is blank or missing.
 */
function valueOrDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim().length === 0 ? fallback : value.trim();
}

/**
 * Parse the required watch-root runtime value, applying the current init root as the local default.
 */
function parseWatchRoots(configured: string | undefined, fallbackRoot: string): string[] {
  const rawRoots =
    configured === undefined || configured.trim().length === 0
      ? [fallbackRoot]
      : configured
          .split(path.delimiter)
          .map((root) => root.trim())
          .filter((root) => root.length > 0);

  if (rawRoots.length === 0) {
    throw new RuntimeConfigError(
      "INVALID_WATCH_ROOTS",
      `${RUNTIME_CONFIG_ENV.watchRoots} must contain at least one path when set.`,
      RUNTIME_CONFIG_ENV.watchRoots
    );
  }

  return [...new Set(rawRoots.map((root) => path.resolve(root)))];
}

/**
 * Parse and validate the HTTP listener port.
 */
function parsePort(configured: string | undefined): number {
  const rawPort = valueOrDefault(configured, String(DEFAULT_HTTP_PORT));
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeConfigError(
      "INVALID_PORT",
      `${RUNTIME_CONFIG_ENV.port} must be an integer between 1 and 65535.`,
      RUNTIME_CONFIG_ENV.port
    );
  }

  return port;
}

/**
 * Parse the future git integration flag without performing any git side effects.
 */
function parseGitFlag(configured: string | undefined): boolean {
  if (configured === undefined || configured.trim().length === 0) {
    return false;
  }

  switch (configured.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new RuntimeConfigError(
        "INVALID_GIT",
        `${RUNTIME_CONFIG_ENV.git} must be a boolean value such as true/false or 1/0.`,
        RUNTIME_CONFIG_ENV.git
      );
  }
}
