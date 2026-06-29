import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayAnthropicOAuthProvider,
  parseFridayAnthropicAuthorizationCode,
  generateFridayPkce,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
} from "#providers";

describe("parseFridayAnthropicAuthorizationCode", () => {
  it("parses code#state format", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc123#stateXYZ");
    expect(result.code).toBe("abc123");
    expect(result.state).toBe("stateXYZ");
  });

  it("handles code with no state", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc123");
    expect(result.code).toBe("abc123");
    expect(result.state).toBe("");
  });

  it("handles multiple # characters", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc#state#extra");
    expect(result.code).toBe("abc");
    expect(result.state).toBe("state#extra");
  });
});

describe("generateFridayPkce", () => {
  it("generates verifier and challenge as non-empty distinct strings", async () => {
    const pair = await generateFridayPkce();
    expect(pair.verifier).toBeTruthy();
    expect(pair.challenge).toBeTruthy();
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  it("generates unique pairs", async () => {
    const pair1 = await generateFridayPkce();
    const pair2 = await generateFridayPkce();
    expect(pair1.verifier).not.toBe(pair2.verifier);
  });
});

describe("FridayAnthropicOAuthProvider", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  function createProvider() {
    return createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => 1708272000000,
    });
  }

  it("advertises Anthropic OAuth as disabled and API-key only", () => {
    const provider = createProvider();
    expect(provider.id).toBe("anthropic");
    expect(provider.displayName).toContain("API key required");
    expect(FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE).toBe("ANTHROPIC_OAUTH_DISABLED");
    expect(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE).toContain("API key");
  });

  it("fails closed before starting authorization", async () => {
    await expect(createProvider().initiateAuthorization()).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed before exchanging authorization codes", async () => {
    await expect(
      createProvider().exchangeAuthorizationCode({
        authorizationCode: "code#state",
        state: "state",
        codeVerifier: "verifier",
      }),
    ).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails closed before refreshing access tokens", async () => {
    await expect(createProvider().refreshAccessToken("refresh-token")).rejects.toMatchObject({
      code: FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
      httpStatus: 400,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
