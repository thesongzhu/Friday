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

function selectedVisualWithServedUi(
  servedUi: Record<string, unknown>,
  desktopExtra: Record<string, unknown> = { status: "gap", mode: "static-ax" },
) {
  const visual = selectedVisual("live-loopback", {}, desktopExtra) as {
    evidence: {
      servedUi?: Array<Record<string, unknown>>;
    };
  };
  visual.evidence.servedUi = [servedUi];
  return visual;
}

function readyServedUi(overrides: Record<string, unknown> = {}) {
  return {
    status: "ready",
    sourceStatus: "served_desktop_dist_ui_and_ios_source",
    checks: {
      renderedDesktop: true,
      builtCss: true,
      iosDesignSystem: true,
    },
    ...overrides,
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

function satisfaction(root: string, rows: Array<Record<string, unknown>>) {
  return writeJson(root, "satisfaction.json", {
    truth: "uiux_product_blocker_satisfaction_manifest",
    status: "ready",
    satisfactions: rows,
  });
}

function satisfactionProof(root: string, relative = "proofs/mobile-home.json", overrides: Record<string, unknown> = {}) {
  return writeJson(root, relative, {
    truth: "same_run_ui_device_product_proof",
    status: "ready",
    surface: "mobile",
    id: "home",
    kind: "needsRuntimeEvidence",
    label: "same-run user proof",
    sameRun: true,
    liveConnected: true,
    currentHead: true,
    ...overrides,
  });
}

function satisfiedHomeRow(overrides: Record<string, unknown> = {}) {
  return {
    surface: "mobile",
    id: "home",
    kind: "needsRuntimeEvidence",
    label: "same-run user proof",
    status: "satisfied",
    evidenceClass: "same_run_ui_device_product_proof",
    evidenceRefs: ["proofs/mobile-home.json"],
    evidenceTruthLabels: ["same_run_ui_device_product_proof"],
    sameRun: true,
    liveConnected: true,
    currentHead: true,
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

  it("accepts matched blocker satisfaction without mutating the native contract", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-satisfied-blocker-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback"));
      const trace = writeJson(root, "trace.json", traceability({
        counts: {
          runtimeEvidenceInputs: 2,
          productActionsMissingRuntimeEvidence: 0,
          destinationsWithResidualEndBarBlockers: 1,
          destinationsStillBlocked: 1,
        },
        gaps: {
          residualEndBarBlockers: [{
            surface: "mobile",
            id: "home",
            blockers: [{ kind: "needsRuntimeEvidence", label: "same-run user proof" }],
          }],
        },
      }));
      satisfactionProof(root);
      const blockerSatisfaction = satisfaction(root, [satisfiedHomeRow()]);
      const output = execFileSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        `--blocker-satisfaction-report=${blockerSatisfaction}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        blockerSatisfaction?: { residualBlockerCount?: number; satisfiedResidualBlockerCount?: number };
        blockers?: unknown[];
      };
      expect(report.status).toBe("product_happy_path_ready");
      expect(report.blockerSatisfaction?.residualBlockerCount).toBe(1);
      expect(report.blockerSatisfaction?.satisfiedResidualBlockerCount).toBe(1);
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects blocker satisfaction backed only by an opaque proof URI", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-opaque-satisfaction-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback"));
      const trace = writeJson(root, "trace.json", traceability({
        counts: {
          runtimeEvidenceInputs: 2,
          productActionsMissingRuntimeEvidence: 0,
          destinationsWithResidualEndBarBlockers: 1,
          destinationsStillBlocked: 1,
        },
        gaps: {
          residualEndBarBlockers: [{
            surface: "mobile",
            id: "home",
            blockers: [{ kind: "needsRuntimeEvidence", label: "same-run user proof" }],
          }],
        },
      }));
      const blockerSatisfaction = satisfaction(root, [satisfiedHomeRow({
        evidenceRefs: ["proof://same-run/mobile-home"],
      })]);
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        `--blocker-satisfaction-report=${blockerSatisfaction}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "blocker_satisfaction_report_invalid" }),
        expect.objectContaining({ code: "residual_endbar_blockers_present" }),
      ]));
      expect(JSON.stringify(report.blockers)).toContain("satisfaction_evidence_ref_not_file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects blocker satisfaction backed by partial or not-END-BAR evidence labels", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-forbidden-satisfaction-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback"));
      const trace = writeJson(root, "trace.json", traceability({
        counts: {
          runtimeEvidenceInputs: 2,
          productActionsMissingRuntimeEvidence: 0,
          destinationsWithResidualEndBarBlockers: 1,
          destinationsStillBlocked: 1,
        },
        gaps: {
          residualEndBarBlockers: [{
            surface: "mobile",
            id: "home",
            blockers: [{ kind: "needsRuntimeEvidence", label: "same-run user proof" }],
          }],
        },
      }));
      const blockerSatisfaction = satisfaction(root, [satisfiedHomeRow({
        evidenceTruthLabels: ["mobile_projection_action_runtime_evidence_partial_not_live_hub_not_endbar"],
      })]);
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        `--blocker-satisfaction-report=${blockerSatisfaction}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "blocker_satisfaction_report_invalid" }),
        expect.objectContaining({ code: "residual_endbar_blockers_present" }),
      ]));
      expect(JSON.stringify(report.blockers)).toContain("satisfaction_evidence_truth_forbidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects blocker satisfaction backed by not-ui-device proof labels", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-not-ui-device-satisfaction-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisual("live-loopback"));
      const trace = writeJson(root, "trace.json", traceability({
        counts: {
          runtimeEvidenceInputs: 2,
          productActionsMissingRuntimeEvidence: 0,
          destinationsWithResidualEndBarBlockers: 1,
          destinationsStillBlocked: 1,
        },
        gaps: {
          residualEndBarBlockers: [{
            surface: "mobile",
            id: "home",
            blockers: [{ kind: "needsRuntimeEvidence", label: "same-run user proof" }],
          }],
        },
      }));
      const blockerSatisfaction = satisfaction(root, [satisfiedHomeRow({
        evidenceClass: "live_write_read_projection_proof",
        evidenceTruthLabels: ["mobile_same_run_event_from_live_write_read_artifact_not_ui_device_proof"],
      })]);
      const result = spawnSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        `--blocker-satisfaction-report=${blockerSatisfaction}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "blocker_satisfaction_report_invalid" }),
        expect.objectContaining({ code: "residual_endbar_blockers_present" }),
      ]));
      expect(JSON.stringify(report.blockers)).toContain("satisfaction_evidence_truth_forbidden");
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

  it("accepts current-head served ui fidelity as the served desktop visual input", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-served-ui-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisualWithServedUi(readyServedUi()));
      const trace = writeJson(root, "trace.json", traceability());
      const output = execFileSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        selectedVisual?: { liveConnectedDesktopEvidenceCount?: number; desktopModes?: string[] };
        blockers?: unknown[];
      };
      expect(report.status).toBe("product_happy_path_ready");
      expect(report.selectedVisual?.liveConnectedDesktopEvidenceCount).toBe(1);
      expect(report.selectedVisual?.desktopModes).toEqual(["static-ax", "served-ui-current-head"]);
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects served ui fidelity unless it is ready and scoped to served dist/ui", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-served-ui-gap-"));
    try {
      const visual = writeJson(root, "visual.json", selectedVisualWithServedUi(readyServedUi({
        status: "gap",
      })));
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

  it("accepts a live desktop aggregate from segmented selected visual proof", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-happy-path-desktop-aggregate-"));
    try {
      const visualValue = selectedVisual("live-loopback", {}, {
        status: "gap",
        missingDestinations: ["evidence"],
      }) as {
        evidence: {
          desktopAggregates?: Array<Record<string, unknown>>;
        };
      };
      visualValue.evidence.desktopAggregates = [{
        status: "ready",
        mode: "live-loopback",
        capture_status: "segmented_aggregate",
        segmentCount: 3,
        missingDestinations: [],
      }];
      const visual = writeJson(root, "visual.json", visualValue);
      const trace = writeJson(root, "trace.json", traceability());
      const output = execFileSync("node", [
        script,
        `--repo-root=${process.cwd()}`,
        `--selected-visual-report=${visual}`,
        `--action-traceability-report=${trace}`,
        "--require-complete",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        selectedVisual?: { liveConnectedDesktopEvidenceCount?: number; desktopModes?: string[] };
        blockers?: unknown[];
      };
      expect(report.status).toBe("product_happy_path_ready");
      expect(report.selectedVisual?.liveConnectedDesktopEvidenceCount).toBe(1);
      expect(report.selectedVisual?.desktopModes).toEqual(["live-loopback", "live-loopback"]);
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
