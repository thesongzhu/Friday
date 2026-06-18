import { describe, expect, it } from "vitest";

import {
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
} from "../../../../src/skills/executor/friday-node-executor.js";
import {
  getFridayExecutionIsolationStatus,
} from "../../../../src/skills/executor/friday-execution-isolation-status.js";

describe("getFridayExecutionIsolationStatus", () => {
  it("truth-labels execution boundaries as not OS-sandboxed by default", () => {
    const status = getFridayExecutionIsolationStatus({});

    expect(status).toMatchObject({
      schemaVersion: "1.0",
      disposition: "open_no_os_sandbox",
      osSandbox: false,
      surfaces: {
        "skill.shell": {
          boundary: "logical_guards_only",
          osSandbox: false,
          defaultLive: false,
        },
        "skill.python": {
          boundary: "logical_guards_only",
          osSandbox: false,
          defaultLive: false,
        },
        "skill.node": {
          boundary: "disabled_by_default_unisolated",
          osSandbox: false,
          defaultLive: false,
        },
        "skill.node.bundled_system": {
          boundary: "in_process_trusted",
          osSandbox: false,
          defaultLive: true,
        },
        "plugin.entrypoint": {
          boundary: "retired_by_default_dynamic_import_when_enabled",
          osSandbox: false,
          defaultLive: false,
        },
        "agent.exec": {
          boundary: "logical_workspace_guard_host_spawn",
          osSandbox: false,
          defaultLive: true,
        },
      },
    });
  });

  it("reports non-bundled Node skills as live only when the unisolated gate is enabled", () => {
    const status = getFridayExecutionIsolationStatus({
      [FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV]: "true",
    });

    expect(status.surfaces["skill.node"]).toMatchObject({
      boundary: "disabled_by_default_unisolated",
      osSandbox: false,
      defaultLive: true,
    });
  });
});
