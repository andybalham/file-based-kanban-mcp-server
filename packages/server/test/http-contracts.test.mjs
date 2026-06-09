import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import {
  HTTP_ROUTE_DEFINITIONS,
  RegistryError,
  createHttpServer,
  getHttpBoard,
  getHttpEntity,
  getHttpGraph,
  getHttpMermaid,
  listHttpProjects,
  toHttpErrorBody
} from "../dist/main.js";

test("HTTP route definitions expose the read-only design surface", () => {
  assert.deepEqual(Object.keys(HTTP_ROUTE_DEFINITIONS), [
    "projects",
    "graph",
    "entity",
    "board",
    "mermaid",
    "websocket"
  ]);

  assert.deepEqual(
    Object.fromEntries(Object.entries(HTTP_ROUTE_DEFINITIONS).map(([key, definition]) => [key, definition.path])),
    {
      projects: "/api/projects",
      graph: "/api/:project/graph",
      entity: "/api/:project/entity/:id",
      board: "/api/:project/board",
      mermaid: "/api/:project/mermaid/:view",
      websocket: "/ws"
    }
  );

  assert.equal(Object.values(HTTP_ROUTE_DEFINITIONS).every((definition) => definition.mutates === false), true);
  assert.equal(HTTP_ROUTE_DEFINITIONS.websocket.method, "WS");
});

test("GET /api/projects returns deterministic registry summaries as a bare array", () => {
  const registry = resourceRegistry([
    projectState(path.join(os.tmpdir(), "file-kanban-http-b"), "wt_b", "Project B"),
    projectState(path.join(os.tmpdir(), "file-kanban-http-a"), "wt_a", "Project A")
  ]);

  assert.deepEqual(listHttpProjects(registry), [
    {
      projectId: "wt_a",
      title: "Project A",
      root: path.join(os.tmpdir(), "file-kanban-http-a")
    },
    {
      projectId: "wt_b",
      title: "Project B",
      root: path.join(os.tmpdir(), "file-kanban-http-b")
    }
  ]);
});

test("GET /api/:project/graph returns active nodes and typed same-type edges", () => {
  const root = path.join(os.tmpdir(), "file-kanban-http-graph");
  const registry = resourceRegistry([projectState(root)]);

  assert.deepEqual(getHttpGraph(registry, "wt_http"), {
    entities: [
      entityView({
        id: "E-001",
        type: "epic",
        title: "Epic",
        parent: null,
        effectiveStatus: "blocked",
        dependsOn: [],
        dependents: ["E-002"]
      }),
      entityView({
        id: "E-002",
        type: "epic",
        title: "Gated epic",
        parent: null,
        effectiveStatus: "blocked",
        dependsOn: ["E-001"],
        dependents: []
      }),
      entityView({
        id: "S-001",
        type: "story",
        title: "Story",
        parent: "E-001",
        effectiveStatus: "todo",
        dependsOn: [],
        dependents: ["S-002"]
      }),
      entityView({
        id: "S-002",
        type: "story",
        title: "Gated story",
        parent: "E-002",
        effectiveStatus: "blocked",
        dependsOn: ["S-001"],
        dependents: []
      }),
      entityView({
        id: "T-001",
        type: "task",
        title: "Ready task",
        parent: "S-001",
        effectiveStatus: "todo",
        dependsOn: [],
        dependents: ["T-002"],
        estimate: 2,
        tags: ["ready"],
        filePath: path.join(root, ".worktracker", "entities", "T-001-ready-task.md")
      }),
      entityView({
        id: "T-002",
        type: "task",
        title: "Blocked task",
        parent: "S-002",
        effectiveStatus: "blocked",
        dependsOn: ["T-001"],
        dependents: [],
        filePath: path.join(root, ".worktracker", "entities", "T-002-blocked-task.md")
      })
    ],
    edges: [
      { from: "E-002", to: "E-001", type: "epic" },
      { from: "S-002", to: "S-001", type: "story" },
      { from: "T-002", to: "T-001", type: "task" }
    ]
  });
});

