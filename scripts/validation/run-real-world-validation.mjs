#!/usr/bin/env node

import { REAL_WORLD_SCENARIOS } from "../../validation/real-world/catalog/scenarios.mjs";
import { runRealWorldValidation } from "../../validation/real-world/lib/runner.mjs";

function parseArgs(argv) {
  const options = {
    suite: "smoke",
    judgePolicy: "auto",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--suite":
        options.suite = next;
        index += 1;
        break;
      case "--base-url":
        options.baseUrl = next;
        index += 1;
        break;
      case "--ui-base-url":
        options.uiBaseUrl = next;
        index += 1;
        break;
      case "--auth-mode":
        options.authMode = next;
        index += 1;
        break;
      case "--access-token":
        options.accessToken = next;
        index += 1;
        break;
      case "--local-passphrase":
        options.localPassphrase = next;
        index += 1;
        break;
      case "--email":
        options.email = next;
        index += 1;
        break;
      case "--password":
        options.password = next;
        index += 1;
        break;
      case "--judge":
        options.judgePolicy = next;
        index += 1;
        break;
      case "--mint-local-admin-token":
        options.mintLocalAdminToken = true;
        break;
      case "--mint-state-db-path":
        options.mintStateDbPath = next;
        index += 1;
        break;
      case "--mint-token-secret":
        options.mintTokenSecret = next;
        index += 1;
        break;
      case "--mint-token-secret-file":
        options.mintTokenSecretFile = next;
        index += 1;
        break;
      case "--mint-user-id":
        options.mintUserId = next;
        index += 1;
        break;
      case "--mint-user-email":
        options.mintUserEmail = next;
        index += 1;
        break;
      case "--mint-tenant-id":
        options.mintTenantId = next;
        index += 1;
        break;
      case "--mint-access-token-ttl-sec":
        options.mintAccessTokenTtlSec = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--scenario":
        options.scenarioIds = next.split(",").map((value) => value.trim()).filter(Boolean);
        index += 1;
        break;
      case "--layer":
        options.layers = next.split(",").map((value) => value.trim()).filter(Boolean);
        index += 1;
        break;
      case "--tag":
        options.tags = next.split(",").map((value) => value.trim()).filter(Boolean);
        index += 1;
        break;
      case "--repetitions":
        options.repetitions = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--catalog-only":
        options.catalogOnly = true;
        break;
      case "--list-scenarios":
        options.listScenarios = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function printScenarioList() {
  console.log("id\tlayer\tproductArea\tsuites\texecution");
  for (const scenario of REAL_WORLD_SCENARIOS) {
    console.log([
      scenario.id,
      scenario.layer,
      scenario.productArea,
      (scenario.suites ?? []).join(","),
      scenario.execution.kind,
    ].join("\t"));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listScenarios) {
    printScenarioList();
    return;
  }
  const result = await runRealWorldValidation({
    ...options,
    repoRoot: process.cwd(),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
