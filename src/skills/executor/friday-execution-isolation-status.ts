import {
  FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV,
  isFridayUnisolatedNodeSkillsEnabled,
} from "./friday-node-executor.js";

export type FridayExecutionIsolationSurface =
  | "skill.shell"
  | "skill.python"
  | "skill.node"
  | "skill.node.bundled_system"
  | "plugin.entrypoint"
  | "agent.exec";

export interface FridayExecutionIsolationStatus {
  schemaVersion: "1.0";
  disposition: "open_no_os_sandbox";
  osSandbox: false;
  surfaces: Record<FridayExecutionIsolationSurface, {
    boundary:
      | "logical_guards_only"
      | "disabled_by_default_unisolated"
      | "in_process_trusted"
      | "retired_by_default_dynamic_import_when_enabled"
      | "logical_workspace_guard_host_spawn";
    osSandbox: false;
    defaultLive: boolean;
    notes: string;
  }>;
}

export function getFridayExecutionIsolationStatus(
  env: NodeJS.ProcessEnv = process.env,
): FridayExecutionIsolationStatus {
  const unisolatedNodeEnabled = isFridayUnisolatedNodeSkillsEnabled(env);
  return {
    schemaVersion: "1.0",
    disposition: "open_no_os_sandbox",
    osSandbox: false,
    surfaces: {
      "skill.shell": {
        boundary: "logical_guards_only",
        osSandbox: false,
        defaultLive: false,
        notes: "Shell skills use host child_process.spawn with cwd/env/timeout/output guards; no kernel sandbox is applied.",
      },
      "skill.python": {
        boundary: "logical_guards_only",
        osSandbox: false,
        defaultLive: false,
        notes: "Python skills share the shell executor boundary and are not isolated by an OS sandbox.",
      },
      "skill.node": {
        boundary: "disabled_by_default_unisolated",
        osSandbox: false,
        defaultLive: unisolatedNodeEnabled,
        notes: `Non-bundled Node skills dynamically import in-process modules and require ${FRIDAY_ENABLE_UNISOLATED_NODE_SKILLS_ENV}=true.`,
      },
      "skill.node.bundled_system": {
        boundary: "in_process_trusted",
        osSandbox: false,
        defaultLive: true,
        notes: "Bundled system Node skills may run without the unisolated env gate, but still execute in the hub process.",
      },
      "plugin.entrypoint": {
        boundary: "retired_by_default_dynamic_import_when_enabled",
        osSandbox: false,
        defaultLive: false,
        notes: "Plugin lifecycle routes are retired by default; enabled plugin entrypoints are dynamic imports, not OS-isolated processes.",
      },
      "agent.exec": {
        boundary: "logical_workspace_guard_host_spawn",
        osSandbox: false,
        defaultLive: true,
        notes: "Agent exec uses host spawn with workspace, shell, timeout, and output controls; no OS sandbox is applied.",
      },
    },
  };
}
