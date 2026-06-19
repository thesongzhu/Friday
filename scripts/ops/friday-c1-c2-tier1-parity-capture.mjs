#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOURCE_ORDER = ["codex", "claude", "deepseek", "live-synthetic"];
const DEFAULT_REPORT_ROOT = path.join(os.tmpdir(), "friday-c1-c2-tier1-parity-capture");

export const TRUTH_LABEL =
  "built-DARK C1/C2 Tier-1 parity-capture harness draft; live parity not claimed; strict organic=0";

export const TIER1_PARITY_FLOW_SPECS = Object.freeze([
  {
    order: 1,
    flowId: "c1-codex-routed-proof",
    lane: "C1",
    source: "codex",
    expectedHarness: "scripts/ops/friday-codex-mission-proof-of-life.sh",
  },
  {
    order: 2,
    flowId: "c1-codex-routed-proof-keychain-wrapper",
    lane: "C1",
    source: "codex",
    expectedHarness: "scripts/ops/friday-codex-mission-proof-of-life-keychain.sh",
  },
  {
    order: 3,
    flowId: "c1-codex-route-agnostic-proof",
    lane: "C1",
    source: "codex",
    expectedHarness: "scripts/ops/friday-proof-of-life.sh",
  },
  {
    order: 4,
    flowId: "c1-codex-observe-wrapper-d8-audit",
    lane: "C1",
    source: "codex",
    expectedHarness: "scripts/diagnostics/friday-observe-wrapper-d8-audit.sh",
  },
  {
    order: 5,
    flowId: "c2-codex-mission-d8-soak",
    lane: "C2",
    source: "codex",
    expectedHarness: "scripts/ops/friday-codex-mission-d8-soak.sh",
  },
  {
    order: 6,
    flowId: "c2-codex-mission-d8-soak-keychain-wrapper",
    lane: "C2",
    source: "codex",
    expectedHarness: "scripts/ops/friday-codex-mission-d8-soak-keychain.sh",
  },
  {
    order: 7,
    flowId: "c1-claude-routed-proof",
    lane: "C1",
    source: "claude",
    expectedHarness: "scripts/ops/friday-claude-mission-proof-of-life.sh",
  },
  {
    order: 8,
    flowId: "c1-claude-routed-proof-keychain-wrapper",
    lane: "C1",
    source: "claude",
    expectedHarness: "scripts/ops/friday-claude-mission-proof-of-life-keychain.sh",
  },
  {
    order: 9,
    flowId: "c1-claude-process-observation-audit",
    lane: "C1",
    source: "claude",
    expectedHarness: "scripts/diagnostics/friday-observe-wrapper-d8-audit.sh",
  },
  {
    order: 10,
    flowId: "c1-claude-session-ledger-link-audit",
    lane: "C1",
    source: "claude",
    expectedHarness: "scripts/diagnostics/friday-observe-wrapper-d8-audit.sh",
  },
  {
    order: 11,
    flowId: "c2-claude-workitem-proof-audit",
    lane: "C2",
    source: "claude",
    expectedHarness: "scripts/diagnostics/friday-observe-wrapper-d8-audit.sh",
  },
  {
    order: 12,
    flowId: "c2-claude-routed-session-capture",
    lane: "C2",
    source: "claude",
    expectedHarness: "scripts/ops/friday-claude-mission-proof-of-life.sh",
  },
  {
    order: 13,
    flowId: "c1-deepseek-route-pong",
    lane: "C1",
    source: "deepseek",
    expectedHarness: "scripts/ops/friday-proof-of-life.sh",
  },
  {
    order: 14,
    flowId: "c1-deepseek-live-route-test",
    lane: "C1",
    source: "deepseek",
    expectedHarness: "rust-core/crates/friday-deepseek/tests/live_route.rs",
  },
  {
    order: 15,
    flowId: "c1-deepseek-rust-route-self-probe",
    lane: "C1",
    source: "deepseek",
    expectedHarness: "src/diagnostics/friday-rust-route-self-probe.ts",
  },
  {
    order: 16,
    flowId: "c1-deepseek-real-green-routing-diagnostic",
    lane: "C1",
    source: "deepseek",
    expectedHarness: "scripts/ops/run-real-green-gate-self-hosted.mjs",
  },
  {
    order: 17,
    flowId: "c2-deepseek-token-ledger-parity",
    lane: "C2",
    source: "deepseek",
    expectedHarness: "scripts/ops/friday-proof-of-life.sh",
  },
  {
    order: 18,
    flowId: "c2-deepseek-no-openai-fallback-diagnostic",
    lane: "C2",
    source: "deepseek",
    expectedHarness: "scripts/ops/phase24h-telegram-natural-trigger-listener.mjs",
  },
  {
    order: 19,
    flowId: "c1-live-synthetic-discord-trusted-inbound",
    lane: "C1",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24b-discord-trusted-inbound-listener.mjs",
  },
  {
    order: 20,
    flowId: "c1-live-synthetic-telegram-trusted-inbound",
    lane: "C1",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24c-telegram-trusted-inbound-listener.mjs",
  },
  {
    order: 21,
    flowId: "c1-live-synthetic-lark-feishu-trusted-inbound",
    lane: "C1",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24d-lark-feishu-trusted-inbound-listener.mjs",
  },
  {
    order: 22,
    flowId: "c2-live-synthetic-telegram-workflow-candidate",
    lane: "C2",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24e-telegram-workflow-candidate-listener.mjs",
  },
  {
    order: 23,
    flowId: "c2-live-synthetic-discord-workflow-candidate",
    lane: "C2",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24f-discord-workflow-candidate-listener.mjs",
  },
  {
    order: 24,
    flowId: "c2-live-synthetic-lark-feishu-workflow-candidate",
    lane: "C2",
    source: "live-synthetic",
    expectedHarness: "scripts/ops/phase24g-lark-feishu-workflow-candidate-listener.mjs",
  },
]);

