import { describe, expect, it } from "vitest";

import {
  blockStatus,
  blockerTypesFromEnvironment,
} from "../../../scripts/e2e/tier1-live-audit-lib.mjs";

describe("tier1 live audit lib", () => {
  it("returns multiple blocker reasons when both runner and credentials are missing", () => {
    const blockerTypes = blockerTypesFromEnvironment({
      credentialEnv: ["FRIDAY_TEST_ENV_THAT_DOES_NOT_EXIST"],
      runner: false,
    });

    expect(blockerTypes).toContain("missing_runner");
    expect(blockerTypes).toContain("missing_credentials");
  });

  it("preserves blockerTypes while exposing the primary blockerType for compatibility", () => {
    const result = blockStatus("china-provider", "runner and credentials missing", {
      blockerTypes: ["missing_runner", "missing_credentials"],
    });

    expect(result.blockerType).toBe("missing_runner");
    expect(result.blockerTypes).toEqual(["missing_runner", "missing_credentials"]);
  });
});
