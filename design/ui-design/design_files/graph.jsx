/* Read-only dependency graph view. Two modes: rendered Mermaid (canonical)
   and an interactive pan/zoom SVG graph. Node click -> entity drawer.
   Relies on React (global), window.BoardLogic, window.mermaid. */
(function () {
  "use strict";
  const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;
  const L = window.BoardLogic;

  const GSTATUS = {
    "done":        { fill: "#c6f6d5", ink: "#22543d", label: "done" },
    "in-progress": { fill: "#feebc8", ink: "#744210", label: "in-progress" },
    "blocked":     { fill: "#fed7d7", ink: "#742a2a", label: "blocked" },
    "todo":        { fill: "#e2e8f0", ink: "#2d3748", label: "todo" },
  };
  const ORDER = ["todo", "in-progress", "blocked", "done"];

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /* ----------------------------- Mermaid mode ----------------------------- */
  function MermaidGraph({ entities, edges, dark, accent, onSelect }) {
    const ref = useRef(null);
    const [err, setErr] = useState(null);
    const uid = useMemo(() => "mmd-" + Math.random().toString(36).slice(2, 8), []);

    useEffect(() => {
      let cancelled = false;
      if (!window.mermaid || !entities.length) return;
      const keyToId = {};
      entities.forEach((e) => { keyToId["n" + e.id.replace(/[^A-Za-z0-9]/g, "")] = e.id; });
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: "base",
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-sans") || "sans-serif",
          themeVariables: {
            lineColor: dark ? "#8b949e" : "#8c959f",
            background: "transparent",
            fontSize: "13px",
          },
          flowchart: { useMaxWidth: false, htmlLabels: true, nodeSpacing: 38, rankSpacing: 64, curve: "basis" },
        });
        const def = L.toMermaid(entities, edges);
        window.mermaid.render(uid, def).then(({ svg, bindFunctions }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
          if (bindFunctions) bindFunctions(ref.current);
          // make nodes clickable -> drawer
          ref.current.querySelectorAll("g.node").forEach((g) => {
            const domId = g.id || "";
            const m = domId.match(/flowchart-(n[A-Za-z0-9]+)-/);
            const realId = m && keyToId[m[1]];
            if (realId) {
              g.style.cursor = "pointer";
              g.addEventListener("click", () => onSelect(realId));
            }
          });
          setErr(null);
        }).catch((e) => { if (!cancelled) setErr(String(e)); });
      } catch (e) { setErr(String(e)); }
      return () => { cancelled = true; };
    }, [entities, edges, dark, uid, onSelect]);

    if (err) return <div style={{ padding: 24, color: "var(--block-ink)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Mermaid render error: {err}</div>;
    return (
      <div className="scroll" style={{ width: "100%", height: "100%", overflow: "auto", padding: 28, display: "flex", justifyContent: "center" }}>
        <div ref={ref} style={{ margin: "auto" }} />
      </div>
    );
  }

  /* --------------------------- Interactive mode --------------------------- */
  function InteractiveGraph({ entities, edges, activeStatuses, onSelect, fitToken }) {
    const wrapRef = useRef(null);
    const [size, setSize] = useState({ w: 800, h: 560 });
    const [view, setView] = useState({ x: 40, y: 40, z: 1 });
    const drag = useRef(null);
    const moved = useRef(false);

    const layout = useMemo(() => L.layoutGraph(entities, edges, {}), [entities, edges]);
    const NW = layout.nodeW, NH = layout.nodeH;

    // measure container
    useLayoutEffect(() => {
      if (!wrapRef.current) return;
      const ro = new ResizeObserver((ents) => {
        const r = ents[0].contentRect;
        setSize({ w: r.width, h: r.height });
      });
      ro.observe(wrapRef.current);
      return () => ro.disconnect();
    }, []);

    const fit = useCallback(() => {
      const pad = 56;
      const gw = layout.width + pad * 2, gh = layout.height + pad * 2;
      if (gw <= 0 || gh <= 0) return;
      const z = Math.min(size.w / gw, size.h / gh, 1.1);
      const x = (size.w - layout.width * z) / 2;
      const y = (size.h - layout.height * z) / 2;
      setView({ x, y, z: Math.max(z, 0.18) });
    }, [layout, size]);

    // auto-fit on data / size / explicit token change
    useEffect(() => { fit(); }, [layout, size.w, size.h, fitToken]);

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
      moved.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.sx, dy = e.clientY - drag.current.sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      setView((v) => ({ ...v, x: drag.current.ox + dx, y: drag.current.oy + dy }));
    };
    const onPointerUp = (e) => { drag.current = null; };

    const onWheel = (e) => {
      e.preventDefault();
      const rect = wrapRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const z = Math.min(2.4, Math.max(0.18, v.z * factor));
        const k = z / v.z;
        return { z, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    const zoomBy = (factor) => setView((v) => {
      const z = Math.min(2.4, Math.max(0.18, v.z * factor));
      const k = z / v.z;
      const cx = size.w / 2, cy = size.h / 2;
      return { z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

    const isActive = (s) => activeStatuses.has(s);
    const nodeClick = (id) => { if (!moved.current) onSelect(id); };

    return (
      <div
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", cursor: drag.current ? "grabbing" : "grab", touchAction: "none", background: "var(--canvas)" }}
      >
        <svg width={size.w} height={size.h} style={{ display: "block" }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--fg-faint)" />
            </marker>
            <marker id="arrow-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--border)" />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.z})`}>
            {/* edges */}
            {edges.map((e, i) => {
              const a = layout.pos[e.from], b = layout.pos[e.to];
              if (!a || !b) return null;
              const x1 = a.x + NW, y1 = a.y + NH / 2;
              const x2 = b.x, y2 = b.y + NH / 2;
              const midx = (x1 + x2) / 2;
              const d = `M${x1},${y1} C${midx},${y1} ${midx},${y2} ${x2},${y2}`;
              const sf = entities.find((n) => n.id === e.from), st = entities.find((n) => n.id === e.to);
              const dim = !(isActive(sf.status) && isActive(st.status));
              return (
                <path key={i} d={d} fill="none"
                  stroke={dim ? "var(--border)" : "var(--fg-faint)"}
                  strokeWidth={dim ? 1 : 1.5}
                  markerEnd={dim ? "url(#arrow-dim)" : "url(#arrow)"}
                  opacity={dim ? 0.4 : 0.9} />
              );
            })}
            {/* nodes */}
            {entities.map((n) => {
              const p = layout.pos[n.id];
              if (!p) return null;
              const c = GSTATUS[n.status] || GSTATUS.todo;
              const active = isActive(n.status);
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`}
                  data-node-id={n.id}
                  onClick={() => nodeClick(n.id)}
                  style={{ cursor: "pointer", opacity: active ? 1 : 0.16, transition: "opacity .18s" }}>
                  <rect width={NW} height={NH} rx="9" fill={c.fill} stroke={c.ink}
                    strokeWidth="1" style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,.06))" }} />
                  <circle cx="14" cy={NH / 2} r="4" fill={c.ink} opacity="0.85" />
                  <text x="26" y={NH / 2 - 4} fontFamily="var(--font-mono)" fontSize="11" fontWeight="600" fill={c.ink} opacity="0.9">{n.id}</text>
                  <text x="26" y={NH / 2 + 11} fontFamily="var(--font-sans)" fontSize="12" fill={c.ink}>{truncate(n.title, 18)}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* zoom controls */}
        <div style={{ position: "absolute", right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 6 }}>
          <ZoomBtn onClick={() => zoomBy(1.2)} title="Zoom in">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3.5v9M3.5 8h9" strokeLinecap="round"/></svg>
          </ZoomBtn>
          <ZoomBtn onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3.5 8h9" strokeLinecap="round"/></svg>
          </ZoomBtn>
          <ZoomBtn onClick={fit} title="Fit to view">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </ZoomBtn>
        </div>
        <div style={{ position: "absolute", left: 16, bottom: 14, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-faint)" }}>
          {Math.round(view.z * 100)}% · drag to pan · scroll to zoom
        </div>
      </div>
    );
  }

  function ZoomBtn({ onClick, title, children }) {
    return (
      <button onClick={onClick} title={title} style={{
        width: 32, height: 32, borderRadius: 8, border: "1px solid var(--border)",
        background: "var(--bg)", color: "var(--fg-muted)", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow)",
      }}>{children}</button>
    );
  }

  /* ------------------------------- Toolbar -------------------------------- */
  function Seg({ active, onClick, children }) {
    return (
      <button onClick={onClick} style={{
        border: "none", background: active ? "var(--bg)" : "transparent",
        color: active ? "var(--fg)" : "var(--fg-muted)", cursor: "pointer", font: "inherit",
        fontSize: 12.5, fontWeight: active ? 600 : 500, padding: "5px 12px", borderRadius: 6,
        boxShadow: active ? "0 1px 2px rgba(0,0,0,.08)" : "none",
      }}>{children}</button>
    );
  }

  function StatusFilterChip({ status, active, onToggle, count }) {
    const c = GSTATUS[status];
    return (
      <button onClick={onToggle} title={active ? "Hide " + c.label : "Show " + c.label} style={{
        display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
        border: "1px solid " + (active ? `color-mix(in oklab, ${c.ink} 30%, transparent)` : "var(--border-soft)"),
        background: active ? c.fill : "transparent", color: active ? c.ink : "var(--fg-faint)",
        borderRadius: 999, padding: "2px 9px", font: "inherit", fontSize: 11.5, fontWeight: 600,
        opacity: active ? 1 : 0.6, textDecoration: active ? "none" : "line-through",
        textDecorationColor: "var(--fg-faint)",
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 999, background: active ? c.ink : "var(--fg-faint)" }} />
        {c.label}
        {count != null && <span style={{ fontFamily: "var(--font-mono)", opacity: 0.7 }}>{count}</span>}
      </button>
    );
  }

  /* ------------------------------ Container ------------------------------- */
  function GraphView({ projectId, dark, accent, onSelect }) {
    const [mode, setMode] = useState("mermaid");
    const [scope, setScope] = useState({ type: "full" });
    const [active, setActive] = useState(() => new Set(ORDER));
    const [fitToken, setFitToken] = useState(0);
    const [scopeOpen, setScopeOpen] = useState(false);
    const scopeRef = useRef(null);

    // reset scope when project changes
    useEffect(() => { setScope({ type: "full" }); setActive(new Set(ORDER)); }, [projectId]);

    useEffect(() => {
      const h = (e) => { if (scopeRef.current && !scopeRef.current.contains(e.target)) setScopeOpen(false); };
      document.addEventListener("mousedown", h);
      return () => document.removeEventListener("mousedown", h);
    }, []);

    const graph = useMemo(() => L.buildGraph(projectId, scope), [projectId, scope]);
    const counts = useMemo(() => {
      const c = { done: 0, "in-progress": 0, blocked: 0, todo: 0 };
      graph.entities.forEach((e) => { c[e.status] = (c[e.status] || 0) + 1; });
      return c;
    }, [graph]);

    const toggleStatus = (s) => setActive((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });

    const dense = graph.totalTasks > 30 && scope.type === "full";
    const isEmpty = graph.totalTasks === 0;
    const scopeLabel = scope.type === "full" ? "Full graph" : scope.id + " subgraph";

    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", boxShadow: "var(--shadow)" }}>
        {/* toolbar */}
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: "var(--canvas)", border: "1px solid var(--border)", borderRadius: 8, padding: 2 }}>
            <Seg active={mode === "mermaid"} onClick={() => setMode("mermaid")}>Mermaid</Seg>
            <Seg active={mode === "interactive"} onClick={() => setMode("interactive")}>Interactive</Seg>
          </div>

          {/* scope selector */}
          <div ref={scopeRef} style={{ position: "relative" }}>
            <button onClick={() => setScopeOpen((o) => !o)} style={{
              display: "flex", alignItems: "center", gap: 8, cursor: "pointer", font: "inherit",
              background: scopeOpen ? "var(--hover)" : "transparent", border: "1px solid var(--border)",
              borderRadius: 8, padding: "6px 10px", color: "var(--fg)", fontSize: 12.5,
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 8h2M10 5l-2 2M10 11l-2-2" strokeLinecap="round"/></svg>
              {scopeLabel}
              <svg width="11" height="11" viewBox="0 0 12 12" style={{ color: "var(--fg-muted)" }}><path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {scopeOpen && (
              <div className="scroll" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20, minWidth: 240, maxHeight: 320, overflow: "auto", background: "var(--elevated)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow)", padding: 5 }}>
                <ScopeOption label="Full graph" sub={graph.totalTasks + " tasks"} active={scope.type === "full"} onClick={() => { setScope({ type: "full" }); setScopeOpen(false); }} />
                <div style={{ height: 1, background: "var(--border-soft)", margin: "5px 8px" }} />
                <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--fg-faint)", letterSpacing: ".05em", textTransform: "uppercase", padding: "4px 9px" }}>Per epic</div>
                {graph.epics.map((ep) => (
                  <ScopeOption key={ep.id} label={ep.id} sub={ep.title} active={scope.type === "epic" && scope.id === ep.id} onClick={() => { setScope({ type: "epic", id: ep.id }); setScopeOpen(false); }} />
                ))}
              </div>
            )}
          </div>

          <div style={{ width: 1, height: 22, background: "var(--border-soft)" }} />

          {/* status filter */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {ORDER.map((s) => <StatusFilterChip key={s} status={s} active={active.has(s)} onToggle={() => toggleStatus(s)} count={counts[s]} />)}
          </div>

          <span style={{ flex: 1 }} />
          {mode === "interactive" && !isEmpty && (
            <button onClick={() => setFitToken((t) => t + 1)} style={{
              display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", font: "inherit",
              background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px",
              color: "var(--fg-muted)", fontSize: 12,
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Fit
            </button>
          )}
        </div>

        {/* dense hint */}
        {dense && (
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 9, padding: "8px 14px", background: "var(--accent-soft)", borderBottom: "1px solid var(--border-soft)", fontSize: 12.5, color: "var(--fg)" }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.5" style={{ flex: "0 0 auto" }}><circle cx="8" cy="8" r="6.2"/><path d="M8 5.5v3.2M8 11h.01" strokeLinecap="round"/></svg>
            <span>This project has <b>{graph.totalTasks} tasks</b> — the full graph is dense. Switching to a single epic's subgraph (scope selector above) is usually easier to read.</span>
          </div>
        )}

        {/* canvas */}
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {isEmpty ? (
            <GraphEmpty scope={scope} />
          ) : mode === "mermaid" ? (
            <MermaidGraph entities={graph.entities} edges={graph.edges} dark={dark} accent={accent} onSelect={onSelect} />
          ) : (
            <InteractiveGraph entities={graph.entities} edges={graph.edges} activeStatuses={active} onSelect={onSelect} fitToken={fitToken} />
          )}
        </div>
      </div>
    );
  }

  function ScopeOption({ label, sub, active, onClick }) {
    return (
      <button onClick={onClick} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
        background: active ? "var(--accent-soft)" : "transparent", border: "none", cursor: "pointer",
        borderRadius: 7, padding: "7px 9px", font: "inherit", color: "var(--fg)",
      }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--hover)"; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: active ? "var(--accent)" : "var(--fg-muted)", minWidth: 42 }}>{label.split(" ")[0]}</span>
        <span style={{ fontSize: 12.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>
      </button>
    );
  }

  function GraphEmpty({ scope }) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, border: "1.5px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--fg-faint)" strokeWidth="1.4"><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.2 11l7.6-4M8.2 13l7.6 4" strokeLinecap="round"/></svg>
        </div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>No tasks to graph yet</div>
        <div style={{ color: "var(--fg-muted)", fontSize: 13, maxWidth: 360, lineHeight: 1.5 }}>
          {scope.type === "epic" ? "This epic has no tasks with dependencies." : "Once this project has tasks, their dependency graph will render here automatically."}
        </div>
      </div>
    );
  }

  window.GraphView = GraphView;
})();
