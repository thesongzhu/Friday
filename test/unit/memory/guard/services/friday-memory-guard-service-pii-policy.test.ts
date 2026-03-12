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
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
      distinctTypes: ["email"],
      transformedContent: "user@test.com",
      tagsToAdd: ["pii.email"],
    });

    await guard.store("test-ns", "user@test.com", { tags: ["my-tag"] });
    const callArgs = vi.mocked(core.store).mock.calls[0];
    const passedTags = callArgs[2]?.tags;
    expect(passedTags).toContain("my-tag");
    expect(passedTags).toContain("pii.email");
  });

  it("does not duplicate existing PII tags", async () => {
    const { guard, core, piiGuard } = createGuardTestSetup();
    vi.mocked(piiGuard.scanAndTransform).mockReturnValue({
      matches: [{ type: "email", value: "user@test.com", start: 0, end: 13 }],
      distinctTypes: ["email"],
      transformedContent: "user@test.com",
      tagsToAdd: ["pii.email"],
    });

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
});
