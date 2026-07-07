import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 session detail screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("exposes a first-class desktop session-detail route", () => {
    const routerSource = read("ui/src/router.tsx");

    expect(routerSource).toContain("const SessionDetailPage");
    expect(routerSource).toContain('path: "sessions/:sessionKey"');
    expect(routerSource).toContain("<SessionDetailPage />");
  });

  it("renders the governed transcript, proof, lifecycle, and native-control truth surface", () => {
    const source = read("ui/src/routes/session-detail-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-session-detail"');
    expect(source).toContain('data-ui-component="session-provider-header"');
    expect(source).toContain('data-ui-component="session-lifecycle-strip"');
    expect(source).toContain('aria-label="Lifecycle state (13 states)"');
    expect(source).toContain("failedTerminal");
    expect(source).toContain("deltaSnapshot");
    expect(source).toContain('data-ui-component="transcript-proof"');
    expect(source).toContain('data-ui-component="split-diff-workbench"');
    expect(source).toContain('data-ui-component="session-control-row"');
    expect(source).toContain("Full native control");
    expect(source).toContain("wired_registry !== runtime PASS");
    expect(source).toContain("NO-GO");
    expect(source).toContain("session_control_native_set");
    expect(source).toContain("provider_adapter_parity_codex_claude");
    expect(source).toContain("security_approval_bound_principal_gate_cat10_netnew");
  });

  it("keeps the 12 design-required session controls machine-readable and fail-closed when not wired", () => {
    const source = read("ui/src/routes/session-detail-page.tsx");

    for (const label of ["Send", "Stop", "Steer", "Resume", "Fork", "Archive", "Tools", "Approvals", "Files", "Diffs", "Attach", "History"]) {
      expect(source).toContain(`label: "${label}"`);
    }

    expect(source).toContain('data-actlabel={control.label}');
    expect(source).toContain('data-cap={control.capability}');
    expect(source).toContain('data-truth={control.truth}');
    expect(source).toContain("disabled={control.truth !== \"wired_registry\"}");
    expect(source).toContain("Blocked - not executed");
  });
});
