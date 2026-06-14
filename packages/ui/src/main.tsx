import {
  StrictMode,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
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
  type GraphResponse,
  type ProjectId,
  type ProjectSummary,
  type ValidationIssue,
  type ViewerApiClient,
  ViewerApiError,
  createViewerApiClient
} from "./api";
import {
  blockedByNote,
  blockedTasks,
  buildTaskGraph,
  collapsibleBoardIds,
  graphDisplayStatus,
  indexBoard,
  layoutGraph,
  readyTasks,
  summarizeBoard,
  toMermaid,
  type BlockedTaskRow,
  type BoardCounts,
  type GraphDisplayStatus,
  type GraphScope,
  type GraphViewEntity,
  type GraphViewModel,
  type IndexedBoardTask
} from "./derived";
import "./styles.css";

/** The read-only shell tabs promised by the UI design. */
type ViewerTab = "board" | "ready" | "blocked" | "graph";

/** Graph renderer modes from the UI design. */
type GraphMode = "mermaid" | "interactive";

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
  /** Same-type dependency graph for the selected project, or null until it has loaded. */
  graph: GraphResponse | null;
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

/** Status filter order from the high-fidelity graph toolbar. */
const GRAPH_STATUS_ORDER = ["todo", "in-progress", "blocked", "done"] as const satisfies readonly GraphDisplayStatus[];

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
  const [data, setData] = useState<ProjectDataState>({ board: null, graph: null });
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
  const selectedProjectRef = useRef<ProjectId | null>(selectedProjectId);
  const refreshSequenceRef = useRef(0);

  /**
   * Keep async refresh completions scoped to the currently selected project.
   *
   * WebSocket-triggered reads are intentionally not tied to the project-switch abort controller, so
   * this ref prevents a slow response for the previous project from replacing the active snapshot.
   */
  useEffect(() => {
    selectedProjectRef.current = selectedProjectId;
  }, [selectedProjectId]);

  /**
   * Fetch the selected project's board and graph as one read-only snapshot.
   *
   * The graph view joins the hierarchy from `/board` with same-type edges from `/graph`, so both
   * reads refresh together after project switches and WebSocket pushes.
   */
  const refreshProjectData = useCallback(
    async (projectId: ProjectId, signal?: AbortSignal) => {
      const refreshSequence = refreshSequenceRef.current + 1;
      refreshSequenceRef.current = refreshSequence;

      setIsLoadingProjectData(true);
      setError(null);

      try {
        const [board, graph] = await Promise.all([api.getBoard(projectId, signal), api.getGraph(projectId, signal)]);
        if (
          signal?.aborted === true ||
          selectedProjectRef.current !== projectId ||
          refreshSequenceRef.current !== refreshSequence
        ) {
          return;
        }

        setData({ board, graph });
        setLastUpdatedAt(new Date());
      } catch (unknownError) {
        if (
          !isAbortError(unknownError) &&
          selectedProjectRef.current === projectId &&
          refreshSequenceRef.current === refreshSequence
        ) {
          setError(messageFromError(unknownError));
          setData({ board: null, graph: null });
        }
      } finally {
        if (
          signal?.aborted !== true &&
          selectedProjectRef.current === projectId &&
          refreshSequenceRef.current === refreshSequence
        ) {
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
      setData({ board: null, graph: null });
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
            setPulseToken((currentToken) => currentToken + 1);
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
          <ValidationWarningsPanel board={data.board} onOpenEntity={openEntity} />
          <ActiveView
            board={data.board}
            collapsed={collapsed}
            counts={counts}
            graph={data.graph}
            isLoading={isLoadingProjects || isLoadingProjectData}
            onOpenEntity={openEntity}
            preferences={preferences}
            projectId={selectedProjectId}
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

/** Surface allowed `validate()` warnings from the board read model without exposing any write path. */
function ValidationWarningsPanel({
  board,
  onOpenEntity
}: {
  board: BoardResponse | null;
  onOpenEntity(id: EntityId): void;
}) {
  const warnings = board?.validationWarnings ?? [];

  if (warnings.length === 0) {
    return null;
  }

  return (
    <aside className="validation-panel" aria-label="Validation warnings">
      <div className="validation-panel-header">
        <span className="validation-icon" aria-hidden="true">
          <WarningIcon />
        </span>
        <div>
          <strong>{warnings.length === 1 ? "1 validation warning" : `${warnings.length} validation warnings`}</strong>
          <p>These findings do not block the project, but they may affect planning decisions.</p>
        </div>
      </div>
      <div className="validation-list" role="list">
        {warnings.map((warning) => (
          <ValidationWarningRow key={validationWarningKey(warning)} warning={warning} onOpenEntity={onOpenEntity} />
        ))}
      </div>
    </aside>
  );
}

/** Render one warning as diagnostics plus a drawer-opening entity chip when validation supplied one. */
function ValidationWarningRow({
  onOpenEntity,
  warning
}: {
  onOpenEntity(id: EntityId): void;
  warning: ValidationIssue;
}) {
  const entityId = warning.entityId;

  return (
    <div className="validation-row" role="listitem">
      <span className="validation-code">{warning.code}</span>
      <span className="validation-message">{warning.message}</span>
      {entityId === undefined ? null : (
        <button className="validation-entity" type="button" onClick={() => onOpenEntity(entityId)}>
          {entityId}
        </button>
      )}
    </div>
  );
}

/** Build a deterministic React key for validation warnings, including message to preserve duplicates. */
function validationWarningKey(warning: ValidationIssue): string {
  return `${warning.code}:${warning.entityId ?? "project"}:${warning.message}`;
}

/** Select the currently active read-only view for the loaded board. */
function ActiveView({
  board,
  collapsed,
  counts,
  graph,
  isLoading,
  onOpenEntity,
  preferences,
  projectId,
  showIds,
  tab,
  toggleCollapsed
}: {
  board: BoardResponse | null;
  collapsed: Set<string>;
  counts: BoardCounts;
  graph: GraphResponse | null;
  isLoading: boolean;
  onOpenEntity(id: EntityId): void;
  preferences: ViewerPreferences;
  projectId: ProjectId | null;
  showIds: boolean;
  tab: ViewerTab;
  toggleCollapsed(id: string): void;
}) {
  if (isLoading) {
    return <EmptyState title="Loading project data" body="Fetching project data." />;
  }

  if (board === null) {
    return <EmptyState title="This project has no entities yet" body="Tracked epics, stories, and tasks will appear here." />;
  }

  switch (tab) {
    case "board":
      if (board.epics.length === 0) {
        return <EmptyState title="This project has no entities yet" body="Tracked epics, stories, and tasks will appear here." />;
      }

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
      return <ReadyView board={board} onOpenEntity={onOpenEntity} showIds={showIds} />;
    case "blocked":
      return <BlockedView board={board} onOpenEntity={onOpenEntity} showIds={showIds} />;
    case "graph":
      if (graph === null) {
        return <EmptyState title="Graph unavailable" body="Dependency graph data could not be loaded from the read API." />;
      }

      return <GraphView board={board} graph={graph} onOpenEntity={onOpenEntity} preferences={preferences} projectId={projectId} />;
  }
}

/** Render the read-only dependency graph tab in canonical Mermaid mode. */
function GraphView({
  board,
  graph,
  onOpenEntity,
  preferences,
  projectId
}: {
  board: BoardResponse;
  graph: GraphResponse;
  onOpenEntity(id: EntityId): void;
  preferences: ViewerPreferences;
  projectId: ProjectId | null;
}) {
  const [mode, setMode] = useState<GraphMode>("mermaid");
  const [scope, setScope] = useState<GraphScope>({ type: "full" });
  const [activeStatuses, setActiveStatuses] = useState<Set<GraphDisplayStatus>>(() => new Set(GRAPH_STATUS_ORDER));
  const [fitToken, setFitToken] = useState(0);
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const graphModel = useMemo(() => buildTaskGraph(board, graph, scope), [board, graph, scope]);
  const visibleGraph = useMemo(() => filterGraphByStatus(graphModel, activeStatuses), [activeStatuses, graphModel]);
  const statusCounts = useMemo(() => graphStatusCounts(graphModel), [graphModel]);
  const dense = graphModel.totalTasks > 30 && scope.type === "full";

  /**
   * Reset graph-local controls when the server project payload changes underneath the current tab.
   */
  useEffect(() => {
    setScope({ type: "full" });
    setActiveStatuses(new Set(GRAPH_STATUS_ORDER));
    setScopeOpen(false);
  }, [projectId]);

  /** Close the scope popover on outside clicks without adding any write interaction. */
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (scopeRef.current !== null && !scopeRef.current.contains(event.target as Node)) {
        setScopeOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const toggleStatus = useCallback((status: GraphDisplayStatus) => {
    setActiveStatuses((currentStatuses) => {
      const nextStatuses = new Set(currentStatuses);
      if (nextStatuses.has(status)) {
        nextStatuses.delete(status);
      } else {
        nextStatuses.add(status);
      }
      return nextStatuses;
    });
  }, []);

  const scopeLabel = scope.type === "full" ? "Full graph" : `${scope.id} subgraph`;
  const renderedGraph = mode === "mermaid" ? visibleGraph : graphModel;
  const emptyTitle = graphModel.totalTasks === 0 ? "No tasks to graph yet" : "No tasks match the current filters";
  const emptyBody =
    graphModel.totalTasks === 0
      ? scope.type === "epic"
        ? "This epic has no active task nodes in the dependency graph."
        : "Once this project has active tasks, their dependency graph will render here automatically."
      : "Re-enable one or more status filters to show nodes in the Mermaid diagram.";

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <div className="segmented-control" aria-label="Graph mode">
          <button
            className={mode === "mermaid" ? "segment segment-active" : "segment"}
            type="button"
            aria-pressed={mode === "mermaid"}
            onClick={() => setMode("mermaid")}
          >
            Mermaid
          </button>
          <button
            className={mode === "interactive" ? "segment segment-active" : "segment"}
            type="button"
            aria-pressed={mode === "interactive"}
            onClick={() => setMode("interactive")}
          >
            Interactive
          </button>
        </div>

        <div className="graph-scope" ref={scopeRef}>
          <button
            className="scope-trigger"
            type="button"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((wasOpen) => !wasOpen)}
          >
            <GraphIcon />
            <span>{scopeLabel}</span>
            <ChevronDown open={scopeOpen} />
          </button>
          {scopeOpen ? (
            <div className="scope-menu scroll" role="menu">
              <ScopeOption
                active={scope.type === "full"}
                label="Full graph"
                meta={`${graphModel.totalTasks} tasks`}
                onClick={() => {
                  setScope({ type: "full" });
                  setScopeOpen(false);
                }}
              />
              <div className="scope-divider" />
              <div className="menu-label">Per epic</div>
              {graphModel.epics.map((epic) => (
                <ScopeOption
                  active={scope.type === "epic" && scope.id === epic.id}
                  key={epic.id}
                  label={epic.id}
                  meta={`${epic.taskCount} tasks . ${epic.title}`}
                  onClick={() => {
                    setScope({ type: "epic", id: epic.id });
                    setScopeOpen(false);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <span className="graph-toolbar-divider" aria-hidden="true" />

        <div className="status-filter-row" aria-label="Graph status filters">
          {GRAPH_STATUS_ORDER.map((status) => (
            <StatusFilterChip
              active={activeStatuses.has(status)}
              count={statusCounts[status]}
              key={status}
              status={status}
              onToggle={() => toggleStatus(status)}
            />
          ))}
        </div>
        {mode === "interactive" ? (
          <button className="graph-fit-button" type="button" onClick={() => setFitToken((currentToken) => currentToken + 1)}>
            Fit
          </button>
        ) : null}
      </div>

      {dense ? (
        <div className="graph-density-hint">
          <InfoIcon />
          <span>
            This project has <strong>{graphModel.totalTasks} tasks</strong>. Use the scope selector to inspect one epic at a time.
          </span>
        </div>
      ) : null}

      <div className="graph-canvas">
        {renderedGraph.entities.length === 0 ? (
          <GraphEmpty title={emptyTitle} body={emptyBody} />
        ) : mode === "interactive" ? (
          <InteractiveGraph
            activeStatuses={activeStatuses}
            fitToken={fitToken}
            graph={graphModel}
            onOpenEntity={onOpenEntity}
          />
        ) : (
          <MermaidGraph
            accent={preferences.accent}
            dark={preferences.dark}
            graph={visibleGraph}
            onOpenEntity={onOpenEntity}
          />
        )}
      </div>
    </div>
  );
}

/** Render one graph scope selector option without mutating project state. */
function ScopeOption({
  active,
  label,
  meta,
  onClick
}: {
  active: boolean;
  label: string;
  meta: string;
  onClick(): void;
}) {
  return (
    <button className={active ? "scope-option scope-option-active" : "scope-option"} type="button" role="menuitemradio" aria-checked={active} onClick={onClick}>
      <span className="scope-option-id">{label}</span>
      <span className="scope-option-meta">{meta}</span>
    </button>
  );
}

/** Render a status filter chip whose colors match the Mermaid status contract. */
function StatusFilterChip({
  active,
  count,
  status,
  onToggle
}: {
  active: boolean;
  count: number;
  status: GraphDisplayStatus;
  onToggle(): void;
}) {
  return (
    <button
      className={active ? `status-filter status-filter-${status} status-filter-active` : `status-filter status-filter-${status}`}
      type="button"
      aria-pressed={active}
      onClick={onToggle}
    >
      <span className="status-filter-dot" aria-hidden="true" />
      <span>{status}</span>
      <span className="status-filter-count">{count}</span>
    </button>
  );
}

/** Render Mermaid SVG from the scoped graph and attach drawer navigation to task nodes. */
function MermaidGraph({
  accent,
  dark,
  graph,
  onOpenEntity
}: {
  accent: string;
  dark: boolean;
  graph: GraphViewModel;
  onOpenEntity(id: EntityId): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const mermaidId = useMemo(() => `mmd-${Math.random().toString(36).slice(2, 10)}`, []);
  const definition = useMemo(() => toMermaid(graph.entities, graph.edges), [graph]);

  /**
   * Mermaid owns the SVG DOM. After render, this hook binds read-only node navigation into the
   * existing drawer rather than introducing any graph mutation control.
   */
  useEffect(() => {
    let cancelled = false;
    const rootStyle = getComputedStyle(document.documentElement);

    async function renderMermaid() {
      const mermaidModule = await import("mermaid");
      const renderer = mermaidModule.default;

      renderer.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        fontFamily: rootStyle.getPropertyValue("--font-sans") || "sans-serif",
        themeVariables: {
          background: "transparent",
          fontSize: "13px",
          lineColor: dark ? "#8b949e" : "#8c959f",
          primaryColor: "transparent",
          primaryBorderColor: accent,
          primaryTextColor: dark ? "#e6edf3" : "#1f2328"
        },
        flowchart: {
          curve: "basis",
          htmlLabels: true,
          nodeSpacing: 38,
          rankSpacing: 64,
          useMaxWidth: false
        }
      });

      const { svg, bindFunctions } = await renderer.render(mermaidId, definition);

      return { svg, bindFunctions };
    }

    renderMermaid()
      .then(({ svg, bindFunctions }) => {
        if (cancelled || containerRef.current === null) {
          return;
        }

        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);
        bindMermaidNodeClicks(containerRef.current, graph.entities, onOpenEntity);
        setRenderError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRenderError(messageFromError(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accent, dark, definition, graph.entities, mermaidId, onOpenEntity]);

  if (renderError !== null) {
    return <div className="graph-render-error">Mermaid render error: {renderError}</div>;
  }

  return (
    <div className="mermaid-scroll scroll">
      <div className="mermaid-output" ref={containerRef} aria-label="Task dependency Mermaid graph" />
    </div>
  );
}

/** Transform state for the hand-rolled interactive SVG graph. */
interface GraphViewport {
  /** Horizontal pan in screen pixels. */
  x: number;
  /** Vertical pan in screen pixels. */
  y: number;
  /** Zoom scale, clamped to the design's useful range. */
  z: number;
}

/** Render the pan/zoom SVG graph while preserving read-only node navigation. */
function InteractiveGraph({
  activeStatuses,
  fitToken,
  graph,
  onOpenEntity
}: {
  activeStatuses: Set<GraphDisplayStatus>;
  fitToken: number;
  graph: GraphViewModel;
  onOpenEntity(id: EntityId): void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const movedRef = useRef(false);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [view, setView] = useState<GraphViewport>({ x: 40, y: 40, z: 1 });
  const layout = useMemo(() => layoutGraph(graph.entities, graph.edges), [graph.edges, graph.entities]);
  const entityById = useMemo(() => new Map(graph.entities.map((entity) => [entity.id, entity])), [graph.entities]);
  const arrowId = useMemo(() => `interactive-arrow-${Math.random().toString(36).slice(2, 10)}`, []);
  const dimArrowId = `${arrowId}-dim`;

  /** Measure the SVG viewport so fitting and zoom controls respond to card resizing. */
  useLayoutEffect(() => {
    if (containerRef.current === null) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) {
        return;
      }

      setSize((currentSize) => {
        const nextSize = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
        return currentSize.width === nextSize.width && currentSize.height === nextSize.height ? currentSize : nextSize;
      });
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  /** Fit the current layout into the visible canvas with a stable amount of visual padding. */
  const fitToView = useCallback(() => {
    if (layout.width <= 0 || layout.height <= 0) {
      return;
    }

    const padding = 56;
    const nextZoom = clampZoom(Math.min(size.width / (layout.width + padding * 2), size.height / (layout.height + padding * 2), 1.1));

    setView({
      x: (size.width - layout.width * nextZoom) / 2,
      y: (size.height - layout.height * nextZoom) / 2,
      z: nextZoom
    });
  }, [layout.height, layout.width, size.height, size.width]);

  /** Auto-fit on data changes, size changes, and explicit toolbar/cluster fit requests. */
  useEffect(() => {
    fitToView();
  }, [fitToView, fitToken]);

  /** Start a pan gesture without preventing a subsequent no-move node click. */
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      dragRef.current = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
      movedRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [view.x, view.y]
  );

  /** Pan the whole graph group while remembering whether the gesture became a drag. */
  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      movedRef.current = true;
    }

    setView((currentView) => ({ ...currentView, x: drag.originX + dx, y: drag.originY + dy }));
  }, []);

  /** End the current pan gesture; the click handler still reads `movedRef` for node selection. */
  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /** Zoom around the cursor position so the user's focus point remains stable. */
  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (containerRef.current === null) {
      return;
    }

    event.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;

    setView((currentView) => zoomViewport(currentView, factor, mouseX, mouseY));
  }, []);

  /** Zoom from explicit controls around the visible center of the graph canvas. */
  const zoomFromCenter = useCallback(
    (factor: number) => {
      setView((currentView) => zoomViewport(currentView, factor, size.width / 2, size.height / 2));
    },
    [size.height, size.width]
  );

  /** Open a node only when the last pointer gesture was a click, not a drag. */
  const handleNodeClick = useCallback(
    (id: EntityId) => {
      if (!movedRef.current) {
        onOpenEntity(id);
      }
    },
    [onOpenEntity]
  );

  return (
    <div
      className="interactive-graph"
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <svg className="interactive-graph-svg" width={size.width} height={size.height} aria-label="Interactive task dependency graph">
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" />
          </marker>
          <marker id={dimArrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.z})`}>
          {graph.edges.map((edge) => (
            <InteractiveGraphEdge
              activeStatuses={activeStatuses}
              edge={edge}
              entityById={entityById}
              key={`${edge.from}->${edge.to}`}
              layout={layout}
              markerId={arrowId}
              dimMarkerId={dimArrowId}
            />
          ))}
          {graph.entities.map((entity) => (
            <InteractiveGraphNode
              active={activeStatuses.has(graphDisplayStatus(entity.effectiveStatus))}
              entity={entity}
              key={entity.id}
              layout={layout}
              onOpenEntity={handleNodeClick}
            />
          ))}
        </g>
      </svg>

      <div className="zoom-cluster" onPointerDown={(event) => event.stopPropagation()}>
        <ZoomButton label="Zoom in" onClick={() => zoomFromCenter(1.2)}>
          <ZoomInIcon />
        </ZoomButton>
        <ZoomButton label="Zoom out" onClick={() => zoomFromCenter(1 / 1.2)}>
          <ZoomOutIcon />
        </ZoomButton>
        <ZoomButton label="Fit graph" onClick={fitToView}>
          <FitIcon />
        </ZoomButton>
      </div>
      <div className="zoom-readout">{Math.round(view.z * 100)}% . drag to pan . scroll to zoom</div>
    </div>
  );
}

/** Render one prerequisite-to-dependent curve with dimming tied to the endpoint filters. */
function InteractiveGraphEdge({
  activeStatuses,
  dimMarkerId,
  edge,
  entityById,
  layout,
  markerId
}: {
  activeStatuses: Set<GraphDisplayStatus>;
  dimMarkerId: string;
  edge: GraphViewModel["edges"][number];
  entityById: Map<EntityId, GraphViewEntity>;
  layout: ReturnType<typeof layoutGraph>;
  markerId: string;
}) {
  const from = layout.pos[edge.from];
  const to = layout.pos[edge.to];
  const fromEntity = entityById.get(edge.from);
  const toEntity = entityById.get(edge.to);

  if (from === undefined || to === undefined || fromEntity === undefined || toEntity === undefined) {
    return null;
  }

  const x1 = from.x + layout.nodeW;
  const y1 = from.y + layout.nodeH / 2;
  const x2 = to.x;
  const y2 = to.y + layout.nodeH / 2;
  const midX = (x1 + x2) / 2;
  const dimmed =
    !activeStatuses.has(graphDisplayStatus(fromEntity.effectiveStatus)) ||
    !activeStatuses.has(graphDisplayStatus(toEntity.effectiveStatus));

  return (
    <path
      className={dimmed ? "interactive-edge interactive-edge-dimmed" : "interactive-edge"}
      d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
      markerEnd={`url(#${dimmed ? dimMarkerId : markerId})`}
    />
  );
}

/** Render one interactive task node with stored-status fill and computed-status filter dimming. */
function InteractiveGraphNode({
  active,
  entity,
  layout,
  onOpenEntity
}: {
  active: boolean;
  entity: GraphViewEntity;
  layout: ReturnType<typeof layoutGraph>;
  onOpenEntity(id: EntityId): void;
}) {
  const position = layout.pos[entity.id];

  if (position === undefined) {
    return null;
  }

  return (
    <g
      className={[
        "interactive-node",
        `interactive-node-${entity.status}`,
        active ? "" : "interactive-node-dimmed"
      ]
        .filter(Boolean)
        .join(" ")}
      transform={`translate(${position.x},${position.y})`}
      role="button"
      tabIndex={0}
      aria-label={`Open ${entity.id}`}
      onClick={() => onOpenEntity(entity.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenEntity(entity.id);
        }
      }}
    >
      <rect className="interactive-node-box" width={layout.nodeW} height={layout.nodeH} rx="9" />
      <circle className="interactive-node-dot" cx="14" cy={layout.nodeH / 2} r="4" />
      <text className="interactive-node-id" x="26" y={layout.nodeH / 2 - 4}>
        {entity.id}
      </text>
      <text className="interactive-node-title" x="26" y={layout.nodeH / 2 + 11}>
        {truncateGraphTitle(entity.title)}
      </text>
    </g>
  );
}

/** Render one compact zoom control button. */
function ZoomButton({ children, label, onClick }: { children: ReactNode; label: string; onClick(): void }) {
  return (
    <button className="zoom-button" type="button" title={label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Clamp zoom to the interaction range documented for the graph prototype. */
function clampZoom(value: number): number {
  return Math.min(2.4, Math.max(0.18, value));
}

/** Calculate a new viewport scale around a fixed screen coordinate. */
function zoomViewport(view: GraphViewport, factor: number, centerX: number, centerY: number): GraphViewport {
  const nextZoom = clampZoom(view.z * factor);
  const ratio = nextZoom / view.z;

  return {
    z: nextZoom,
    x: centerX - (centerX - view.x) * ratio,
    y: centerY - (centerY - view.y) * ratio
  };
}

/** Keep SVG node titles compact without relying on unsupported SVG text wrapping. */
function truncateGraphTitle(title: string): string {
  return title.length > 18 ? `${title.slice(0, 17)}...` : title;
}

/** Render the Graph tab's empty-state icon and copy. */
function GraphEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="graph-empty">
      <span className="empty-icon" aria-hidden="true">
        <GraphIcon large />
      </span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/** Return a filtered graph for Mermaid mode, dropping edges whose endpoints are hidden. */
function filterGraphByStatus(graph: GraphViewModel, activeStatuses: Set<GraphDisplayStatus>): GraphViewModel {
  const entities = graph.entities.filter((entity) => activeStatuses.has(graphDisplayStatus(entity.effectiveStatus)));
  const visibleIds = new Set(entities.map((entity) => entity.id));

  return {
    ...graph,
    entities,
    edges: graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to))
  };
}

/** Count scoped task nodes by the four graph palette statuses. */
function graphStatusCounts(graph: GraphViewModel): Record<GraphDisplayStatus, number> {
  const counts: Record<GraphDisplayStatus, number> = {
    blocked: 0,
    done: 0,
    "in-progress": 0,
    todo: 0
  };

  for (const entity of graph.entities) {
    counts[graphDisplayStatus(entity.effectiveStatus)] += 1;
  }

  return counts;
}

/** Attach pointer and keyboard handlers to Mermaid node groups after SVG generation. */
function bindMermaidNodeClicks(root: HTMLElement, entities: ReadonlyArray<{ id: EntityId }>, onOpenEntity: (id: EntityId) => void): void {
  const keyToId = new Map(entities.map((entity) => [mermaidNodeKey(entity.id), entity.id]));

  root.querySelectorAll<SVGGElement>("g.node").forEach((node) => {
    const nodeId = mermaidNodeId(node.id);
    const entityId = nodeId === null ? null : keyToId.get(nodeId) ?? null;

    if (entityId === null) {
      return;
    }

    node.style.cursor = "pointer";
    node.setAttribute("role", "button");
    node.setAttribute("tabindex", "0");
    node.setAttribute("aria-label", `Open ${entityId}`);
    node.addEventListener("click", () => onOpenEntity(entityId));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenEntity(entityId);
      }
    });
  });
}

/** Convert an entity id to the same Mermaid-safe key used by `toMermaid`. */
function mermaidNodeKey(id: EntityId): string {
  const sanitized = id.replace(/[^A-Za-z0-9]/g, "");
  return `n${sanitized.length === 0 ? "node" : sanitized}`;
}

/** Extract the generated Mermaid node key from current Mermaid flowchart group ids. */
function mermaidNodeId(id: string): string | null {
  return id.match(/flowchart-(n[A-Za-z0-9]+)-/)?.[1] ?? null;
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

/** Render tasks that are immediately workable according to the derived ready rule. */
function ReadyView({
  board,
  onOpenEntity,
  showIds
}: {
  board: BoardResponse;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
}) {
  const rows = readyTasks(board);

  return (
    <FlatViewShell
      hint="Tasks shown here are still todo and have no unfinished task dependencies."
      emptyTitle="Nothing is ready to start."
      emptyBody="Todo tasks will appear here once every prerequisite task is done."
      isEmpty={rows.length === 0}
    >
      <div className="flat-list" role="list" aria-label="Ready tasks">
        {rows.map((row) => (
          <ReadyTaskRow key={row.task.id} row={row} onOpenEntity={onOpenEntity} showIds={showIds} />
        ))}
      </div>
    </FlatViewShell>
  );
}

/** Render one ready task as the flat, drawer-opening row promised by the UI design. */
function ReadyTaskRow({
  onOpenEntity,
  row,
  showIds
}: {
  onOpenEntity(id: EntityId): void;
  row: IndexedBoardTask;
  showIds: boolean;
}) {
  return (
    <FlatTaskButton className="flat-row" id={row.task.id} onOpenEntity={onOpenEntity}>
      <ReadOnlyCheckbox checked={false} />
      <EntityLabel id={row.task.id} showIds={showIds} title={row.task.title} />
      <Breadcrumb epic={row.epic} story={row.story} />
      <RowSpacer />
      <StatusBadge status="todo" />
    </FlatTaskButton>
  );
}

/** Render stored/computed blocked tasks with the blocker ids that explain the current gate. */
function BlockedView({
  board,
  onOpenEntity,
  showIds
}: {
  board: BoardResponse;
  onOpenEntity(id: EntityId): void;
  showIds: boolean;
}) {
  const rows = blockedTasks(board);

  return (
    <FlatViewShell
      hint="Blocked lists tasks whose server-computed effective status is blocked and includes the ids currently holding them."
      emptyTitle="No blocked tasks."
      emptyBody="Tasks with unresolved blockers will appear here with their waiting-on chips."
      isEmpty={rows.length === 0}
    >
      <div className="flat-list blocked-list" role="list" aria-label="Blocked tasks">
        {rows.map((row) => (
          <BlockedTaskBlock key={row.task.id} row={row} onOpenEntity={onOpenEntity} showIds={showIds} />
        ))}
      </div>
    </FlatViewShell>
  );
}

/** Render one blocked task and its wrapped blocker chip row. */
function BlockedTaskBlock({
  onOpenEntity,
  row,
  showIds
}: {
  onOpenEntity(id: EntityId): void;
  row: BlockedTaskRow;
  showIds: boolean;
}) {
  return (
    <FlatTaskButton className="blocked-block" id={row.task.id} onOpenEntity={onOpenEntity}>
      <span className="blocked-main-line">
        <ReadOnlyCheckbox checked={false} />
        <EntityLabel id={row.task.id} showIds={showIds} title={row.task.title} />
        <Breadcrumb epic={row.epic} story={row.story} />
        <RowSpacer />
        <StatusBadge status="blocked" />
      </span>
      <span className="blocker-line">
        <span className="blocker-label">waiting on</span>
        <span className="blocker-chip-row">
          {row.blockers.length === 0 ? (
            <span className="blocker-chip blocker-chip-missing">No blocker ids reported</span>
          ) : (
            row.blockers.map((blocker) => <BlockerChip blocker={blocker} key={blocker.id} />)
          )}
        </span>
      </span>
    </FlatTaskButton>
  );
}

/** Shared shell for the Ready and Blocked tabs, including their explanatory design hint. */
function FlatViewShell({
  children,
  emptyBody,
  emptyTitle,
  hint,
  isEmpty
}: {
  children: React.ReactNode;
  emptyBody: string;
  emptyTitle: string;
  hint: string;
  isEmpty: boolean;
}) {
  return (
    <div className="flat-view">
      <div className="view-hint">{hint}</div>
      {isEmpty ? <EmptyState title={emptyTitle} body={emptyBody} /> : children}
    </div>
  );
}

/** Keyboard-accessible flat task wrapper that opens the read-only drawer but never mutates state. */
function FlatTaskButton({
  children,
  className,
  id,
  onOpenEntity
}: {
  children: React.ReactNode;
  className: string;
  id: EntityId;
  onOpenEntity(id: EntityId): void;
}) {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      onClick={() => onOpenEntity(id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenEntity(id);
        }
      }}
    >
      {children}
    </div>
  );
}

/** Render the flat-view ancestor breadcrumb in mono text. */
function Breadcrumb({ epic, story }: { epic: BoardEpic; story: BoardStory }) {
  return (
    <span className="breadcrumb">
      {epic.id} &gt; {story.id}
    </span>
  );
}

/** Render one blocker relation chip without making the dependency chip itself a mutation control. */
function BlockerChip({ blocker }: { blocker: BlockedTaskRow["blockers"][number] }) {
  const dotStatus = blocker.status ?? "empty";

  return (
    <span className={blocker.missing ? "blocker-chip blocker-chip-missing" : "blocker-chip"}>
      <span className={`relation-dot relation-dot-${dotStatus}`} aria-hidden="true" />
      <span className="blocker-id">{blocker.id}</span>
      {blocker.title === null ? null : <span className="blocker-title">{blocker.title}</span>}
    </span>
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

/** Inline graph icon used by graph scope controls and empty states. */
function GraphIcon({ large = false }: { large?: boolean }) {
  return (
    <svg className={large ? "icon icon-large" : "icon"} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="5" cy="10" r="2.2" fill="none" stroke="currentColor" />
      <circle cx="15" cy="5" r="2.2" fill="none" stroke="currentColor" />
      <circle cx="15" cy="15" r="2.2" fill="none" stroke="currentColor" />
      <path d="M7.1 9.1 12.9 5.9M7.1 10.9 12.9 14.1" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline info icon for the large-graph density hint. */
function InfoIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" />
      <path d="M8 7.2v4M8 4.8h.01" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline warning icon used by the validation summary panel. */
function WarningIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.4 14 13H2L8 2.4Z" fill="none" stroke="currentColor" strokeLinejoin="round" />
      <path d="M8 6v3.2M8 11.8h.01" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline icon for the interactive graph zoom-in control. */
function ZoomInIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline icon for the interactive graph zoom-out control. */
function ZoomOutIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8h9" fill="none" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

/** Inline icon for fitting the interactive graph to the viewport. */
function FitIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
