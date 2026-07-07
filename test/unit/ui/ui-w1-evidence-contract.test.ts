import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 Evidence screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("exposes Evidence as a first-class desktop hubConsole route", () => {
    const routerSource = read("ui/src/router.tsx");
    const navSource = read("ui/src/lib/routes/agent-os-nav.ts");

    expect(routerSource).toContain("const EvidencePage");
    expect(routerSource).toContain('path: "evidence"');
    expect(routerSource).toContain("<EvidencePage />");
    expect(navSource).toContain('path: "/evidence"');
    expect(navSource).toContain("Evidence");
  });

  it("renders the evidence workbench from redacted server evidence APIs", () => {
    const source = read("ui/src/routes/evidence-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-evidence"');
    expect(source).toContain('data-ui-component="evidence-search"');
    expect(source).toContain("taskWorkflowsApi.queryEvidence");
    expect(source).toContain("taskWorkflowsApi.getEvidenceRawDrilldown");
    expect(source).toContain("server-redacted");
    expect(source).toContain("redactionApplied");
    expect(source).toContain("NO-GO");
  });

  it("keeps receipt lanes, inspector, and split diff truth boundaries machine-readable", () => {
    const source = read("ui/src/routes/evidence-page.tsx");

    expect(source).toContain('data-ui-component="evidence-receipt-lanes"');
    expect(source).toContain("runtime_evidence");
    expect(source).toContain("code_evidence");
    expect(source).toContain("api_evidence");
    expect(source).toContain("artifact_evidence");
    expect(source).toContain('data-ui-component="evidence-inspector"');
    expect(source).toContain('data-ui-component="evidence-split-diff"');
    expect(source).toContain("same SHA != runtime PASS");
    expect(source).toContain("receipt hash is not execution proof");
  });
});
