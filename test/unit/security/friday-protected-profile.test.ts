import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRIDAY_TEST_ONLY_ENV_SWITCHES,
  assertFridayTestOnlyEnvSwitchAllowed,
  isFridayProtectedReleaseProfile,
  isRegisteredFridayTestOnlyEnvSwitch,
} from "../../../src/security/friday-protected-profile.js";

/**
 * ART-NONPROD-001 (P0) — shared protected-profile predicate + open-world guard.
 *
 * Enumerates EVERY `FRIDAY_ALLOW_TEST_ONLY_*` literal referenced under `src/`
 * and asserts each is registered AND refused in a protected profile, so a future
 * un-gated test-only switch fails this guard rather than shipping an activatable
 * mock lane in a release build.
 *
 * OUT OF SCOPE (release-gated, documented): the real signed-artifact / release-
 * manifest observation scan — this is the source-level, code-only guard.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src");
const TEST_ONLY_LITERAL = /FRIDAY_ALLOW_TEST_ONLY_[A-Z0-9_]+/g;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".mts"))) {
      out.push(full);
    }
  }
  return out;
}

function discoverTestOnlySwitchesUnderSrc(): Set<string> {
  const discovered = new Set<string>();
  for (const file of walkTsFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(TEST_ONLY_LITERAL)) {
      discovered.add(match[0]);
    }
  }
  return discovered;
}

describe("isFridayProtectedReleaseProfile", () => {
  it("is true for NODE_ENV=production (case-insensitive, trimmed)", () => {
    expect(isFridayProtectedReleaseProfile({ NODE_ENV: "production" })).toBe(true);
    expect(isFridayProtectedReleaseProfile({ NODE_ENV: "  PRODUCTION  " })).toBe(true);
  });

  it("is true when FRIDAY_RELEASE_TAG is non-empty", () => {
    expect(isFridayProtectedReleaseProfile({ FRIDAY_RELEASE_TAG: "v1.2.3" })).toBe(true);
    expect(isFridayProtectedReleaseProfile({ FRIDAY_RELEASE_TAG: " 2026.07.19 " })).toBe(true);
  });

  it("is false for dev/test profiles and empty markers", () => {
    expect(isFridayProtectedReleaseProfile({})).toBe(false);
    expect(isFridayProtectedReleaseProfile({ NODE_ENV: "test" })).toBe(false);
    expect(isFridayProtectedReleaseProfile({ NODE_ENV: "development" })).toBe(false);
    expect(isFridayProtectedReleaseProfile({ FRIDAY_RELEASE_TAG: "" })).toBe(false);
    expect(isFridayProtectedReleaseProfile({ FRIDAY_RELEASE_TAG: "   " })).toBe(false);
  });
});

describe("assertFridayTestOnlyEnvSwitchAllowed", () => {
  it("throws (naming the switch) in a protected profile", () => {
    expect(() =>
      assertFridayTestOnlyEnvSwitchAllowed("FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION", {
        NODE_ENV: "production",
      }),
    ).toThrow(/FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION.*cannot be enabled in production\/release/);
  });

  it("is a no-op in a non-protected profile", () => {
    expect(() =>
      assertFridayTestOnlyEnvSwitchAllowed("FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION", {}),
    ).not.toThrow();
  });
});

describe("ART-NONPROD-001 open-world test-only switch registry guard", () => {
  it("registers exactly the known test-only switches", () => {
    expect([...FRIDAY_TEST_ONLY_ENV_SWITCHES].sort()).toEqual(
      [
        "FRIDAY_ALLOW_TEST_ONLY_AUTONOMY_LIFECYCLE_EXECUTION",
        "FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION",
        "FRIDAY_ALLOW_TEST_ONLY_PLUGIN_EXECUTION",
      ],
    );
  });

  it("every FRIDAY_ALLOW_TEST_ONLY_* literal under src/ is registered (open-world)", () => {
    const discovered = discoverTestOnlySwitchesUnderSrc();
    // Sanity: the scan actually found the switches (guards against a broken walk).
    expect(discovered.size).toBeGreaterThanOrEqual(FRIDAY_TEST_ONLY_ENV_SWITCHES.length);

    const unregistered = [...discovered].filter((n) => !isRegisteredFridayTestOnlyEnvSwitch(n));
    // If this fails, a new FRIDAY_ALLOW_TEST_ONLY_* switch was added under src/
    // without registering + protected-profile-gating it. Register it in
    // FRIDAY_TEST_ONLY_ENV_SWITCHES and gate it fail-closed.
    expect(unregistered).toEqual([]);
  });

  it("every registered switch is refused in a protected profile and allowed in dev/test", () => {
    for (const name of FRIDAY_TEST_ONLY_ENV_SWITCHES) {
      expect(() => assertFridayTestOnlyEnvSwitchAllowed(name, { NODE_ENV: "production" })).toThrow();
      expect(() => assertFridayTestOnlyEnvSwitchAllowed(name, { FRIDAY_RELEASE_TAG: "v1" })).toThrow();
      expect(() => assertFridayTestOnlyEnvSwitchAllowed(name, {})).not.toThrow();
    }
  });

  it("catches an un-registered / un-gated switch (open-world negative control)", () => {
    const simulated = new Set<string>([
      ...discoverTestOnlySwitchesUnderSrc(),
      "FRIDAY_ALLOW_TEST_ONLY_FAKE_UNGATED_SWITCH",
    ]);
    const unregistered = [...simulated].filter((n) => !isRegisteredFridayTestOnlyEnvSwitch(n));
    expect(unregistered).toEqual(["FRIDAY_ALLOW_TEST_ONLY_FAKE_UNGATED_SWITCH"]);
  });
});
