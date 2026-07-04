import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-suite13-coverage-oracle.mjs";

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function canonicalMechanisms() {
  return [
    "intake_mission",
    "by_strength_routing",
    "execution_agent_run",
    "verification_proof",
    "memory_confirm_recall",
    "approval_gate",
    "trust_grant_dial",
    "context_passport",
    "audit_hash_chain",
    "token_metering",
    "skills",
    "provider_workspace",
    "channels",
    "voice",
    "pairing_device_trust",
    "needs_me_activity",
    "crash_recovery",
    "smart_queue",
    "smart_watch",
  ];
}

function census(overrides: Record<string, unknown> = {}) {
  return {
    truth: "suite13_census",
    sources: {
      A: {
        uiRoutes: ["/home", "/chat"],
        uiApiCalls: ["/v1/agent/runs"],
        swiftScreens: ["FridayChatScreen.swift"],
      },
      B: {
        httpRoutes: ["POST /v1/agent/runs"],
        sealedWsMessages: ["AskFridayRequest"],
        operatorClientEndpoints: ["POST /v1/agent/runs"],
      },
      C: {
        mechanisms: canonicalMechanisms(),
      },
    },
    cells: [
      {
        cellId: "desktop-web|smart_queue|/home:retry|success",
        surface: "desktop-web",
        mechanism: "smart_queue",
        control: "/home:retry",
        lifecycleState: "success",
      },
      {
        cellId: "sealed-ws|smart_watch|AskFridayRequest|permission-denied-fail-closed-503",
        surface: "sealed-ws",
        mechanism: "smart_watch",
        control: "AskFridayRequest",
        lifecycleState: "permission-denied-fail-closed-503",
      },
    ],
    orphans: [
      {
        kind: "orphan-backend",
        id: "POST /v1/agent/runs",
        reason: "operator-gated",
        owningIssue: "S13-1-COVERAGE-ORACLE",
      },
    ],
    ...overrides,
  };
}

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    truth: "suite13_coverage_ledger",
    rows: [
      {
        cellId: "desktop-web|smart_queue|/home:retry|success",
        status: "recorded-gap",
        notCoveredReason: "not-built",
        owningIssue: "S13-1-COVERAGE-ORACLE",
        evidenceRef: "evidence/s13/desktop-smart-queue-gap.json",
      },
      {
        cellId: "sealed-ws|smart_watch|AskFridayRequest|permission-denied-fail-closed-503",
        status: "recorded-gap",
        notCoveredReason: "structurally-unreachable-503",
        owningIssue: "S13-1-COVERAGE-ORACLE",
        evidenceRef: "evidence/s13/sealed-ws-smart-watch-503.json",
      },
    ],
    ...overrides,
  };
}

function run(args: string[], expectFailure = false) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectFailure) throw error;
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString() || "";
    return JSON.parse(stdout);
  }
}

