import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  MCP_RESOURCE_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  RegistryError
} from "../dist/main.js";
import { parseResourceReadArgs, registerStdioMcpSurface } from "../dist/stdio.js";

test("stdio surface registers every design resource and tool deterministically", () => {
  const server = new FakeMcpServer();
  const templates = [];

  registerStdioMcpSurface(server, {
    registry: registryWithProjects([projectState("wt_stdio")]),
    initRoot: path.join(os.tmpdir(), "file-kanban-stdio-init"),
    resourceTemplateFactory(key, template) {
      templates.push([key, template]);
      return { key, template };
    }
  });

  assert.deepEqual(
    server.resources.map((resource) => resource.name),
    Object.keys(MCP_RESOURCE_DEFINITIONS)
  );
  assert.deepEqual(
    templates,
    Object.entries(MCP_RESOURCE_TEMPLATES).map(([key, template]) => [key, template])
  );
  assert.deepEqual(
    server.tools.map((tool) => tool.name),
    MCP_TOOL_NAMES
  );
  assert.equal(server.tools.find((tool) => tool.name === "list_projects").options.annotations.readOnlyHint, true);
  assert.equal(server.tools.find((tool) => tool.name === "create_entity").options.annotations.readOnlyHint, false);
  assert.equal(server.tools.find((tool) => tool.name === "init").options.description, MCP_TOOL_DEFINITIONS.init.description);
});

test("stdio registered handlers return MCP resource and tool response envelopes", async () => {
  const server = new FakeMcpServer();
  const project = projectState("wt_stdio_handlers");

  registerStdioMcpSurface(server, {
    registry: registryWithProjects([project]),
    initRoot: project.root
  });

  const projectList = await server.resource("projectList").handler(new URL("project://list"));
  assert.deepEqual(projectList, {
    contents: [
      {
        uri: "project://list",
        mimeType: "application/json",
        text: `${JSON.stringify({ projects: [{ projectId: project.projectId, title: project.marker.title, root: project.root }] }, null, 2)}\n`
      }
    ]
  });

  const listProjects = await server.tool("list_projects").handler({});
  assert.equal(listProjects.isError, undefined);
  assert.deepEqual(listProjects.structuredContent, {
    projects: [{ projectId: project.projectId, title: project.marker.title, root: project.root }]
  });
  assert.match(listProjects.content[0].text, /wt_stdio_handlers/);
});

test("stdio init handler targets the configured process root", async () => {
  const server = new FakeMcpServer();
  const initRoot = path.join(os.tmpdir(), "file-kanban-stdio-configured-root");
  const calls = [];
  const registry = {
    ...registryWithProjects([]),
    async init(args) {
      calls.push(args);
      return { projectId: "wt_init" };
    }
  };

  registerStdioMcpSurface(server, { registry, initRoot });

  const result = await server.tool("init").handler({ title: "Initialized", intent: "Seed requirements" });

  assert.deepEqual(calls, [{ title: "Initialized", intent: "Seed requirements", root: initRoot }]);
  assert.deepEqual(result.structuredContent, { projectId: "wt_init" });
});

test("stdio tool errors preserve structured MCP error payloads", async () => {
  const server = new FakeMcpServer();

  registerStdioMcpSurface(server, {
    registry: registryWithProjects([projectState("wt_one"), projectState("wt_two")]),
    initRoot: os.tmpdir()
  });

  const result = await server.tool("query_ready").handler({});

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "AMBIGUOUS_PROJECT",
      message: "Multiple projects are registered; provide projectId to choose one."
    }
  });
  assert.match(result.content[0].text, /AMBIGUOUS_PROJECT/);
});

test("parseResourceReadArgs supports SDK variable maps and URL fallback parsing", () => {
  assert.deepEqual(parseResourceReadArgs("entity", new URL("entity://ignored/T-999"), { project: "wt_vars", id: "T-001" }), {
    key: "entity",
    projectId: "wt_vars",
    id: "T-001"
  });
  assert.deepEqual(parseResourceReadArgs("epicGraph", new URL("graph://wt_url/epic/E-001")), {
    key: "epicGraph",
    projectId: "wt_url",
    id: "E-001"
  });
  assert.deepEqual(parseResourceReadArgs("requirementsSource", new URL("requirements://wt_url/source")), {
    key: "requirementsSource",
    projectId: "wt_url"
  });
});

class FakeMcpServer {
  constructor() {
    this.resources = [];
    this.tools = [];
  }

  registerResource(name, template, options, handler) {
    this.resources.push({ name, template, options, handler });
  }

  registerTool(name, options, handler) {
    this.tools.push({ name, options, handler });
  }

  resource(name) {
    return this.resources.find((resource) => resource.name === name);
  }

  tool(name) {
    return this.tools.find((tool) => tool.name === name);
  }
}

function registryWithProjects(states) {
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
      if (projectId === undefined) {
        if (states.length === 1) {
          return states[0];
        }

        if (states.length === 0) {
          throw new RegistryError("PROJECT_NOT_FOUND", "No projects are registered.");
        }

        throw new RegistryError("AMBIGUOUS_PROJECT", "Multiple projects are registered; provide projectId to choose one.");
      }

      const state = states.find((candidate) => candidate.projectId === projectId);
      if (state === undefined) {
        throw new RegistryError("PROJECT_NOT_FOUND", `Project '${projectId}' is not registered.`, { projectId });
      }

      return state;
    },
    async discover() {
      return states;
    },
    async init() {
      return { projectId: "wt_init" };
    },
    async registerDiscovered() {
      return states[0];
    }
  };
}

function projectState(projectId) {
  const root = path.join(os.tmpdir(), projectId);
  return {
    projectId,
    root,
    marker: {
      projectId,
      title: `Project ${projectId}`,
      created: "2026-06-07T00:00:00Z"
    },
    index: {
      byId: new Map(),
      childrenOf: new Map()
    },
    eff: new Map()
  };
}
