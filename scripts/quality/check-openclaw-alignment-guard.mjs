#!/usr/bin/env node
/**
 * Agent Parity Alignment Guard
 *
 * Protects critical runtime linkage invariants with deterministic source checks.
 */

import { readFile } from "node:fs/promises";

let errors = 0;

function ok(msg) {
  console.log(`OK ${msg}`);
}

function fail(msg) {
  console.error(`FAIL ${msg}`);
  errors++;
}

async function readUtf8(path) {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    fail(`Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function assertContains(source, needle, label) {
  if (!source.includes(needle)) {
    fail(`${label} missing required fragment: ${needle}`);
    return;
  }
  ok(`${label} contains required fragment`);
}

async function run() {
  const runtimePath = "src/agent/runtime/friday-agent-runtime.ts";
  const apiRuntimePath = "src/api/runtime/friday-api-runtime.ts";
  const hubPath = "src/hub/friday-hub-bootstrap.ts";
  const sessionsToolPath = "src/agent/tools/friday-agent-sessions-tool.ts";
  const heartbeatPath = "src/heartbeat/friday-heartbeat-runner.ts";

  const [
    runtimeSource,
    apiRuntimeSource,
    hubSource,
    sessionsToolSource,
    heartbeatSource,
  ] = await Promise.all([
    readUtf8(runtimePath),
    readUtf8(apiRuntimePath),
    readUtf8(hubPath),
    readUtf8(sessionsToolPath),
    readUtf8(heartbeatPath),
  ]);

  assertContains(
    runtimeSource,
    "enforceToolEvidenceForCompletionClaim(",
    "Agent runtime tool-evidence guard",
  );
  assertContains(
    runtimeSource,
    "no successful tool call evidence was recorded in this run",
    "Agent runtime unverified completion warning",
  );

  assertContains(
    apiRuntimeSource,
    "loadSessionHistoryMessages(",
    "API runtime session history loader",
  );
  assertContains(
    apiRuntimeSource,
    "historyMessages,",
    "API runtime executeRun history injection",
  );

  assertContains(
    hubSource,
    "FRIDAY_CHANNEL_CONTEXT_HISTORY_LIMIT",
    "Hub channel history limit",
  );
  assertContains(
    hubSource,
    "historyMessages,",
    "Hub channel executeRun history injection",
  );
  assertContains(
    sessionsToolSource,
    "SESSION_CONTEXT_HISTORY_LIMIT",
    "Sessions tool history limit",
  );
  assertContains(
    sessionsToolSource,
    "historyMessages,",
    "Sessions tool executeRun history injection",
  );
  assertContains(
    heartbeatSource,
    "historyMessages,",
    "Heartbeat executeRun history injection",
  );

  if (errors > 0) {
    console.error(`\nAgent parity alignment guard failed with ${errors} error(s)`);
    process.exit(1);
  }

  console.log("\nAgent parity alignment guard passed");
}

await run();
