#!/usr/bin/env node
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runHttpViewerServer } from "./main.js";
import type { HttpViewerRuntime, RunHttpViewerServerOptions } from "./main.js";

/** Stream shape used by the CLI so tests can capture output without patching process globals. */
export interface ViewerCliOutput {
  /** Write one human-facing startup or shutdown line. */
  write(message: string): void;
}

/** Optional dependencies for deterministic CLI tests and alternate process hosts. */
export interface StartViewerCliOptions extends RunHttpViewerServerOptions {
  /** Runtime starter; defaults to the production HTTP/WebSocket viewer runtime. */
  runServer?: (options?: RunHttpViewerServerOptions) => Promise<HttpViewerRuntime>;
  /** Output stream for operator-facing startup information. */
  stdout?: ViewerCliOutput;
  /** Register SIGINT/SIGTERM cleanup hooks for the current Node process. */
  installSignalHandlers?: boolean;
}

/**
 * Start the read-only viewer as an operator-facing process command.
 *
 * The heavy lifting stays in `runHttpViewerServer()`: configuration loading, boot discovery,
 * watcher registration, static UI serving, and WebSocket broadcasting remain shared with tests and
 * any future embedded host. This wrapper only adds process-friendly startup output and shutdown
 * handling for the generated `file-kanban-viewer` bin.
 */
export async function startViewerCli(options: StartViewerCliOptions = {}): Promise<HttpViewerRuntime> {
  const {
    runServer = runHttpViewerServer,
    stdout = process.stdout,
    installSignalHandlers = true,
    ...runtimeOptions
  } = options;
  const runtime = await runServer(runtimeOptions);
  const url = viewerUrl(runtime);

  stdout.write(`File Kanban viewer listening on ${url}\n`);
  stdout.write(`Watching ${runtime.config.watchRoots.join(path.delimiter)}\n`);

  if (installSignalHandlers) {
    installViewerShutdownHandlers(runtime, stdout);
  }

  return runtime;
}

/**
 * Convert the Node listener address into the URL operators should open in a browser.
 */
export function viewerUrl(runtime: HttpViewerRuntime): string {
  const address = runtime.server.address();

  if (address === null || typeof address === "string") {
    return `http://127.0.0.1:${runtime.config.port}`;
  }

  const host = normalizeAddressHost(address);
  return `http://${host}:${address.port}`;
}

/**
 * Normalize wildcard listen hosts into a loopback URL that works for local browser usage.
 */
function normalizeAddressHost(address: AddressInfo): string {
  if (address.address === "::" || address.address === "0.0.0.0") {
    return "127.0.0.1";
  }

  return address.family === "IPv6" ? `[${address.address}]` : address.address;
}

/**
 * Close the viewer cleanly when the hosting process receives the usual terminal stop signals.
 */
function installViewerShutdownHandlers(runtime: HttpViewerRuntime, stdout: ViewerCliOutput): void {
  const shutdown = async (): Promise<void> => {
    await runtime.close();
    stdout.write("File Kanban viewer stopped.\n");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startViewerCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
