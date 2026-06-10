import { StrictMode, type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  type BoardEpic,
  type BoardResponse,
  type BoardStory,
  type BoardTask,
  type EffectiveStatus,
  type GraphResponse,
  type ProjectId,
  type ProjectSummary,
  type ViewerApiClient,
  ViewerApiError,
  createViewerApiClient
} from "./api";
import "./styles.css";

/**
 * Small read-only app state assembled from the Phase 6 HTTP/WS API.
 *
 * Full board tabs, graph rendering, and the entity drawer are intentionally left for the later
 * Phase 7 UI tasks. This task wires the browser to the public API, proves project-scoped refreshes
 * flow through WebSocket events, and keeps the surface free of browser mutation controls.
 */
interface ProjectDataState {
  /** Board hierarchy for the selected project, or null while no project is selected. */
  board: BoardResponse | null;
  /** Graph payload fetched in parallel so later graph UI work can consume an already typed shape. */
  graph: GraphResponse | null;
}

/** Derived counters displayed by the lightweight shell. */
interface BoardCounts {
  /** Total active tasks present in the board hierarchy. */
  totalTasks: number;
  /** Tasks the server considers ready because stored status and effective status are both todo. */
  readyTasks: number;
  /** Tasks currently blocked by direct dependency or propagated ancestor gates. */
  blockedTasks: number;
  /** Tasks whose effective status is done. */
  doneTasks: number;
}

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

  const selectedProject = useMemo(
    () => projects.find((project) => project.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const counts = useMemo(() => summarizeBoard(data.board), [data.board]);

  /**
   * Fetch the selected project's board and graph together.
   *
   * Fetching both read models in parallel avoids creating a waterfall that the graph UI would
   * otherwise have to pay for immediately after the board has loaded.
   */
  const refreshProjectData = useCallback(
    async (projectId: ProjectId, signal?: AbortSignal) => {
      setIsLoadingProjectData(true);
      setError(null);

      try {
        const [board, graph] = await Promise.all([api.getBoard(projectId, signal), api.getGraph(projectId, signal)]);
        setData({ board, graph });
        setLastUpdatedAt(new Date());
      } catch (unknownError) {
        if (!isAbortError(unknownError)) {
          setError(messageFromError(unknownError));
          setData({ board: null, graph: null });
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
   * Load the project picker once on startup and select the first deterministic project returned
   * by the server. The selected project remains explicit state so a later full picker can control
   * it without changing the data-fetching contract.
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
   * Refetch read models whenever the active project changes.
   */
  useEffect(() => {
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
   * Subscribe to live project changes.
   *
   * The server already scopes messages by project subscription, but the handler still verifies the
   * project id before refetching so stale messages from a closing socket cannot affect a new
   * selection.
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

  return (
    <main className="app-shell" aria-busy={isLoadingProjects || isLoadingProjectData}>
      <header className="top-bar">
        <label className="project-picker">
          <span className="picker-dot" aria-hidden="true" />
          <span className="project-picker-copy">
            <span className="picker-label">Project</span>
            <select
              value={selectedProjectId ?? ""}
              disabled={projects.length === 0}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {projects.length === 0 ? (
                <option value="">No projects discovered</option>
              ) : (
                projects.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.title}
                  </option>
                ))
              )}
            </select>
          </span>
        </label>
        <LiveIndicator isLive={isLive} lastUpdatedAt={lastUpdatedAt} pulseToken={pulseToken} />
        <span className="readonly-chip" aria-label="Viewer is read-only">
          Locked read-only
        </span>
      </header>

      <section className="summary-band" aria-label="Selected project summary">
        <div>
          <p className="eyebrow">Selected Project</p>
          <h1>{selectedProject?.title ?? "File Kanban Viewer"}</h1>
          <p className="project-root">{selectedProject?.root ?? "Waiting for /api/projects"}</p>
        </div>
        <div className="summary-grid" aria-label="Board counts">
          <SummaryTile label="Tasks" value={counts.totalTasks} />
          <SummaryTile label="Ready" value={counts.readyTasks} />
          <SummaryTile label="Blocked" value={counts.blockedTasks} tone="blocked" />
          <SummaryTile label="Done" value={counts.doneTasks} tone="done" />
        </div>
      </section>

      {error === null ? null : <div className="error-banner">{error}</div>}

      <section className="board-card" aria-label="Read-only board preview">
        <div className="card-header">
          <div>
            <p className="eyebrow">Board API</p>
            <h2>Epic / Story / Task hierarchy</h2>
          </div>
          <span className="graph-count">{data.graph?.edges.length ?? 0} dependency edges</span>
        </div>

        {isLoadingProjects || isLoadingProjectData ? (
          <EmptyState title="Loading project data" body="Fetching the read-only board and graph endpoints." />
        ) : data.board === null || data.board.epics.length === 0 ? (
          <EmptyState title="No board data" body="No active epics were returned by the selected project." />
        ) : (
          <BoardPreview epics={data.board.epics} />
        )}
      </section>
    </main>
  );
}

/** Render a compact project-scoped live indicator. */
function LiveIndicator({
  isLive,
  lastUpdatedAt,
  pulseToken
}: {
  isLive: boolean;
  lastUpdatedAt: Date | null;
  pulseToken: number;
}) {
  return (
    <span className="live-indicator">
      <span key={pulseToken} className={isLive ? "live-dot live-dot-pulse" : "live-dot"} aria-hidden="true" />
      <span>{isLive ? relativeTime(lastUpdatedAt) : "live offline"}</span>
    </span>
  );
}

/** Render one count tile without introducing interactive controls. */
function SummaryTile({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "blocked" | "done" }) {
  return (
    <div className={`summary-tile summary-tile-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Render the first useful slice of the board tree while the full Phase 7 screens are pending. */
function BoardPreview({ epics }: { epics: BoardEpic[] }) {
  return (
    <div className="board-preview">
      {epics.map((epic) => (
        <div className="epic-group" key={epic.id}>
          <BoardRow id={epic.id} title={epic.title} status={epic.effectiveStatus} depth={0} progress={epic.progress} />
          {epic.children.map((story) => (
            <StoryPreview key={story.id} story={story} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Render one story and its task leaves. */
function StoryPreview({ story }: { story: BoardStory }) {
  return (
    <>
      <BoardRow id={story.id} title={story.title} status={story.effectiveStatus} depth={1} progress={story.progress} />
      {story.children.map((task) => (
        <TaskPreview key={task.id} task={task} />
      ))}
    </>
  );
}

/** Render a task row with read-only dependency context. */
function TaskPreview({ task }: { task: BoardTask }) {
  const waitingOn = task.blockedBy.length > 0 ? `waiting on ${task.blockedBy.join(", ")}` : null;

  return (
    <BoardRow
      id={task.id}
      title={task.title}
      status={task.effectiveStatus}
      depth={2}
      isDone={task.effectiveStatus === "done"}
      detail={waitingOn}
    />
  );
}

/** Shared hierarchy row renderer for the compact board preview. */
function BoardRow({
  id,
  title,
  status,
  depth,
  progress,
  isDone = false,
  detail = null
}: {
  id: string;
  title: string;
  status: EffectiveStatus;
  depth: 0 | 1 | 2;
  progress?: { done: number; total: number };
  isDone?: boolean;
  detail?: string | null;
}) {
  return (
    <div className="board-row" style={{ "--depth": depth } as CSSProperties}>
      <span className="entity-id">{id}</span>
      <span className={isDone ? "entity-title entity-title-done" : "entity-title"}>{title}</span>
      {detail === null ? null : <span className="row-detail">{detail}</span>}
      <span className="row-spacer" />
      {progress === undefined || progress.total === 0 ? null : (
        <span className="progress-text">
          {progress.done}/{progress.total}
        </span>
      )}
      <StatusBadge status={status} />
    </div>
  );
}

/** Render the status palette shared by board and graph surfaces. */
function StatusBadge({ status }: { status: EffectiveStatus }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

/** Render a non-interactive empty/loading state. */
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/** Summarize the board without storing duplicate derived state. */
function summarizeBoard(board: BoardResponse | null): BoardCounts {
  const tasks = board?.epics.flatMap((epic) => epic.children.flatMap((story) => story.children)) ?? [];

  return {
    totalTasks: tasks.length,
    readyTasks: tasks.filter((task) => task.status === "todo" && task.effectiveStatus === "todo").length,
    blockedTasks: tasks.filter((task) => task.effectiveStatus === "blocked").length,
    doneTasks: tasks.filter((task) => task.effectiveStatus === "done").length
  };
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

// Vite serves `index.html`, which owns the root element that React mounts into.
const rootElement = document.getElementById("root");

if (!rootElement) {
  // Failing fast makes an HTML/template mismatch obvious during local development and CI builds.
  throw new Error("Root element not found");
}

// StrictMode surfaces unsafe React patterns while the viewer API integration is still small.
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
