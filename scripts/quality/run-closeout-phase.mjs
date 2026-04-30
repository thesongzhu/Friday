#!/usr/bin/env node

import { PHASE_TITLES, createPhaseSteps, getGitHead, validatePhaseArg, writeEvidence, runCommand } from "./closeout-lib.mjs";

const phaseId = validatePhaseArg(process.argv[2]);

const phaseSteps = {
  phase1: createPhaseSteps([
    { type: "npm", label: "Route contracts", script: "test:contracts:routes" },
    { type: "npm", label: "Type contracts", script: "test:contracts:types" },
    {
      label: "Canonical API compatibility pack",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: [
        "vitest",
        "run",
        "test/e2e/api/friday-api-approvals-routes.test.ts",
        "test/e2e/api/friday-api-health-routes.test.ts",
        "test/e2e/api/friday-api-sessions-memory-routes.test.ts",
        "test/unit/api/realtime/friday-realtime-ws-gateway.test.ts",
        "test/unit/api/http/routes/friday-realtime-routes.test.ts",
        "test/unit/api/http/routes/friday-health-routes.test.ts",
        "test/unit/api/http/routes/friday-session-routes.test.ts",
      ],
    },
    { type: "npm", label: "Truth audit", script: "check:closeout:truth:phase1" },
  ]),
  phase2: createPhaseSteps([
    {
      label: "Fleet and satellite pack",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: [
        "vitest",
        "run",
        "test/unit/api/http/routes/friday-fleet-routes.test.ts",
        "test/unit/api/http/routes/friday-satellite-runtime-routes.test.ts",
        "test/unit/api/routes/friday-satellite-pairing-routes.test.ts",
        "test/unit/api/fleet/friday-fleet-dashboard-service.test.ts",
        "test/unit/satellites/services/friday-satellite-registration-service.test.ts",
        "test/unit/satellites/services/friday-satellite-pairing-service.test.ts",
        "test/unit/satellites/services/friday-satellite-heartbeat-service.test.ts",
        "test/unit/satellites/services/friday-satellite-sync-service.test.ts",
        "test/unit/satellites/services/friday-satellite-offline-sweeper.test.ts",
        "test/unit/satellites/services/friday-outbox-queue-service.test.ts",
        "test/unit/workflows/friday-workflow-execution-service-distributed.test.ts",
        "test/unit/workflows/friday-workflow-satellite-dispatch-service.test.ts",
        "test/unit/ui/fleet-view-models.test.ts",
      ],
    },
    { type: "npm", label: "Truth audit", script: "check:closeout:truth:phase2" },
  ]),
  phase3: createPhaseSteps([
    {
      label: "Autonomous loop pack",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: [
        "vitest",
        "run",
        "test/unit/api/http/routes/friday-agent-loop-routes.test.ts",
        "test/unit/api/http/routes/friday-diagnosis-routes.test.ts",
        "test/unit/api/http/routes/friday-auto-fix-routes.test.ts",
        "test/unit/api/http/routes/friday-uix-routes.test.ts",
        "test/unit/learning/services/friday-agent-loop-service.test.ts",
        "test/unit/learning/services/friday-auto-fix-plan-service.test.ts",
        "test/unit/learning/services/friday-auto-fix-execution-service.test.ts",
        "test/unit/learning/services/friday-auto-fix-risk-assessment-service.test.ts",
        "test/unit/uix/services/friday-uix-surface-service.test.ts",
        "test/unit/ui/assistant-view-models.test.ts",
        "test/e2e/api/friday-api-self-healing-routes.test.ts",
      ],
    },
    { type: "npm", label: "Truth audit", script: "check:closeout:truth:phase3" },
  ]),
  phase4: createPhaseSteps([
    {
      label: "Acceptance, retry, and rules pack",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: [
        "vitest",
        "run",
        "test/integration/acceptance/friday-acceptance-gate-integration.test.ts",
        "test/integration/retry/friday-production-retry-bridge.test.ts",
        "test/integration/rules/friday-rules-persistence.test.ts",
        "test/unit/acceptance/engine/assertion-engine.test.ts",
        "test/unit/retry/engine/circuit-breaker.test.ts",
        "test/unit/rules/engine/rule-engine.test.ts",
        "test/unit/rules/engine/dsl-parser.test.ts",
        "test/unit/observability/services/friday-observability-api-service.test.ts",
        "test/unit/api/http/routes/friday-observability-routes.test.ts",
        "test/unit/observability/engine/dashboard-data-provider.test.ts",
      ],
    },
    { type: "npm", label: "Truth audit", script: "check:closeout:truth:phase4" },
  ]),
  phase5: createPhaseSteps([
    {
      label: "Skills lifecycle pack",
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: [
        "vitest",
        "run",
        "test/e2e/skills/friday-skill-lifecycle.test.ts",
        "test/e2e/api/friday-api-skills-routes.test.ts",
        "test/integration/skills/friday-skill-registry-lifecycle.test.ts",
        "test/unit/ui/skills-view-models.test.ts",
      ],
    },
    { type: "npm", label: "Truth audit", script: "check:closeout:truth:phase5" },
  ]),
};

const startedAt = new Date().toISOString();
const steps = [];

for (const step of phaseSteps[phaseId]) {
  console.log(`\n── ${step.label} ──`);
  const result = runCommand(step);
  steps.push(result);
  if (result.status !== "passed") {
    writeEvidence(phaseId, {
      status: "failed",
      gitHead: getGitHead(),
      generatedAt: new Date().toISOString(),
      title: PHASE_TITLES[phaseId],
      notes: ["Closeout phase failed before all checks completed."],
      steps,
    });
    process.exit(result.exitCode);
  }
}

const completedAt = new Date().toISOString();
writeEvidence(phaseId, {
  status: "passed",
  gitHead: getGitHead(),
  generatedAt: completedAt,
  title: PHASE_TITLES[phaseId],
  notes: [`Phase closeout completed successfully for ${phaseId}.`],
  metrics: {
    stepCount: String(steps.length),
    startedAt,
    completedAt,
  },
  steps,
});

console.log(`\n🎉 ${PHASE_TITLES[phaseId]} closeout passed`);
