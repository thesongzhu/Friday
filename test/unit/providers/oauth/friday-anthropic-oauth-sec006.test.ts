import { describe, it, expect, vi } from "vitest";
import {
  createFridayAnthropicOAuthProvider,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
} from "#providers";

describe("FridayAnthropicOAuthProvider — SEC-006 closed Anthropic OAuth posture", () => {
  it("does not accept caller-provided state or verifier for token exchange", async () => {
    const fetchImpl = vi.fn();
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => 1708272000000,
    });

    await expect(
      provider.exchangeAuthorizationCode({
        authorizationCode: "stolen-code#fake-state",
        state: "fake-state",
        codeVerifier: "attacker-verifier",
      }),
    ).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not create pending verifier state for Anthropic OAuth", async () => {
    const fetchImpl = vi.fn();
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => 1708272000000,
    });

    await expect(provider.initiateAuthorization()).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });
    await expect(provider.refreshAccessToken("refresh-token")).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
