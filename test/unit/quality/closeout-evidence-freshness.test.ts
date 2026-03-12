import { describe, expect, it } from "vitest";

import { collectEvidenceFreshnessFailures } from "../../../scripts/quality/closeout-lib.mjs";

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
      "marketplace",
      {
        status: "passed",
        gitHead: "4cf0cd7",
      },
      [
        "# Marketplace Creator Ecosystem",
        "",
        "- Status: passed",
        "- Git SHA: 4cf0cd7",
      ].join("\n"),
      "4cf0cd7",
    );

    expect(failures).toEqual([]);
  });
});
