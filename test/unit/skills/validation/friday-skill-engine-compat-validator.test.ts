import { describe, it, expect } from "vitest";
import { validateFridaySkillEngineCompatibility } from "#skills";
import { makeManifest } from "../_helpers/make-manifest.helper.js";

describe("validateFridaySkillEngineCompatibility", () => {
  it("accepts compatible API version and hub version", () => {
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "0.1.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(issues).toEqual([]);
  });

  it("rejects unsupported API version", () => {
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "0.1.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: "1.0.0",
      supportedApiVersions: ["2", "3"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("UNSUPPORTED_API_VERSION");
  });

  it("rejects too-high minHubVersion", () => {
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "5.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("HUB_VERSION_TOO_LOW");
  });

  it("accepts when hub version exactly matches minHubVersion", () => {
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: "1.0.0",
      supportedApiVersions: ["1"],
    });
    expect(issues).toEqual([]);
  });

  it("accepts when hub version is higher than minHubVersion", () => {
    const manifest = makeManifest({
      runtime: {
        kind: "node",
        entrypoint: "index.ts",
        minHubVersion: "0.5.0",
        apiVersion: "1",
        timeoutMsDefault: 30_000,
      },
    });

    const issues = validateFridaySkillEngineCompatibility(manifest, {
      hubVersion: "2.0.0",
      supportedApiVersions: ["1"],
    });
    expect(issues).toEqual([]);
  });
});
