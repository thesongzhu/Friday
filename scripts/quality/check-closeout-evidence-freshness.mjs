#!/usr/bin/env node

import { assertEvidenceFreshness, exitWithFailure, getGitHead, PHASE_DIRECTORY_NAMES } from "./closeout-lib.mjs";

const phaseIds = process.argv.slice(2);
const selectedPhases = phaseIds.length > 0 ? phaseIds : Object.keys(PHASE_DIRECTORY_NAMES);

try {
  assertEvidenceFreshness(selectedPhases, getGitHead());
  console.log(`\n🎉 Closeout evidence freshness passed for ${selectedPhases.join(", ")}`);
} catch (error) {
  exitWithFailure(
    error instanceof Error
      ? `Closeout evidence freshness failed\n${error.message}`
      : "Closeout evidence freshness failed",
  );
}
