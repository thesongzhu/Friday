#!/usr/bin/env node

import { assertEvidenceFreshness, createPhaseSteps, getGitHead, runCommand, writeEvidence } from "./closeout-lib.mjs";
import { acquireWorkspaceRunLock, releaseWorkspaceRunLock } from "./workspace-run-lock.mjs";

const steps = createPhaseSteps([
  { type: "npm", label: "Repo-ready verify", script: "release:verify:repo" },
  { type: "npm", label: "Phase 1 closeout", script: "closeout:phase1" },
  { type: "npm", label: "Phase 2 closeout", script: "closeout:phase2" },
  { type: "npm", label: "Phase 3 closeout", script: "closeout:phase3" },
  { type: "npm", label: "Phase 4 closeout", script: "closeout:phase4" },
  { type: "npm", label: "Phase 5 closeout", script: "closeout:phase5" },
  { type: "npm", label: "UI bundle health", script: "check:ui-bundle-health" },
  { type: "npm", label: "Final truth audit", script: "check:closeout:truth:final" },
]);

const startedAt = new Date().toISOString();
const runId = `closeout-final-${startedAt.replace(/[:.]/g, "-")}`;
const results = [];

acquireWorkspaceRunLock({
  pid: process.pid,
  kind: "closeout-final",
  runId,
  startedAt,
});

try {
  for (const step of steps) {
    console.log(`\n── ${step.label} ──`);
    const result = runCommand(step);
    results.push(result);
    if (result.status !== "passed") {
      writeEvidence("final", {
        status: "failed",
        gitHead: getGitHead(),
        generatedAt: new Date().toISOString(),
        title: "Non-Platform Final Closeout",
        notes: ["Final closeout halted because one of the required validation steps failed."],
        steps: results,
      });
      process.exit(result.exitCode);
    }
  }

  const completedAt = new Date().toISOString();
  const successPayload = {
    status: "passed",
    gitHead: getGitHead(),
    generatedAt: completedAt,
    title: "Non-Platform Final Closeout",
    notes: ["All non-platform closeout gates passed."],
    metrics: {
      stepCount: String(results.length),
      startedAt,
      completedAt,
    },
    steps: results,
  };
  writeEvidence("final", successPayload);

  try {
    assertEvidenceFreshness(
      ["phase1", "phase2", "phase3", "phase4", "phase5", "final"],
      getGitHead(),
    );
  } catch (error) {
    writeEvidence("final", {
      ...successPayload,
      status: "failed",
      notes: [
        "Final closeout generated fresh final evidence, but one or more closeout reports are stale for the current git head.",
        error instanceof Error ? error.message : String(error),
      ],
    });
    throw error;
  }

  console.log("\n🎉 Friday non-platform final closeout passed");
} finally {
  releaseWorkspaceRunLock({ runId });
}
