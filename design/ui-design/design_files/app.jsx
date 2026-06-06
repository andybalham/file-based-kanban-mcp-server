const { useState, useEffect, useRef, useMemo, useCallback } = React;
const L = window.BoardLogic;

/* ----------------------------------------------------------------- *
 * Tweak defaults
 * ----------------------------------------------------------------- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "accent": "#7c5cff",
  "density": "comfortable",
  "font": "geist",
  "showIds": true
}/*EDITMODE-END*/;

const FONTS = {
  geist:  { sans: '"Geist", system-ui, sans-serif',     mono: '"Geist Mono", ui-monospace, monospace' },
  plex:   { sans: '"IBM Plex Sans", system-ui, sans-serif', mono: '"IBM Plex Mono", ui-monospace, monospace' },
  system: { sans: 'system-ui, -apple-system, sans-serif', mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
};

/* ----------------------------------------------------------------- *
 * Small presentational pieces
 * ----------------------------------------------------------------- */
const BADGE = {
  "done":        { fill: "var(--done-fill)",  ink: "var(--done-ink)",  label: "done" },
  "in-progress": { fill: "var(--prog-fill)",  ink: "var(--prog-ink)",  label: "in-progress" },
  "blocked":     { fill: "var(--block-fill)", ink: "var(--block-ink)", label: "blocked" },
  "todo":        { fill: "var(--todo-fill)",  ink: "var(--todo-ink)",  label: "todo" },
};

function StatusBadge({ status }) {
  const b = BADGE[status] || BADGE.todo;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      background: b.fill, color: b.ink,
      border: `1px solid color-mix(in oklab, ${b.ink} 22%, transparent)`,
      borderRadius: 999, padding: "1px 9px",
      fontSize: 11.5, fontWeight: 600, letterSpacing: ".01em",
      lineHeight: "17px", whiteSpace: "nowrap", fontFamily: "var(--font-sans)",
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: 999, background: b.ink, opacity: .85,
      }} />
      {b.label}
    </span>
  );
}

function Chevron({ open }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
      style={{ transition: "transform .14s ease", transform: open ? "rotate(90deg)" : "none", flex: "0 0 auto" }}>
      <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Read-only checkbox indicator (checked = done). Never interactive.
function TaskCheck({ done }) {
  return (
    <span aria-hidden="true" style={{
      width: 15, height: 15, borderRadius: 4, flex: "0 0 auto",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      border: done ? "1px solid var(--done-ink)" : "1.5px solid var(--fg-faint)",
      background: done ? "var(--done-ink)" : "transparent",
    }}>
      {done && (
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 5.2 L4 7.2 L8 2.6" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function ProgressMeter({ done, total }) {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-faint)", fontSize: 11.5, fontFamily: "var(--font-mono)" }}>
      <span style={{ width: 44, height: 4, borderRadius: 999, background: "var(--border-soft)", overflow: "hidden", flex: "0 0 auto" }}>
        <span style={{ display: "block", height: "100%", width: pct + "%", background: pct === 100 ? "var(--done-ink)" : "var(--accent)", opacity: .85 }} />
      </span>
      {done}/{total}
    </span>
  );
}

function EntityId({ id }) {
  return <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--id-fs)", color: "var(--fg-muted)", fontWeight: 500, flex: "0 0 auto" }}>{id}</span>;
}

/* ----------------------------------------------------------------- *
 * Tree rows
 * ----------------------------------------------------------------- */
function Row({ depth, children, onClick, interactive }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: `var(--row-py) 16px var(--row-py) ${16 + depth * 22}px`,
        fontSize: "var(--row-fs)",
        cursor: interactive ? "pointer" : "default",
        background: hover && interactive ? "var(--hover)" : "transparent",
        borderBottom: "1px solid var(--border-soft)",
        minWidth: 0,
      }}>
      {children}
    </div>
  );
}

function TitleText({ children, strong, dim }) {
  return (
    <span style={{
      fontWeight: strong ? 600 : 450,
      color: dim ? "var(--fg-muted)" : "var(--fg)",
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      minWidth: 0,
    }}>{children}</span>
  );
}

function Sep() {
  return <span style={{ color: "var(--fg-faint)", flex: "0 0 auto" }}>·</span>;
}

function Spacer() { return <span style={{ flex: 1, minWidth: 8 }} />; }

