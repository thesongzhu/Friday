import { describe, it, expect } from "vitest";
import { FridayBriefConfigSchema, buildDefaultFridayBriefConfig } from "../../../src/brief/friday-brief-config.types.js";

describe("FridayBriefConfigSchema cron + timezone validation", () => {
  it("rejects an invalid cron expression", () => {
    const r = FridayBriefConfigSchema.safeParse({ ...buildDefaultFridayBriefConfig(), cronExpression: "not a cron" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "cronExpression")).toBe(true);
    }
  });
  it("accepts a valid cron expression", () => {
    const r = FridayBriefConfigSchema.safeParse({ ...buildDefaultFridayBriefConfig(), cronExpression: "*/15 * * * *" });
    expect(r.success).toBe(true);
  });
  it("rejects an invalid IANA timezone", () => {
    const r = FridayBriefConfigSchema.safeParse({ ...buildDefaultFridayBriefConfig(), timezone: "Earth/Unknown" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "timezone")).toBe(true);
    }
  });
  it("accepts a valid IANA timezone", () => {
    const r = FridayBriefConfigSchema.safeParse({ ...buildDefaultFridayBriefConfig(), timezone: "America/New_York" });
    expect(r.success).toBe(true);
  });
});
