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
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/providerAdmin/check",
        accessibility_id: "friday.desktop.provider-readiness-detail",
        event: "real_provider_execution_visible",
        interaction: "read",
      }));
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/parity/route-readiness",
        accessibility_id: "friday.desktop.provider-route-decision-card",
        event: "real_provider_execution_visible",
        interaction: "read",
      }));
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/tokenLedger/run-readback",
        accessibility_id: "friday.desktop.evidence.transcript-browser",
        event: "transcript_browser_visible",
        interaction: "read",
      }));
      expect(summary.targets).toContainEqual(expect.objectContaining({
        runtimeActionId: "desktop/evidence/index-read",
        accessibility_id: "friday.desktop.evidence.timeline-pages",
        event: "transcript_browser_visible",
        interaction: "read",
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
    expect(source).toContain("live_connection");
    expect(source).toContain("FRIDAY_CONSOLE_LIVE_READ_HOST");
    expect(source).toContain("FRIDAY_CONSOLE_LIVE_READ_PORT");
    expect(source).toContain("mission_bound_live_read_requested");
    expect(source).toContain("live-loopback");
    expect(source).toContain("Only visible, safe observations are emitted");
    expect(source).toContain("does not click governed or");
    expect(source).toContain("friday-ui-device-accessibility-click-capture.mjs");
    expect(source).toContain("killSignal: \"SIGKILL\"");
    expect(source).toContain("timeout: timeoutSeconds * 1000");
    expect(source).toContain("const overallTimeoutMs = Math.max(timeoutSeconds * 1000 * 4, 30_000)");
    expect(source).toContain("function overallDeadlineExceeded()");
    expect(source).toContain("capture_overall_timeout");
    expect(source).toContain("overall_timeout_ms: overallTimeoutMs");
    expect(source).toContain("function waitForDestination(destination, title)");
    expect(source).toContain("const destinationWaitMs = Math.min(timeoutSeconds * 1000, 8_000)");
    expect(source).toContain("initial_destination_ready");
    expect(source).toContain("matched_by: \"initial_destination\"");
    expect(source).toContain("perform action \"AXPress\" of e");
    expect(navSource).toContain(".accessibilityElement(children: .contain)");
    expect(navSource).toContain(".accessibilityIdentifier(\"friday.desktop.nav.\\(destination.rawValue)\")");
    expect(navSource).toContain(".accessibilityIdentifier(\"friday.desktop.destination.\\(destination.rawValue)\")");
  });

  it("applies the configured AX tree depth to navigation and targeted probes", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain("const axTraversalDepth = Number.isInteger(treeDepth) ? treeDepth : 5");
    expect(source).toContain("if depth < ${axTraversalDepth} then");
    expect(source).not.toContain("if depth < 8 then");
  });

  it("only emits status-label events from visible accessibility labels", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain("friday.desktop.status-label.");
    expect(source).toContain("stale_label_visible");
    expect(source).toContain("offline_label_visible");
    expect(source).toContain("error_label_visible");
    expect(source).toContain("matched_by: matchedLabel.identifier.includes(identifier) ? \"accessibility_id\" : \"visible_label\"");
  });
});
