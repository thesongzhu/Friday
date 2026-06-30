import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/build-friday-uiux-runtime-blocker-satisfaction.mjs";
const head = "abc1234";

function writeJson(root: string, relative: string, value: unknown) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function writeText(root: string, relative: string, value = "real ui/device bytes\n") {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function writeEvidenceDir(root: string) {
  const dir = join(root, "rebuilt-capture-dir");
  writeJson(dir, "gap-report.json", {
    status: "gaps_present",
    blockers: [],
    checks: {
      pressureAskCountOk: true,
      duplicateSurfaceCountOk: true,
      timelinePageCountOk: true,
    },
  });
  writeJson(dir, "observations-manifest.json", {
    truth: "ui_device_observations_manifest_derived_from_same_run_events_not_proof",
    mission_id: "mission_ui_device_contract",
    observations: [{ surface: "mobile" }, { surface: "desktop" }],
  });
  writeText(dir, "same-run-events.with-channel.jsonl", "{\"event\":\"mission_workbench_visible\"}\n");
  writeJson(dir, "mobile.json", { surface: "mobile", status: "ready" });
  writeJson(dir, "desktop.json", { surface: "desktop", status: "ready" });
  writeJson(dir, "timeline.json", { surface: "timeline", status: "ready" });
  return dir;
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    truth: "uiux_action_traceability_not_endbar_not_adoption_not_gui_proof",
    status: "product_runtime_actions_traceable",
    counts: {
      runtimeEvidenceInputs: 2,
      productActionsMissingRuntimeEvidence: 0,
    },
    gaps: {
      residualEndBarBlockers: [{
        surface: "mobile",
        id: "home",
        title: "Friday Home",
        tier: "liveWorkbench",
        blockers: [{ kind: "needsRuntimeEvidence", label: "same-run user proof" }],
        evidenceOverlay: {
          status: "runtime_action_evidence_attached_not_endbar",
          runtimeActionCount: 1,
          runtimeActionsCovered: 1,
          runtimeActionsMissing: 0,
          evidenceRefs: ["proof://runtime/mobile-home"],
          evidenceTruthLabels: ["accessibility_click_action_runtime_evidence_real_ui_not_endbar"],
        },
      }],
    },
    ...overrides,
  };
}

