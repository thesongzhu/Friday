import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 operations screen contract", () => {
  const homeSource = () => readFileSync("ui/src/routes/home-page.tsx", "utf8");

  it("promotes served web home into the selected desktop Operations surface", () => {
    const source = homeSource();

    expect(source).toContain('data-ui-screen="desktop-operations"');
    expect(source).toContain('data-ui-component="ops-masthead"');
    expect(source).toContain("OpsMasthead");
    expect(source).toContain("Needs Me");
    expect(source).toContain("Running");
    expect(source).toContain("Standing goals");
    expect(source).toContain("Agenda");
    expect(source).toContain("Scheduled");
  });

  it("keeps Operations mission intake explicit and truth-labelled", () => {
    const source = homeSource();

    expect(source).toContain('data-testid="operations-submit-intent"');
    expect(source).toContain('data-testid="home-start-task"');
    expect(source).toContain('data-action="mission_intake_submit"');
    expect(source).toContain('data-cap="mission_intake"');
    expect(source).toContain('data-truth="wired_registry"');
    expect(source).toContain("Submit Intent");
  });
});
