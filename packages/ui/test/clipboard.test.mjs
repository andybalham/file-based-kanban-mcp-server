import assert from "node:assert/strict";
import { test } from "node:test";

import { copyCommitLabel, formatCommitLabel } from "../dist-types/clipboard.js";

test("commit labels use the current drawer entity id and title", () => {
  assert.equal(formatCommitLabel({ id: "T-103", title: "Login form" }), "T-103: Login form");
});

test("copy commit label writes the formatted label to the supplied clipboard", async () => {
  const writes = [];
  const copied = await copyCommitLabel(
    { id: "S-014", title: "Document runtime configuration" },
    {
      async writeText(value) {
        writes.push(value);
      }
    }
  );

  assert.equal(copied, "S-014: Document runtime configuration");
  assert.deepEqual(writes, ["S-014: Document runtime configuration"]);
});