describe("build-friday-uiux-runtime-blocker-satisfaction", () => {
  it("creates satisfaction rows only after full runtime coverage plus strict UI/device proof", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-runtime-satisfaction-ready-"));
    try {
      const tracePath = writeJson(root, "trace.json", trace());
      const proofPath = writeJson(root, "ui-device-proof.json", {
        truth: "assembled_real_ui_device_proof",
        status: "pass",
      });
      const evidenceDir = writeEvidenceDir(root);
      const output = execFileSync("node", [
        script,
        `--head=${head}`,
        `--action-traceability-report=${tracePath}`,
        `--ui-device-proof=${proofPath}`,
        `--ui-device-evidence-dir=${evidenceDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        truth?: string;
        status?: string;
        counts?: { satisfactions?: number };
        satisfactions?: Array<{
          evidenceClass?: string;
          evidenceTruthLabels?: string[];
          sameRun?: boolean;
          liveConnected?: boolean;
          currentHead?: boolean;
        }>;
        blockers?: unknown[];
      };
      expect(report.truth).toBe("uiux_runtime_blocker_satisfaction_manifest");
      expect(report.status).toBe("ready");
      expect(report.counts?.satisfactions).toBe(1);
      expect(report.satisfactions?.[0]).toEqual(expect.objectContaining({
        evidenceClass: "same_run_ui_device_product_proof",
        evidenceTruthLabels: ["assembled_real_ui_device_proof_same_run_live_connected_current_head"],
        sameRun: true,
        liveConnected: true,
        currentHead: true,
      }));
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not satisfy partial runtime overlays", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-runtime-satisfaction-partial-"));
    try {
      const tracePath = writeJson(root, "trace.json", trace({
        gaps: {
          residualEndBarBlockers: [{
            surface: "desktop",
            id: "chat",
            blockers: [{ kind: "needsRuntimeEvidence", label: "full desktop tap proof" }],
            evidenceOverlay: {
              status: "partial_runtime_action_evidence_attached_not_endbar",
              runtimeActionCount: 2,
              runtimeActionsCovered: 1,
              runtimeActionsMissing: 1,
              evidenceRefs: ["proof://runtime/desktop-chat"],
            },
          }],
        },
      }));
      const proofPath = writeJson(root, "ui-device-proof.json", {
        truth: "assembled_real_ui_device_proof",
        status: "pass",
      });
      const evidenceDir = writeEvidenceDir(root);
      const result = spawnSync("node", [
        script,
        `--head=${head}`,
        `--action-traceability-report=${tracePath}`,
        `--ui-device-proof=${proofPath}`,
        `--ui-device-evidence-dir=${evidenceDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        status?: string;
        blockers?: Array<{ code?: string }>;
        skippedRows?: Array<{ reason?: string }>;
      };
      expect(report.status).toBe("not_ready");
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "no_runtime_blocker_satisfactions" }),
      ]));
      expect(report.skippedRows?.[0]?.reason).toContain("runtime_overlay_not_fully_covered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not satisfy provider/signature blockers", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-runtime-satisfaction-non-runtime-"));
    try {
      const tracePath = writeJson(root, "trace.json", trace({
        gaps: {
          residualEndBarBlockers: [{
            surface: "desktop",
            id: "providerAdmin",
            blockers: [{ kind: "needsProviderCredential", label: "all selected provider routes" }],
            evidenceOverlay: {
              status: "runtime_action_evidence_attached_not_endbar",
              runtimeActionCount: 1,
              runtimeActionsCovered: 1,
              runtimeActionsMissing: 0,
              evidenceRefs: ["proof://runtime/provider-admin"],
            },
          }],
        },
      }));
      const proofPath = writeJson(root, "ui-device-proof.json", {
        truth: "assembled_real_ui_device_proof",
        status: "pass",
      });
      const evidenceDir = writeEvidenceDir(root);
      const result = spawnSync("node", [
        script,
        `--head=${head}`,
        `--action-traceability-report=${tracePath}`,
        `--ui-device-proof=${proofPath}`,
        `--ui-device-evidence-dir=${evidenceDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        blockers?: Array<{ code?: string }>;
        skippedRows?: Array<{ reason?: string }>;
      };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "no_runtime_blocker_satisfactions" }),
      ]));
      expect(report.skippedRows?.[0]?.reason).toBe("non_runtime_blocker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not promote partial or not-live overlay truth labels", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-runtime-satisfaction-forbidden-truth-"));
    try {
      const tracePath = writeJson(root, "trace.json", trace({
        gaps: {
          residualEndBarBlockers: [{
            surface: "mobile",
            id: "voice",
            blockers: [{ kind: "needsRuntimeEvidence", label: "real microphone and speech-output tap proof" }],
            evidenceOverlay: {
              status: "runtime_action_evidence_attached_not_endbar",
              runtimeActionCount: 1,
              runtimeActionsCovered: 1,
              runtimeActionsMissing: 0,
              evidenceRefs: ["swift://mobile/voice/partial"],
              evidenceTruthLabels: ["swift_viewmodel_write_client_runtime_not_live_hub_not_sim_tap"],
            },
          }],
        },
      }));
      const proofPath = writeJson(root, "ui-device-proof.json", {
        truth: "assembled_real_ui_device_proof",
        status: "pass",
      });
      const evidenceDir = writeEvidenceDir(root);
      const result = spawnSync("node", [
        script,
        `--head=${head}`,
        `--action-traceability-report=${tracePath}`,
        `--ui-device-proof=${proofPath}`,
        `--ui-device-evidence-dir=${evidenceDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as {
        blockers?: Array<{ code?: string }>;
        skippedRows?: Array<{ reason?: string }>;
      };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "no_runtime_blocker_satisfactions" }),
      ]));
      expect(report.skippedRows?.[0]?.reason).toContain("runtime_overlay_truth_forbidden");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts full per-action clean coverage even when legacy partial overlay labels are present", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-runtime-satisfaction-clean-action-trace-"));
    try {
      const tracePath = writeJson(root, "trace.json", trace({
        gaps: {
          residualEndBarBlockers: [{
            surface: "desktop",
            id: "tokenLedger",
            blockers: [{ kind: "needsRuntimeEvidence", label: "run-backed ledger proof" }],
            evidenceOverlay: {
              status: "runtime_action_evidence_attached_not_endbar",
              runtimeActionCount: 1,
              runtimeActionsCovered: 1,
              runtimeActionsMissing: 0,
              evidenceRefs: ["swift://desktop/tokenLedger/run-readback/run-desktop", "proof://desktop-ax/token-ledger"],
              evidenceTruthLabels: [
                "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
                "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
              ],
            },
          }],
        },
        destinations: [{
          surface: "desktop",
          id: "tokenLedger",
          actionTrace: [{
            runtimeActionId: "desktop/tokenLedger/run-readback",
            runtimeEvidenceMatched: true,
            evidenceRefs: ["proof://desktop-ax/token-ledger"],
            evidenceTruthLabels: [
              "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
              "accessibility_click_action_runtime_evidence_real_ui_not_endbar",
            ],
          }],
        }],
      }));
      const proofPath = writeJson(root, "ui-device-proof.json", {
        truth: "assembled_real_ui_device_proof",
        status: "pass",
      });
      const evidenceDir = writeEvidenceDir(root);
      const output = execFileSync("node", [
        script,
        `--head=${head}`,
        `--action-traceability-report=${tracePath}`,
        `--ui-device-proof=${proofPath}`,
        `--ui-device-evidence-dir=${evidenceDir}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { satisfactions?: number };
        satisfactions?: Array<{ id?: string; evidenceRefs?: string[] }>;
      };
      expect(report.status).toBe("ready");
      expect(report.counts?.satisfactions).toBe(1);
      expect(report.satisfactions?.[0]?.id).toBe("tokenLedger");
      expect(report.satisfactions?.[0]?.evidenceRefs).toContain("proof://desktop-ax/token-ledger");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
