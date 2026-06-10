import { StrictMode, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type BoardEpic,
  type BoardResponse,
  type BoardStory,
  type BoardTask,
  type EffectiveStatus,
  type EntityDetail,
  type EntityId,
  type EntityType,
  type ProjectId,
  type ProjectSummary,
  type ViewerApiClient,
  ViewerApiError,
  createViewerApiClient
} from "./api";
import { blockedByNote, collapsibleBoardIds, indexBoard, summarizeBoard, type BoardCounts } from "./derived";
import "./styles.css";

/** The read-only shell tabs promised by the UI design. */
type ViewerTab = "board" | "ready" | "blocked" | "graph";

/** Appearance preferences applied as root CSS classes and variables. */
interface ViewerPreferences {
  /** Whether the dark token set is active on `<html>`. */
  dark: boolean;
  /** Accent color copied into `--accent`; limited to the design-approved swatches. */
  accent: string;
  /** Row density, mapped to the `.density-compact` root class. */
  density: "comfortable" | "compact";
  /** Font stack key used to set the sans and mono CSS variables. */
  font: "geist" | "plex" | "system";
  /** Whether entity ids appear in hierarchy rows. */
  showIds: boolean;
}

/** Project-scoped read models fetched from the Phase 6 HTTP API. */
interface ProjectDataState {
  /** Board hierarchy for the selected project, or null while no project is selected. */
  board: BoardResponse | null;
}

/** Font stacks from the UI reference, applied through CSS variables. */
const FONT_STACKS: Record<ViewerPreferences["font"], { sans: string; mono: string }> = {
  geist: {
    sans: '"Geist", "IBM Plex Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: '"Geist Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace'
  },
  plex: {
    sans: '"IBM Plex Sans", "Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: '"IBM Plex Mono", "Geist Mono", ui-monospace, SFMono-Regular, Consolas, monospace'
  },
  system: {
    sans: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: "ui-monospace, SFMono-Regular, Consolas, monospace"
  }
};

/** Default appearance matches the high-fidelity design reference. */
const DEFAULT_PREFERENCES: ViewerPreferences = {
  dark: false,
  accent: "#7c5cff",
  density: "comfortable",
  font: "geist",
  showIds: true
};

/**
 * Markdown rendering overrides for the read-only drawer.
 *
 * `react-markdown` keeps raw HTML inert by default. These overrides preserve that safety while
 * matching the design requirement that task-list checkboxes render as non-interactive viewer state.
 */
