import { describe, expect, it } from "vitest";

import {
  collectEvidenceFreshnessFailures,
  hasOnlyCloseoutEvidenceChanges,
} from "../../../scripts/quality/closeout-lib.mjs";

describe("closeout evidence freshness", () => {
  it("fails when report SHA drifts from the expected git head", () => {
    const failures = collectEvidenceFreshnessFailures(
      "final",
      {
        status: "passed",
        gitHead: "d322c61",
      },
      [
        "# Non-Platform Final Closeout",
        "",
        "- Status: passed",
        "- Git SHA: d322c61",
      ].join("\n"),
      "4cf0cd7",
    );

    expect(failures).toContain(
      "final: latest.json gitHead d322c61 does not match expected 4cf0cd7",
    );
  });

  it("passes when markdown and json both match the expected git head", () => {
    const failures = collectEvidenceFreshnessFailures(
      "phase5",
      {
        status: "passed",
        gitHead: "4cf0cd7",
      },
      [
        "# Skills Lifecycle Hardening",
        "",
        "- Status: passed",
        "- Git SHA: 4cf0cd7",
      ].join("\n"),
      "4cf0cd7",
    );

    expect(failures).toEqual([]);
  });

  it("allows head drift when only closeout evidence files changed after generation", () => {
    const failures = collectEvidenceFreshnessFailures(
      "final",
      {
        status: "passed",
        gitHead: "2464075",
      },
      [
        "# Non-Platform Final Closeout",
        "",
        "- Status: passed",
        "- Git SHA: 2464075",
      ].join("\n"),
      "184ecb8",
      { allowGitHeadDrift: true },
    );

    expect(failures).toEqual([]);
  });

  it("recognizes closeout latest files as the only allowed post-generation drift", () => {
    expect(
      hasOnlyCloseoutEvidenceChanges([
        ".friday/evidence/closeout/phase1-canonical-truth/latest.json",
        ".friday/evidence/closeout/phase1-canonical-truth/latest.md",
        ".friday/evidence/closeout/final-non-platform/latest.json",
      ]),
    ).toBe(true);

    expect(
      hasOnlyCloseoutEvidenceChanges([
        ".friday/evidence/closeout/final-non-platform/latest.json",
        "scripts/quality/closeout-lib.mjs",
      ]),
    ).toBe(false);
  });
});
