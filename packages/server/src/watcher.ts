import path from "node:path";

import { readMarker } from "@file-kanban/core";
import type { ProjectId } from "@file-kanban/core";
import chokidar from "chokidar";

import type { HttpWebSocketBroadcaster } from "./http.js";
import type { ProjectRegistry, RegisteredProject } from "./registry.js";

/** Relative marker path that identifies one work-tracker project root. */
const PROJECT_MARKER_RELATIVE_PATH = path.join(".worktracker", "project.json");

/** Relative store paths that should be watched after a project is known. */
const PROJECT_CONTENT_RELATIVE_PATHS = [
  path.join(".worktracker", "entities"),
  path.join(".worktracker", "requirements")
] as const;

/** Directory names ignored by coarse discovery watchers before project registration. */
const DISCOVERY_IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "build", "coverage"]);

/** Events that may require project discovery or project content refresh. */
export type ProjectWatcherEventName = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

/**
 * Minimal watcher contract used by the server watcher orchestration.
 *
 * The shape deliberately matches the subset of chokidar used in production while allowing tests to
 * inject a deterministic fake watcher instead of depending on filesystem event timing.
 */
export interface ProjectFileWatcher {
  /** Register a callback for one filesystem event name or chokidar's aggregate `all` event. */
  on(event: "all", listener: (event: ProjectWatcherEventName, filePath: string) => void): ProjectFileWatcher;
  /** Stop watching and release any OS watcher handles. */
  close(): Promise<unknown> | unknown;
}

/** Factory used to create concrete or fake watchers for a set of paths. */
export type ProjectFileWatcherFactory = (paths: string[], options: ProjectFileWatcherOptions) => ProjectFileWatcher;

/** Narrow options from chokidar that the watcher module actually relies on. */
export interface ProjectFileWatcherOptions {
  /** Ignore already-existing files at startup; boot discovery owns initial state. */
  ignoreInitial: boolean;
  /** Predicate used to drop noisy directories and generated paths before event handling. */
  ignored?: (filePath: string) => boolean;
}

/** Options for wiring marker discovery and per-project content watchers. */
export interface CreateProjectWatcherOptions {
  /** Runtime project registry shared by MCP and HTTP adapters. */
  registry: ProjectRegistry;
  /** Coarse roots to watch recursively for `.worktracker/project.json` markers. */
  watchRoots: string[];
  /** Project-scoped broadcaster attached to the HTTP/WebSocket server. */
  broadcaster: HttpWebSocketBroadcaster;
  /** Optional watcher factory for tests; production defaults to chokidar. */
  watcherFactory?: ProjectFileWatcherFactory;
}

/** Running watcher controller returned to server startup code. */
export interface ProjectWatcherController {
  /** Start coarse marker discovery and fine content watchers for currently registered projects. */
  start(): Promise<void>;
  /** Close every underlying watcher handle. */
  close(): Promise<void>;
}

/**
 * Create watcher orchestration for project markers and known project content.
 *
 * Marker discovery watches the configured roots for project markers only. Once a marker is found,
 * the registry is refreshed through the same `registerDiscovered` path used by boot discovery, then
 * a content watcher is attached only to `.worktracker/entities` and `.worktracker/requirements` for
 * that project. Every genuine external content event refreshes the in-memory `ProjectState` and
 * emits a project-scoped reload broadcast.
 */
export function createProjectWatcher(options: CreateProjectWatcherOptions): ProjectWatcherController {
  return new ProjectWatcher(options);
}

/** Production watcher factory backed by chokidar. */
export function createChokidarProjectFileWatcher(
  paths: string[],
  options: ProjectFileWatcherOptions
): ProjectFileWatcher {
  return chokidar.watch(paths, {
    ignoreInitial: options.ignoreInitial,
    ignored: options.ignored
  }) as ProjectFileWatcher;
}

/** Stateful implementation that owns one coarse watcher plus one fine watcher per project root. */
class ProjectWatcher implements ProjectWatcherController {
  /** Registry refreshed when external markers or content edits appear. */
  private readonly registry: ProjectRegistry;

  /** Absolute roots watched for externally appearing project markers. */
  private readonly watchRoots: string[];

  /** WebSocket broadcaster used only after the registry has been refreshed. */
  private readonly broadcaster: HttpWebSocketBroadcaster;

  /** Factory that creates chokidar-compatible watcher handles. */
  private readonly watcherFactory: ProjectFileWatcherFactory;

