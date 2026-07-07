import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 providers screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("exposes Providers as a first-class desktop hubConsole route", () => {
    const routerSource = read("ui/src/router.tsx");
    const navSource = read("ui/src/lib/routes/agent-os-nav.ts");

    expect(routerSource).toContain("const ProvidersPage");
    expect(routerSource).toContain('path: "providers"');
    expect(routerSource).toContain("<ProvidersPage />");
    expect(navSource).toContain('path: "/providers"');
    expect(navSource).toContain("Providers & auth");
  });

  it("renders the provider-auth parity surface from registry truth instead of hiding NO-GO lanes", () => {
    const source = read("ui/src/routes/providers-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-providers"');
    expect(source).toContain("Providers & auth");
    expect(source).toContain("auth-ready");
    expect(source).toContain("parity");
    expect(source).toContain("capabilityMatrixAndQueues");
    expect(source).toContain("provider_adapter_parity");
    expect(source).toContain("NO-GO");
    expect(source).toContain("external_blocked");
    expect(source).toContain("Run smoke");
    expect(source).toContain("Queues");
    expect(source).toContain("Multi-provider routing");
  });
});
