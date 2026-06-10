import { StrictMode, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type BoardEpic,
  type BoardResponse,
  type BoardStory,
  type BoardTask,
  type EffectiveStatus,
  type ProjectId,
  type ProjectSummary,
  type ViewerApiClient,
  ViewerApiError,
  createViewerApiClient
} from "./api";
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

/** Counts shown in the shell tab bar and project summary. */
interface BoardCounts {
  /** Total active tasks present in the board hierarchy. */
  totalTasks: number;
  /** Tasks that are immediately workable according to the current server effective status. */
  readyTasks: number;
  /** Tasks or descendants currently blocked by the server status resolver. */
  blockedTasks: number;
  /** Tasks whose effective status is done. */
  doneTasks: number;
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
            showIds={preferences.showIds}
            tab={tab}
            toggleCollapsed={toggleCollapsed}
          />
        </section>
      </main>
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
  showIds,
  tab,
  toggleCollapsed
}: {
  board: BoardResponse | null;
  collapsed: Set<string>;
  counts: BoardCounts;
  isLoading: boolean;
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
      return <BoardPreview board={board} collapsed={collapsed} showIds={showIds} toggleCollapsed={toggleCollapsed} />;
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
  showIds,
  toggleCollapsed
}: {
  board: BoardResponse;
  collapsed: Set<string>;
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
  showIds,
  toggleCollapsed
}: {
  collapsed: Set<string>;
  epic: BoardEpic;
  showIds: boolean;
  toggleCollapsed(id: string): void;
}) {
  const open = !collapsed.has(epic.id);

  return (
    <div className="epic-group">
      <HierarchyRow depth={0}>
        <ChevronButton open={open} onClick={() => toggleCollapsed(epic.id)} />
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
  showIds,
  story,
  toggleCollapsed
}: {
  collapsed: Set<string>;
  showIds: boolean;
  story: BoardStory;
  toggleCollapsed(id: string): void;
}) {
  const open = !collapsed.has(story.id);

  return (
    <>
      <HierarchyRow depth={1}>
        <ChevronButton open={open} onClick={() => toggleCollapsed(story.id)} />
        <EntityLabel id={story.id} showIds={showIds} title={story.title} strong />
        <RowSpacer />
        <ProgressMeter progress={story.progress} />
        <StatusBadge status={story.effectiveStatus} />
      </HierarchyRow>
      {open ? story.children.map((task) => <TaskRow key={task.id} showIds={showIds} task={task} />) : null}
    </>
  );
}

/** Render one read-only task row with checkbox and dependency hint. */
function TaskRow({ showIds, task }: { showIds: boolean; task: BoardTask }) {
  const done = task.status === "done";
  const waitingOn = task.blockedBy.length > 0 ? `waiting on ${task.blockedBy.join(", ")}` : null;

  return (
    <HierarchyRow depth={2}>
      <span className="task-spacer" aria-hidden="true" />
      <ReadOnlyCheckbox checked={done} />
      <EntityLabel dim={done} id={task.id} showIds={showIds} title={task.title} />
      {waitingOn === null ? null : <span className="row-detail">{waitingOn}</span>}
      <RowSpacer />
      <StatusBadge status={task.effectiveStatus} />
    </HierarchyRow>
  );
}

/** Shared row wrapper that applies the design's depth-based left padding. */
function HierarchyRow({ children, depth }: { children: React.ReactNode; depth: 0 | 1 | 2 }) {
  return (
    <div className="board-row" style={{ "--depth": depth } as CSSProperties}>
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
function ReadOnlyCheckbox({ checked }: { checked: boolean }) {
  return (
    <span className={checked ? "task-check task-check-checked" : "task-check"} aria-hidden="true">
      {checked ? <CheckIcon small /> : null}
    </span>
  );
}

/** Render one collapsible-row chevron as a local-only control. */
function ChevronButton({ onClick, open }: { onClick(): void; open: boolean }) {
  return (
    <button className="chev-btn" type="button" aria-label={open ? "Collapse row" : "Expand row"} onClick={onClick}>
      <ChevronRight open={open} />
    </button>
  );
}

/** Render descendant progress using the design's faint meter. */
function ProgressMeter({ progress }: { progress: { done: number; total: number } }) {
  if (progress.total === 0) {
    return null;
  }

  const percent = Math.round((progress.done / progress.total) * 100);

  return (
    <span className="progress-meter">
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

/** Summarize the board from server read models without storing duplicate derived state. */
function summarizeBoard(board: BoardResponse | null): BoardCounts {
  const tasks = board?.epics.flatMap((epic) => epic.children.flatMap((story) => story.children)) ?? [];

  return {
    totalTasks: tasks.length,
    readyTasks: tasks.filter((task) => task.status === "todo" && task.effectiveStatus === "todo").length,
    blockedTasks: tasks.filter((task) => task.effectiveStatus === "blocked").length,
    doneTasks: tasks.filter((task) => task.effectiveStatus === "done").length
  };
}

/** Return epic/story ids that participate in local collapse-all behavior. */
function collapsibleBoardIds(board: BoardResponse | null): string[] {
  return board?.epics.flatMap((epic) => [epic.id, ...epic.children.map((story) => story.id)]) ?? [];
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
