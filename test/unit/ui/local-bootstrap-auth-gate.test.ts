import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local bootstrap auth gate", () => {
  it("routes first-run auth failures into local session recovery instead of passphrase setup", () => {
    const routerSource = readFileSync("ui/src/router.tsx", "utf8");

    expect(routerSource).toContain("getBootstrapStatus");
    expect(routerSource).toContain("LocalSessionUnavailableGate");
    expect(routerSource).toContain("bootstrapStatusQuery.isError");
    expect(routerSource).toContain("正在恢复本地会话");
    expect(routerSource).toContain("Friday 后台还没连上");
    expect(routerSource).not.toContain("bootstrapLocalPassphrase");
    expect(routerSource).not.toContain("LocalBootstrapGate");
    expect(routerSource).not.toContain("LocalUnlockGate");
    expect(routerSource).not.toContain("先设置本地安全口令");
    expect(routerSource).not.toContain("Set a local security passphrase");
    expect(routerSource).not.toContain("解锁并继续");
    expect(routerSource).not.toContain("后端返回：");
    expect(routerSource).not.toContain("Backend said:");
    expect(routerSource).not.toContain("Local session not connected");
    expect(routerSource).not.toContain("No authentication method provided");
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