function envBoolean(env, name, fallback = false) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function defaultReportPath() {
  return path.join(DEFAULT_REPORT_ROOT, "c1-c2-tier1-parity-capture.json");
}

function artifactPathFor(root, flow) {
  return path.join(root, `${String(flow.order).padStart(2, "0")}-${flow.flowId}.json`);
}

function orderedSourceSignature(flows = TIER1_PARITY_FLOW_SPECS) {
  return flows.map((flow) => flow.source);
}

export function readEnvConfig(env = process.env) {
  return {
    enabled: envBoolean(env, "FRIDAY_C1_C2_TIER1_CAPTURE", false),
    artifactRoot: env.FRIDAY_C1_C2_TIER1_CAPTURE_ROOT?.trim() || "",
    reportPath: env.FRIDAY_C1_C2_TIER1_CAPTURE_REPORT?.trim() || defaultReportPath(),
    generatedAt: new Date().toISOString(),
  };
}

export function validateFlowSpecs(flows = TIER1_PARITY_FLOW_SPECS) {
  const errors = [];
  if (flows.length !== 24) {
    errors.push(`expected 24 flows, got ${flows.length}`);
  }

  const orders = flows.map((flow) => flow.order);
  for (let index = 0; index < orders.length; index += 1) {
    if (orders[index] !== index + 1) {
      errors.push(`flow order mismatch at index ${index}: got ${orders[index]}`);
    }
  }

  const sourceOrder = [...new Set(orderedSourceSignature(flows))];
  if (JSON.stringify(sourceOrder) !== JSON.stringify(SOURCE_ORDER)) {
    errors.push(`source order mismatch: ${sourceOrder.join(",")}`);
  }

  for (const source of SOURCE_ORDER) {
    const count = flows.filter((flow) => flow.source === source).length;
    if (count !== 6) {
      errors.push(`expected 6 ${source} flows, got ${count}`);
    }
  }

  for (const flow of flows) {
    if (!flow.flowId || !flow.expectedHarness || !flow.lane || !flow.source) {
      errors.push(`flow ${flow.order} is missing required metadata`);
    }
    if (!["C1", "C2"].includes(flow.lane)) {
      errors.push(`flow ${flow.flowId} has invalid lane ${flow.lane}`);
    }
  }

  return errors;
}

