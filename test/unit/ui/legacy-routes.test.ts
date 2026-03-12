import { describe, expect, it } from "vitest";
import { LEGACY_ROUTE_PREFIXES, resolveLegacyRedirect } from "../../../ui/src/lib/routes/legacy-routes";

describe("legacy route redirects", () => {
  it("redirects deferred builder surfaces into the command center", () => {
    for (const prefix of LEGACY_ROUTE_PREFIXES) {
      expect(resolveLegacyRedirect(prefix)).toBe("/");
      expect(resolveLegacyRedirect(`${prefix}/nested/path`)).toBe("/");
    }
  });

  it("redirects automation detail routes back to the task queue", () => {
    expect(resolveLegacyRedirect("/automations/run-1")).toBe("/automations");
  });

  it("leaves active routes untouched", () => {
    expect(resolveLegacyRedirect("/")).toBeNull();
    expect(resolveLegacyRedirect("/settings")).toBeNull();
    expect(resolveLegacyRedirect("/skills")).toBeNull();
    expect(resolveLegacyRedirect("/workflows")).toBeNull();
  });
});
