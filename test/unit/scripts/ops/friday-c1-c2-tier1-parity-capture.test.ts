import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

type CaptureModule = typeof import("../../../../scripts/ops/friday-c1-c2-tier1-parity-capture.mjs");

const repoRoot = process.cwd();
const scriptPath = path.resolve(repoRoot, "scripts/ops/friday-c1-c2-tier1-parity-capture.mjs");
const artifactRunnerPath = path.resolve(repoRoot, "scripts/ops/friday-c1-c2-tier1-parity-artifact-runner.mjs");
const scriptUrl = pathToFileURL(scriptPath).href;
const tempRoots: string[] = [];

async function loadCaptureModule(): Promise<CaptureModule> {
  return (await import(`${scriptUrl}?t=${Date.now()}`)) as CaptureModule;
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "friday-c1-c2-capture-test-"));
  tempRoots.push(root);
  return root;
}

function writeCaptureArtifact(root: string, flow: CaptureModule["TIER1_PARITY_FLOW_SPECS"][number], patch = {}): void {
  const filePath = path.join(root, `${String(flow.order).padStart(2, "0")}-${flow.flowId}.json`);
  writeFileSync(
    filePath,
    `${JSON.stringify({
      flowId: flow.flowId,
      order: flow.order,
      lane: flow.lane,
      source: flow.source,
      builtDark: true,
      live: false,
      organic: false,
      truthLabel: "parity-capture artifact from existing routed harness output",
      evidence: [{ kind: "artifact", path: flow.expectedHarness }],
      ...patch,
    }, null, 2)}\n`,
    "utf8",
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("C1/C2 Tier-1 parity capture runner", () => {
  it("pins the 24-flow source order without claiming live parity", async () => {
    const capture = await loadCaptureModule();

    expect(capture.validateFlowSpecs()).toEqual([]);
    expect(capture.TIER1_PARITY_FLOW_SPECS).toHaveLength(24);
    expect(capture.TIER1_PARITY_FLOW_SPECS.map((flow) => flow.order)).toEqual(
      Array.from({ length: 24 }, (_value, index) => index + 1),
    );
    expect(capture.TIER1_PARITY_FLOW_SPECS.map((flow) => flow.source)).toEqual([
      "codex",
      "codex",
      "codex",
      "codex",
      "codex",
      "codex",
      "claude",
      "claude",
      "claude",
      "claude",
      "claude",
      "claude",
      "deepseek",
      "deepseek",
      "deepseek",
      "deepseek",
      "deepseek",
      "deepseek",
      "live-synthetic",
      "live-synthetic",
      "live-synthetic",
      "live-synthetic",
      "live-synthetic",
      "live-synthetic",
    ]);

    const report = await capture.buildCaptureReport({
      enabled: false,
      artifactRoot: "",
      reportPath: "/tmp/not-written.json",
      generatedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(report.status).toBe("skipped");
    expect(report.builtDark).toBe(true);
    expect(report.live).toBe(false);
    expect(report.organicFlowCount).toBe(0);
    expect(report.truthLabel).toContain("built-DARK");
    expect(report.truthLabel).toContain("live parity not claimed");
    expect(report.flows.every((flow) => flow.live === false && flow.organic === false)).toBe(true);
  });

  it("captures only supplied artifacts and rejects fake, organic, or DARK-is-live overclaims", async () => {
    const capture = await loadCaptureModule();
    const root = makeTempRoot();

    for (const flow of capture.TIER1_PARITY_FLOW_SPECS) {
      const patch = flow.order === 2
        ? { organic: true }
        : flow.order === 3
          ? { fakeDbRows: true }
          : flow.order === 4
            ? { live: true }
            : {};
      writeCaptureArtifact(root, flow, patch);
    }

    const report = await capture.buildCaptureReport({
      enabled: true,
      artifactRoot: root,
      reportPath: path.join(root, "report.json"),
      generatedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(report.status).toBe("blocked");
    expect(report.blocker).toBe("3 capture artifact(s) missing or invalid");
    expect(report.flows.filter((flow) => flow.status === "invalid").map((flow) => flow.order)).toEqual([2, 3, 4]);
    expect(report.flows.find((flow) => flow.order === 2)?.errors).toContain(
      "organic claim is not allowed for c1-codex-routed-proof-keychain-wrapper",
    );
    expect(report.flows.find((flow) => flow.order === 3)?.errors).toContain(
      "fake-data marker is not allowed for c1-codex-route-agnostic-proof",
    );
    expect(report.flows.find((flow) => flow.order === 4)?.errors).toContain(
      "built-DARK cannot also be live for c1-codex-observe-wrapper-d8-audit",
    );
  });

  it("keeps the runner source free of DB writes and operator-key reads", () => {
    const source = `${readFileSync(scriptPath, "utf8")}\n${readFileSync(artifactRunnerPath, "utf8")}`;

    expect(source).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(source).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toContain("better-sqlite3");
    expect(source).not.toMatch(/operator[_ -]?key/i);
    expect(source).not.toMatch(/read\s+-rs/i);
    expect(source).not.toContain("acquireLocalBearerToken");
    expect(source).not.toContain("FRIDAY_LOCAL_PASSPHRASE");
  });

  it("writes a capture artifact from an explicitly selected flow command", async () => {
    const capture = await loadCaptureModule();
    const root = makeTempRoot();
    const result = spawnSync(process.execPath, [artifactRunnerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FRIDAY_C1_C2_TIER1_ARTIFACT_RUN: "1",
        FRIDAY_C1_C2_TIER1_CAPTURE_ROOT: root,
        FRIDAY_C1_C2_TIER1_FLOW_ID: "c1-codex-routed-proof",
        FRIDAY_C1_C2_TIER1_FLOW_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "process.stdout.write('ok')"]),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status": "passed"');

    const report = await capture.buildCaptureReport({
      enabled: true,
      artifactRoot: root,
      reportPath: path.join(root, "report.json"),
      generatedAt: "2026-06-19T00:00:00.000Z",
    });
    const captured = report.flows.find((flow) => flow.flowId === "c1-codex-routed-proof");

    expect(captured?.status).toBe("captured");
    expect(captured?.record.status).toBe("passed");
    expect(captured?.record.evidence[0].outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(captured?.record.truthLabel).toContain("parity-capture");
    expect(captured?.record.live).toBe(false);
    expect(captured?.record.organic).toBe(false);
  });

  it("does not let a failed flow artifact count as captured", async () => {
    const capture = await loadCaptureModule();
    const root = makeTempRoot();
    const result = spawnSync(process.execPath, [artifactRunnerPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FRIDAY_C1_C2_TIER1_ARTIFACT_RUN: "1",
        FRIDAY_C1_C2_TIER1_CAPTURE_ROOT: root,
        FRIDAY_C1_C2_TIER1_FLOW_ID: "c1-codex-routed-proof",
        FRIDAY_C1_C2_TIER1_FLOW_COMMAND_JSON: JSON.stringify([process.execPath, "-e", "process.exit(7)"]),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"status": "failed"');

    const report = await capture.buildCaptureReport({
      enabled: true,
      artifactRoot: root,
      reportPath: path.join(root, "report.json"),
      generatedAt: "2026-06-19T00:00:00.000Z",
    });
    const failed = report.flows.find((flow) => flow.flowId === "c1-codex-routed-proof");

    expect(report.status).toBe("blocked");
    expect(failed?.status).toBe("invalid");
    expect(failed?.errors).toContain("status must be passed or captured for c1-codex-routed-proof");
  });

  it("fails closed when capture is enabled without an artifact root", () => {
    const reportPath = path.join(makeTempRoot(), "blocked-report.json");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FRIDAY_C1_C2_TIER1_CAPTURE: "1",
        FRIDAY_C1_C2_TIER1_CAPTURE_ROOT: "",
        FRIDAY_C1_C2_TIER1_CAPTURE_REPORT: reportPath,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"status": "blocked"');
    expect(result.stdout).toContain("FRIDAY_C1_C2_TIER1_CAPTURE_ROOT is required");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { status: string; blocker: string };
    expect(report.status).toBe("blocked");
    expect(report.blocker).toBe("FRIDAY_C1_C2_TIER1_CAPTURE_ROOT is required when capture is enabled");
  });
});
