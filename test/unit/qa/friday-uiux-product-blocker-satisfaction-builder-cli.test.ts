import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/build-friday-uiux-product-blocker-satisfaction.mjs";
const head = "abc1234";

function writeJson(root: string, relative: string, value: unknown) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    surface: "mobile",
    id: "home",
    kind: "needsRuntimeEvidence",
    label: "same-run user proof",
    status: "satisfied",
    evidenceClass: "same_run_ui_device_product_proof",
    evidenceRefs: ["proof://same-run/mobile-home"],
    evidenceTruthLabels: ["same_run_ui_device_product_proof"],
    sameRun: true,
    liveConnected: true,
    currentHead: true,
    ...overrides,
  };
}

function manifest(root: string, rows: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return writeJson(root, `manifest-${Math.random().toString(16).slice(2)}.json`, {
    truth: "uiux_product_blocker_satisfaction_manifest",
    status: "ready",
    head,
    satisfactions: rows,
    ...overrides,
  });
}

describe("build-friday-uiux-product-blocker-satisfaction", () => {
  it("merges same-head satisfaction manifests and deduplicates rows", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-satisfaction-builder-ready-"));
    try {
      const first = manifest(root, [row()]);
      const second = manifest(root, [row(), row({
        surface: "desktop",
        id: "chat",
        label: "full desktop tap proof",
        evidenceRefs: ["proof://same-run/desktop-chat"],
      })]);
      const output = execFileSync("node", [
        script,
        `--head=${head}`,
        `--satisfaction-report=${first}`,
        `--satisfaction-report=${second}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      const report = JSON.parse(output) as {
        status?: string;
        counts?: { satisfactions?: number };
        satisfactions?: Array<{ surface?: string; id?: string }>;
        blockers?: unknown[];
      };
      expect(report.status).toBe("ready");
      expect(report.counts?.satisfactions).toBe(2);
      expect(report.satisfactions?.map((item) => `${item.surface}:${item.id}`)).toEqual([
        "mobile:home",
        "desktop:chat",
      ]);
      expect(report.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale-head satisfaction manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-satisfaction-builder-stale-"));
    try {
      const stale = manifest(root, [row()], { head: "old1234" });
      const result = spawnSync("node", [
        script,
        `--head=${head}`,
        `--satisfaction-report=${stale}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "input_head_mismatch" }),
        expect.objectContaining({ code: "no_valid_satisfactions" }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects partial or not-ui-device truth labels", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-satisfaction-builder-partial-"));
    try {
      const partial = manifest(root, [row({
        evidenceTruthLabels: ["mobile_same_run_event_from_live_write_read_artifact_not_ui_device_proof"],
      })]);
      const result = spawnSync("node", [
        script,
        `--head=${head}`,
        `--satisfaction-report=${partial}`,
        "--require-ready",
      ], { cwd: process.cwd(), encoding: "utf8" });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string; detail?: string }> };
      expect(report.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "row_invalid" }),
        expect.objectContaining({ code: "no_valid_satisfactions" }),
      ]));
      expect(JSON.stringify(report.blockers)).toContain("forbiddenTruth");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
