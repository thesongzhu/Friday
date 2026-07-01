import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-ios-sim-xcui-observation.mjs";
const missionId = "mission_ios_sim_xcui_observation_contract";
const fakeUdid = "11111111-2222-3333-4444-555555555555";

async function writeFakeTools(binDir: string, mode: "pass" | "no-tree" | "missing-id" | "selected-design" | "legacy-home" = "pass") {
  await mkdir(binDir, { recursive: true });
  const xcrun = join(binDir, "xcrun");
  writeFileSync(xcrun, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
{"devices":{"iOS Test":[{"name":"iPhone 17 Pro","udid":"${fakeUdid}","state":"Booted","isAvailable":true}]}}
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
  chmodSync(xcrun, 0o755);

  const xcodebuild = join(binDir, "xcodebuild");
  const tree = mode === "no-tree"
    ? ""
    : mode === "missing-id"
      ? "Application, identifier: 'friday.mobile.toolbar.command-sheet', label: 'Open Command Sheet'"
      : mode === "selected-design"
        ? [
          "Application, 0x1, identifier: 'com.friday.shell'",
          "  Button, 0x2, identifier: 'friday.mobile.toolbar.command-sheet', label: 'Open Command Sheet'",
          "  Button, 0x3, identifier: 'friday.mobile.toolbar.refresh', label: 'Refresh Hub status'",
          "  Button, 0x4, identifier: 'friday.mobile.toolbar.chat', label: 'Open Friday Chat'",
          "  Other, 0x5, identifier: 'friday.home.selected-design-intro', label: 'Good morning. Here is what Friday is watching for you.'",
          "  Other, 0x6, identifier: 'friday.home.selected-hero-pet', label: 'Friday companion'",
        ].join("\\n")
        : mode === "legacy-home"
          ? [
            "Application, 0x1, identifier: 'com.friday.shell'",
            "  StaticText, 0x2, label: 'Friday Home'",
            "  StaticText, 0x3, label: 'Friday is offline'",
            "  StaticText, 0x4, label: 'No cached or fabricated status is shown.'",
            "  StaticText, 0x5, label: 'Device pairing'",
            "  StaticText, 0x6, label: 'disabled'",
            "  StaticText, 0x7, label: 'Hub provisioning'",
            "  Other, 0x8, identifier: 'friday.home.unavailable'",
          ].join("\\n")
          : [
            "Application, 0x1, identifier: 'com.friday.shell'",
            "  Button, 0x2, identifier: 'friday.mobile.toolbar.refresh', label: 'Refresh Hub status'",
          ].join("\\n");
  writeFileSync(xcodebuild, `#!/usr/bin/env bash
set -euo pipefail
echo "Test Suite 'FridayIOSAXObserverUITests' started"
if [ "\${FRIDAY_IOS_AX_INTERACTION_SCENARIO:-}" = "missions-dispatch" ]; then
  echo "FRIDAY_AX_DESC_BEGIN"
  printf '%b\\n' "Application, 0x1, identifier: 'com.friday.shell'\\n  TextField, 0x2, identifier: 'friday.missions.dispatch-input', label: 'What should Friday do next?'\\n  Button, 0x3, identifier: 'friday.missions.open-chat-loop', label: 'Continue in Friday Chat'"
  echo "FRIDAY_AX_DESC_END"
else
  ${tree ? `echo "FRIDAY_AX_DESC_BEGIN"\nprintf '%b\\n' "${tree.replace(/"/g, "\\\"")}"\necho "FRIDAY_AX_DESC_END"` : "echo 'no tree emitted'"}
fi
echo "Test Suite 'FridayIOSAXObserverUITests' passed"
`);
  chmodSync(xcodebuild, 0o755);
}

describe("friday-ios-sim-xcui-observation", () => {
  it("runs the checked-in UI-test harness and emits real observation JSON for visible IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir);
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=home",
        "--normalize",
        "--require-observed",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      const output = JSON.parse(stdout) as {
        truth?: string;
        status?: string;
        observed_count?: number;
        outputs?: { observation?: string; normalized?: string };
      };
      expect(output.truth).toBe("ios_sim_xcui_observation_real_ui_not_endbar");
      expect(output.status).toBe("observation_ready");
      expect(output.observed_count).toBe(1);
      expect(existsSync(output.outputs?.observation || "")).toBe(true);
      expect(existsSync(join(output.outputs?.normalized || "", "accessibility-click-events.jsonl"))).toBe(true);

      const observation = JSON.parse(readFileSync(output.outputs?.observation || "", "utf8")) as {
        truth_label?: string;
        evidence_type?: string;
        observations?: Array<{ runtimeActionId?: string; accessibility_id?: string; evidence_type?: string }>;
      };
      expect(observation.truth_label).toBe("ios_simulator_accessibility_observation_real_ui");
      expect(observation.evidence_type).toBe("xctest_accessibility");
      expect(observation.observations).toContainEqual(expect.objectContaining({
        runtimeActionId: "mobile/home/refresh",
        accessibility_id: "friday.mobile.toolbar.refresh",
        evidence_type: "xctest_accessibility",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the UI-test output does not contain a real AX tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-blocked-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir, "no-tree");
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=home",
        "--require-observed",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("accessibility_tree_missing");
      expect(existsSync(join(outDir, "ios-xcui-accessibility-observation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps require-all-planned red when planned IDs are not visible on that destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-missing-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir, "missing-id");
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=home",
        "--require-all-planned",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      expect(output.blockers?.map((blocker) => blocker.code)).toContain("planned_actions_missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes selected-design enforcement for the current product home identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-selected-design-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir, "selected-design");
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=home",
        "--require-selected-design",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      const output = JSON.parse(stdout) as { status?: string; selected_design_required?: boolean; blockers?: Array<{ code?: string }> };
      expect(output.status).toBe("observation_ready");
      expect(output.selected_design_required).toBe(true);
      expect(output.blockers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails selected-design enforcement for the old offline/debug home state", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-legacy-home-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir, "legacy-home");
      const result = spawnSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=home",
        "--require-selected-design",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout) as { blockers?: Array<{ code?: string }> };
      const blockerCodes = output.blockers?.map((blocker) => blocker.code) ?? [];
      expect(blockerCodes).toContain("selected_design_required_id_missing");
      expect(blockerCodes).toContain("selected_design_forbidden_home_state_visible");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes explicit interaction scenario env through and captures the resulting receipt identifier", async () => {
    const root = mkdtempSync(join(tmpdir(), "friday-ios-xcui-observation-interaction-"));
    try {
      const binDir = join(root, "bin");
      const outDir = join(root, "out");
      await writeFakeTools(binDir);
      const stdout = execFileSync("node", [
        script,
        `--mission-id=${missionId}`,
        `--out-dir=${outDir}`,
        "--destinations=missions",
        "--interaction-scenarios=missions=missions-dispatch",
        "--interaction-text=prove mission dispatch",
        "--live-loopback",
        "--normalize",
        "--require-observed",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      const output = JSON.parse(stdout) as {
        live_loopback_requested?: boolean;
        xcode_runs?: Array<{ interaction_scenario?: string | null }>;
        outputs?: { observation?: string; normalized?: string };
      };
      expect(output.live_loopback_requested).toBe(true);
      expect(output.xcode_runs?.[0]?.interaction_scenario).toBe("missions-dispatch");

      const observation = JSON.parse(readFileSync(output.outputs?.observation || "", "utf8")) as {
        observations?: Array<{ runtimeActionId?: string; accessibility_id?: string }>;
      };
      expect(observation.observations).toContainEqual(expect.objectContaining({
        runtimeActionId: "mobile/missions/open-chat-loop",
        accessibility_id: "friday.missions.open-chat-loop",
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