  /** Coarse watcher over configured roots, created at start. */
  private markerWatcher: ProjectFileWatcher | null = null;

  /** Fine content watchers keyed by normalized project root. */
  private readonly contentWatchersByRoot = new Map<string, ProjectFileWatcher>();

  /**
   * Create the watcher controller.
   */
  constructor(options: CreateProjectWatcherOptions) {
    this.registry = options.registry;
    this.watchRoots = options.watchRoots.map((watchRoot) => path.resolve(watchRoot));
    this.broadcaster = options.broadcaster;
    this.watcherFactory = options.watcherFactory ?? createChokidarProjectFileWatcher;
  }

  /**
   * Start coarse marker discovery and attach fine watchers for already registered projects.
   */
  async start(): Promise<void> {
    await this.ensureKnownProjectContentWatchers();

    this.markerWatcher = this.watcherFactory(this.watchRoots, {
      ignoreInitial: true,
      ignored: (filePath) => isDiscoveryPathIgnored(filePath)
    });
    this.markerWatcher.on("all", (event, filePath) => {
      if (event === "add" || event === "change") {
        void this.handleMarkerEvent(filePath);
      }
    });
  }

  /**
   * Close every watcher, clearing runtime handles so tests and server shutdown can be deterministic.
   */
  async close(): Promise<void> {
    const watchers = [
      ...(this.markerWatcher === null ? [] : [this.markerWatcher]),
      ...this.contentWatchersByRoot.values()
    ];

    this.markerWatcher = null;
    this.contentWatchersByRoot.clear();

    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  /**
   * Attach content watchers for projects that were registered before `start` was called.
   */
  private async ensureKnownProjectContentWatchers(): Promise<void> {
    for (const project of this.registry.listProjects()) {
      this.ensureContentWatcher(project);
    }
  }

  /**
   * Discover or refresh one project when a marker path appears under a watched root.
   */
  private async handleMarkerEvent(filePath: string): Promise<void> {
    if (!isProjectMarkerPath(filePath)) {
      return;
    }

    const projectRoot = projectRootFromMarkerPath(filePath);
    const marker = await readMarker(projectRoot);
    if (marker === null) {
      return;
    }

    const state = await this.registry.registerDiscovered(projectRoot, marker);
    this.ensureContentWatcher({ projectId: state.projectId, title: state.marker.title, root: state.root });
    this.broadcaster.broadcastReload(state.projectId);
  }

  /**
   * Attach a fine watcher only to the work-tracker content paths for one registered project.
   */
  private ensureContentWatcher(project: RegisteredProject): void {
    const root = path.resolve(project.root);
    if (this.contentWatchersByRoot.has(root)) {
      return;
    }

    const watchPaths = PROJECT_CONTENT_RELATIVE_PATHS.map((relativePath) => path.join(root, relativePath));
    const watcher = this.watcherFactory(watchPaths, {
      ignoreInitial: true
    });

    watcher.on("all", (event) => {
      if (event === "add" || event === "change" || event === "unlink") {
        void this.refreshProject(root, project.projectId);
      }
    });

    this.contentWatchersByRoot.set(root, watcher);
  }

  /**
   * Rescan one known project after a content edit and notify only that project's subscribers.
   */
  private async refreshProject(root: string, expectedProjectId: ProjectId): Promise<void> {
    const marker = await readMarker(root);
    if (marker === null) {
      return;
    }

    const state = await this.registry.registerDiscovered(root, marker);
    this.broadcaster.broadcastReload(state.projectId ?? expectedProjectId);
  }
}

/**
 * Return true when a path is inside a directory that should never participate in marker discovery.
 */
function isDiscoveryPathIgnored(filePath: string): boolean {
  const segments = path.normalize(filePath).split(path.sep);
  return segments.some((segment) => DISCOVERY_IGNORED_DIRECTORY_NAMES.has(segment));
}

/**
 * Return true only for the portable project marker path.
 */
function isProjectMarkerPath(filePath: string): boolean {
  return normalizePathSuffix(filePath).endsWith(normalizePathSuffix(PROJECT_MARKER_RELATIVE_PATH));
}

/**
 * Convert a marker path into its owning project root.
 */
function projectRootFromMarkerPath(filePath: string): string {
  return path.dirname(path.dirname(path.resolve(filePath)));
}

/**
 * Normalize path separators for suffix checks that should be stable on Windows and POSIX.
 */
function normalizePathSuffix(filePath: string): string {
  return path.normalize(filePath).split(path.sep).join("/");
}
