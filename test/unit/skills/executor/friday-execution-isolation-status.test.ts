import { describe, expect, it } from "vitest";

import {
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
} from "../../../../src/skills/executor/friday-node-executor.js";
import {
  getFridayExecutionIsolationStatus,
} from "../../../../src/skills/executor/friday-execution-isolation-status.js";

describe("getFridayExecutionIsolationStatus", () => {
  it("truth-labels execution boundaries as not OS-sandboxed when no process sandbox is available", () => {
    const status = getFridayExecutionIsolationStatus({}, { darwinSandboxExecAvailable: false });

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
          boundary: "disabled_in_production_unisolated_test_harness_only",
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

  it("truth-labels shell and python as partially OS-sandboxed when Darwin sandbox-exec is available", () => {
    const status = getFridayExecutionIsolationStatus({}, { darwinSandboxExecAvailable: true });

    expect(status).toMatchObject({
      schemaVersion: "1.0",
      disposition: "partial_os_sandbox",
      osSandbox: true,
      surfaces: {
        "skill.shell": {
          boundary: "darwin_sandbox_exec_write_network_guard",
          osSandbox: true,
          defaultLive: true,
        },
        "skill.python": {
          boundary: "darwin_sandbox_exec_write_network_guard",
          osSandbox: true,
          defaultLive: true,
        },
        "skill.node": {
          osSandbox: false,
        },
        "plugin.entrypoint": {
          osSandbox: false,
        },
        "agent.exec": {
          osSandbox: false,
        },
      },
    });
  });

  it("never reports non-bundled Node skills as production-live from the unisolated test gate", () => {
    const status = getFridayExecutionIsolationStatus({
      [FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV]: "true",
      FRIDAY_UNISOLATED_NODE_SKILLS_TEST_HARNESS: "true",
    });

    expect(status.surfaces["skill.node"]).toMatchObject({
      boundary: "disabled_in_production_unisolated_test_harness_only",
      osSandbox: false,
      defaultLive: false,
    });
  });
});
