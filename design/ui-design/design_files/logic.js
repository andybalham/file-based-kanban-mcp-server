// Pure read-only computation over the board data.
// No mutation anywhere — this only derives views.

(function () {
  // Flatten all tasks across a board into a map by id, plus an ordered list.
  function indexTasks(board) {
    const byId = {};
    const all = [];
    (board.epics || []).forEach((ep) => {
      (ep.children || []).forEach((st) => {
        (st.children || []).forEach((tk) => {
          byId[tk.id] = tk;
          all.push({ task: tk, epic: ep, story: st });
        });
      });
    });
    return { byId, all };
  }

  // Effective status of a task: a stored "todo" whose deps are not all done
  // is effectively blocked (not workable yet). Everything else passes through.
  function effectiveStatus(task, byId) {
    if (task.status === "todo" && task.deps && task.deps.length) {
      const allDone = task.deps.every((d) => byId[d] && byId[d].status === "done");
      if (!allDone) return "blocked-implicit"; // distinct from stored "blocked"
    }
    return task.status;
  }

  // Rollup: collapse children statuses into done | in-progress | todo.
  // Anything active (in-progress / blocked / partially done) -> in-progress.
  function rollup(statuses) {
    if (!statuses.length) return "todo";
    const norm = statuses.map((s) =>
      s === "done" ? "done" : s === "todo" || s === "blocked-implicit" ? "todo" : "active"
    );
    // careful: an implicitly-blocked todo is still "todo" for rollup intent,
    // but a STORED blocked counts as active work in flight.
    if (norm.every((s) => s === "done")) return "done";
    if (norm.every((s) => s === "todo")) return "todo";
    return "in-progress";
  }

  function storyStatus(story, byId) {
    const statuses = (story.children || [])
      .filter((tk) => !tk.archived) // archived tasks don't count toward rollup
      .map((tk) => (tk.status === "blocked" ? "blocked" : tk.status));
    return rollup(statuses);
  }

  function epicStatus(epic, byId) {
    const statuses = (epic.children || []).map((st) => storyStatus(st, byId));
    return rollup(statuses);
  }

  // Ready: tasks whose effective status is todo with ALL deps done.
  function readyTasks(board) {
    const { byId, all } = indexTasks(board);
    return all
      .filter(({ task }) => {
        if (task.archived) return false;
        if (task.status !== "todo") return false;
        if (!task.deps || !task.deps.length) return true;
        return task.deps.every((d) => byId[d] && byId[d].status === "done");
      })
      .sort((a, b) => a.task.id.localeCompare(b.task.id));
  }

  // Blocked: STORED-blocked tasks, with their blockers.
  function blockedTasks(board) {
    const { byId, all } = indexTasks(board);
    return all
      .filter(({ task }) => task.status === "blocked" && !task.archived)
      .map((row) => ({
        ...row,
        blockers: (row.task.deps || []).map((d) => ({
          id: d,
          title: byId[d] ? byId[d].title : null,
          status: byId[d] ? byId[d].status : null,
        })),
      }))
      .sort((a, b) => a.task.id.localeCompare(b.task.id));
  }

  // Count of done / total tasks under an epic or story (for the faint meter).
  function progress(node) {
    let done = 0,
      total = 0;
    const walk = (n) => {
      if (n.kind === "task") {
        if (n.archived) return; // archived excluded from progress
        total += 1;
        if (n.status === "done") done += 1;
      }
      (n.children || []).forEach(walk);
    };
    (node.children || []).forEach(walk);
    return { done, total };
  }

  // Full entity payload for the detail drawer (mirrors GET /api/:project/entity/:id).
  function getEntity(projectId, id) {
    const board = (window.BOARDS || {})[projectId];
    if (!board) return null;
    const taskById = {};
    const parentOf = {};
    const node = { ref: null };
    (board.epics || []).forEach((ep) => {
      if (ep.id === id) node.ref = { entity: ep, kind: "epic", parent: null };
      (ep.children || []).forEach((st) => {
        parentOf[st.id] = { id: ep.id, title: ep.title, kind: "epic" };
        if (st.id === id) node.ref = { entity: st, kind: "story", parent: parentOf[st.id] };
        (st.children || []).forEach((tk) => {
          taskById[tk.id] = tk;
          parentOf[tk.id] = { id: st.id, title: st.title, kind: "story" };
          if (tk.id === id) node.ref = { entity: tk, kind: "task", parent: parentOf[tk.id] };
        });
      });
    });
    if (!node.ref) return null;
    const { entity, kind, parent } = node.ref;

    // collect all tasks for inverse-dependency lookup
    const allTasks = Object.values(taskById);

    const status =
      kind === "task" ? entity.status
      : kind === "story" ? storyStatus(entity)
      : epicStatus(entity);

    const rel = (tid) => ({
      id: tid,
      title: taskById[tid] ? taskById[tid].title : null,
      status: taskById[tid] ? taskById[tid].status : null,
      missing: !taskById[tid],
    });

    const dependsOn = kind === "task" ? (entity.deps || []).map(rel) : [];
    const blocks =
      kind === "task"
        ? allTasks
            .filter((tk) => (tk.deps || []).includes(id))
            .map((tk) => ({ id: tk.id, title: tk.title, status: tk.status, missing: false }))
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];

    const meta = (window.ENTITY_META || {})[id] || {};
    const body =
      meta.body ||
      `## ${entity.title}\n\n_No description has been written for this ${kind} yet._`;

    return {
      id: entity.id,
      title: entity.title,
      kind,
      status,
      parent,
      dependsOn,
      blocks,
      body,
      created: meta.created || null,
      updated: meta.updated || null,
      estimate: meta.estimate || null,
      tags: meta.tags || [],
      archived: !!(entity.archived || meta.archived),
    };
  }

  // ---- Dependency graph -------------------------------------------------
  // Edges point prerequisite -> dependent (from a task's dep TO the task).
  // scope: { type: "full" } | { type: "epic", id }
  function buildGraph(projectId, scope) {
    const board = (window.BOARDS || {})[projectId];
    if (!board) return { entities: [], edges: [], totalTasks: 0, epics: [] };

    const epicsList = (board.epics || []).map((ep) => ({ id: ep.id, title: ep.title }));
    let totalTasks = 0;
    const rows = []; // {task, epicId, storyId}
    (board.epics || []).forEach((ep) => {
      (ep.children || []).forEach((st) => {
        (st.children || []).forEach((tk) => {
          if (tk.archived) return; // archived excluded from the graph
          totalTasks += 1;
          rows.push({ task: tk, epicId: ep.id, storyId: st.id });
        });
      });
    });

    const inScope =
      scope && scope.type === "epic"
        ? rows.filter((r) => r.epicId === scope.id)
        : rows;
    const idSet = new Set(inScope.map((r) => r.task.id));

    const entities = inScope.map((r) => ({
      id: r.task.id,
      title: r.task.title,
      status: r.task.status,
      effectiveStatus: effectiveStatus(r.task, indexTasks(board).byId),
      epicId: r.epicId,
      storyId: r.storyId,
    }));

    const edges = [];
    inScope.forEach((r) => {
      (r.task.deps || []).forEach((dep) => {
        if (idSet.has(dep)) edges.push({ from: dep, to: r.task.id });
      });
    });

    return { entities, edges, totalTasks, epics: epicsList };
  }

  // Layered (Sugiyama-style) DAG layout. Returns positions keyed by id plus bounds.
  function layoutGraph(entities, edges, opts) {
    const o = Object.assign({ nodeW: 172, nodeH: 48, hGap: 64, vGap: 22 }, opts || {});
    const ids = entities.map((e) => e.id);
    const preds = {}; // id -> [prereqs in scope]
    const succs = {};
    ids.forEach((id) => { preds[id] = []; succs[id] = []; });
    edges.forEach((e) => {
      if (preds[e.to] && succs[e.from]) { preds[e.to].push(e.from); succs[e.from].push(e.to); }
    });

    // longest-path layering
    const layer = {};
    const visiting = {};
    function computeLayer(id) {
      if (layer[id] != null) return layer[id];
      if (visiting[id]) return 0; // cycle guard (shouldn't happen in a DAG)
      visiting[id] = true;
      let m = 0;
      preds[id].forEach((p) => { m = Math.max(m, computeLayer(p) + 1); });
      visiting[id] = false;
      layer[id] = m;
      return m;
    }
    ids.forEach(computeLayer);

    // group by layer, order by id for stability
    const byLayer = {};
    ids.forEach((id) => { (byLayer[layer[id]] = byLayer[layer[id]] || []).push(id); });
    const maxLayer = Math.max(0, ...ids.map((id) => layer[id]));
    Object.keys(byLayer).forEach((k) => byLayer[k].sort((a, b) => a.localeCompare(b)));

    const pos = {};
    let maxRows = 0;
    for (let l = 0; l <= maxLayer; l++) {
      const col = byLayer[l] || [];
      maxRows = Math.max(maxRows, col.length);
    }
    const colH = (id) => {}; // noop
    for (let l = 0; l <= maxLayer; l++) {
      const col = byLayer[l] || [];
      const totalH = col.length * o.nodeH + (col.length - 1) * o.vGap;
      const fullH = maxRows * o.nodeH + (maxRows - 1) * o.vGap;
      const offsetY = (fullH - totalH) / 2; // center each column
      col.forEach((id, i) => {
        pos[id] = {
          x: l * (o.nodeW + o.hGap),
          y: offsetY + i * (o.nodeH + o.vGap),
        };
      });
    }
    const width = (maxLayer + 1) * o.nodeW + maxLayer * o.hGap;
    const height = maxRows * o.nodeH + (maxRows - 1) * o.vGap;
    return { pos, width, height, nodeW: o.nodeW, nodeH: o.nodeH, layer };
  }

  // Generate a Mermaid flowchart definition (mirrors the server's .mmd output).
  function toMermaid(entities, edges) {
    const key = (id) => "n" + id.replace(/[^A-Za-z0-9]/g, "");
    const esc = (s) => s.replace(/"/g, "&quot;");
    const lines = ["graph LR"];
    entities.forEach((e) => {
      lines.push(`  ${key(e.id)}["${e.id}<br/>${esc(e.title)}"]:::${statusClass(e.status)}`);
    });
    edges.forEach((e) => { lines.push(`  ${key(e.from)} --> ${key(e.to)}`); });
    lines.push("  classDef done fill:#c6f6d5,stroke:#22543d,color:#22543d,stroke-width:1px;");
    lines.push("  classDef inprogress fill:#feebc8,stroke:#744210,color:#744210,stroke-width:1px;");
    lines.push("  classDef blocked fill:#fed7d7,stroke:#742a2a,color:#742a2a,stroke-width:1px;");
    lines.push("  classDef todo fill:#e2e8f0,stroke:#2d3748,color:#2d3748,stroke-width:1px;");
    return lines.join("\n");
  }
  function statusClass(s) {
    return s === "done" ? "done" : s === "in-progress" ? "inprogress" : s === "blocked" ? "blocked" : "todo";
  }

  window.BoardLogic = {
    indexTasks,
    effectiveStatus,
    storyStatus,
    epicStatus,
    readyTasks,
    blockedTasks,
    progress,
    getEntity,
    buildGraph,
    layoutGraph,
    toMermaid,
    statusClass,
  };
})();