export function validateCaptureRecord(flow, record) {
  const errors = [];
  const recordObject = record && typeof record === "object" ? record : {};
  if (recordObject.flowId !== flow.flowId) {
    errors.push(`flowId mismatch for ${flow.flowId}`);
  }
  if (recordObject.source !== flow.source) {
    errors.push(`source mismatch for ${flow.flowId}`);
  }
  if (recordObject.order !== flow.order) {
    errors.push(`order mismatch for ${flow.flowId}`);
  }
  if (recordObject.lane !== flow.lane) {
    errors.push(`lane mismatch for ${flow.flowId}`);
  }
  if (recordObject.organic === true || recordObject.runKind === "organic") {
    errors.push(`organic claim is not allowed for ${flow.flowId}`);
  }
  if (recordObject.fakeData === true || recordObject.fakeDbRows === true || recordObject.fixture === true) {
    errors.push(`fake-data marker is not allowed for ${flow.flowId}`);
  }
  if (recordObject.builtDark === true && recordObject.live === true) {
    errors.push(`built-DARK cannot also be live for ${flow.flowId}`);
  }
  if (recordObject.claimedOrganic === true || recordObject.claimedLiveParity === true) {
    errors.push(`overclaim marker is not allowed for ${flow.flowId}`);
  }
  if (typeof recordObject.truthLabel !== "string" || !recordObject.truthLabel.includes("parity-capture")) {
    errors.push(`truthLabel must name parity-capture for ${flow.flowId}`);
  }
  if (!Array.isArray(recordObject.evidence) || recordObject.evidence.length === 0) {
    errors.push(`evidence array is required for ${flow.flowId}`);
  }
  return errors;
}

function skippedEntry(flow, reason) {
  return {
    ...flow,
    status: "skipped",
    reason,
    builtDark: true,
    live: false,
    organic: false,
    truthLabel: TRUTH_LABEL,
    evidence: [],
  };
}

async function readCapture(flow, artifactRoot) {
  const filePath = artifactPathFor(artifactRoot, flow);
  const raw = await fs.readFile(filePath, "utf8");
  const record = JSON.parse(raw);
  const errors = validateCaptureRecord(flow, record);
  return {
    ...flow,
    status: errors.length === 0 ? "captured" : "invalid",
    artifactPath: filePath,
    errors,
    record,
  };
}

export async function buildCaptureReport(config = readEnvConfig()) {
  const specErrors = validateFlowSpecs();
  const report = {
    schemaVersion: "friday.c1_c2_tier1_parity_capture.v1",
    generatedAt: config.generatedAt,
    truthLabel: TRUTH_LABEL,
    builtDark: true,
    live: false,
    organicFlowCount: 0,
    scope: "C1/C2 Tier-1 24-flow parity capture",
    sourceOrder: SOURCE_ORDER,
    status: "skipped",
    blocker: null,
    flows: [],
    specErrors,
  };

  if (specErrors.length > 0) {
    report.status = "invalid";
    report.blocker = "flow spec invariant failed";
    report.flows = TIER1_PARITY_FLOW_SPECS.map((flow) => skippedEntry(flow, "flow spec invariant failed"));
    return report;
  }

  if (!config.enabled) {
    report.blocker = "FRIDAY_C1_C2_TIER1_CAPTURE is not enabled";
    report.flows = TIER1_PARITY_FLOW_SPECS.map((flow) =>
      skippedEntry(flow, "capture runner is env-gated and was not enabled"),
    );
    return report;
  }

  if (!config.artifactRoot) {
    report.status = "blocked";
    report.blocker = "FRIDAY_C1_C2_TIER1_CAPTURE_ROOT is required when capture is enabled";
    report.flows = TIER1_PARITY_FLOW_SPECS.map((flow) => skippedEntry(flow, report.blocker));
    return report;
  }

  const captured = [];
  for (const flow of TIER1_PARITY_FLOW_SPECS) {
    try {
      captured.push(await readCapture(flow, config.artifactRoot));
    } catch (error) {
      captured.push({
        ...flow,
        status: "missing",
        artifactPath: artifactPathFor(config.artifactRoot, flow),
        errors: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  report.flows = captured;
  const invalidCount = captured.filter((flow) => flow.status !== "captured").length;
  report.status = invalidCount === 0 ? "captured" : "blocked";
  report.blocker = invalidCount === 0 ? null : `${invalidCount} capture artifact(s) missing or invalid`;
  return report;
}

export async function writeCaptureReport(report, reportPath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main() {
  const config = readEnvConfig();
  const report = await buildCaptureReport(config);
  await writeCaptureReport(report, config.reportPath);
  console.log(JSON.stringify({
    ok: report.status === "captured" || report.status === "skipped",
    status: report.status,
    reportPath: config.reportPath,
    truthLabel: report.truthLabel,
    organicFlowCount: report.organicFlowCount,
    blocker: report.blocker,
  }, null, 2));
  return report.status === "captured" || report.status === "skipped" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