function TaskRow({ task, byId, depth, showIds, onSelect }) {
  const done = task.status === "done";
  const archived = !!task.archived;
  const blockers = task.status === "blocked" ? (task.deps || []) : [];
  return (
    <Row depth={depth} interactive onClick={() => onSelect(task.id)}>
      <span style={{ width: 12, flex: "0 0 auto" }} />
      <span style={{ opacity: archived ? .5 : 1, display: "flex" }}><TaskCheck done={done} /></span>
      {showIds && <EntityId id={task.id} />}
      {showIds && <Sep />}
      <TitleText dim={done || archived}>
        <span style={(done || archived) ? { textDecoration: "line-through", textDecorationColor: "var(--fg-faint)" } : null}>{task.title}</span>
      </TitleText>
      {archived && (
        <span style={{
          fontSize: 10.5, fontWeight: 600, letterSpacing: ".03em", textTransform: "uppercase",
          color: "var(--fg-faint)", border: "1px dashed var(--border)", borderRadius: 5, padding: "0 6px",
          lineHeight: "15px", flex: "0 0 auto",
        }}>archived</span>
      )}
      {blockers.length > 0 && (
        <span style={{ color: "var(--fg-faint)", fontSize: 12, fontStyle: "italic", whiteSpace: "nowrap", flex: "0 0 auto" }}>
          waiting on {blockers.join(", ")}
        </span>
      )}
      <Spacer />
      <span style={{ opacity: archived ? .55 : 1, display: "flex" }}><StatusBadge status={task.status} /></span>
    </Row>
  );
}

function StoryRow({ story, byId, depth, collapsed, toggle, showIds, onSelect }) {
  const open = !collapsed.has(story.id);
  const status = L.storyStatus(story, byId);
  const prog = L.progress(story);
  return (
    <React.Fragment>
      <Row depth={depth} interactive onClick={() => onSelect(story.id)}>
        <span className="chev-btn" onClick={(e) => { e.stopPropagation(); toggle(story.id); }}><Chevron open={open} /></span>
        {showIds && <EntityId id={story.id} />}
        {showIds && <Sep />}
        <TitleText strong>{story.title}</TitleText>
        <Spacer />
        <ProgressMeter {...prog} />
        <StatusBadge status={status} />
      </Row>
      {open && story.children.map((tk) => (
        <TaskRow key={tk.id} task={tk} byId={byId} depth={depth + 1} showIds={showIds} onSelect={onSelect} />
      ))}
    </React.Fragment>
  );
}

