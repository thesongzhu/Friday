import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/friday-desktop-ax-accessibility-capture.mjs";

describe("friday-desktop-ax-accessibility-capture contract", () => {
  it("plans desktop runtime-action accessibility observations without claiming runtime proof", () => {
    const outDir = mkdtempSync(join(tmpdir(), "friday-desktop-ax-capture-plan-"));
    try {
      const output = execFileSync("node", [
        script,
        "--plan-only",
        "--mission-id=mission_desktop_ax_capture_contract",
        `--out-dir=${outDir}`,
      ], { cwd: process.cwd(), encoding: "utf8" });
      const summaryPath = join(outDir, "desktop-ax-accessibility-capture-summary.json");
      expect(existsSync(summaryPath)).toBe(true);
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        truth?: string;
        status?: string;
        targetCount?: number;
        targets?: Array<{ runtimeActionId?: string; accessibility_id?: string; interaction?: string }>;
        caveat?: string;
      };
      expect(output).toContain("plan_ready");
      expect(summary.truth).toBe("desktop_ax_accessibility_capture_plan_only_not_runtime_proof");
      expect(summary.status).toBe("plan_ready");
      expect(summary.targetCount).toBeGreaterThan(0);
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/operations/refresh",
        accessibility_id: "friday.desktop.refresh",
        interaction: "visible",
      }));
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/operations/mission-resolve-or-create",
        accessibility_id: "friday.desktop.mission-card",
        event: "mission_resolve_or_create_visible",
        interaction: "visible",
      }));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("keeps the real capture boundary strict and non-destructive", () => {
    const source = readFileSync(script, "utf8");
    const navSource = readFileSync("apps/macos/FridayHubConsole/Sources/FridayHubConsole/HubConsoleShell.swift", "utf8");

    expect(source).toContain("ui_device_accessibility_click_capture_real_ui_not_endbar");
    expect(source).toContain("macos_accessibility");
    expect(source).toContain("Only visible, safe observations are emitted");
    expect(source).toContain("does not click governed or");
    expect(source).toContain("friday-ui-device-accessibility-click-capture.mjs");
    expect(navSource).toContain(".accessibilityIdentifier(\"friday.desktop.nav.\\(destination.rawValue)\")");
  });
});
