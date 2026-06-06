/* Read-only entity detail drawer. Opens over the dimmed board.
   Self-contained: relies only on React (global), window.BoardLogic, and marked. */
(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const L = window.BoardLogic;

  const D_BADGE = {
    "done":        { fill: "var(--done-fill)",  ink: "var(--done-ink)",  label: "done" },
    "in-progress": { fill: "var(--prog-fill)",  ink: "var(--prog-ink)",  label: "in-progress" },
    "blocked":     { fill: "var(--block-fill)", ink: "var(--block-ink)", label: "blocked" },
    "todo":        { fill: "var(--todo-fill)",  ink: "var(--todo-ink)",  label: "todo" },
  };
  const dotColor = (s) =>
    s === "done" ? "var(--done-ink)" : s === "in-progress" ? "var(--prog-ink)"
    : s === "blocked" ? "var(--block-ink)" : "var(--fg-faint)";

  function Badge({ status, size = "md" }) {
    const b = D_BADGE[status] || D_BADGE.todo;
    const big = size === "md";
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        background: b.fill, color: b.ink,
        border: `1px solid color-mix(in oklab, ${b.ink} 22%, transparent)`,
        borderRadius: 999, padding: big ? "3px 11px" : "1px 9px",
        fontSize: big ? 12.5 : 11.5, fontWeight: 600, lineHeight: big ? "18px" : "17px", whiteSpace: "nowrap",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: b.ink, opacity: .85 }} />
        {b.label}
      </span>
    );
  }

  // clickable id chip that swaps the drawer to another entity
  function RelChip({ id, title, status, missing, onNavigate }) {
    const [hover, setHover] = useState(false);
    return (
      <button
        onClick={() => !missing && onNavigate(id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={missing}
        title={missing ? id + " — not in this project" : title || id}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: hover && !missing ? "var(--hover)" : "var(--bg)",
          border: "1px solid var(--border)", borderRadius: 8,
          padding: "5px 11px 5px 9px", cursor: missing ? "not-allowed" : "pointer",
          font: "inherit", color: "var(--fg)", maxWidth: "100%", opacity: missing ? .5 : 1,
          boxShadow: hover && !missing ? "var(--shadow)" : "none", transition: "background .12s, box-shadow .12s",
        }}>
        {status != null && <span style={{ width: 7, height: 7, borderRadius: 999, background: dotColor(status), flex: "0 0 auto" }} />}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "var(--fg-muted)" }}>{id}</span>
        {title && <span style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>}
      </button>
    );
  }

  function RelGroup({ label, items, onNavigate }) {
    if (!items || !items.length) return null; // omit empty groups
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--fg-faint)" }}>{label}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {items.map((it) => <RelChip key={it.id} {...it} onNavigate={onNavigate} />)}
        </div>
      </div>
    );
  }

  function Markdown({ source }) {
    const html = React.useMemo(() => {
      try {
        if (window.marked) {
          window.marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
          return window.marked.parse(source || "");
        }
      } catch (e) { /* fall through */ }
      return "<p>" + (source || "").replace(/[<>&]/g, "") + "</p>";
    }, [source]);
    return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  function fmtDate(d) {
    if (!d) return null;
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  const KIND_LABEL = { epic: "Epic", story: "Story", task: "Task" };

  function Drawer({ projectId, id, onClose }) {
    // internal navigation stack so relation chips swap entities (with back)
    const [stack, setStack] = useState([id]);
    const [closing, setClosing] = useState(false);
    const scrollRef = useRef(null);

    useEffect(() => { setStack([id]); }, [id]);

    const currentId = stack[stack.length - 1];
    const entity = L.getEntity(projectId, currentId);

    // reset scroll on entity change
    useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [currentId]);

    const close = useCallback(() => {
      setClosing(true);
      setTimeout(onClose, 210);
    }, [onClose]);

    const navigate = useCallback((toId) => setStack((s) => [...s, toId]), []);
    const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);

    useEffect(() => {
      const h = (e) => {
        if (e.key === "Escape") close();
        else if (e.key === "Backspace" && stack.length > 1) { e.preventDefault(); back(); }
      };
      document.addEventListener("keydown", h);
      return () => document.removeEventListener("keydown", h);
    }, [close, back, stack.length]);

    if (!entity) return null;
    const hasMeta = entity.created || entity.updated || entity.estimate || (entity.tags && entity.tags.length);

    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", justifyContent: "flex-end" }}>
        {/* backdrop */}
        <div onClick={close} className={"dwr-backdrop" + (closing ? " closing" : "")} style={{
          position: "absolute", inset: 0, background: "rgba(12,16,22,.42)", cursor: "default",
        }} />
        {/* panel */}
        <div className={"scroll dwr-panel" + (closing ? " closing" : "")} ref={scrollRef} style={{
          position: "relative", width: "min(480px, 92vw)", height: "100%",
          background: "var(--bg)", borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 40px rgba(12,16,22,.18)", overflowY: "auto",
          opacity: entity.archived ? .92 : 1,
        }}>
          {/* sticky header bar */}
          <div style={{
            position: "sticky", top: 0, zIndex: 2, background: "var(--bg)",
            borderBottom: "1px solid var(--border)", padding: "14px 18px 14px 20px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              {stack.length > 1 && (
                <button onClick={back} title="Back (Backspace)" className="dwr-ibtn" style={iconBtn}>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3.5 L5.5 8 L10 12.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
              <span style={{
                fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase",
                color: "var(--fg-faint)", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 8px",
              }}>{KIND_LABEL[entity.kind]}</span>
              {entity.archived && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600,
                  color: "var(--fg-muted)", background: "var(--hover)", border: "1px dashed var(--border)",
                  borderRadius: 6, padding: "2px 8px",
                }}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="10" height="3" rx="1"/><path d="M3 6v5h8V6M6 8.5h2" strokeLinecap="round"/></svg>
                  archived
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={close} title="Close (Esc)" className="dwr-ibtn" style={iconBtn}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg-muted)", fontWeight: 500, marginBottom: 3 }}>{entity.id}</div>
                <h1 style={{
                  margin: 0, fontSize: 19, fontWeight: 600, lineHeight: 1.28, color: "var(--fg)",
                  textDecoration: entity.archived ? "line-through" : "none",
                  textDecorationColor: "var(--fg-faint)",
                }}>{entity.title}</h1>
              </div>
              <div style={{ flex: "0 0 auto", paddingTop: 2 }}><Badge status={entity.status} /></div>
            </div>
          </div>

          {/* relations */}
          {(!!entity.parent || entity.dependsOn.length > 0 || entity.blocks.length > 0) && (
            <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, borderBottom: "1px solid var(--border-soft)" }}>
              <RelGroup label="Parent" items={entity.parent ? [{ ...entity.parent }] : []} onNavigate={navigate} />
              <RelGroup label="Depends on" items={entity.dependsOn} onNavigate={navigate} />
              <RelGroup label="Blocks" items={entity.blocks} onNavigate={navigate} />
            </div>
          )}

          {/* body */}
          <div style={{ padding: "18px 20px 20px" }}>
            <Markdown source={entity.body} />
          </div>

          {/* metadata footer */}
          {hasMeta && (
            <div style={{
              padding: "14px 20px 24px", borderTop: "1px solid var(--border-soft)",
              display: "flex", flexDirection: "column", gap: 10, fontSize: 12, color: "var(--fg-muted)",
            }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px" }}>
                {entity.created && <Meta k="Created" v={fmtDate(entity.created)} />}
                {entity.updated && <Meta k="Updated" v={fmtDate(entity.updated)} />}
                {entity.estimate && <Meta k="Estimate" v={entity.estimate} />}
              </div>
              {entity.tags && entity.tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {entity.tags.map((tg) => (
                    <span key={tg} style={{
                      fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
                      background: "var(--hover)", border: "1px solid var(--border-soft)",
                      borderRadius: 999, padding: "1px 9px",
                    }}>{tg}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  function Meta({ k, v }) {
    return (
      <span style={{ display: "inline-flex", gap: 7 }}>
        <span style={{ color: "var(--fg-faint)" }}>{k}</span>
        <span style={{ color: "var(--fg)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{v}</span>
      </span>
    );
  }

  const iconBtn = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28, borderRadius: 7, border: "1px solid transparent",
    background: "transparent", color: "var(--fg-muted)", cursor: "pointer", flex: "0 0 auto",
  };

  window.Drawer = Drawer;
})();
