import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-uiux-product-happy-path.mjs";

function writeJson(root: string, relative: string, value: unknown) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function selectedVisual(
  mode: string,
  extra: Record<string, unknown> = {},
  desktopExtra: Record<string, unknown> = {},
) {
  return {
    truth: "selected_uiux_visual_proof_not_static_linkage_not_action_runtime_not_endbar",
    status: "selected_visual_proof_ready",
    evidence: {
      ios: [
        {
          status: "ready",
          mode,
          missingDestinations: [],
          ...extra,
        },
      ],
      desktop: [
        {
          status: "ready",
          mode,
          missingDestinations: [],
          ...desktopExtra,
        },
      ],
    },
  };
}

function traceability(overrides: Record<string, unknown> = {}) {
  return {
    truth: "uiux_action_traceability_not_endbar_not_adoption_not_gui_proof",
    status: "product_runtime_actions_traceable",
    counts: {
      runtimeEvidenceInputs: 2,
      productActionsMissingRuntimeEvidence: 0,
      destinationsWithResidualEndBarBlockers: 0,
      destinationsStillBlocked: 0,
    },
    bySurface: {
      mobile: { destinations: 1, runtimeActionIds: 1, traceGaps: 0, destinationsWithResidualEndBarBlockers: 0 },
      desktop: { destinations: 1, runtimeActionIds: 1, traceGaps: 0, destinationsWithResidualEndBarBlockers: 0 },
    },
    ...overrides,
  };
}

describe("check-friday-uiux-product-happy-path", () => {
  it("rejects design-proof-sample as product happy path", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-design-only-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("design-proof-sample"));
      const trace = writeJson(root, "trace.json", traceability());
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        blockers?: Array<{ code?: string; detail?: string }>;
      };
      expect(report.status).toBe("product_happy_path_not_ready");
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "mobile_visual_not_live_connected",
        detail: "modes=design-proof-sample",
      }));
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "design_proof_sample_only",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects residual END-BAR blockers even when action evidence is attached", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-residual-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback"));
      const trace = writeJson(root, "trace.json", traceability({
        counts: {
          runtimeEvidenceInputs: 2,
          productActionsMissingRuntimeEvidence: 0,
          destinationsWithResidualEndBarBlockers: 3,
          destinationsStillBlocked: 3,
        },
      }));
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "residual_endbar_blockers_present",
        detail: "3",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects negative status labels on the connected happy path", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-negative-labels-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback", {
        statusLabels: ["online", "offline"],
      }));
      const trace = writeJson(root, "trace.json", traceability());
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "negative_happy_path_labels_present",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects static desktop visual proof as product happy path", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-static-desktop-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback", {}, {
        mode: "static-ax",
      }));
      const trace = writeJson(root, "trace.json", traceability());
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toContainEqual(expect.objectContaining({
        code: "desktop_visual_not_live_connected",
        detail: "modes=static-ax",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes only when visual proof is live-connected and runtime/product blockers are closed", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-ready-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback", {
        statusLabels: ["online"],
      }));
      const trace = writeJson(root, "trace.json", traceability());
      const out = join(root, "happy-path.json");
      const output = execFileSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
        `--out=${out}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        selectedVisual?: { liveConnectedMobileEvidenceCount?: number };
        blockers?: unknown[];
      };
      const persisted = JSON.parse(readFileSync(out, "utf8")) as typeof report;
      expect(report.status).toBe("product_happy_path_ready");
      expect(report.selectedVisual?.liveConnectedMobileEvidenceCount).toBe(1);
      expect(report.blockers).toEqual([]);
      expect(persisted.status).toBe("product_happy_path_ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
