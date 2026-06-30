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

  it("keeps the selected desktop Hub strip and right-docked proof inspector in the shell", () => {
    const shellSource = readFileSync("ui/src/components/console/shell/console-shell.tsx", "utf8");
    const rightRailSource = readFileSync("ui/src/components/console/shell/right-rail.tsx", "utf8");

    expect(shellSource).toContain("function DesktopHubStrip");
    expect(shellSource).toContain("data-testid=\"desktop-subtle-status-pet\"");
    expect(shellSource).toContain("Friday Hub");
    expect(shellSource).toContain("source-of-truth projection");
    expect(shellSource).toContain("<RightRail />");
    expect(shellSource).not.toContain("function DesktopProofDock");
    expect(rightRailSource).toContain("data-testid=\"desktop-proof-inspector\"");
    expect(rightRailSource).toContain("data-dock=\"right\"");
    expect(rightRailSource).toContain("Right-docked ProofInspector");
  });

  it("keeps the right-docked proof inspector primary action wired to a real product route", () => {
    const rightRailSource = readFileSync("ui/src/components/console/shell/right-rail.tsx", "utf8");

    expect(rightRailSource).toContain("useNavigate");
    expect(rightRailSource).toContain("data-testid=\"desktop-proof-inspector-open-workbench\"");
    expect(rightRailSource).toContain("navigate(\"/mission-workbench\")");
    expect(rightRailSource).toContain("Open Mission Workbench");
    expect(rightRailSource).not.toContain("Review current proof");
  });

  it("keeps Friday Home on the selected Chat/Status baseline without the old debug hero stage", () => {
    const homeSource = readFileSync("ui/src/routes/home-page.tsx", "utf8");

    expect(homeSource).toContain("Friday Home");
    expect(homeSource).toContain("Chat + Status");
    expect(homeSource).toContain("Status first, chat always one tap away");
    expect(homeSource).toContain("ProviderTruthCard");
    expect(homeSource).toContain("ProviderTruthCompact");
    expect(homeSource).not.toContain("function HeroPetStage");
  });
});
