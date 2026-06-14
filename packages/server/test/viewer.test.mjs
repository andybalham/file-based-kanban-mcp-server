import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { startViewerCli, viewerUrl } from "../dist/viewer.js";

test("viewer CLI starts the HTTP runtime and prints the operator URL", async () => {
  const writes = [];
  const watchRoot = path.resolve("viewer-cli-root");
  const runtime = runtimeWithAddress({ address: "0.0.0.0", family: "IPv4", port: 4321 }, [watchRoot]);
  const calls = [];

  const result = await startViewerCli({
    installSignalHandlers: false,
    stdout: {
      write(message) {
        writes.push(message);
      }
    },
    async runServer(options) {
      calls.push(options);
      return runtime;
    },
    config: {
      initRoot: watchRoot,
      watchRoots: [watchRoot],
      port: 4321,
      git: false
    }
  });

  assert.equal(result, runtime);
  assert.deepEqual(calls, [
    {
      config: {
        initRoot: watchRoot,
        watchRoots: [watchRoot],
        port: 4321,
        git: false
      }
    }
  ]);
  assert.deepEqual(writes, [`File Kanban viewer listening on http://127.0.0.1:4321\n`, `Watching ${watchRoot}\n`]);
});

test("viewerUrl preserves explicit loopback and IPv6 listener addresses", () => {
  assert.equal(viewerUrl(runtimeWithAddress({ address: "127.0.0.1", family: "IPv4", port: 4000 })), "http://127.0.0.1:4000");
  assert.equal(viewerUrl(runtimeWithAddress({ address: "::1", family: "IPv6", port: 4001 })), "http://[::1]:4001");
});

function runtimeWithAddress(address, watchRoots = [path.resolve("viewer-root")]) {
  return {
    config: {
      initRoot: watchRoots[0],
      watchRoots,
      port: address.port,
      git: false
    },
    registry: {},
    watcher: {},
    server: {
      address() {
        return address;
      }
    },
    async close() {}
  };
}