function EpicRow({ epic, byId, collapsed, toggle, showIds, onSelect }) {
  const open = !collapsed.has(epic.id);
  const status = L.epicStatus(epic, byId);
  const prog = L.progress(epic);
  return (
    <React.Fragment>
      <Row depth={0} interactive onClick={() => onSelect(epic.id)}>
        <span className="chev-btn" onClick={(e) => { e.stopPropagation(); toggle(epic.id); }}><Chevron open={open} /></span>
        {showIds && <EntityId id={epic.id} />}
        {showIds && <Sep />}
        <span style={{ fontWeight: 600, fontSize: "calc(var(--row-fs) + .5px)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{epic.title}</span>
        <Spacer />
        <ProgressMeter {...prog} />
        <StatusBadge status={status} />
      </Row>
      {open && epic.children.map((st) => (
        <StoryRow key={st.id} story={st} byId={byId} depth={1} collapsed={collapsed} toggle={toggle} showIds={showIds} onSelect={onSelect} />
      ))}
    </React.Fragment>
  );
}

/* ----------------------------------------------------------------- *
 * Views
 * ----------------------------------------------------------------- */
function BoardView({ board, byId, collapsed, toggle, showIds, onSelect }) {
  if (!board.epics.length) return <EmptyState />;
  return (
    <div>
      {board.epics.map((ep) => (
        <EpicRow key={ep.id} epic={ep} byId={byId} collapsed={collapsed} toggle={toggle} showIds={showIds} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FlatRow({ children, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "var(--row-py) 18px",
        fontSize: "var(--row-fs)", cursor: onClick ? "pointer" : "default",
        background: hover && onClick ? "var(--hover)" : "transparent",
        borderBottom: "1px solid var(--border-soft)",
      }}>{children}</div>
  );
}

function ReadyView({ board, showIds, onSelect }) {
  const rows = useMemo(() => L.readyTasks(board), [board]);
  if (!rows.length) return <EmptyState label="Nothing is ready to start." sub="Every todo is either blocked by an unfinished dependency, or already in flight." />;
  return (
    <div>
      <ViewHint>
        Tasks workable now — effective status <b>todo</b> with all dependencies <b>done</b>. Flat, sorted by id.
      </ViewHint>
      {rows.map(({ task, epic, story }) => (
        <FlatRow key={task.id} onClick={() => onSelect(task.id)}>
          <TaskCheck done={false} />
          {showIds && <EntityId id={task.id} />}
          {showIds && <Sep />}
          <TitleText>{task.title}</TitleText>
          <span style={{ color: "var(--fg-faint)", fontSize: 12, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flex: "0 0 auto" }}>
            {epic.id} › {story.id}
          </span>
          <Spacer />
          <StatusBadge status="todo" />
        </FlatRow>
      ))}
    </div>
  );
}

function BlockedView({ board, showIds, onSelect }) {
  const rows = useMemo(() => L.blockedTasks(board), [board]);
  if (!rows.length) return <EmptyState label="No blocked tasks." sub="Nothing in this project is waiting on another task." />;
  return (
    <div>
      <ViewHint>
        Blocked tasks with their blockers listed. Flat, sorted by id.
      </ViewHint>
      {rows.map(({ task, epic, story, blockers }) => (
        <div key={task.id} onClick={() => onSelect(task.id)} style={{
          display: "flex", flexDirection: "column", gap: 6, cursor: "pointer",
          padding: "calc(var(--row-py) + 1px) 18px",
          fontSize: "var(--row-fs)", borderBottom: "1px solid var(--border-soft)",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            <TaskCheck done={false} />
            {showIds && <EntityId id={task.id} />}
            {showIds && <Sep />}
            <TitleText>{task.title}</TitleText>
            <span style={{ color: "var(--fg-faint)", fontSize: 12, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flex: "0 0 auto" }}>
              {epic.id} › {story.id}
            </span>
            <Spacer />
            <StatusBadge status="blocked" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: showIds ? 24 : 24 }}>
            <span style={{ color: "var(--fg-faint)", fontSize: 12, fontStyle: "italic", whiteSpace: "nowrap" }}>waiting on</span>
            {blockers.map((b) => (
              <span key={b.id} title={b.title || ""} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500,
                color: "var(--fg-muted)", background: "var(--hover)",
                border: "1px solid var(--border)", borderRadius: 6, padding: "1px 7px 1px 6px", whiteSpace: "nowrap",
              }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: b.status === "done" ? "var(--done-ink)" : b.status === "in-progress" ? "var(--prog-ink)" : "var(--fg-faint)", flex: "0 0 auto" }} />
                {b.id}
                {b.title && <span style={{ color: "var(--fg-faint)", fontFamily: "var(--font-sans)", fontWeight: 400 }}>{b.title}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ViewHint({ children }) {
  return (
    <div style={{
      padding: "10px 18px", fontSize: 12.5, color: "var(--fg-muted)",
      background: "var(--canvas)", borderBottom: "1px solid var(--border-soft)",
    }}>{children}</div>
  );
}

function EmptyState({ label = "This project has no entities yet.", sub = "Once epics, stories and tasks are tracked here, the board will populate automatically." }) {
  return (
    <div style={{ padding: "72px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, border: "1.5px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="var(--fg-faint)" strokeWidth="1.4">
          <rect x="3" y="3" width="14" height="14" rx="3" />
          <path d="M7 10h6M7 13h4" strokeLinecap="round" />
        </svg>
      </div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{label}</div>
      <div style={{ color: "var(--fg-muted)", fontSize: 13, maxWidth: 360, lineHeight: 1.5 }}>{sub}</div>
    </div>
  );
}

/* ----------------------------------------------------------------- *
 * Top bar: project picker, tabs, live dot
 * ----------------------------------------------------------------- */
function ProjectPicker({ projects, current, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const cur = projects.find((p) => p.projectId === current);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
        background: open ? "var(--hover)" : "transparent",
        border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px 6px 12px",
        font: "inherit", color: "var(--fg)", minWidth: 230, textAlign: "left",
      }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: "var(--accent)", flex: "0 0 auto" }} />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur ? cur.title : "Select project"}</span>
          {cur && <span style={{ fontSize: 11.5, color: "var(--fg-faint)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cur.root}</span>}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" style={{ flex: "0 0 auto", color: "var(--fg-muted)", transition: "transform .14s", transform: open ? "rotate(180deg)" : "none" }}>
          <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="scroll" style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30,
          minWidth: 280, background: "var(--elevated)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "var(--shadow)", padding: 5, animation: "fade-in .12s ease",
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--fg-faint)", letterSpacing: ".04em", textTransform: "uppercase", padding: "6px 9px 5px" }}>Projects</div>
          {projects.map((p) => {
            const sel = p.projectId === current;
            return (
              <button key={p.projectId} onClick={() => { onPick(p.projectId); setOpen(false); }} style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                background: sel ? "var(--accent-soft)" : "transparent", border: "none", cursor: "pointer",
                borderRadius: 7, padding: "8px 9px", font: "inherit", color: "var(--fg)",
              }}
                onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--hover)"; }}
                onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "transparent"; }}>
                <span style={{ width: 8, height: 8, borderRadius: 2.5, background: sel ? "var(--accent)" : "var(--border)", flex: "0 0 auto" }} />
                <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.25, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</span>
                  <span style={{ fontSize: 11.5, color: "var(--fg-faint)", fontFamily: "var(--font-mono)" }}>{p.root}</span>
                </span>
                {sel && <svg width="14" height="14" viewBox="0 0 14 14" style={{ marginLeft: "auto", color: "var(--accent)", flex: "0 0 auto" }}><path d="M3 7.5 L6 10.5 L11 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LiveDot({ pulsing, updatedAt }) {
  const [ago, setAgo] = useState("");
  useEffect(() => {
    if (!updatedAt) return;
    const tick = () => {
      const s = Math.round((Date.now() - updatedAt) / 1000);
      setAgo(s < 3 ? "just now" : s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [updatedAt]);
  return (
    <span title="Live — board updates over WebSocket" style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--fg-faint)", fontSize: 12 }}>
      <span style={{
        width: 7, height: 7, borderRadius: 999, background: "#3fb950", flex: "0 0 auto",
        animation: pulsing ? "pulse-ring 1.1s ease-out" : "none",
      }} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{updatedAt ? "updated " + ago : "live"}</span>
    </span>
  );
}

function Tab({ active, onClick, children, count }) {
  return (
    <button onClick={onClick} style={{
      position: "relative", background: "none", border: "none", cursor: "pointer",
      font: "inherit", fontSize: 13.5, fontWeight: active ? 600 : 500,
      color: active ? "var(--fg)" : "var(--fg-muted)",
      padding: "12px 4px", display: "inline-flex", alignItems: "center", gap: 7,
    }}>
      {children}
      {count != null && (
        <span style={{
          fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600,
          color: active ? "var(--accent)" : "var(--fg-faint)",
          background: active ? "var(--accent-soft)" : "var(--hover)",
          borderRadius: 999, padding: "0 6px", lineHeight: "16px",
        }}>{count}</span>
      )}
      <span style={{
        position: "absolute", left: 0, right: 0, bottom: -1, height: 2, borderRadius: 2,
        background: active ? "var(--accent)" : "transparent",
      }} />
    </button>
  );
}

/* ----------------------------------------------------------------- *
 * App
 * ----------------------------------------------------------------- */
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [projectId, setProjectId] = useState(window.PROJECTS[0].projectId);
  const [tab, setTab] = useState("board");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [pulse, setPulse] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const board = window.BOARDS[projectId] || { epics: [] };
  const byId = useMemo(() => L.indexTasks(board).byId, [board]);
  const readyCount = useMemo(() => L.readyTasks(board).length, [board]);
  const blockedCount = useMemo(() => L.blockedTasks(board).length, [board]);

  // apply theme / accent / density / font to :root
  useEffect(() => {
    const r = document.documentElement;
    r.classList.toggle("dark", !!t.dark);
    r.classList.toggle("density-compact", t.density === "compact");
    r.style.setProperty("--accent", t.accent);
    const f = FONTS[t.font] || FONTS.geist;
    r.style.setProperty("--font-sans", f.sans);
    r.style.setProperty("--font-mono", f.mono);
  }, [t.dark, t.accent, t.density, t.font]);

  // "Subscribe to a WebSocket; refetch when the project changes."
  // Simulated: on project change we register interest, and the server pushes
  // periodic update pings that flash the live dot.
  useEffect(() => {
    setUpdatedAt(Date.now());
    setPulse(true);
    const stop = setTimeout(() => setPulse(false), 1200);
    const interval = setInterval(() => {
      setUpdatedAt(Date.now());
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
    }, 14000);
    return () => { clearTimeout(stop); clearInterval(interval); };
  }, [projectId]);

  // close the drawer when switching projects (the entity may not exist there)
  useEffect(() => { setSelectedId(null); }, [projectId]);

  const toggle = useCallback((id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // collapse/expand all (board view convenience — still read-only)
  const allIds = useMemo(() => {
    const ids = [];
    board.epics.forEach((ep) => { ids.push(ep.id); ep.children.forEach((st) => ids.push(st.id)); });
    return ids;
  }, [board]);
  const anyOpen = allIds.some((id) => !collapsed.has(id));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--canvas)" }}>
      {/* Top bar */}
      <header style={{
        flex: "0 0 auto", background: "var(--bg)", borderBottom: "1px solid var(--border)",
        padding: "11px 18px", display: "flex", alignItems: "center", gap: 16,
      }}>
        <ProjectPicker projects={window.PROJECTS} current={projectId} onPick={setProjectId} />
        <LiveDot pulsing={pulse} updatedAt={updatedAt} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--fg-faint)", fontFamily: "var(--font-mono)", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5 6V4.2a2 2 0 1 1 4 0V6" strokeLinecap="round"/><rect x="3" y="6" width="8" height="6" rx="1.5"/></svg>
          read-only
        </span>
      </header>

      {/* Tabs + board chrome */}
      <div style={{ flex: "0 0 auto", background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "0 18px", display: "flex", alignItems: "center", gap: 22 }}>
        <Tab active={tab === "board"} onClick={() => setTab("board")}>Board</Tab>
        <Tab active={tab === "ready"} onClick={() => setTab("ready")} count={readyCount}>Ready</Tab>
        <Tab active={tab === "blocked"} onClick={() => setTab("blocked")} count={blockedCount}>Blocked</Tab>
        <Tab active={tab === "graph"} onClick={() => setTab("graph")}>Graph</Tab>
        <span style={{ flex: 1 }} />
        {tab === "board" && board.epics.length > 0 && (
          <button onClick={() => setCollapsed(anyOpen ? new Set(allIds) : new Set())} style={{
            background: "none", border: "none", cursor: "pointer", font: "inherit",
            fontSize: 12, color: "var(--fg-muted)", display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 2px",
          }}>
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {/* Scroll region */}
      {tab === "graph" ? (
        <main style={{ flex: 1, minHeight: 0, padding: "18px 18px 22px" }}>
          <div key={projectId} style={{ height: "100%", maxWidth: 1180, margin: "0 auto" }}>
            <GraphView projectId={projectId} dark={t.dark} accent={t.accent} onSelect={setSelectedId} />
          </div>
        </main>
      ) : (
        <main className="scroll" style={{ flex: 1, overflow: "auto", padding: "18px 18px 64px" }}>
          <div key={projectId + tab} style={{
            maxWidth: 940, margin: "0 auto", background: "var(--bg)",
            border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden",
            boxShadow: "var(--shadow)",
          }}>
            {tab === "board" && <BoardView board={board} byId={byId} collapsed={collapsed} toggle={toggle} showIds={t.showIds} onSelect={setSelectedId} />}
            {tab === "ready" && <ReadyView board={board} showIds={t.showIds} onSelect={setSelectedId} />}
            {tab === "blocked" && <BlockedView board={board} showIds={t.showIds} onSelect={setSelectedId} />}
          </div>
        </main>
      )}

      {/* Read-only entity detail drawer */}
      {selectedId && <Drawer projectId={projectId} id={selectedId} onClose={() => setSelectedId(null)} />}

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakToggle label="Dark mode" value={t.dark} onChange={(v) => setTweak("dark", v)} />
        <TweakColor label="Accent" value={t.accent} options={["#7c5cff", "#3b82f6", "#10b981", "#f97316"]} onChange={(v) => setTweak("accent", v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["comfortable", "compact"]} onChange={(v) => setTweak("density", v)} />
        <TweakSelect label="Font" value={t.font} options={[{ value: "geist", label: "Geist" }, { value: "plex", label: "IBM Plex" }, { value: "system", label: "System UI" }]} onChange={(v) => setTweak("font", v)} />
        <TweakToggle label="Show entity ids" value={t.showIds} onChange={(v) => setTweak("showIds", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
