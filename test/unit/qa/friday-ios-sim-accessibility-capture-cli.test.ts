import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ios-sim-accessibility-capture.mjs";
const missionId = "mission_ios_sim_accessibility_capture_contract";
const fakeUdid = "11111111-2222-3333-4444-555555555555";

async function writeFakeXcrun(binDir: string) {
  await mkdir(binDir, { recursive: true });
  const file = join(binDir, "xcrun");
  writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
{"devices":{"iOS Test":[{"name":"iPhone Test","udid":"${fakeUdid}","state":"Booted","isAvailable":true}]}}
JSON
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ]; then
  echo "/tmp/friday-ios-sim-data-container"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "com.friday.shell: 12345"
  exit 0
fi
echo "unexpected xcrun $*" >&2
exit 64
`);
  await chmod(file, 0o755);
}

function writeObservation(root: string, overrides: Record<string, unknown> = {}) {
  const evidence = join(root, "ios-accessibility-tree.txt");
  writeFileSync(evidence, "real iOS accessibility tree bytes from XCTest or AX probe\n");
  const observation = join(root, "ios-accessibility-observation.json");
  writeFileSync(observation, JSON.stringify({
    truth_label: "ios_simulator_accessibility_observation_real_ui",
    mission_id: missionId,
    bundle_id: "com.friday.shell",
    udid: fakeUdid,
    capture_method: "ios_simulator_accessibility",
    evidence_type: "accessibility_tree",
    evidence_ref: evidence,
    observations: [
      {
        screen: "home",
        runtimeActionId: "mobile/home/refresh",
        accessibility_id: "friday.mobile.toolbar.refresh",
        interaction: "visible",
        status: "pass",
        event: "mission_workbench_visible",
      },
    ],
    ...overrides,
  }, null, 2));
  return { observation, evidence };
}

describe("friday-ios-sim-accessibility-capture", () => {
  it("is exposed as the iOS AX proof script without claiming END-BAR", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["proof:ios:ax-capture"]).toContain(script);
    expect(readFileSync(script, "utf8")).toContain("not END-BAR/adoption proof");
  });

  it("defaults to plan-only without writing capture JSON or claiming runtime proof", () => {
    const outDir = mkdtempSync(join(tmpdir(), "friday-ios-sim-ax-plan-"));
    try {
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const output = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        targetCount?: number;
        outputs?: { capture?: string | null };
        caveat?: string;
      };
      expect(output.truth).toBe("ios_sim_accessibility_capture_plan_only_not_runtime_proof");
      expect(output.status).toBe("plan_ready");
      expect(output.targetCount).toBeGreaterThan(0);
      expect(output.outputs?.capture).toBeNull();
      expect(output.caveat).toContain("does not launch Simulator");
      expect(existsSync(join(outDir, "ios-sim-accessibility-capture.json"))).toBe(false);

      const summary = JSON.parse(readFileSync(join(outDir, "ios-sim-accessibility-capture-summary.json"), "utf8")) as {
        truth?: string;
        targets?: Array<{ runtimeActionId?: string; accessibilityIds?: string[] }>;
      };
      expect(summary.truth).toBe("ios_sim_accessibility_capture_plan_only_not_runtime_proof");
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "mobile/home/refresh",
        accessibilityIds: expect.arrayContaining(["friday.mobile.toolbar.refresh"]),
      }));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("blocks screenshot-only or mock evidence before writing capture JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-sim-ax-blocked-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeXcrun(binDir);
      const screenshot = join(root, "screenshot.png");
      writeFileSync(screenshot, "not accessibility evidence\n");
      const { observation } = writeObservation(root, {
        truth_label: "ios_simulator_accessibility_observation_real_ui_screenshot_only",
        source: "mock screenshot-only harness",
        evidence_type: "screenshot_only",
        evidence_ref: screenshot,
      });
      const result = spawnSync("node", [
        script,
        "--real",
        "--require-observed",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--observation=${observation}`,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { status?: string; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("blocked");
      expect(output.blockers?.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
        "truth_label_forbidden",
        "evidence_type_not_accessibility",
        "screenshot_only_evidence_forbidden",
        "observation_source_forbidden",
      ]));
      expect(existsSync(join(outDir, "ios-sim-accessibility-capture.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits normalizer-accepted capture JSON only after simulator/app and accessibility observation checks pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-sim-ax-real-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      const normalizedOut = join(root, "normalized");
      await writeFakeXcrun(binDir);
      const { observation } = writeObservation(root);
      const stdout = execFileSync("node", [
        script,
        "--real",
        "--normalize",
        "--require-observed",
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        `--normalizer-out-dir=${normalizedOut}`,
        `--observation=${observation}`,
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      const output = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        simulator?: { udid?: string };
        capture?: { path?: string; observed_count?: number };
      };
      expect(output.truth).toBe("ios_sim_accessibility_capture_real_simulator_accessibility_not_endbar");
      expect(output.status).toBe("capture_ready");
      expect(output.simulator?.udid).toBe(fakeUdid);
      expect(output.capture?.observed_count).toBe(1);

      const capture = JSON.parse(readFileSync(output.capture?.path || "", "utf8")) as {
        truth_label?: string;
        capture_method?: string;
        ui_actions?: Array<{ runtimeActionId?: string; accessibility_id?: string }>;
      };
      expect(capture.truth_label).toBe("ui_device_accessibility_click_capture_real_ui_not_endbar");
      expect(capture.capture_method).toBe("ios_simulator_accessibility");
      expect(capture.ui_actions).toContainEqual(expect.objectContaining({
        runtimeActionId: "mobile/home/refresh",
        accessibility_id: "friday.mobile.toolbar.refresh",
      }));
      expect(existsSync(join(normalizedOut, "accessibility-click-events.jsonl"))).toBe(true);
      expect(existsSync(join(normalizedOut, "action-runtime-evidence.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