test("GET /api/:project/board returns computed statuses and active hierarchy", () => {
  const registry = resourceRegistry([projectState(path.join(os.tmpdir(), "file-kanban-http-board"))]);

  assert.deepEqual(getHttpBoard(registry, "wt_http"), {
    epics: [
      {
        id: "E-001",
        type: "epic",
        title: "Epic",
        effectiveStatus: "blocked",
        blockedBy: [],
        progress: { done: 0, total: 1 },
        children: [
          {
            id: "S-001",
            type: "story",
            title: "Story",
            effectiveStatus: "todo",
            blockedBy: [],
            progress: { done: 0, total: 1 },
            children: [
              {
                id: "T-001",
                type: "task",
                title: "Ready task",
                effectiveStatus: "todo",
                blockedBy: [],
                progress: { done: 0, total: 1 },
                status: "todo",
                dependsOn: [],
                estimate: 2,
                tags: ["ready"]
              }
            ]
          }
        ]
      },
      {
        id: "E-002",
        type: "epic",
        title: "Gated epic",
        effectiveStatus: "blocked",
        blockedBy: ["E-001"],
        progress: { done: 0, total: 1 },
        children: [
          {
            id: "S-002",
            type: "story",
            title: "Gated story",
            effectiveStatus: "blocked",
            blockedBy: ["S-001"],
            progress: { done: 0, total: 1 },
            children: [
              {
                id: "T-002",
                type: "task",
                title: "Blocked task",
                effectiveStatus: "blocked",
                blockedBy: ["T-001"],
                progress: { done: 0, total: 1 },
                status: "todo",
                dependsOn: ["T-001"],
                tags: []
              }
            ]
          }
        ]
      }
    ]
  });
});

test("GET /api/:project/entity/:id returns direct archived entity details", () => {
  const root = path.join(os.tmpdir(), "file-kanban-http-entity");
  const registry = resourceRegistry([projectState(root)]);

  assert.deepEqual(getHttpEntity(registry, "wt_http", "T-003"), {
    id: "T-003",
    type: "task",
    title: "Archived task",
    parent: "S-001",
    status: "done",
    effectiveStatus: "done",
    dependsOn: [],
    dependents: [],
    tags: ["archived"],
    archived: true,
    filePath: path.join(root, ".worktracker", "entities", "T-003-archived-task.md"),
    body: "\nArchived body.\n",
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z"
  });
});

test("GET /api/:project/mermaid/:view reads generated Mermaid text without regenerating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-http-mermaid-"));
  const registry = resourceRegistry([projectState(root)]);

  await writeText(root, path.join(".worktracker", "graphs", "dependencies.mmd"), "graph LR\n");
  await writeText(root, path.join(".worktracker", "graphs", "E-001.mmd"), "graph TB\n");

  assert.equal(await getHttpMermaid(registry, "wt_http", "dependencies"), "graph LR\n");
  assert.equal(await getHttpMermaid(registry, "wt_http", "epic/E-001"), "graph TB\n");
});

test("unknown project and missing entity map to HTTP 404 error bodies", () => {
  const registry = resourceRegistry([projectState(path.join(os.tmpdir(), "file-kanban-http-errors"))]);

  assert.deepEqual(captureHttpError(() => getHttpBoard(registry, "wt_missing")), {
    status: 404,
    body: {
      code: "PROJECT_NOT_FOUND",
      message: "Project 'wt_missing' is not registered.",
      details: { projectId: "wt_missing" }
    }
  });

  assert.deepEqual(captureHttpError(() => getHttpEntity(registry, "wt_http", "T-404")), {
    status: 404,
    body: {
      code: "NOT_FOUND",
      message: "Entity 'T-404' was not found.",
      details: { projectId: "wt_http", id: "T-404" }
    }
  });
});

test("Node HTTP adapter serves project-scoped read endpoints", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-http-adapter-"));
  const registry = resourceRegistry([projectState(root)]);
  await writeText(root, path.join(".worktracker", "graphs", "dependencies.mmd"), "graph LR\n");

  await withHttpServer(registry, async (baseUrl) => {
    const projects = await fetchJson(`${baseUrl}/api/projects`);
    assert.deepEqual(projects, [
      {
        projectId: "wt_http",
        title: "HTTP Project",
        root
      }
    ]);

    const board = await fetchJson(`${baseUrl}/api/wt_http/board`);
    assert.equal(board.epics[1].effectiveStatus, "blocked");
    assert.deepEqual(board.epics[1].blockedBy, ["E-001"]);

    const graph = await fetchJson(`${baseUrl}/api/wt_http/graph`);
    assert.deepEqual(graph.edges, [
      { from: "E-002", to: "E-001", type: "epic" },
      { from: "S-002", to: "S-001", type: "story" },
      { from: "T-002", to: "T-001", type: "task" }
    ]);

    const entityDetail = await fetchJson(`${baseUrl}/api/wt_http/entity/T-001`);
    assert.equal(entityDetail.body, "\n");
    assert.deepEqual(entityDetail.dependents, ["T-002"]);

    const mermaid = await fetch(`${baseUrl}/api/wt_http/mermaid/dependencies`);
    assert.equal(mermaid.status, 200);
    assert.match(mermaid.headers.get("content-type"), /^text\/plain/);
    assert.equal(await mermaid.text(), "graph LR\n");
  });
});

