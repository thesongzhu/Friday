import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-mechanism-multiangle-stress-report.mjs";

function writeJson(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function backendProof(overrides: Record<string, unknown> = {}) {
  return {
    proof: "mission_spine_backend_api_live_pressure",
    status: "passed",
    scope: "backend/API/channel runtime proof for Mission-bound asks; not real UI/device consumption proof",
    deepseek_live_api_pressure: {
      status: "passed",
      real_external_api: true,
      mission_bound_ask_count: 20,
    },
    local_real_http_pressure: {
      status: "passed",
      mission_bound_ask_count: 50,
    },
    invalid_key_negative: {
      status: "passed",
      asserts: ["no_hidden_fallback", "no_ledger", "no_completion"],
    },
    ...overrides,
  };
}

function objectiveCoverage(backendPath: string, extra = {}) {
  return {
    proof: "mission_spine_objective_backend_wire_coverage",
    status: "passed",
    backend_live_proof_artifact: backendPath,
    executed_tests: [
      {
        package: "friday-hub",
        filter: "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary",
        proves: [
          "twenty_to_fifty_mission_bound_asks",
          "no_hidden_fallback",
          "no_secret_leak",
          "memory_candidate_not_confirmed",
        ],
      },
      {
        package: "friday-hub",
        filter: "mission_bound_ask_provider_error_is_explicit_no_fallback_no_ledger",
        proves: ["provider_unavailable_error", "no_ledger_or_completion_on_provider_failure"],
      },
      {
        package: "friday-hub",
        filter: "mission_bound_ask_quota_post_error_is_no_fallback_no_ledger_or_secret_leak",
        proves: ["quota_error", "no_ledger_or_completion_on_quota_failure"],
      },
      {
        package: "friday-hub",
        filter: "mission_bound_ask_network_discovery_error_is_no_fallback_no_ledger_or_completion",
        proves: ["network_failure", "no_ledger_or_completion_on_network_failure"],
      },
      {
        package: "friday-transport",
        filter: "reconnect_resumes_missed_stream_frames",
        proves: ["reconnect_replays_only_missed_frames"],
      },
      {
        package: "friday-protocol",
        filter: "provider_timeline_reconnect_wire_round_trips_delta_and_snapshot",
        proves: ["provider_ack_not_done"],
      },
    ],
    ...extra,
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

describe("Friday mechanism multiangle stress report", () => {
  it("passes when backend live proof and objective coverage satisfy the mechanism pass bar", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-mechanism-report-"));
    const backend = writeJson(dir, "backend-live-proof.json", backendProof());
    const objective = writeJson(dir, "objective-coverage.json", objectiveCoverage(backend));
    const out = join(dir, "report.json");

    const report = run([
      `--backend-live-proof=${backend}`,
      `--objective-coverage=${objective}`,
      `--out=${out}`,
      "--require-passed",
    ]);

    expect(report.truth).toBe("mechanism_multiangle_stress_report");
    expect(report.status).toBe("passed");
    expect(report.passBar.real_provider_spend_windowed_and_joined).toBe(true);
    expect(report.passBar.fail_closed_failure_injection).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("blocks synthetic or non-live backend proof instead of counting it as mechanism evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-mechanism-report-"));
    const backend = writeJson(dir, "backend-live-proof.json", backendProof({
      scope: "synthetic fixture backend proof",
      deepseek_live_api_pressure: {
        status: "passed",
        real_external_api: false,
        mission_bound_ask_count: 20,
      },
    }));
    const objective = writeJson(dir, "objective-coverage.json", objectiveCoverage(backend));

    const report = run([
      `--backend-live-proof=${backend}`,
      `--objective-coverage=${objective}`,
      "--require-passed",
    ], true);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "backend_truth_not_synthetic" }),
      expect.objectContaining({ code: "real_provider_spend_windowed" }),
    ]));
  });

  it("blocks missing failure-injection coverage", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-mechanism-report-"));
    const backend = writeJson(dir, "backend-live-proof.json", backendProof());
    const objective = writeJson(dir, "objective-coverage.json", objectiveCoverage(backend, {
      executed_tests: [
        {
          package: "friday-hub",
          filter: "mission_bound_ask_pressure_loop_paginates_and_preserves_memory_boundary",
          proves: ["twenty_to_fifty_mission_bound_asks", "no_hidden_fallback", "no_secret_leak"],
        },
      ],
    }));

    const report = run([
      `--backend-live-proof=${backend}`,
      `--objective-coverage=${objective}`,
    ]);

    expect(report.status).toBe("blocked");
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "objective_proves_provider_unavailable_error" }),
      expect.objectContaining({ code: "objective_proves_reconnect_replays_only_missed_frames" }),
    ]));
  });
});
