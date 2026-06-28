import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("selected shell structure", () => {
  it("uses the selected mobile Command Sheet instead of a fixed bottom tab bar", () => {
    const shellSource = readFileSync("ui/src/components/console/shell/console-shell.tsx", "utf8");
    const topBarSource = readFileSync("ui/src/components/console/shell/top-bar.tsx", "utf8");

    expect(shellSource).toContain("AGENT_OS_NAV_PRIMARY");
    expect(shellSource).toContain("commandSheetItems");
    expect(shellSource).toContain("role=\"dialog\"");
    expect(shellSource).toContain("Command Sheet");
    expect(shellSource).not.toContain("<MobileNav");
    expect(shellSource).not.toContain("pb-[72px]");
    expect(topBarSource).toContain("Open command sheet");
  });

  it("keeps the selected desktop Hub strip and bottom proof dock in the shell", () => {
    const shellSource = readFileSync("ui/src/components/console/shell/console-shell.tsx", "utf8");

    expect(shellSource).toContain("function DesktopHubStrip");
    expect(shellSource).toContain("Rust Hub / Core");
    expect(shellSource).toContain("function DesktopProofDock");
    expect(shellSource).toContain("Proof inspector");
    expect(shellSource).toContain("Hub-projected");
  });

  it("keeps Friday Home on the selected hero pet plus Chat/Status baseline", () => {
    const homeSource = readFileSync("ui/src/routes/home-page.tsx", "utf8");

    expect(homeSource).toContain("function HeroPetStage");
    expect(homeSource).toContain("/source/pet/g-sit.png");
    expect(homeSource).toContain("Friday Home");
    expect(homeSource).toContain("Chat + Status");
    expect(homeSource).toContain("providerLabel");
  });
});
