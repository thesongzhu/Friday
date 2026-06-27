import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-endbar-report-inputs.mjs";

function run(args: string[] = [], expectFailure = false) {
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

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("Friday END-BAR report input discovery", () => {
  it("requires an explicit search root and never claims readiness from nothing", () => {
    const report = run([], true);

    expect(report.truth).toBe("endbar_report_input_discovery_not_runtime_proof_not_release");
    expect(report.status).toBe("partial_candidate_set");
    expect(report.blockers).toContainEqual({
      code: "search_root_missing",
      detail: "provide at least one --search-root",
    });
  });

  it("discovers a complete satisfying report set and prints the aggregator command", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    const nested = join(dir, "nested");
    mkdirSync(nested);

    const mechanism = writeJson(dir, "mechanism-multiangle.json", {
      truth: "mechanism_multiangle_stress_report",
      status: "passed",
    });
    const ui = writeJson(nested, "ui-real-use.json", { status: "strict_uiux_real_use_ready" });
    const selected = writeJson(dir, "selected-uiux.json", { status: "uiux_product_closure_evidence_ready" });
    const provider = writeJson(dir, "provider-entitlement.json", { status: "passed" });
    const integrated = writeJson(dir, "integrated-tape.json", { status: "integrated_end_to_end_tape_ready" });

    const report = run([`--search-root=${dir}`]);

    expect(report.status).toBe("complete_candidate_set");
    expect(report.counts.satisfiedCandidates).toBe(5);
    expect(report.command).toEqual([
      "node",
      "scripts/ops/check-friday-endbar-readiness.mjs",
      `--mechanism-report=${mechanism}`,
      `--ui-real-use-report=${ui}`,
      `--selected-uiux-report=${selected}`,
      `--provider-entitlement-report=${provider}`,
      `--integrated-tape-report=${integrated}`,
      "--require-complete",
    ]);
    expect(report.blockers).toEqual([]);
  });

  it("keeps provider manifest boundary checks and deferred channel reports out of strict candidates", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    writeJson(dir, "provider-boundary.json", {
      truth: "endbar_acceptance_manifest_check_not_runtime_proof",
      status: "passed",
    });
    writeJson(dir, "ui-device-deferred.json", {
      status: "partial_ready",
      readinessBlockers: ["ui_device_proof_evidence:channel_deferred_strict_assembly_blocked"],
    });

    const report = run([`--search-root=${dir}`], true);
    const provider = report.groups.find((group: { id: string }) => group.id === "provider_entitlement_matrix");
    const ui = report.groups.find((group: { id: string }) => group.id === "ui_real_use_mobile_desktop");

    expect(provider.selectedCandidate.classification).toBe("boundary_only");
    expect(ui.selectedCandidate.classification).toBe("deferred");
    expect(report.blockers).toContainEqual({
      code: "report_candidate_not_satisfied",
      detail: "provider_entitlement_matrix:boundary_only",
    });
    expect(report.blockers).toContainEqual({
      code: "report_candidate_not_satisfied",
      detail: "ui_real_use_mobile_desktop:deferred",
    });
    expect(report.command).toBeNull();
  });
});
