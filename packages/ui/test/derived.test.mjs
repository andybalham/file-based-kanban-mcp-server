import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockedTasks,
  buildTaskGraph,
  blockedByNote,
  collapsibleBoardIds,
  defaultCollapsedBoardIds,
  indexBoard,
  layoutGraph,
  orderBoardByDependencies,
  progress,
  readyTasks,
  statusClass,
  summarizeBoard,
  toMermaid
} from "../dist-types/derived.js";

test("derived board views flatten tasks and keep ready distinct from computed blocked", () => {
  const indexed = indexBoard(board);

  assert.deepEqual(
    indexed.tasks.map(({ task, epic, story }) => [task.id, epic.id, story.id]),
    [
      ["T-001", "E-001", "S-001"],
      ["T-002", "E-001", "S-001"],
      ["T-003", "E-001", "S-002"],
      ["T-004", "E-002", "S-003"]
    ]
  );

  assert.deepEqual(
    readyTasks(board).map(({ task }) => task.id),
    ["T-001"]
  );
  assert.deepEqual(
    blockedTasks(board).map(({ task, blockers }) => ({
      id: task.id,
      blockers
    })),
    [
      {
        id: "T-002",
        blockers: [{ id: "T-003", title: "Blocked task", status: "blocked", missing: false }]
      },
      {
        id: "T-003",
        blockers: [{ id: "T-999", title: null, status: null, missing: true }]
      }
    ]
  );
  assert.deepEqual(summarizeBoard(board), {
    totalTasks: 4,
    readyTasks: 1,
    blockedTasks: 2,
    doneTasks: 1
  });
});

test("derived progress counts done task descendants", () => {
  assert.deepEqual(progress(board.epics[0]), { done: 0, total: 3 });
  assert.deepEqual(progress(board.epics[0].children[0]), { done: 0, total: 2 });
  assert.deepEqual(progress(board.epics[0].children[0].children[0]), { done: 0, total: 1 });
});

test("board row helpers only collapse visible groups and format blocked notes", () => {
  const boardWithEmptyGroups = {
    epics: [
      ...board.epics,
      {
        id: "E-003",
        type: "epic",
        title: "Empty epic",
        effectiveStatus: "empty",
        blockedBy: [],
        progress: { done: 0, total: 0 },
        children: [
          {
            id: "S-004",
            type: "story",
            title: "Empty story",
            effectiveStatus: "empty",
            blockedBy: [],
            progress: { done: 0, total: 0 },
            children: []
          }
        ]
      }
    ]
  };

  assert.deepEqual(collapsibleBoardIds(boardWithEmptyGroups), ["E-001", "S-001", "S-002", "E-002", "S-003", "E-003"]);
  assert.equal(blockedByNote(board.epics[0].children[0].children[0]), null);
  assert.equal(blockedByNote(board.epics[0].children[0].children[1]), "waiting on T-003");
});

test("only todo and in-progress epics and stories with children start expanded", () => {
  // Builds a story with one task so each status can be checked as a collapsible group.
  const storyWithStatus = (id, effectiveStatus) => ({
    id,
    type: "story",
    title: `${effectiveStatus} story`,
    effectiveStatus,
    blockedBy: [],
    progress: { done: 0, total: 1 },
    children: [task(`T-${id}`, "Task", "todo", "todo", [])]
  });

  // The in-progress epic must stay open while its done and blocked stories collapse on their own.
  // The shared fixture adds a blocked epic and a done epic, which collapse along with their stories,
  // and a done composite with no children must be skipped because it has no rows to hide.
  const boardWithMixedGroups = {
    epics: [
      {
        id: "E-010",
        type: "epic",
        title: "In-progress epic",
        effectiveStatus: "in-progress",
        blockedBy: [],
        progress: { done: 0, total: 4 },
        children: [
          storyWithStatus("S-010", "todo"),
          storyWithStatus("S-011", "in-progress"),
          storyWithStatus("S-012", "done"),
          storyWithStatus("S-013", "blocked")
        ]
      },
      {
        id: "E-011",
        type: "epic",
        title: "Todo epic",
        effectiveStatus: "todo",
        blockedBy: [],
        progress: { done: 0, total: 1 },
        children: [storyWithStatus("S-014", "todo")]
      },
      ...board.epics,
      {
        id: "E-004",
        type: "epic",
        title: "Done epic without stories",
        effectiveStatus: "done",
        blockedBy: [],
        progress: { done: 0, total: 0 },
        children: []
      }
    ]
  };

  assert.deepEqual(defaultCollapsedBoardIds(boardWithMixedGroups), [
    "S-012",
    "S-013",
    "E-001",
    "S-001",
    "S-002",
    "E-002",
    "S-003"
  ]);
  assert.deepEqual(defaultCollapsedBoardIds(null), []);
});