describe("Friday Suite-13 coverage oracle", () => {
  it("passes only when census sources, 19 mechanism families, typed orphans, and all ledger cells line up", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-suite13-oracle-"));
    const censusPath = writeJson(dir, "census.json", census());
    const ledgerPath = writeJson(dir, "ledger.json", ledger());

    const report = run([
      `--census=${censusPath}`,
      `--coverage-ledger=${ledgerPath}`,
      "--require-passed",
    ]);

    expect(report.truth).toBe("suite13_coverage_oracle");
    expect(report.status).toBe("passed");
    expect(report.summary.mechanismFamilyCount).toBe(19);
    expect(report.summary.cellCount).toBe(2);
    expect(report.blockers).toEqual([]);
  });

  it("blocks the exact §13.8 loopholes: missing Smart families, freeform gaps, boolean evidence, and untyped orphans", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-suite13-oracle-"));
    const censusPath = writeJson(dir, "census.json", census({
      sources: {
        A: { uiRoutes: ["/home"], uiApiCalls: ["/v1/agent/runs"], swiftScreens: [] },
        B: { httpRoutes: ["POST /v1/agent/runs"], sealedWsMessages: [], operatorClientEndpoints: [] },
        C: { mechanisms: canonicalMechanisms().filter((item) => !["smart_queue", "smart_watch"].includes(item)) },
      },
      orphans: [
        { kind: "orphan-backend", id: "POST /v1/agent/runs", reason: "needs follow up" },
      ],
    }));
    const ledgerPath = writeJson(dir, "ledger.json", ledger({
      rows: [
        {
          cellId: "desktop-web|smart_queue|/home:retry|success",
          status: "recorded-gap",
          notCoveredReason: "needs follow up",
          evidenceRef: true,
        },
      ],
    }));

    const report = run([
      `--census=${censusPath}`,
      `--coverage-ledger=${ledgerPath}`,
      "--require-passed",
    ], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_mechanism_family", detail: "smart_queue" }),
      expect.objectContaining({ code: "missing_mechanism_family", detail: "smart_watch" }),
      expect.objectContaining({ code: "invalid_not_covered_reason" }),
      expect.objectContaining({ code: "boolean_evidence_ref" }),
      expect.objectContaining({ code: "invalid_orphan_reason" }),
    ]));
  });

  it("blocks string-shaped test-oracle posture on exercised-green cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-suite13-oracle-"));
    const censusPath = writeJson(dir, "census.json", census());
    const ledgerPath = writeJson(dir, "ledger.json", ledger({
      rows: [
        {
          cellId: "desktop-web|smart_queue|/home:retry|success",
          status: "exercised-green",
          assertionCount: 1,
          testOracle: "true",
          hubPosture: "production-fail-closed",
          evidenceRef: "evidence/s13/desktop-smart-queue-green.json",
        },
        {
          cellId: "sealed-ws|smart_watch|AskFridayRequest|permission-denied-fail-closed-503",
          status: "exercised-green",
          assertionCount: 1,
          testOracle: false,
          hubPosture: "test-oracle",
          evidenceRef: "evidence/s13/sealed-ws-smart-watch-green.json",
        },
      ],
    }));

    const report = run([
      `--census=${censusPath}`,
      `--coverage-ledger=${ledgerPath}`,
      "--require-passed",
    ], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "green_cell_mock_or_test_oracle",
        detail: "desktop-web|smart_queue|/home:retry|success",
      }),
      expect.objectContaining({
        code: "green_cell_mock_or_test_oracle",
        detail: "sealed-ws|smart_watch|AskFridayRequest|permission-denied-fail-closed-503",
      }),
    ]));
  });

  it("rejects surface-N/A as a freeform NOT-COVERED reason under the prompt §13.8 closed vocabulary", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-suite13-oracle-"));
    const censusPath = writeJson(dir, "census.json", census());
    const ledgerPath = writeJson(dir, "ledger.json", ledger({
      rows: [
        {
          cellId: "desktop-web|smart_queue|/home:retry|success",
          status: "recorded-gap",
          notCoveredReason: "surface-N/A",
          owningIssue: "S13-1-COVERAGE-ORACLE",
          evidenceRef: "evidence/s13/desktop-smart-queue-gap.json",
        },
        {
          cellId: "sealed-ws|smart_watch|AskFridayRequest|permission-denied-fail-closed-503",
          status: "recorded-gap",
          notCoveredReason: "structurally-unreachable-503",
          owningIssue: "S13-1-COVERAGE-ORACLE",
          evidenceRef: "evidence/s13/sealed-ws-smart-watch-503.json",
        },
      ],
    }));

    const report = run([
      `--census=${censusPath}`,
      `--coverage-ledger=${ledgerPath}`,
      "--require-passed",
    ], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_not_covered_reason",
        detail: "desktop-web|smart_queue|/home:retry|success:surface-N/A",
      }),
    ]));
  });
});
