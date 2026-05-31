import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local bootstrap auth gate", () => {
  // PR #446: a fresh machine (backend reachable + bootstrapRequired) is routed to the first-run
  // create-passphrase gate, NOT a misleading "connecting" splash and NOT browser-storage seeding.
  // Genuine auth/backend failures still go to real recovery; unauth non-fresh users go to /login.
  it("routes a fresh machine into the first-run create-passphrase gate (no misleading connect screen, no storage seeding)", () => {
    const routerSource = readFileSync("ui/src/router.tsx", "utf8");

    // Still keyed off the real bootstrap-status + login signals.
    expect(routerSource).toContain("getBootstrapStatus");
    expect(routerSource).toContain("LoginPage");
    expect(routerSource).toContain("/login?next=");
    expect(routerSource).toContain("bootstrapStatusQuery.isError");

    // NEW correct behavior: bootstrapRequired -> first-run create-passphrase gate.
    expect(routerSource).toContain("bootstrapStatusQuery.data?.bootstrapRequired");
    expect(routerSource).toContain("FirstRunPassphraseGate");

    // The misleading "connecting" gate/copy must be GONE (it told fresh users it was a connection failure).
    expect(routerSource).not.toContain("LocalSessionUnavailableGate");
    expect(routerSource).not.toContain("正在连接本机 Friday");

    // No browser-storage seeding / legacy local-bootstrap variants.
    expect(routerSource).not.toContain("LocalBootstrapGate");
    expect(routerSource).not.toContain("LocalUnlockGate");
    expect(routerSource).not.toContain("后端返回：");
    expect(routerSource).not.toContain("Backend said:");
    expect(routerSource).not.toContain("Local session not connected");
    expect(routerSource).not.toContain("No authentication method provided");

    // Genuine network/backend failure still surfaces the real connection-failure copy via the isError path.
    expect(routerSource).toContain("Friday 后台还没连上");

    const loginSource = readFileSync("ui/src/routes/login-page.tsx", "utf8");
    expect(loginSource).toContain("login({ localPassphrase: trimmed })");
    expect(loginSource).toContain('id="login-local-passphrase"');
    expect(loginSource).toContain("Continue locally");
    expect(loginSource).not.toContain("localStorage.setItem");
  });

  it("first-run gate creates a local passphrase then logs in (no browser-storage seeding)", () => {
    const gateSource = readFileSync("ui/src/routes/first-run-passphrase-gate.tsx", "utf8");
    // Real bootstrap + login wiring (not localStorage token seeding).
    expect(gateSource).toContain("postBootstrapLocalPassphrase");
    expect(gateSource).toContain("login({ localPassphrase: passphrase })");
    expect(gateSource).not.toContain("localStorage.setItem");
    // Validation gate is the single source of truth for submit-enable.
    expect(gateSource).toContain("evaluatePassphraseGate");
  });

  it("restores a stored token without attempting local auto-login", () => {
    const authProviderSource = readFileSync("ui/src/providers/auth-provider.tsx", "utf8");
    const firstIdentityRead = authProviderSource.indexOf("const me = await fetchMe()");

    expect(firstIdentityRead).toBeGreaterThanOrEqual(0);
    expect(authProviderSource).not.toContain("loginRequest({ local:");
    expect(authProviderSource).not.toContain("Fall back to legacy local login");
  });

  it("allows splash screens to embed the first-run setup form", () => {
    const shellSource = readFileSync("ui/src/components/console/shell/splash/shell.tsx", "utf8");

    expect(shellSource).toContain("children?: ReactNode");
    expect(shellSource).toContain("{children ? <div");
  });

  it("sends completed setup revisits straight to home", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).toContain('navigate("/home", { replace: true })');
  });
});
