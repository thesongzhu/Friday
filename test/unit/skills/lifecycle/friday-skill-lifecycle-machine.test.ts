import { describe, it, expect } from "vitest";
import {
  canApplyFridaySkillLifecycleOperation,
  applyFridaySkillLifecycleOperation,
} from "#skills";

describe("canApplyFridaySkillLifecycleOperation", () => {
  it("allows install from not_installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "install")).toBe(true);
  });

  it("allows discover from not_installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "discover")).toBe(true);
  });

  it("rejects disable from not_installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("not_installed", "disable")).toBe(false);
  });

  it("allows disable from installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("installed", "disable")).toBe(true);
  });

  it("allows enable from disabled", () => {
    expect(canApplyFridaySkillLifecycleOperation("disabled", "enable")).toBe(true);
  });

  it("rejects enable from installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("installed", "enable")).toBe(false);
  });

  it("allows mark_error from installed", () => {
    expect(canApplyFridaySkillLifecycleOperation("installed", "mark_error")).toBe(true);
  });

  it("allows install from error (recovery)", () => {
    expect(canApplyFridaySkillLifecycleOperation("error", "install")).toBe(true);
  });

  it("allows update from upgrade_available", () => {
    expect(canApplyFridaySkillLifecycleOperation("upgrade_available", "update")).toBe(true);
  });

  it("allows clear_upgrade from upgrade_available", () => {
    expect(canApplyFridaySkillLifecycleOperation("upgrade_available", "clear_upgrade")).toBe(true);
  });

  it("allows uninstall from all non-not_installed states", () => {
    expect(canApplyFridaySkillLifecycleOperation("installed", "uninstall")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("disabled", "uninstall")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("error", "uninstall")).toBe(true);
    expect(canApplyFridaySkillLifecycleOperation("upgrade_available", "uninstall")).toBe(true);
  });
});

describe("applyFridaySkillLifecycleOperation", () => {
  it("transitions not_installed → installed on install", () => {
    const result = applyFridaySkillLifecycleOperation("not_installed", "install");
    expect(result.previous).toBe("not_installed");
    expect(result.next).toBe("installed");
    expect(result.changed).toBe(true);
  });

  it("stays not_installed on discover", () => {
    const result = applyFridaySkillLifecycleOperation("not_installed", "discover");
    expect(result.next).toBe("not_installed");
    expect(result.changed).toBe(false);
  });

  it("transitions installed → disabled on disable", () => {
    const result = applyFridaySkillLifecycleOperation("installed", "disable");
    expect(result.next).toBe("disabled");
    expect(result.changed).toBe(true);
  });

  it("transitions disabled → installed on enable", () => {
    const result = applyFridaySkillLifecycleOperation("disabled", "enable");
    expect(result.next).toBe("installed");
    expect(result.changed).toBe(true);
  });

  it("transitions installed → error on mark_error", () => {
    const result = applyFridaySkillLifecycleOperation("installed", "mark_error");
    expect(result.next).toBe("error");
    expect(result.changed).toBe(true);
  });

  it("transitions error → installed on install", () => {
    const result = applyFridaySkillLifecycleOperation("error", "install");
    expect(result.next).toBe("installed");
    expect(result.changed).toBe(true);
  });

  it("transitions installed → upgrade_available on detect_upgrade", () => {
    const result = applyFridaySkillLifecycleOperation("installed", "detect_upgrade");
    expect(result.next).toBe("upgrade_available");
    expect(result.changed).toBe(true);
  });

  it("transitions upgrade_available → installed on update", () => {
    const result = applyFridaySkillLifecycleOperation("upgrade_available", "update");
    expect(result.next).toBe("installed");
    expect(result.changed).toBe(true);
  });

  it("throws for invalid operations", () => {
    expect(() => applyFridaySkillLifecycleOperation("not_installed", "disable")).toThrow(
      /Invalid lifecycle operation/,
    );
  });
});
