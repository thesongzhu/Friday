import { describe, it, expect, vi } from "vitest";
import { createGuardTestSetup } from "./_helpers/create-guard-service.helper.js";

describe("FridayMemoryGuardService — PII Policy", () => {
  it("calls PII guard scanAndTransform on store", async () => {
    const { guard, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [],
      distinctTypes: [],
      transformedContent: "clean content",
      tagsToAdd: [],
    });

    await guard.store("test-ns", "clean content");
    expect(piiGuard.scanAndTransform).toHaveBeenCalledWith("clean content");
  });

  it("passes transformed content to core when PII is detected in tag mode", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
      distinctTypes: ["email"],
      transformedContent: "user@test.com is here", // In tag mode, content is unchanged
      tagsToAdd: ["pii.email"],
    });

    await guard.store("test-ns", "user@test.com is here");
    expect(core.store).toHaveBeenCalledWith(
      expect.anything(),
      "user@test.com is here",
      expect.objectContaining({ tags: ["pii.email"] }),
    );
  });

  it("merges PII tags with existing tags", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    // Input-aware: the email-bearing content is PII; the clean "my-tag" is not (scanAndTransform
    // is now called per-tag as well as on content).
    vi.mocked(piiGuard.scanAndTransform).mockImplementation((s: string) =>
      s.includes("@")
        ? {
            matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
            distinctTypes: ["email"],
            transformedContent: "user@test.com",
            tagsToAdd: ["pii.email"],
          }
        : { matches: [], distinctTypes: [], transformedContent: s, tagsToAdd: [] },
    );

    await guard.store("test-ns", "user@test.com", { tags: ["my-tag"] });
    const callArgs = vi.mocked(core.store).mock.calls[0];
    const passedTags = callArgs[2]?.tags;
    expect(passedTags).toContain("my-tag");
    expect(passedTags).toContain("pii.email");
  });

  it("does not duplicate existing PII tags", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockImplementation((s: string) =>
      s.includes("@")
        ? {
            matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
            distinctTypes: ["email"],
            transformedContent: "user@test.com",
            tagsToAdd: ["pii.email"],
          }
        : { matches: [], distinctTypes: [], transformedContent: s, tagsToAdd: [] },
    );

    await guard.store("test-ns", "user@test.com", { tags: ["pii.email", "existing"] });
    const callArgs = vi.mocked(core.store).mock.calls[0];
    const passedTags = callArgs[2]?.tags;
    // Should only have pii.email once
    const piiEmailCount = passedTags?.filter((t: string) => t === "pii.email").length;
    expect(piiEmailCount).toBe(1);
    expect(passedTags).toContain("existing");
  });

  it("passes clean content unchanged when no PII detected", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [],
      distinctTypes: [],
      transformedContent: "safe content",
      tagsToAdd: [],
    });

    await guard.store("test-ns", "safe content");
    expect(core.store).toHaveBeenCalledWith(
      expect.anything(),
      "safe content",
      expect.anything(),
    );
  });

  it("handles multiple PII types", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [
        { type: "email", value: "user@test.com", start: 0, end: 13 },
        { type: "ssn_us", value: "123-45-6789", start: 20, end: 31 },
      ],
      distinctTypes: ["email", "ssn_us"],
      transformedContent: "user@test.com and 123-45-6789",
      tagsToAdd: ["pii.email", "pii.ssn_us"],
    });

    await guard.store("test-ns", "user@test.com and 123-45-6789");
    const callArgs = vi.mocked(core.store).mock.calls[0];
    const passedTags = callArgs[2]?.tags;
    expect(passedTags).toContain("pii.email");
    expect(passedTags).toContain("pii.ssn_us");
  });

  it("redacts metadata, drops PII-bearing tags, and surfaces pii.* tags on store", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    // content is clean; the SSN-pattern tag is the PII tag.
    vi.mocked(piiGuard.scanAndTransform).mockImplementation((s: string) => {
      const isSsnTag = s === "123-45-6789";
      return {
        matches: isSsnTag ? [{ type: "ssn_us" as const, value: s, start: 0, end: s.length }] : [],
        distinctTypes: isSsnTag ? ["ssn_us" as const] : [],
        transformedContent: s,
        tagsToAdd: isSsnTag ? ["pii.ssn_us"] : [],
      };
    });
    // redactDeep redacts email-bearing metadata string values.
    vi.mocked(piiGuard.redactDeep).mockImplementation((value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const out: Record<string, unknown> = {};
        let found = false;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v === "string" && v.includes("@")) {
            out[k] = "[EMAIL]";
            found = true;
          } else {
            out[k] = v;
          }
        }
        return { value: out, tagsToAdd: found ? ["pii.email"] : [] };
      }
      return { value, tagsToAdd: [] };
    });

    await guard.store("test-ns", "clean content", {
      metadata: { note: "ping owner@test.com" },
      tags: ["keep-me", "123-45-6789"],
    });

    const callArgs = vi.mocked(core.store).mock.calls[0];
    const storedMeta = callArgs[2]?.metadata as Record<string, unknown> | undefined;
    const storedTags = callArgs[2]?.tags as string[] | undefined;
    expect(storedMeta?.note).toBe("[EMAIL]"); // metadata redacted in place
    expect(storedTags).toContain("keep-me"); // clean tag kept
    expect(storedTags).not.toContain("123-45-6789"); // PII-bearing tag dropped
    expect(storedTags).toContain("pii.ssn_us"); // tag PII type surfaced
    expect(storedTags).toContain("pii.email"); // metadata PII type surfaced
  });
});
