import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 Settings Security screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("keeps Settings Security on the authenticated desktop settings route", () => {
    const routerSource = read("ui/src/router.tsx");
    const navSource = read("ui/src/lib/routes/agent-os-nav.ts");

    expect(routerSource).toContain('path: "settings"');
    expect(routerSource).toContain("<SettingsPage />");
    expect(navSource).toContain('path: "/settings"');
    expect(navSource).toContain("Settings Security");
  });

  it("renders the security workbench from existing provider, system, and security APIs", () => {
    const source = read("ui/src/routes/settings-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-settings-security"');
    expect(source).toContain('data-ui-component="settings-security-header"');
    expect(source).toContain('data-ui-component="settings-security-provider-auth"');
    expect(source).toContain('data-ui-component="settings-security-permissions"');
    expect(source).toContain('data-ui-component="settings-security-command-center"');
    expect(source).toContain('data-ui-component="settings-security-runtime-guards"');
    expect(source).toContain("providersApi.list()");
    expect(source).toContain("systemApi.getCurrentState");
    expect(source).toContain("securityApi.getCenter");
  });

  it("keeps security actions wired while labeling operator-gated boundaries as not completed by UI", () => {
    const source = read("ui/src/routes/settings-page.tsx");
    const securityApiSource = read("ui/src/lib/api/security.ts");

    expect(securityApiSource).toContain("revokeToken");
    expect(securityApiSource).toContain("revokeSatellite");
    expect(source).toContain("securityApi.revokeToken");
    expect(source).toContain("securityApi.revokeSatellite");
    expect(source).toContain('data-ui-component="settings-security-token-revoke"');
    expect(source).toContain('data-ui-component="settings-security-satellite-revoke"');
    expect(source).toContain('data-ui-component="settings-security-operator-boundary"');
    expect(source).toContain("settings security != operator SIGN");
    expect(source).toContain("UI status != prod deploy");
    expect(source).toContain("NO-GO");
  });
});
