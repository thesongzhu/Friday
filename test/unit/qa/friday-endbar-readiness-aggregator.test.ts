import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-endbar-readiness.mjs";

function run(args: string[] = []) {
  const stdout = execFileSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe("Friday END-BAR readiness aggregator", () => {
  it("reports missing evidence reports without claiming END-BAR", () => {
    const report = run();

    expect(report.truth).toBe("endbar_readiness_aggregator_not_runtime_proof_not_release");
    expect(report.status).toBe("blocked");
    expect(report.strictEndBarReady).toBe(false);
    expect(report.counts.requiredGroups).toBe(5);
    expect(report.counts.missingReport).toBe(5);
    expect(report.blockers).toContainEqual({
      code: "acceptance_group_not_satisfied",
      detail: "mechanism_multiangle_stress:missing_report",
    });
  });

  it("keeps deferred channel proof outside strict END-BAR", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-readiness-"));
    const pass = writeJson(dir, "pass.json", { status: "passed" });
    const deferred = writeJson(dir, "deferred.json", {
      status: "blocked",
      deferredInputs: [{ role: "channel", status: "deferred_by_operator" }],
    });

    const report = run([
      `--mechanism-report=${pass}`,
      `--ui-real-use-report=${deferred}`,
      `--selected-uiux-report=${pass}`,
      `--provider-entitlement-report=${pass}`,
      `--integrated-tape-report=${pass}`,
    ]);

    expect(report.status).toBe("blocked");
    expect(report.strictEndBarReady).toBe(false);
    expect(report.counts.satisfied).toBe(4);
    expect(report.counts.deferred).toBe(1);
    expect(report.groups.find((group: { id: string }) => group.id === "ui_real_use_mobile_desktop").status).toBe("deferred");
  });

  it("marks strict ready only when every required group has a supplied pass report", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-endbar-readiness-"));
    const pass = writeJson(dir, "pass.json", { status: "passed" });
    const selected = writeJson(dir, "selected.json", { status: "uiux_product_closure_evidence_ready" });
    const integrated = writeJson(dir, "integrated.json", { status: "integrated_end_to_end_tape_ready" });

    const report = run([
      `--mechanism-report=${pass}`,
      `--ui-real-use-report=${pass}`,
      `--selected-uiux-report=${selected}`,
      `--provider-entitlement-report=${pass}`,
      `--integrated-tape-report=${integrated}`,
      "--require-complete",
    ]);

    expect(report.status).toBe("strict_endbar_inputs_satisfied");
    expect(report.strictEndBarReady).toBe(true);
    expect(report.counts.satisfied).toBe(5);
    expect(report.blockers).toEqual([]);
  });
});
