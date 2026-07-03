import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("current-source-of-truth OpenAI Codex subscription auth copy", () => {
  it("marks the live OpenAI Codex device OAuth route as current rather than future-only", () => {
    const sot = readFileSync("docs/current-source-of-truth.md", "utf8");
    const providerRoutes = readFileSync("src/api/http/routes/friday-provider-routes.ts", "utf8");

    expect(providerRoutes).toContain('operationId: "auth.oauth.openai.codex.device.initiate"');
    expect(providerRoutes).toContain('operationId: "auth.oauth.openai.codex.device.complete"');
    expect(providerRoutes).toContain('path: "/v1/auth/oauth/openai-codex/device/initiate"');
    expect(providerRoutes).toContain('path: "/v1/auth/oauth/openai-codex/device/complete"');

    expect(sot).toContain("OpenAI Codex device OAuth");
    expect(sot).toContain("/v1/auth/oauth/openai-codex/device/initiate");
    expect(sot).not.toContain("Subscription-based Codex access should be treated as a future Codex client/backend integration");
    expect(sot).not.toContain("OpenAI subscription/Codex account sign-in is **not** a current steady-state auth surface");
  });
});