test("board siblings are listed prerequisites first at every level with ids breaking ties", () => {
  // Ids are deliberately the reverse of dependency order so id sorting alone would fail.
  const unorderedBoard = {
    epics: [
      composite("E-001", "epic", [
        composite("S-001", "story", [
          task("T-001", "Ships last", "todo", "blocked", ["T-003"], ["T-003"]),
          task("T-002", "Unlinked", "todo", "todo", []),
          task("T-003", "Ships first", "todo", "todo", [])
        ]),
        composite("S-002", "story", [task("T-004", "Story prerequisite", "todo", "todo", [])])
      ]),
      composite("E-002", "epic", [composite("S-003", "story", [task("T-005", "Epic prerequisite", "todo", "todo", [])])]),
      composite("E-003", "epic", [])
    ],
    validationWarnings: [{ code: "EMPTY_COMPOSITE", entityId: "E-003", message: "Epic has no stories." }]
  };
  const dependencies = {
    entities: [],
    edges: [
      { from: "T-001", to: "T-003", type: "task" },
      { from: "S-001", to: "S-002", type: "story" },
      { from: "E-001", to: "E-002", type: "epic" },
      // Archived or missing endpoints have no visible row and must not disturb the order.
      { from: "T-002", to: "T-999", type: "task" }
    ]
  };
  const snapshot = JSON.stringify(unorderedBoard);
  const ordered = orderBoardByDependencies(unorderedBoard, dependencies);

  assert.deepEqual(boardOutline(ordered), [
    ["E-002", [["S-003", ["T-005"]]]],
    [
      "E-001",
      [
        ["S-002", ["T-004"]],
        ["S-001", ["T-002", "T-003", "T-001"]]
      ]
    ],
    ["E-003", []]
  ]);
  assert.deepEqual(ordered.validationWarnings, unorderedBoard.validationWarnings);
  assert.equal(JSON.stringify(unorderedBoard), snapshot, "the server response must not be mutated");
  // Reordering is idempotent, so repeated refreshes of the same snapshot render identically.
  assert.deepEqual(boardOutline(orderBoardByDependencies(ordered, dependencies)), boardOutline(ordered));
});

test("dependencies between lower layers order the ancestors that hold them", () => {
  const unorderedBoard = {
    epics: [
      composite("E-001", "epic", [composite("S-001", "story", [task("T-001", "Waits on other epic", "todo", "blocked", ["T-003"], ["T-003"])])]),
      composite("E-002", "epic", [
        composite("S-002", "story", [task("T-002", "Waits on sibling story", "todo", "blocked", ["T-003"], ["T-003"])]),
        composite("S-003", "story", [task("T-003", "Shared prerequisite", "todo", "todo", [])])
      ])
    ]
  };
  const dependencies = {
    entities: [],
    edges: [
      { from: "T-001", to: "T-003", type: "task" },
      { from: "T-002", to: "T-003", type: "task" }
    ]
  };

  assert.deepEqual(boardOutline(orderBoardByDependencies(unorderedBoard, dependencies)), [
    [
      "E-002",
      [
        ["S-003", ["T-003"]],
        ["S-002", ["T-002"]]
      ]
    ],
    ["E-001", [["S-001", ["T-001"]]]]
  ]);
});

test("conflicting inferred constraints fall back to id order without dropping rows", () => {
  // The shared fixture has S-002 depending on S-001 while a task in S-001 waits on a task in S-002.
  assert.deepEqual(boardOutline(orderBoardByDependencies(board, graph)), [
    [
      "E-001",
      [
        ["S-001", ["T-001", "T-002"]],
        ["S-002", ["T-003"]]
      ]
    ],
    ["E-002", [["S-003", ["T-004"]]]]
  ]);
});

test("task graph scopes by epic and renders prerequisite to dependent edges", () => {
  const fullGraph = buildTaskGraph(board, graph, { type: "full" });
  const epicGraph = buildTaskGraph(board, graph, { type: "epic", id: "E-001" });

  assert.deepEqual(
    fullGraph.epics.map((epic) => [epic.id, epic.taskCount]),
    [
      ["E-001", 3],
      ["E-002", 1]
    ]
  );
  assert.deepEqual(
    fullGraph.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["T-001->T-002", "T-003->T-002"]
  );
  assert.deepEqual(
    epicGraph.entities.map((entity) => entity.id),
    ["T-001", "T-002", "T-003"]
  );
  assert.deepEqual(
    epicGraph.edges.map((edge) => `${edge.from}->${edge.to}`),
    ["T-001->T-002", "T-003->T-002"]
  );
});

