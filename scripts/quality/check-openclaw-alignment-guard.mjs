#!/usr/bin/env node
/**
 * Agent Parity Alignment Guard
 *
 * Purpose:
 * - Protect Friday MVP scope from silent drift.
 * - Ensure the critical runtime linkage invariants remain intact.
 *
 * This script is intentionally lightweight and deterministic:
 * it checks source-level invariants instead of invoking network/runtime state.
 */

import { readFile } from "node:fs/promises";

let errors = 0;

function ok(msg) {
  console.log(`✅ ${msg}`);
}

function fail(msg) {
  console.error(`❌ ${msg}`);
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

function extractConstStringArray(source, constName) {
  const re = new RegExp(
    String.raw`const\s+${constName}\s*=\s*\[([\s\S]*?)\]\s*as\s+const`,
    "m",
  );
  const match = source.match(re);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function assertSameArray(actual, expected, label) {
  const sameLength = actual.length === expected.length;
  const sameItems = sameLength && actual.every((value, idx) => value === expected[idx]);
  if (!sameItems) {
    fail(`${label} mismatch. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return;
  }
  ok(`${label} is locked: ${expected.join(", ")}`);
}

function assertContains(source, needle, label) {
  if (!source.includes(needle)) {
    fail(`${label} missing required fragment: ${needle}`);
    return;
  }
  ok(`${label} contains required fragment`);
}

async function run() {
  const marketplaceTypesPath = "src/marketplace/model/friday-marketplace.types.ts";
  const runtimePath = "src/agent/runtime/friday-agent-runtime.ts";
  const apiRuntimePath = "src/api/runtime/friday-api-runtime.ts";
  const hubPath = "src/hub/friday-hub-bootstrap.ts";
  const capabilityGatesPath = "src/hub/bootstrap/friday-capability-gates.ts";
  const marketplaceRoutesPath = "src/api/http/routes/friday-marketplace-commerce-routes.ts";
  const sessionsToolPath = "src/agent/tools/friday-agent-sessions-tool.ts";
  const heartbeatPath = "src/heartbeat/friday-heartbeat-runner.ts";
  const runbookPath = "docs/task/marketplace-agent-mvp-runtime-runbook-2026-03-01.md";

  const [
    marketplaceTypesSource,
    runtimeSource,
    apiRuntimeSource,
    hubSource,
    capabilityGatesSource,
    marketplaceRoutesSource,
    sessionsToolSource,
    heartbeatSource,
    runbookSource,
  ] = await Promise.all([
    readUtf8(marketplaceTypesPath),
    readUtf8(runtimePath),
    readUtf8(apiRuntimePath),
    readUtf8(hubPath),
    readUtf8(capabilityGatesPath),
    readUtf8(marketplaceRoutesPath),
    readUtf8(sessionsToolPath),
    readUtf8(heartbeatPath),
    readUtf8(runbookPath),
  ]);

  const mvpPricing = extractConstStringArray(
    marketplaceTypesSource,
    "FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES",
  );
  if (!mvpPricing) {
    fail("Could not locate FRIDAY_MVP_ALLOWED_PRICING_PLAN_TYPES");
  } else {
    assertSameArray(mvpPricing, ["free", "one_time"], "MVP pricing types");
  }

  const assetTypes = extractConstStringArray(
    marketplaceTypesSource,
    "FRIDAY_MARKETPLACE_ASSET_TYPES",
  );
  if (!assetTypes) {
    fail("Could not locate FRIDAY_MARKETPLACE_ASSET_TYPES");
  } else {
    assertSameArray(assetTypes, ["skill", "workflow", "agent"], "Marketplace asset types");
  }

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

  assertContains(
    hubSource,
    "resolveFridayCapabilityGates(",
    "Marketplace capability gate resolver wiring",
  );
  assertContains(
    hubSource,
    "marketplaceCommerceEnabled",
    "Marketplace commerce flag wiring",
  );
  assertContains(
    hubSource,
    "marketplaceInstallRequired",
    "Marketplace install-required flag wiring",
  );
  assertContains(
    capabilityGatesSource,
    "env.FRIDAY_MARKETPLACE_COMMERCE_ENABLED",
    "Marketplace commerce env gate source",
  );
  assertContains(
    capabilityGatesSource,
    "env.FRIDAY_MARKETPLACE_INSTALL_REQUIRED",
    "Marketplace install-required env gate source",
  );
  assertContains(
    marketplaceRoutesSource,
    "FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED",
    "Marketplace agent-asset flag wiring",
  );

  assertContains(
    runbookSource,
    "`FRIDAY_MARKETPLACE_COMMERCE_ENABLED`",
    "Runtime runbook commerce flag docs",
  );
  assertContains(
    runbookSource,
    "`FRIDAY_MARKETPLACE_INSTALL_REQUIRED`",
    "Runtime runbook install flag docs",
  );
  assertContains(
    runbookSource,
    "`FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED`",
    "Runtime runbook agent flag docs",
  );

  if (errors > 0) {
    console.error(`\n💥 Agent parity alignment guard failed with ${errors} error(s)`);
    process.exit(1);
  }

  console.log("\n🎉 Agent parity alignment guard passed");
}

await run();
