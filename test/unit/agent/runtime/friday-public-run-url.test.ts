import { describe, expect, it } from "vitest";
import { resolveFridayPublicRunUrl } from "#agent";

describe("resolveFridayPublicRunUrl", () => {
  it("builds a command-center URL when a public app base URL is configured", () => {
    expect(resolveFridayPublicRunUrl("run-123", "https://friday.example.com")).toBe(
      "https://friday.example.com/command-center?runId=run-123",
    );
  });

  it("returns undefined when the public app base URL is missing", () => {
    expect(resolveFridayPublicRunUrl("run-123", undefined)).toBeUndefined();
    expect(resolveFridayPublicRunUrl("run-123", "")).toBeUndefined();
  });

  it("returns undefined when the public app base URL is invalid", () => {
    expect(resolveFridayPublicRunUrl("run-123", "not a url")).toBeUndefined();
  });
});