test("graph layout and Mermaid output are deterministic", () => {
  const taskGraph = buildTaskGraph(board, graph);
  const layout = layoutGraph(taskGraph.entities, taskGraph.edges, { nodeW: 100, nodeH: 40, hGap: 10, vGap: 5 });

  assert.deepEqual(layout.layer, {
    "T-001": 0,
    "T-002": 1,
    "T-003": 0,
    "T-004": 0
  });
  assert.deepEqual(layout.pos["T-002"], { x: 110, y: 45 });
  assert.equal(statusClass("blocked"), "blocked");
  assert.equal(statusClass("empty"), "todo");
  assert.equal(
    toMermaid(taskGraph.entities, taskGraph.edges),
    [
      "graph LR",
      '  nT001["T-001<br/>Ready task"]:::todo',
      '  nT002["T-002<br/>Waiting task"]:::blocked',
      '  nT003["T-003<br/>Blocked task"]:::blocked',
      '  nT004["T-004<br/>Done task"]:::done',
      "  nT001 --> nT002",
      "  nT003 --> nT002",
      "  classDef done fill:#c6f6d5,stroke:#22543d,color:#22543d,stroke-width:1px;",
      "  classDef inprogress fill:#feebc8,stroke:#744210,color:#744210,stroke-width:1px;",
      "  classDef blocked fill:#fed7d7,stroke:#742a2a,color:#742a2a,stroke-width:1px;",
      "  classDef todo fill:#e2e8f0,stroke:#2d3748,color:#2d3748,stroke-width:1px;"
    ].join("\n")
  );
});

const board = {
  epics: [
    {
      id: "E-001",
      type: "epic",
      title: "First epic",
      effectiveStatus: "blocked",
      blockedBy: [],
      progress: { done: 1, total: 3 },
      children: [
        {
          id: "S-001",
          type: "story",
          title: "First story",
          effectiveStatus: "blocked",
          blockedBy: [],
          progress: { done: 1, total: 2 },
          children: [
            task("T-001", "Ready task", "todo", "todo", []),
            task("T-002", "Waiting task", "todo", "blocked", ["T-003"], ["T-001", "T-003"])
          ]
        },
        {
          id: "S-002",
          type: "story",
          title: "Second story",
          effectiveStatus: "blocked",
          blockedBy: ["T-999"],
          progress: { done: 0, total: 1 },
          children: [task("T-003", "Blocked task", "todo", "blocked", ["T-999"], ["T-999"])]
        }
      ]
    },
    {
      id: "E-002",
      type: "epic",
      title: "Second epic",
      effectiveStatus: "done",
      blockedBy: [],
      progress: { done: 1, total: 1 },
      children: [
        {
          id: "S-003",
          type: "story",
          title: "Done story",
          effectiveStatus: "done",
          blockedBy: [],
          progress: { done: 1, total: 1 },
          children: [task("T-004", "Done task", "done", "done", [])]
        }
      ]
    }
  ]
};

const graph = {
  entities: [
    graphEntity("T-001", "Ready task", "todo", "todo"),
    graphEntity("T-002", "Waiting task", "todo", "blocked"),
    graphEntity("T-003", "Blocked task", "todo", "blocked"),
    graphEntity("T-004", "Done task", "done", "done"),
    graphEntity("S-001", "First story", "todo", "blocked", "story")
  ],
  edges: [
    { from: "T-002", to: "T-001", type: "task" },
    { from: "T-002", to: "T-003", type: "task" },
    { from: "S-002", to: "S-001", type: "story" }
  ]
};

function task(id, title, status, effectiveStatus, blockedBy, dependsOn = []) {
  return {
    id,
    type: "task",
    title,
    effectiveStatus,
    blockedBy,
    progress: { done: effectiveStatus === "done" ? 1 : 0, total: 1 },
    status,
    dependsOn,
    tags: []
  };
}

/** Build an epic or story fixture node; status fields are irrelevant to ordering assertions. */
function composite(id, type, children) {
  return {
    id,
    type,
    title: `${type} ${id}`,
    effectiveStatus: children.length === 0 ? "empty" : "todo",
    blockedBy: [],
    progress: { done: 0, total: 0 },
    children
  };
}

/** Reduce a board to nested ids so ordering assertions read as the visible top-to-bottom tree. */
function boardOutline(boardResponse) {
  return boardResponse.epics.map((epic) => [
    epic.id,
    epic.children.map((story) => [story.id, story.children.map((child) => child.id)])
  ]);
}

function graphEntity(id, title, status, effectiveStatus, type = "task") {
  return {
    id,
    type,
    title,
    parent: null,
    status,
    effectiveStatus,
    dependsOn: [],
    dependents: [],
    tags: [],
    archived: false,
    filePath: `.worktracker/entities/${id}.md`
  };
}