const MARKDOWN_COMPONENTS: Components = {
  a({ children, href }) {
    return (
      <a href={safeMarkdownHref(href)} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  input({ checked, type }) {
    if (type === "checkbox") {
      return <ReadOnlyCheckbox checked={checked === true} />;
    }

    return <input checked={checked} disabled readOnly type={type} />;
  }
};

/** Root React component for the read-only viewer. */
function App() {
  const api = useMemo(() => createViewerApiClient(), []);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [data, setData] = useState<ProjectDataState>({ board: null });
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isLoadingProjectData, setIsLoadingProjectData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [pulseToken, setPulseToken] = useState(0);
  const [tab, setTab] = useState<ViewerTab>("board");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedEntityId, setSelectedEntityId] = useState<EntityId | null>(null);
  const [preferences] = useState<ViewerPreferences>(DEFAULT_PREFERENCES);

  useRootAppearance(preferences);

  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const counts = useMemo(() => summarizeBoard(data.board), [data.board]);
  const collapsibleIds = useMemo(() => collapsibleBoardIds(data.board), [data.board]);
  const hasExpandedRows = collapsibleIds.some((id) => !collapsed.has(id));

  /**
   * Fetch the selected project's board.
   *
   * The shell only needs the board read model today; graph, drawer, and derived-view tasks will add
   * their own API reads without changing the top-level project subscription contract.
   */
  const refreshProjectData = useCallback(
    async (projectId: ProjectId, signal?: AbortSignal) => {
      setIsLoadingProjectData(true);
      setError(null);

      try {
        const board = await api.getBoard(projectId, signal);
        setData({ board });
        setLastUpdatedAt(new Date());
      } catch (unknownError) {
        if (!isAbortError(unknownError)) {
          setError(messageFromError(unknownError));
          setData({ board: null });
        }
      } finally {
        if (signal?.aborted !== true) {
          setIsLoadingProjectData(false);
        }
      }
    },
    [api]
  );

  /**
   * Load registered projects once and select the first deterministic project returned by the server.
   */
  useEffect(() => {
    const controller = new AbortController();

    async function loadProjects() {
      setIsLoadingProjects(true);
      setError(null);

      try {
        const nextProjects = await api.listProjects(controller.signal);
        setProjects(nextProjects);
        setSelectedProjectId((currentProjectId) => currentProjectId ?? nextProjects[0]?.projectId ?? null);
      } catch (unknownError) {
        if (!isAbortError(unknownError)) {
          setError(messageFromError(unknownError));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingProjects(false);
        }
      }
    }

    void loadProjects();

    return () => {
      controller.abort();
    };
  }, [api]);

  /**
   * Reset project-local shell state and refetch the read model when the selected project changes.
   */
  useEffect(() => {
    setCollapsed(new Set());
    setSelectedEntityId(null);

    if (selectedProjectId === null) {
      setData({ board: null });
      return;
    }

    const controller = new AbortController();
    void refreshProjectData(selectedProjectId, controller.signal);

    return () => {
      controller.abort();
    };
  }, [refreshProjectData, selectedProjectId]);

  /**
   * Subscribe to project-scoped live changes and refetch the board after each server push.
   */
  useEffect(() => {
    if (selectedProjectId === null) {
      setIsLive(false);
      return;
    }

    let disposed = false;
    let subscription: ReturnType<ViewerApiClient["subscribeToProject"]> | null = null;

    try {
      subscription = api.subscribeToProject(selectedProjectId, {
        onOpen() {
          if (!disposed) {
            setIsLive(true);
          }
        },
        onMessage(message) {
          if (disposed || message.project !== selectedProjectId) {
            return;
          }

          setPulseToken((currentToken) => currentToken + 1);
          void refreshProjectData(selectedProjectId);
        },
        onClose() {
          if (!disposed) {
            setIsLive(false);
          }
        },
        onError() {
          if (!disposed) {
            setIsLive(false);
          }
        }
      });
    } catch (unknownError) {
      setIsLive(false);
      setError(messageFromError(unknownError));
    }

    return () => {
      disposed = true;
      subscription?.close();
    };
  }, [api, refreshProjectData, selectedProjectId]);

  /** Toggle one local, non-persisted hierarchy collapse state. */
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((currentCollapsed) => {
      const nextCollapsed = new Set(currentCollapsed);
      if (nextCollapsed.has(id)) {
        nextCollapsed.delete(id);
      } else {
        nextCollapsed.add(id);
      }
      return nextCollapsed;
    });
  }, []);

  /** Collapse or expand every visible epic/story row without mutating server state. */
  const toggleAllCollapsed = useCallback(() => {
    setCollapsed(hasExpandedRows ? new Set(collapsibleIds) : new Set());
  }, [collapsibleIds, hasExpandedRows]);

  /** Open the read-only drawer for an entity selected from any viewer surface. */
  const openEntity = useCallback((id: EntityId) => {
    setSelectedEntityId(id);
  }, []);

  return (
    <div className="app-frame" aria-busy={isLoadingProjects || isLoadingProjectData}>
      <header className="top-bar">
        <ProjectPicker projects={projects} current={selectedProjectId} onPick={setSelectedProjectId} />
        <LiveIndicator isLive={isLive} lastUpdatedAt={lastUpdatedAt} pulseToken={pulseToken} />
        <span className="top-spacer" />
        <ReadOnlyChip />
      </header>

      <nav className="tab-bar" aria-label="Board views">
        <TabButton active={tab === "board"} onClick={() => setTab("board")}>
          Board
        </TabButton>
        <TabButton active={tab === "ready"} count={counts.readyTasks} onClick={() => setTab("ready")}>
          Ready
        </TabButton>
        <TabButton active={tab === "blocked"} count={counts.blockedTasks} onClick={() => setTab("blocked")}>
          Blocked
        </TabButton>
        <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
          Graph
        </TabButton>
        <span className="tab-spacer" />
        {tab === "board" && collapsibleIds.length > 0 ? (
          <button className="text-button" type="button" onClick={toggleAllCollapsed}>
            {hasExpandedRows ? "Collapse all" : "Expand all"}
          </button>
        ) : null}
      </nav>

      <main className="main-scroll scroll">
        <section className={tab === "graph" ? "view-card view-card-graph" : "view-card"} aria-label={`${tab} view`}>
          <ViewHeader project={selectedProject} counts={counts} />
          {error === null ? null : <div className="error-banner">{error}</div>}
          <ActiveView
            board={data.board}
            collapsed={collapsed}
            counts={counts}
            isLoading={isLoadingProjects || isLoadingProjectData}
            onOpenEntity={openEntity}
            showIds={preferences.showIds}
            tab={tab}
            toggleCollapsed={toggleCollapsed}
          />
        </section>
      </main>

      {selectedProjectId !== null && selectedEntityId !== null ? (
        <EntityDrawer
          api={api}
          board={data.board}
          initialEntityId={selectedEntityId}
          projectId={selectedProjectId}
          refreshToken={pulseToken}
          onClose={() => setSelectedEntityId(null)}
        />
      ) : null}
    </div>
  );
}

