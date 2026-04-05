#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const phase = process.argv[2] ?? "full";
const supportedPhases = new Set(["phase1", "phase2", "phase3", "full"]);

if (!supportedPhases.has(phase)) {
  console.error(
    `Unsupported phase "${phase}". Expected one of: ${Array.from(supportedPhases).join(", ")}`,
  );
  process.exit(1);
}

const baseFlagsDisabled = Object.freeze({
  FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING: "false",
  FRIDAY_SUBAGENT_FORK_MODE_ENABLED: "false",
});

const phase2Flags = Object.freeze({
  ...baseFlagsDisabled,
  FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING: "true",
});

const phase3Flags = Object.freeze({
  ...phase2Flags,
  FRIDAY_SUBAGENT_FORK_MODE_ENABLED: "true",
});

function createVitestStep(label, files, env) {
  return {
    label,
    command: NPX,
    args: ["vitest", "run", ...files],
    env,
  };
}

const phaseSteps = {
  phase1: [
    createVitestStep(
      "Phase 1: MCP readiness and starter-skill availability surface",
      [
        "test/unit/skills/manifest/friday-skill-manifest-defaults.test.ts",
        "test/unit/skills/manifest/friday-skill-manifest.schema.test.ts",
        "test/unit/agent/tools/friday-agent-capabilities-tool.test.ts",
        "test/unit/agent/tools/friday-agent-skills-list-tool.test.ts",
        "test/unit/agent/tools/friday-agent-skill-tool.test.ts",
        "test/unit/agent/tools/friday-agent-tool-registry.test.ts",
        "test/unit/sessions/friday-deterministic-dispatch.test.ts",
        "test/unit/api/runtime/friday-api-runtime-deterministic-dispatch.test.ts",
        "test/unit/agent/runtime/friday-agent-evidence-blocks.test.ts",
      ],
      baseFlagsDisabled,
    ),
  ],
  phase2: [
    createVitestStep(
      "Phase 2: starter-skill routing enforcement",
      [
        "test/unit/agent/runtime/friday-agent-starter-skill-routing.test.ts",
        "test/unit/agent/runtime/friday-agent-system-prompt-builder.test.ts",
        "test/unit/agent/runtime/friday-agent-runtime.test.ts",
      ],
      phase2Flags,
    ),
  ],
  phase3: [
    createVitestStep(
      "Phase 3: explicit subagent fork mode",
      [
        "test/unit/agent/persistence/friday-subagent-run-repository.test.ts",
        "test/unit/agent/subagent/friday-subagent-registry.test.ts",
        "test/unit/agent/subagent/friday-subagent-system-prompt.test.ts",
        "test/unit/agent/tools/friday-agent-subagent-tools.test.ts",
        "test/unit/agent/tools/friday-agent-agents-list-tool.test.ts",
        "test/integration/agent/friday-subagent-integration.test.ts",
        "test/integration/state/sqlite/friday-migration-chain.test.ts",
      ],
      phase3Flags,
    ),
  ],
};

if (phase === "full") {
  phaseSteps.full = [
    {
      label: "TypeScript typecheck",
      command: NPM,
      args: ["run", "typecheck"],
      env: phase3Flags,
    },
    ...phaseSteps.phase1,
    ...phaseSteps.phase2,
    ...phaseSteps.phase3,
  ];
}

for (const step of phaseSteps[phase]) {
  console.log(`\n== ${step.label} ==`);
  console.log(`$ ${[step.command, ...step.args].join(" ")}`);
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    env: { ...process.env, ...step.env },
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`\nAgent rollout acceptance passed for ${phase}.`);
