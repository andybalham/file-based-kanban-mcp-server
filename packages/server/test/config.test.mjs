import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_HTTP_PORT,
  RUNTIME_CONFIG_ENV,
  RuntimeConfigError,
  createProjectRegistry,
  loadRuntimeConfig,
  runHttpViewerServer
} from "../dist/main.js";

class FakeWatcher {
  constructor(paths, options) {
    this.paths = paths;
    this.options = options;
    this.listeners = [];
    this.closed = false;
  }

  on(event, listener) {
    assert.equal(event, "all");
    this.listeners.push(listener);
    return this;
  }

  async close() {
    this.closed = true;
  }
}

function createFakeWatcherFactory() {
  const watchers = [];

  return {
    watchers,
    factory(paths, options) {
      const watcher = new FakeWatcher(paths, options);
      watchers.push(watcher);
      return watcher;
    }
  };
}

test("loadRuntimeConfig defaults to the process root, default port, and disabled git", () => {
  const cwd = path.join(os.tmpdir(), "file-kanban-config-default");

  assert.deepEqual(loadRuntimeConfig({ env: {}, cwd }), {
    initRoot: path.resolve(cwd),
    watchRoots: [path.resolve(cwd)],
    port: DEFAULT_HTTP_PORT,
    git: false
  });
});

test("loadRuntimeConfig parses configured watch roots, port, init root, and git flag", () => {
  const firstRoot = path.join(os.tmpdir(), "file-kanban-config-first");
  const secondRoot = path.join(os.tmpdir(), "file-kanban-config-second");
  const initRoot = path.join(os.tmpdir(), "file-kanban-config-init");

  assert.deepEqual(
    loadRuntimeConfig({
      env: {
        [RUNTIME_CONFIG_ENV.watchRoots]: [firstRoot, secondRoot, firstRoot].join(path.delimiter),
        [RUNTIME_CONFIG_ENV.port]: "4317",
        [RUNTIME_CONFIG_ENV.initRoot]: initRoot,
        [RUNTIME_CONFIG_ENV.git]: "yes"
      },
      cwd: path.join(os.tmpdir(), "ignored-cwd")
    }),
    {
      initRoot: path.resolve(initRoot),
      watchRoots: [path.resolve(firstRoot), path.resolve(secondRoot)],
      port: 4317,
      git: true
    }
  );
});

test("loadRuntimeConfig rejects invalid port and git values", () => {
  assert.throws(
    () => loadRuntimeConfig({ env: { [RUNTIME_CONFIG_ENV.port]: "not-a-port" } }),
    (error) =>
      error instanceof RuntimeConfigError &&
      error.code === "INVALID_PORT" &&
      error.variable === RUNTIME_CONFIG_ENV.port
  );

  assert.throws(
    () => loadRuntimeConfig({ env: { [RUNTIME_CONFIG_ENV.git]: "maybe" } }),
    (error) =>
      error instanceof RuntimeConfigError &&
      error.code === "INVALID_GIT" &&
      error.variable === RUNTIME_CONFIG_ENV.git
  );
});

test("runHttpViewerServer listens on configured port and starts watchers for configured roots", async () => {
  const watchRoot = path.join(os.tmpdir(), "file-kanban-config-viewer");
  const fake = createFakeWatcherFactory();
  const registry = createProjectRegistry({ watchRoots: [] });
  const runtime = await runHttpViewerServer({
    config: {
      initRoot: watchRoot,
      watchRoots: [watchRoot],
      port: 0,
      git: false
    },
    registry,
    watcherFactory: fake.factory
  });

  try {
    const address = runtime.server.address();

    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    assert.equal(address.port > 0, true);
    assert.deepEqual(fake.watchers.map((watcher) => watcher.paths), [[path.resolve(watchRoot)]]);
    assert.deepEqual(await fetchJson(`http://127.0.0.1:${address.port}/api/projects`), []);
  } finally {
    await runtime.close();
  }

  assert.equal(fake.watchers.every((watcher) => watcher.closed), true);
});

async function fetchJson(url) {
  const response = await fetch(url);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  return response.json();
}
