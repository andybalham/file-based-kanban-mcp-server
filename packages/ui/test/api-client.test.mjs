import assert from "node:assert/strict";
import { test } from "node:test";

import { ViewerApiError, createViewerApiClient } from "../dist-types/api.js";

test("viewer API client calls the read-only project, board, and entity endpoints", async () => {
  const calls = [];
  const client = createViewerApiClient({
    baseUrl: "http://127.0.0.1:4100/",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, accept: init?.headers?.accept });

      if (String(url).endsWith("/api/projects")) {
        return jsonResponse([{ projectId: "wt_demo", title: "Demo", root: "C:\\demo" }]);
      }

      if (String(url).endsWith("/entity/T-001")) {
        return jsonResponse({ id: "T-001", body: "\n" });
      }

      return jsonResponse({
        epics: [],
        validationWarnings: [{ code: "EMPTY_COMPOSITE", entityId: "E-001", message: "epic has no active children." }]
      });
    }
  });

  assert.deepEqual(await client.listProjects(), [{ projectId: "wt_demo", title: "Demo", root: "C:\\demo" }]);
  assert.deepEqual(await client.getBoard("wt/demo"), {
    epics: [],
    validationWarnings: [{ code: "EMPTY_COMPOSITE", entityId: "E-001", message: "epic has no active children." }]
  });
  assert.deepEqual(await client.getEntity("wt/demo", "T-001"), { id: "T-001", body: "\n" });
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:4100/api/projects",
      method: "GET",
      accept: "application/json"
    },
    {
      url: "http://127.0.0.1:4100/api/wt%2Fdemo/board",
      method: "GET",
      accept: "application/json"
    },
    {
      url: "http://127.0.0.1:4100/api/wt%2Fdemo/entity/T-001",
      method: "GET",
      accept: "application/json"
    }
  ]);
});

test("viewer API client preserves structured server error envelopes", async () => {
  const client = createViewerApiClient({
    fetchImpl: async () =>
      jsonResponse(
        {
          code: "PROJECT_NOT_FOUND",
          message: "Project 'wt_missing' is not registered.",
          details: { projectId: "wt_missing" }
        },
        404
      )
  });

  await assert.rejects(
    () => client.getGraph("wt_missing"),
    (error) => {
      assert.equal(error instanceof ViewerApiError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, "PROJECT_NOT_FOUND");
      assert.equal(error.message, "Project 'wt_missing' is not registered.");
      assert.deepEqual(error.details, { projectId: "wt_missing" });
      return true;
    }
  );
});

test("viewer API client subscribes to project-scoped WebSocket updates", () => {
  const messages = [];
  const client = createViewerApiClient({
    baseUrl: "https://example.test/app",
    fetchImpl: async () => jsonResponse({}),
    WebSocketCtor: FakeWebSocket
  });

  const subscription = client.subscribeToProject("wt_demo", {
    onMessage(message) {
      messages.push(message);
    }
  });
  const socket = FakeWebSocket.instances.at(-1);

  assert.notEqual(socket, undefined);
  assert.equal(socket.url, "wss://example.test/app/ws");

  socket.emit("open", {});
  assert.deepEqual(socket.sent, [JSON.stringify({ subscribe: "wt_demo" })]);

  socket.emit("message", { data: JSON.stringify({ type: "changed", project: "wt_demo", ids: ["T-001"] }) });
  socket.emit("message", { data: JSON.stringify({ type: "reload", project: "wt_demo" }) });
  socket.emit("message", { data: "not-json" });

  assert.deepEqual(messages, [
    { type: "changed", project: "wt_demo", ids: ["T-001"] },
    { type: "reload", project: "wt_demo" }
  ]);

  subscription.close();
  assert.equal(socket.closed, true);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
