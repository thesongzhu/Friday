import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 desktop shell contract", () => {
  const shellSource = () => readFileSync("ui/src/components/console/shell/console-shell.tsx", "utf8");
  const rightRailSource = () => readFileSync("ui/src/components/console/shell/right-rail.tsx", "utf8");
  const tokenSource = () => readFileSync("ui/src/styles/tokens.css", "utf8");

  it("uses the selected desktop win shell grid instead of the old flex shell", () => {
    const source = shellSource();

    expect(source).toContain('data-ui-shell="desktop-win"');
    expect(source).toContain('data-ui-shell="win-body"');
    expect(source).toContain('gridTemplateColumns: "var(--shell-rail-w) minmax(0, 1fr) var(--shell-right-rail-w-full)"');
    expect(source).toContain('minHeight: "560px"');
    expect(source).toContain("<Rail");
    expect(source).toContain("<RightRail");
    expect(source).toContain("<DesktopBottomDock");
    expect(source).not.toContain("relative flex min-h-screen w-full lg:h-screen lg:overflow-hidden");
  });

  it("keeps the hubstrip and adds the required bottom proof timeline dock", () => {
    const source = shellSource();

    expect(source).toContain('data-ui-shell="hubstrip"');
    expect(source).toContain('data-ui-shell="dock-bottom"');
    expect(source).toContain("Proof timeline");
    expect(source).toContain("data-testid=\"desktop-proof-timeline\"");
  });

  it("keeps a visible desktop Friday brand anchor before the hidden mobile top bar", () => {
    const shell = shellSource();
    const topBar = readFileSync("ui/src/components/console/shell/top-bar.tsx", "utf8");

    expect(shell.indexOf("<TopBar")).toBeGreaterThan(-1);
    expect(shell.indexOf("<MobileTopBar")).toBeGreaterThan(shell.indexOf("<TopBar"));
    expect(topBar).toContain('data-testid="desktop-friday-brand"');
    expect(topBar).toContain(">Friday<");
  });

  it("uses the selected desktop rail and inspector dimensions", () => {
    const tokens = tokenSource();
    const rightRail = rightRailSource();

    expect(tokens).toContain("--shell-rail-w: 210px");
    expect(tokens).toContain("--shell-right-rail-w-full: 248px");
    expect(rightRail).toContain("const DEFAULT_RIGHT_RAIL_WIDTH = 248");
    expect(rightRail).toContain("const MIN_RIGHT_RAIL_WIDTH = 248");
  });

  it("renders the v9 desktop companion stage in the proof inspector", () => {
    const source = rightRailSource();

    expect(source).toContain("Companion");
    expect(source).toContain("desktop-pet-stage");
    expect(source).toContain("data-friday-pet-stage");
    expect(source).toContain("source/pet/g-idle.png");
    expect(source).not.toContain("<iframe");
    expect(source).not.toContain("pet-host.html");
    expect(source).not.toContain("Friday status dot");
  });
});
