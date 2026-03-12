import { describe, it, expect } from "vitest";
import {
  mapFridaySkillOriginToTrustTier,
  getFridayDefaultSandboxPolicy,
  enforceFridaySkillTrust,
} from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("mapFridaySkillOriginToTrustTier", () => {
  it("maps bundled origin to bundled tier", () => {
    expect(mapFridaySkillOriginToTrustTier("bundled")).toBe("bundled");
  });

  it("maps managed origin to managed tier", () => {
    expect(mapFridaySkillOriginToTrustTier("managed")).toBe("managed");
  });

  it("maps workspace origin to workspace tier", () => {
    expect(mapFridaySkillOriginToTrustTier("workspace")).toBe("workspace");
  });

  it("maps agents-skills-personal to workspace tier", () => {
    expect(mapFridaySkillOriginToTrustTier("agents-skills-personal")).toBe("workspace");
  });

  it("maps agents-skills-project to workspace tier", () => {
    expect(mapFridaySkillOriginToTrustTier("agents-skills-project")).toBe("workspace");
  });

  it("maps extra origin to extra tier", () => {
    expect(mapFridaySkillOriginToTrustTier("extra")).toBe("extra");
  });
});

describe("getFridayDefaultSandboxPolicy", () => {
  it("bundled tier defaults to trusted execution", () => {
    const policy = getFridayDefaultSandboxPolicy("bundled");
    expect(policy.defaultExecutionMode).toBe("trusted");
    expect(policy.allowedExecutionModes).toContain("trusted");
  });

  it("managed tier defaults to restricted execution", () => {
    const policy = getFridayDefaultSandboxPolicy("managed");
    expect(policy.defaultExecutionMode).toBe("restricted");
    expect(policy.allowedExecutionModes).not.toContain("trusted");
  });

  it("workspace tier defaults to isolated execution per §6.4", () => {
    const policy = getFridayDefaultSandboxPolicy("workspace");
    expect(policy.defaultExecutionMode).toBe("isolated");
  });

  it("extra tier defaults to isolated execution only", () => {
    const policy = getFridayDefaultSandboxPolicy("extra");
    expect(policy.defaultExecutionMode).toBe("isolated");
    expect(policy.allowedExecutionModes).toEqual(["isolated"]);
  });
});

describe("enforceFridaySkillTrust", () => {
  it("returns decision for valid trust/execution combination", () => {
    const manifest = makeManifest();
    const result = enforceFridaySkillTrust({
      manifest,
      origin: "bundled",
    });

    expect(result.issues).toEqual([]);
    expect(result.decision).toBeDefined();
    expect(result.decision!.trustTier).toBe("bundled");
    expect(result.decision!.executionMode).toBe("trusted");
  });

  it("blocks disallowed execution modes for extra tier", () => {
    const manifest = makeManifest();
    const result = enforceFridaySkillTrust({
      manifest,
      origin: "extra",
      requestedExecutionMode: "trusted",
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe("EXECUTION_MODE_DISALLOWED");
    expect(result.decision).toBeUndefined();
  });

  it("uses forced execution mode from security profile", () => {
    const manifest = makeManifest({ id: "forced-skill" });
    const result = enforceFridaySkillTrust({
      manifest,
      origin: "bundled",
      securityProfile: {
        forcedExecutionModeBySkillId: { "forced-skill": "isolated" },
      },
    });

    expect(result.decision).toBeDefined();
    expect(result.decision!.executionMode).toBe("isolated");
  });

  it("applies policy overrides from security profile", () => {
    const manifest = makeManifest();
    const result = enforceFridaySkillTrust({
      manifest,
      origin: "extra",
      securityProfile: {
        policyOverridesByTier: {
          extra: {
            allowedExecutionModes: ["isolated", "restricted"],
            defaultExecutionMode: "restricted",
          },
        },
      },
    });

    expect(result.decision).toBeDefined();
    expect(result.decision!.executionMode).toBe("restricted");
  });

  it("partitions permissions into required and optional", () => {
    const manifest = makeManifest({
      permissions: {
        grants: [
          { id: "req1", resource: "filesystem", action: "read", required: true, reason: "Need it" },
          { id: "opt1", resource: "network", action: "connect", required: false, reason: "Maybe" },
        ],
        promptOn: [],
      },
    });

    const result = enforceFridaySkillTrust({ manifest, origin: "bundled" });
    expect(result.decision!.requiredPermissionIds).toEqual(["req1"]);
    expect(result.decision!.optionalPermissionIds).toEqual(["opt1"]);
  });
});
