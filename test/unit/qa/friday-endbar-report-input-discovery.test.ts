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

  it("accepts comma-separated --search-roots as an alias for repeated search roots", () => {
    const first = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-a-"));
    const second = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-b-"));

    const mechanism = writeJson(first, "mechanism-multiangle.json", {
      truth: "mechanism_multiangle_stress_report",
      status: "passed",
    });
    const ui = writeJson(second, "ui-real-use.json", { status: "strict_uiux_real_use_ready" });
    const selected = writeJson(first, "selected-uiux.json", { status: "uiux_product_closure_evidence_ready" });
    const provider = writeJson(second, "provider-entitlement.json", { status: "passed" });
    const integrated = writeJson(first, "integrated-tape.json", { status: "integrated_end_to_end_tape_ready" });

    const report = run([`--search-roots=${first},${second}`]);

    expect(report.searchRoots).toEqual([first, second]);
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

  it("keeps partial selected UIUX reports out of strict candidate sets", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    const partial = writeJson(dir, "selected-uiux-partial.json", {
      truth: "selected_uiux_conformance_report",
      status: "selected_visual_proof_ready",
    });

    const report = run([`--search-root=${dir}`], true);
    const group = report.groups.find((row: { id: string }) => row.id === "selected_uiux_conformance");

    expect(group.selectedCandidate).toEqual(expect.objectContaining({
      path: partial,
      classification: "partial",
    }));
    expect(report.status).toBe("partial_candidate_set");
    expect(report.command).toBeNull();
    expect(report.blockers).toContainEqual({
      code: "report_candidate_not_satisfied",
      detail: "selected_uiux_conformance:partial",
    });
  });

  it("discovers mechanism multiangle stress reports by truth label", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    const mechanism = writeJson(dir, "current-report.json", {
      truth: "mechanism_multiangle_stress_report",
      status: "passed",
    });

    const report = run([`--search-root=${dir}`], true);
    const group = report.groups.find((row: { id: string }) => row.id === "mechanism_multiangle_stress");

    expect(group.selectedCandidate).toEqual(expect.objectContaining({
      path: mechanism,
      classification: "satisfied",
    }));
    expect(report.blockers).toContainEqual({
      code: "report_candidate_missing",
      detail: "ui_real_use_mobile_desktop",
    });
  });

  it("discovers integrated end-to-end tape reports by truth label", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    const tape = writeJson(dir, "current-report.json", {
      truth: "integrated_end_to_end_tape_report",
      status: "integrated_end_to_end_tape_ready",
    });

    const report = run([`--search-root=${dir}`], true);
    const group = report.groups.find((row: { id: string }) => row.id === "integrated_end_to_end_tape");

    expect(group.selectedCandidate).toEqual(expect.objectContaining({
      path: tape,
      classification: "satisfied",
    }));
    expect(report.blockers).toContainEqual({
      code: "report_candidate_missing",
      detail: "mechanism_multiangle_stress",
    });
  });

  it("discovers strict UI real-use reports and keeps deferred ones non-satisfied", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-inputs-"));
    const strict = writeJson(dir, "ui-real-use-strict.json", {
      truth: "ui_real_use_mobile_desktop_report",
      status: "strict_uiux_real_use_ready",
    });
    writeJson(dir, "ui-real-use-deferred.json", {
      truth: "ui_real_use_mobile_desktop_report",
      status: "deferred",
      blockers: [{ code: "no_deferred_channel_or_external_input" }],
    });

    const report = run([`--search-root=${dir}`], true);
    const group = report.groups.find((row: { id: string }) => row.id === "ui_real_use_mobile_desktop");

    expect(group.selectedCandidate).toEqual(expect.objectContaining({
      path: strict,
      classification: "satisfied",
    }));
    expect(group.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: expect.stringContaining("ui-real-use-deferred.json"),
        classification: "deferred",
      }),
    ]));
  });
});