/** Apply appearance preferences through the same root hooks used by the prototype. */
function useRootAppearance(preferences: ViewerPreferences): void {
  useEffect(() => {
    const root = document.documentElement;
    const font = FONT_STACKS[preferences.font];

    root.classList.toggle("dark", preferences.dark);
    root.classList.toggle("density-compact", preferences.density === "compact");
    root.style.setProperty("--accent", preferences.accent);
    root.style.setProperty("--font-sans", font.sans);
    root.style.setProperty("--font-mono", font.mono);
  }, [preferences]);
}

/** Render the custom project picker popover from the UI design. */
function ProjectPicker({
  projects,
  current,
  onPick
}: {
  projects: ProjectSummary[];
  current: ProjectId | null;
  onPick(projectId: ProjectId): void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedProject = projects.find((project) => project.projectId === current) ?? null;

  /**
   * Close the popover on outside clicks so the picker behaves like a normal menu button.
   */
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  return (
    <div className="project-picker" ref={containerRef}>
      <button
        className="project-trigger"
        type="button"
        disabled={projects.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="project-accent" aria-hidden="true" />
        <span className="project-trigger-copy">
          <span className="project-title">{selectedProject?.title ?? "No projects discovered"}</span>
          <span className="project-root">{selectedProject?.root ?? "Waiting for /api/projects"}</span>
        </span>
        <ChevronDown open={open} />
      </button>

      {open ? (
        <div className="project-menu scroll" role="menu">
          <div className="menu-label">Projects</div>
          {projects.map((project) => {
            const selected = project.projectId === current;

            return (
              <button
                className={selected ? "project-option project-option-selected" : "project-option"}
                key={project.projectId}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onPick(project.projectId);
                  setOpen(false);
                }}
              >
                <span className="project-option-dot" aria-hidden="true" />
                <span className="project-option-copy">
                  <span>{project.title}</span>
                  <span>{project.root}</span>
                </span>
                {selected ? <CheckIcon /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Render the project-scoped live indicator and keep its relative text current. */
function LiveIndicator({
  isLive,
  lastUpdatedAt,
  pulseToken
}: {
  isLive: boolean;
  lastUpdatedAt: Date | null;
  pulseToken: number;
}) {
  const [, setClockToken] = useState(0);

  /**
   * The socket only pushes when data changes, so a small local timer is needed for "12s ago" text.
   */
  useEffect(() => {
    const interval = window.setInterval(() => setClockToken((currentToken) => currentToken + 1), 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <span className="live-indicator">
      <span
        key={pulseToken}
        className={isLive ? "live-dot live-dot-online live-dot-pulse" : "live-dot"}
        aria-hidden="true"
      />
      <span>{isLive ? relativeTime(lastUpdatedAt) : "live offline"}</span>
    </span>
  );
}

/** Render the small lock chip that makes the browser surface explicitly read-only. */
function ReadOnlyChip() {
  return (
    <span className="readonly-chip" aria-label="Viewer is read-only">
      <LockIcon />
      read-only
    </span>
  );
}

/** Render one shell tab with an optional count pill. */
function TabButton({
  active,
  children,
  count,
  onClick
}: {
  active: boolean;
  children: string;
  count?: number;
  onClick(): void;
}) {
  return (
    <button className={active ? "tab-button tab-button-active" : "tab-button"} type="button" onClick={onClick}>
      {children}
      {count === undefined ? null : <span className="tab-count">{count}</span>}
    </button>
  );
}

/** Render compact selected-project context above the active card contents. */
function ViewHeader({ project, counts }: { project: ProjectSummary | null; counts: BoardCounts }) {
  return (
    <header className="view-header">
      <div className="view-heading">
        <p className="eyebrow">Project</p>
        <h1>{project?.title ?? "File Kanban Viewer"}</h1>
        <p className="view-root">{project?.root ?? "No project selected"}</p>
      </div>
      <div className="metric-strip" aria-label="Project counts">
        <Metric label="Tasks" value={counts.totalTasks} />
        <Metric label="Ready" value={counts.readyTasks} />
        <Metric label="Blocked" value={counts.blockedTasks} tone="blocked" />
        <Metric label="Done" value={counts.doneTasks} tone="done" />
      </div>
    </header>
  );
}

/** Render one small shell metric using mono numerals. */
function Metric({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: number;
  tone?: "neutral" | "blocked" | "done";
}) {
  return (
    <span className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

/** Select the currently active view while keeping later Phase 7 surfaces as isolated placeholders. */
function ActiveView({
  board,
  collapsed,
  counts,
  isLoading,
  onOpenEntity,
  showIds,
  tab,
  toggleCollapsed
}: {
  board: BoardResponse | null;
  collapsed: Set<string>;
  counts: BoardCounts;
  isLoading: boolean;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
  tab: ViewerTab;
  toggleCollapsed(id: string): void;
}) {
  if (isLoading) {
    return <EmptyState title="Loading project data" body="Fetching project data." />;
  }

  if (board === null || board.epics.length === 0) {
    return <EmptyState title="This project has no entities yet" body="Tracked epics, stories, and tasks will appear here." />;
  }

  switch (tab) {
    case "board":
      return (
        <BoardPreview
          board={board}
          collapsed={collapsed}
          onOpenEntity={onOpenEntity}
          showIds={showIds}
          toggleCollapsed={toggleCollapsed}
        />
      );
    case "ready":
      return (
        <EmptyState
          title={counts.readyTasks === 0 ? "Nothing is ready to start" : `${counts.readyTasks} ready tasks`}
          body={`${counts.readyTasks} tasks currently match the ready count.`}
        />
      );
    case "blocked":
      return (
        <EmptyState
          title={counts.blockedTasks === 0 ? "No blocked tasks" : `${counts.blockedTasks} blocked tasks`}
          body={`${counts.blockedTasks} tasks currently match the blocked count.`}
        />
      );
    case "graph":
      return <EmptyState title="Graph" body="Dependency graph data is available from the read API." />;
  }
}

/** Render the current hierarchy slice using the final row tokens and local collapse state. */
function BoardPreview({
  board,
  collapsed,
  onOpenEntity,
  showIds,
  toggleCollapsed
}: {
  board: BoardResponse;
  collapsed: Set<string>;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
  toggleCollapsed(id: string): void;
}) {
  return (
    <div className="board-tree">
      {board.epics.map((epic) => (
        <EpicRow
          collapsed={collapsed}
          epic={epic}
          key={epic.id}
          onOpenEntity={onOpenEntity}
          showIds={showIds}
          toggleCollapsed={toggleCollapsed}
        />
      ))}
    </div>
  );
}

/** Render one epic row and its expanded story descendants. */
function EpicRow({
  collapsed,
  epic,
  onOpenEntity,
  showIds,
  toggleCollapsed
}: {
  collapsed: Set<string>;
  epic: BoardEpic;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
  toggleCollapsed(id: string): void;
}) {
  const hasChildren = epic.children.length > 0;
  const open = hasChildren && !collapsed.has(epic.id);

  return (
    <div className="epic-group">
      <HierarchyRow depth={0} onOpen={() => onOpenEntity(epic.id)}>
        {hasChildren ? <ChevronButton open={open} onClick={() => toggleCollapsed(epic.id)} /> : <ChevronPlaceholder />}
        <EntityLabel id={epic.id} showIds={showIds} title={epic.title} strong />
        <RowSpacer />
        <ProgressMeter progress={epic.progress} />
        <StatusBadge status={epic.effectiveStatus} />
      </HierarchyRow>
      {open
        ? epic.children.map((story) => (
            <StoryRow
              collapsed={collapsed}
              key={story.id}
              onOpenEntity={onOpenEntity}
              showIds={showIds}
              story={story}
              toggleCollapsed={toggleCollapsed}
            />
          ))
        : null}
    </div>
  );
}

/** Render one story row and its expanded task leaves. */
function StoryRow({
  collapsed,
  onOpenEntity,
  showIds,
  story,
  toggleCollapsed
}: {
  collapsed: Set<string>;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
  story: BoardStory;
  toggleCollapsed(id: string): void;
}) {
  const hasChildren = story.children.length > 0;
  const open = hasChildren && !collapsed.has(story.id);

  return (
    <>
      <HierarchyRow depth={1} onOpen={() => onOpenEntity(story.id)}>
        {hasChildren ? <ChevronButton open={open} onClick={() => toggleCollapsed(story.id)} /> : <ChevronPlaceholder />}
        <EntityLabel id={story.id} showIds={showIds} title={story.title} strong />
        <RowSpacer />
        <ProgressMeter progress={story.progress} />
        <StatusBadge status={story.effectiveStatus} />
      </HierarchyRow>
      {open ? story.children.map((task) => <TaskRow key={task.id} onOpenEntity={onOpenEntity} showIds={showIds} task={task} />) : null}
    </>
  );
}

/** Render one read-only task row with checkbox and dependency hint. */
function TaskRow({ onOpenEntity, showIds, task }: { onOpenEntity(id: EntityId): void; showIds: boolean; task: BoardTask }) {
  const done = task.status === "done";
  const archived = task.archived === true;
  const waitingOn = blockedByNote(task);

  return (
    <HierarchyRow className={archived ? "board-row-archived" : undefined} depth={2} onOpen={() => onOpenEntity(task.id)}>
      <span className="task-spacer" aria-hidden="true" />
      <ReadOnlyCheckbox checked={done} dimmed={archived} />
      <EntityLabel dim={done || archived} id={task.id} showIds={showIds} title={task.title} />
      {waitingOn === null ? null : <span className="row-detail">{waitingOn}</span>}
      {archived ? <span className="archive-chip">Archived</span> : null}
      <RowSpacer />
      <StatusBadge status={task.effectiveStatus} />
    </HierarchyRow>
  );
}

/** Shared row wrapper that applies the design's depth-based left padding. */
function HierarchyRow({
  children,
  className,
  depth,
  onOpen
}: {
  children: React.ReactNode;
  className?: string;
  depth: 0 | 1 | 2;
  onOpen?(): void;
}) {
  const interactive = onOpen !== undefined;

  return (
    <div
      className={[
        "board-row",
        interactive ? "board-row-interactive" : "",
        className ?? ""
      ]
        .filter(Boolean)
        .join(" ")}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      style={{ "--depth": depth } as CSSProperties}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (interactive && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Render the id/title pair used in hierarchy rows. */
function EntityLabel({
  dim = false,
  id,
  showIds,
  strong = false,
  title
}: {
  dim?: boolean;
  id: string;
  showIds: boolean;
  strong?: boolean;
  title: string;
}) {
  return (
    <>
      {showIds ? (
        <>
          <span className="entity-id">{id}</span>
          <span className="separator" aria-hidden="true">
            .
          </span>
        </>
      ) : null}
      <span className={dim ? "entity-title entity-title-dim" : strong ? "entity-title entity-title-strong" : "entity-title"}>
        {title}
      </span>
    </>
  );
}

/** Render the final read-only checkbox visual used by task rows. */
function ReadOnlyCheckbox({ checked, dimmed = false }: { checked: boolean; dimmed?: boolean }) {
  return (
    <span
      className={[
        "task-check",
        checked ? "task-check-checked" : "",
        dimmed ? "task-check-dimmed" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    >
      {checked ? <CheckIcon small /> : null}
    </span>
  );
}

/** Render one collapsible-row chevron as a local-only control. */
function ChevronButton({ onClick, open }: { onClick(): void; open: boolean }) {
  return (
    <button
      className="chev-btn"
      type="button"
      aria-label={open ? "Collapse row" : "Expand row"}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <ChevronRight open={open} />
    </button>
  );
}

/** Read-only entity drawer with keyboard and relation-chip navigation. */
function EntityDrawer({
  api,
  board,
  initialEntityId,
  projectId,
  refreshToken,
  onClose
}: {
  api: ViewerApiClient;
  board: BoardResponse | null;
  initialEntityId: EntityId;
  projectId: ProjectId;
  refreshToken: number;
  onClose(): void;
}) {
  const [stack, setStack] = useState<EntityId[]>(() => [initialEntityId]);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const currentId = stack.at(-1) ?? initialEntityId;
  const boardIndex = useMemo(() => (board === null ? null : indexBoard(board)), [board]);

  /**
   * Reset the local navigation stack when a different entity is selected outside the drawer.
   */
  useEffect(() => {
    setStack([initialEntityId]);
    setClosing(false);
  }, [initialEntityId]);

  /**
   * Fetch the current drawer entity. The refresh token lets project-scoped WS updates refresh the
   * open payload without creating a browser write path or optimistic state.
   */
  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    api
      .getEntity(projectId, currentId, controller.signal)
      .then((nextDetail) => {
        setDetail(nextDetail);
      })
      .catch((unknownError) => {
        if (!isAbortError(unknownError)) {
          setError(messageFromError(unknownError));
          setDetail(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [api, currentId, projectId, refreshToken]);

  /** Scroll each newly opened entity back to the top of the full-height panel. */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [currentId]);

  /** Clear a pending delayed close if the drawer unmounts during project switching. */
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    []
  );

  const close = useCallback(() => {
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 210);
  }, [onClose]);

  const navigate = useCallback((id: EntityId) => {
    setStack((currentStack) => [...currentStack, id]);
  }, []);

  const back = useCallback(() => {
    setStack((currentStack) => (currentStack.length > 1 ? currentStack.slice(0, -1) : currentStack));
  }, []);

  /**
   * Match the prototype keyboard model: Escape closes; Backspace walks relation history first.
   */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        return;
      }

      if (event.key === "Backspace" && stack.length > 1) {
        event.preventDefault();
        back();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [back, close, stack.length]);

  const relationGroups = detail === null ? [] : detailRelationGroups(detail, boardIndex);

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className={closing ? "drawer-backdrop drawer-backdrop-closing" : "drawer-backdrop"}
        type="button"
        aria-label="Close entity detail drawer"
        onClick={close}
      />
      <aside
        className={closing ? "entity-drawer entity-drawer-closing scroll" : "entity-drawer scroll"}
        ref={scrollRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-drawer-title"
      >
        <header className="drawer-header">
          <div className="drawer-actions">
            {stack.length > 1 ? (
              <button className="drawer-icon-button" type="button" title="Back (Backspace)" onClick={back}>
                <BackIcon />
              </button>
            ) : null}
            <span className="kind-chip">{detail === null ? "Entity" : kindLabel(detail.type)}</span>
            {detail?.archived === true ? <span className="drawer-archive-chip">Archived</span> : null}
            <span className="row-spacer" />
            <button className="drawer-icon-button" type="button" title="Close (Esc)" onClick={close}>
              <CloseIcon />
            </button>
          </div>
          <div className="drawer-title-row">
            <div className="drawer-title-copy">
              <div className="drawer-id">{currentId}</div>
              <h2 id="entity-drawer-title" className={detail?.archived === true ? "drawer-title drawer-title-archived" : "drawer-title"}>
                {detail?.title ?? (isLoading ? "Loading entity" : "Entity unavailable")}
              </h2>
            </div>
            {detail === null ? null : <StatusBadge status={detail.effectiveStatus} />}
          </div>
        </header>

        {error === null ? null : <div className="error-banner">{error}</div>}

        {detail !== null && relationGroups.length > 0 ? (
          <section className="drawer-relations" aria-label="Entity relations">
            {relationGroups.map((group) => (
              <RelationGroup group={group} key={group.label} onNavigate={navigate} />
            ))}
          </section>
        ) : null}

        <section className="drawer-body" aria-label="Entity body">
          {detail === null && isLoading ? <EmptyState title="Loading entity" body="Fetching entity detail." /> : null}
          {detail !== null ? <MarkdownBody source={detail.body} /> : null}
        </section>

        {detail !== null && hasDrawerMeta(detail) ? <DrawerMeta detail={detail} /> : null}
      </aside>
    </div>
  );
}

/** One relation group rendered as compact navigable chips. */
function RelationGroup({ group, onNavigate }: { group: RelationGroupModel; onNavigate(id: EntityId): void }) {
  return (
    <div className="relation-group">
      <div className="relation-label">{group.label}</div>
      <div className="relation-chip-row">
        {group.items.map((item) => (
          <button
            className={item.missing ? "relation-chip relation-chip-missing" : "relation-chip"}
            disabled={item.missing}
            key={item.id}
            type="button"
            title={item.missing ? `${item.id} is not in this project` : item.title ?? item.id}
            onClick={() => onNavigate(item.id)}
          >
            {item.status === null ? null : <span className={`relation-dot relation-dot-${item.status}`} aria-hidden="true" />}
            <span className="relation-id">{item.id}</span>
            {item.title === null ? null : <span className="relation-title">{item.title}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Render drawer Markdown through `react-markdown` with GFM and read-only task checkboxes. */
function MarkdownBody({ source }: { source: string }) {
  if (source.trim().length === 0) {
    return <div className="md md-empty">No description provided.</div>;
  }

  return (
    <div className="md">
      <ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Render optional drawer metadata only when the server supplied values. */
function DrawerMeta({ detail }: { detail: EntityDetail }) {
  return (
    <footer className="drawer-meta">
      <div className="drawer-meta-grid">
        <MetaItem label="Created" value={formatDate(detail.created)} />
        <MetaItem label="Updated" value={formatDate(detail.updated)} />
        {detail.estimate === undefined ? null : <MetaItem label="Estimate" value={String(detail.estimate)} />}
      </div>
      {detail.tags.length === 0 ? null : (
        <div className="tag-row">
          {detail.tags.map((tag) => (
            <span className="tag-pill" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </footer>
  );
}

/** Render one metadata key/value pair with mono value text. */
function MetaItem({ label, value }: { label: string; value: string | null }) {
  if (value === null || value.length === 0) {
    return null;
  }

  return (
    <span className="meta-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

/** Reserve the same row width when an empty composite has no local collapse affordance. */
function ChevronPlaceholder() {
  return <span className="chev-placeholder" aria-hidden="true" />;
}

/** Render descendant progress using the design's faint meter. */
function ProgressMeter({ progress }: { progress: { done: number; total: number } }) {
  if (progress.total === 0) {
    return null;
  }

  const percent = Math.round((progress.done / progress.total) * 100);

  return (
    <span className={percent === 100 ? "progress-meter progress-meter-complete" : "progress-meter"}>
      <span className="progress-track">
        <span className="progress-fill" style={{ width: `${percent}%` }} />
      </span>
      <span>
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

/** Keep row metadata aligned to the right edge. */
function RowSpacer() {
  return <span className="row-spacer" />;
}

/** Render a status badge whose colors match the CSS/Mermaid status contract. */
function StatusBadge({ status }: { status: EffectiveStatus }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

/** Render a centered state block without introducing mutation affordances. */
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <BoardIcon />
      </span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/** Relation chip model after joining ids against the active board snapshot where possible. */
interface RelationChipModel {
  /** Entity id used as the navigation target. */
  id: EntityId;
  /** Best-effort title for active board entities; null for missing or not-yet-loaded relations. */
  title: string | null;
  /** Best-effort computed status used for the relation status dot. */
  status: EffectiveStatus | null;
  /** Whether the endpoint has proven this relation is not resolvable. */
  missing: boolean;
}

/** Named drawer relation group. */
interface RelationGroupModel {
  /** Section label rendered in the drawer relations region. */
  label: string;
  /** Relation chips in deterministic API order. */
  items: RelationChipModel[];
}

/**
 * Convert entity relationship ids into visible relation groups.
 *
 * The Phase 6 server returns canonical ids for parent/dependencies/dependents. The drawer enriches
 * those ids from the active board snapshot when possible, but keeps chips navigable because direct
 * entity reads can resolve archived entities that collection endpoints intentionally omit.
 */
function detailRelationGroups(detail: EntityDetail, boardIndex: ReturnType<typeof indexBoard> | null): RelationGroupModel[] {
  const groups: RelationGroupModel[] = [];

  if (detail.parent !== null) {
    groups.push({ label: "Parent", items: [relationChip(detail.parent, boardIndex)] });
  }

  if (detail.dependsOn.length > 0) {
    groups.push({ label: "Depends on", items: detail.dependsOn.map((id) => relationChip(id, boardIndex)) });
  }

  if (detail.dependents.length > 0) {
    groups.push({ label: "Blocks", items: detail.dependents.map((id) => relationChip(id, boardIndex)) });
  }

  return groups;
}

/**
 * Join one relation id against active board data without treating board absence as missing.
 */
function relationChip(id: EntityId, boardIndex: ReturnType<typeof indexBoard> | null): RelationChipModel {
  const entity = boardIndex?.byId.get(id);

  return {
    id,
    title: entity?.title ?? null,
    status: entity?.effectiveStatus ?? null,
    missing: false
  };
}

/** Return the display label for one entity type chip. */
function kindLabel(type: EntityType): string {
  switch (type) {
    case "epic":
      return "Epic";
    case "story":
      return "Story";
    case "task":
      return "Task";
  }
}

/** Determine whether the metadata footer has anything useful to render. */
function hasDrawerMeta(detail: EntityDetail): boolean {
  return detail.created.length > 0 || detail.updated.length > 0 || detail.estimate !== undefined || detail.tags.length > 0;
}

/** Format frontmatter timestamps into compact local dates while preserving unparseable values. */
function formatDate(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Keep rendered Markdown links on ordinary web/mail targets.
 *
 * Returning `undefined` strips suspicious protocols from the anchor while still showing its label.
 */
function safeMarkdownHref(href: string | undefined): string | undefined {
  if (href === undefined || href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) {
    return href;
  }

  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Convert API and transport errors into short user-facing text. */
function messageFromError(error: unknown): string {
  if (error instanceof ViewerApiError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown viewer API error.";
}

/** Identify aborts so normal project switching does not flash an error banner. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Format the live timestamp with stable, compact copy. */
function relativeTime(date: Date | null): string {
  if (date === null) {
    return "subscribed";
  }

  const elapsedSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (elapsedSeconds < 5) {
    return "updated just now";
  }

  if (elapsedSeconds < 60) {
    return `updated ${elapsedSeconds}s ago`;
  }

  return `updated ${Math.floor(elapsedSeconds / 60)}m ago`;
}

/** Inline icon for the project menu checkmark and task checkbox. */
function CheckIcon({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? "icon icon-small" : "icon"} viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.4 L5.8 10.1 L11 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline icon for the project picker dropdown. */
function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg className={open ? "icon chevron-down chevron-down-open" : "icon chevron-down"} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline icon for tree expansion. */
function ChevronRight({ open }: { open: boolean }) {
  return (
    <svg className={open ? "icon chevron-right chevron-right-open" : "icon chevron-right"} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline lock icon used by the immutable viewer chip. */
function LockIcon() {
  return (
    <svg className="icon icon-small" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M5 6 V4.2a2 2 0 1 1 4 0V6" fill="none" stroke="currentColor" strokeLinecap="round" />
      <rect x="3" y="6" width="8" height="6" rx="1.5" fill="none" stroke="currentColor" />
    </svg>
  );
}

/** Inline icon used by empty states. */
function BoardIcon() {
  return (
    <svg className="icon icon-large" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="3" fill="none" stroke="currentColor" />
      <path d="M7 8h6M7 12h4" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline icon for drawer history navigation. */
function BackIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3.5 L5.5 8 L10 12.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Inline icon for closing the drawer. */
function CloseIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

// Vite serves `index.html`, which owns the root element that React mounts into.
const rootElement = document.getElementById("root");

if (!rootElement) {
  // Failing fast makes an HTML/template mismatch obvious during local development and CI builds.
  throw new Error("Root element not found");
}

// StrictMode surfaces unsafe React patterns while the viewer shell is still being assembled.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
