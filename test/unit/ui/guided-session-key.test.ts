import { describe, expect, it } from "vitest";

import { buildGuidedAssistantSessionKey } from "../../../ui/src/lib/guided/session-key";

describe("buildGuidedAssistantSessionKey", () => {
  it("builds a canonical three-segment session key for guided flows", () => {
    expect(
      buildGuidedAssistantSessionKey({
        wizardId: "cross-border-hero",
        userId: "Admin-001",
      }),
    ).toBe("guided:default:admin-001-cross-border-hero");
  });

  it("falls back to the wizard id when no user id is available", () => {
    expect(
      buildGuidedAssistantSessionKey({
        wizardId: "Build New",
      }),
    ).toBe("guided:default:build-new");
  });
});