test("Node HTTP adapter serializes route, project, and method errors", async () => {
  const registry = resourceRegistry([projectState(path.join(os.tmpdir(), "file-kanban-http-adapter-errors"))]);

  await withHttpServer(registry, async (baseUrl) => {
    const unknownProject = await fetch(`${baseUrl}/api/wt_missing/board`);
    assert.equal(unknownProject.status, 404);
    assert.deepEqual(await unknownProject.json(), {
      code: "PROJECT_NOT_FOUND",
      message: "Project 'wt_missing' is not registered.",
      details: { projectId: "wt_missing" }
    });

    const missingRoute = await fetch(`${baseUrl}/api/wt_http/unknown`);
    assert.equal(missingRoute.status, 404);
    assert.deepEqual(await missingRoute.json(), {
      code: "NOT_FOUND",
      message: "Viewer API route was not found."
    });

    const writeAttempt = await fetch(`${baseUrl}/api/wt_http/board`, { method: "POST" });
    assert.equal(writeAttempt.status, 405);
    assert.deepEqual(await writeAttempt.json(), {
      code: "METHOD_NOT_ALLOWED",
      message: "The viewer API is read-only and accepts GET requests only."
    });
  });
});

test("Node HTTP adapter serves the built React viewer without changing API errors", async () => {
  const staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), "file-kanban-http-static-"));
  const registry = resourceRegistry([projectState(path.join(os.tmpdir(), "file-kanban-http-static-project"))]);

  await writeStaticText(staticRoot, "index.html", "<!doctype html><div id=\"root\"></div>\n");
  await writeStaticText(staticRoot, path.join("assets", "viewer.js"), "console.log('viewer');\n");

  await withHttpServer(
    registry,
    async (baseUrl) => {
      const root = await fetch(`${baseUrl}/`);
      assert.equal(root.status, 200);
      assert.match(root.headers.get("content-type"), /^text\/html/);
      assert.equal(await root.text(), "<!doctype html><div id=\"root\"></div>\n");

      const asset = await fetch(`${baseUrl}/assets/viewer.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type"), /^text\/javascript/);
      assert.equal(await asset.text(), "console.log('viewer');\n");

      const clientRoute = await fetch(`${baseUrl}/projects/wt_http/board`);
      assert.equal(clientRoute.status, 200);
      assert.match(clientRoute.headers.get("content-type"), /^text\/html/);
      assert.equal(await clientRoute.text(), "<!doctype html><div id=\"root\"></div>\n");

      const missingApi = await fetch(`${baseUrl}/api/wt_http/unknown`);
      assert.equal(missingApi.status, 404);
      assert.match(missingApi.headers.get("content-type"), /^application\/json/);
      assert.deepEqual(await missingApi.json(), {
        code: "NOT_FOUND",
        message: "Viewer API route was not found."
      });

      const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
      assert.equal(missingAsset.status, 404);
      assert.match(missingAsset.headers.get("content-type"), /^text\/plain/);
    },
    { staticRoot }
  );
});

test("Node HTTP adapter emits WebSocket changes only to subscribers for the changed project", async () => {
  const registry = resourceRegistry([
    projectState(path.join(os.tmpdir(), "file-kanban-http-ws-a"), "wt_a", "Project A"),
    projectState(path.join(os.tmpdir(), "file-kanban-http-ws-b"), "wt_b", "Project B")
  ]);

  await withHttpServer(registry, async (baseUrl, server) => {
    const projectAClient = await openWebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
    const projectBClient = await openWebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
    const projectAMessages = collectWebSocketJson(projectAClient);
    const projectBMessages = collectWebSocketJson(projectBClient);

    try {
      projectAClient.send(JSON.stringify({ subscribe: "wt_a" }));
      projectBClient.send(JSON.stringify({ subscribe: "wt_b" }));
      await waitForSubscription();

      server.broadcastChanged("wt_a", ["T-002", "T-001"]);
      assert.deepEqual(await projectAMessages.next(), {
        type: "changed",
        project: "wt_a",
        ids: ["T-001", "T-002"]
      });
      assert.deepEqual(projectBMessages.values, []);

      server.broadcastReload("wt_b");
      assert.deepEqual(await projectBMessages.next(), {
        type: "reload",
        project: "wt_b"
      });
      assert.equal(projectAMessages.values.length, 0);
    } finally {
      projectAClient.close();
      projectBClient.close();
    }
  });
});

test("Node HTTP adapter rejects WebSocket subscriptions for unknown projects", async () => {
  const registry = resourceRegistry([projectState(path.join(os.tmpdir(), "file-kanban-http-ws-unknown"))]);

  await withHttpServer(registry, async (baseUrl) => {
    const client = await openWebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);

    try {
      const close = onceWebSocketClose(client);
      client.send(JSON.stringify({ subscribe: "wt_missing" }));
      const closeEvent = await close;
      assert.equal(closeEvent.code, 1008);
    } finally {
      client.close();
    }
  });
});

async function writeText(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeStaticText(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function withHttpServer(registry, run, options) {
  const server = createHttpServer(registry, options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  return response.json();
}

async function openWebSocket(url) {
  const websocket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    websocket.once("open", resolve);
    websocket.once("error", reject);
  });
  return websocket;
}

function collectWebSocketJson(websocket) {
  const values = [];
  const waiters = [];

  websocket.on("message", (data) => {
    const value = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }

    values.push(value);
  });

  return {
    values,
    next() {
      if (values.length > 0) {
        return Promise.resolve(values.shift());
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timed out waiting for WebSocket message."));
        }, 500);

        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    }
  };
}

function onceWebSocketClose(websocket) {
  return new Promise((resolve) => {
    websocket.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function waitForSubscription() {
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
}

function captureHttpError(run) {
  try {
    run();
  } catch (error) {
    return toHttpErrorBody(error);
  }

  throw new Error("Expected function to throw.");
}

function resourceRegistry(states) {
  return {
    listProjects() {
      return states
        .map((state) => ({
          projectId: state.projectId,
          title: state.marker.title,
          root: state.root
        }))
        .sort((left, right) => left.projectId.localeCompare(right.projectId) || left.root.localeCompare(right.root));
    },
    resolveProject(projectId) {
      const state = states.find((candidate) => candidate.projectId === projectId);
      if (state === undefined) {
        throw new RegistryError("PROJECT_NOT_FOUND", `Project '${projectId}' is not registered.`, { projectId });
      }

      return state;
    }
  };
}

function projectState(root, projectId = "wt_http", title = "HTTP Project") {
  const entities = [
    entity({ id: "E-001", type: "epic", title: "Epic", parent: null }),
    entity({ id: "E-002", type: "epic", title: "Gated epic", parent: null, dependsOn: ["E-001"] }),
    entity({ id: "S-001", type: "story", title: "Story", parent: "E-001" }),
    entity({ id: "S-002", type: "story", title: "Gated story", parent: "E-002", dependsOn: ["S-001"] }),
    entity({
      id: "T-001",
      type: "task",
      title: "Ready task",
      parent: "S-001",
      estimate: 2,
      tags: ["ready"],
      filePath: path.join(root, ".worktracker", "entities", "T-001-ready-task.md")
    }),
    entity({
      id: "T-002",
      type: "task",
      title: "Blocked task",
      parent: "S-002",
      dependsOn: ["T-001"],
      filePath: path.join(root, ".worktracker", "entities", "T-002-blocked-task.md")
    }),
    entity({
      id: "T-003",
      type: "task",
      title: "Archived task",
      parent: "S-001",
      status: "done",
      tags: ["archived"],
      archived: true,
      body: "\nArchived body.\n",
      filePath: path.join(root, ".worktracker", "entities", "T-003-archived-task.md")
    })
  ];

  return {
    projectId,
    root,
    marker: {
      projectId,
      title,
      created: "2026-06-07T00:00:00Z"
    },
    index: {
      byId: new Map(entities.map((current) => [current.id, current])),
      childrenOf: new Map([
        ["E-001", ["S-001"]],
        ["E-002", ["S-002"]],
        ["S-001", ["T-001", "T-003"]],
        ["S-002", ["T-002"]]
      ])
    },
    eff: new Map([
      ["E-001", "blocked"],
      ["E-002", "blocked"],
      ["S-001", "todo"],
      ["S-002", "blocked"],
      ["T-001", "todo"],
      ["T-002", "blocked"],
      ["T-003", "done"]
    ])
  };
}

function entityView(overrides) {
  return {
    status: "todo",
    archived: false,
    filePath: "",
    tags: [],
    ...overrides
  };
}

function entity(overrides) {
  return {
    id: "T-001",
    type: "task",
    title: "Task",
    parent: "S-001",
    status: "todo",
    dependsOn: [],
    tags: [],
    archived: false,
    created: "2026-06-07T00:00:00Z",
    updated: "2026-06-07T00:00:00Z",
    body: "\n",
    filePath: "",
    ...overrides
  };
}
