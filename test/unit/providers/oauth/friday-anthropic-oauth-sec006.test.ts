import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayAnthropicOAuthProvider,
} from "#providers";

describe("FridayAnthropicOAuthProvider — SEC-006: PKCE strict state + TTL", () => {
  const NOW_MS = 1708272000000;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it("rejects exchange when state is unknown — even with caller-provided codeVerifier", async () => {
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => NOW_MS,
    });

    // Do NOT initiate — go directly to exchange with an attacker-provided verifier
    await expect(
      provider.exchangeAuthorizationCode({
        authorizationCode: "stolen-code#fake-state",
        state: "fake-state",
        codeVerifier: "attacker-verifier",
      }),
    ).rejects.toThrow("No PKCE verifier found for the provided state");

    // Fetch should NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses stored verifier (not caller-provided) for exchange", async () => {
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => NOW_MS,
    });

    const initResult = await provider.initiateAuthorization();

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    // Pass a DIFFERENT codeVerifier — should be ignored in favor of stored one
    await provider.exchangeAuthorizationCode({
      authorizationCode: `code#${initResult.state}`,
      codeVerifier: "this-should-be-ignored",
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
    // Should use the stored verifier from initiation, not the caller-provided one
    expect(callBody.code_verifier).toBe(initResult.codeVerifier);
    expect(callBody.code_verifier).not.toBe("this-should-be-ignored");
  });

  it("cleans up expired pending verifiers (10-minute TTL)", async () => {
    let currentTime = NOW_MS;
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => currentTime,
    });

    // Initiate first authorization
    const first = await provider.initiateAuthorization();

    // Advance time by 11 minutes (past 10-minute TTL)
    currentTime = NOW_MS + 11 * 60 * 1000;

    // Initiate second — should trigger cleanup of expired entries
    const second = await provider.initiateAuthorization();

    // First state should be expired and cleaned up
    await expect(
      provider.exchangeAuthorizationCode({
        authorizationCode: `code#${first.state}`,
      }),
    ).rejects.toThrow("No PKCE verifier found for the provided state");

    // Second state should still work
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    const tokenSet = await provider.exchangeAuthorizationCode({
      authorizationCode: `code#${second.state}`,
    });
    expect(tokenSet.accessToken).toBe("at");
  });

  it("does not clean up non-expired verifiers", async () => {
    let currentTime = NOW_MS;
    const provider = createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => currentTime,
    });

    // Initiate first authorization
    const first = await provider.initiateAuthorization();

    // Advance time by 5 minutes (within 10-minute TTL)
    currentTime = NOW_MS + 5 * 60 * 1000;

    // Initiate second — should NOT clean up first
    await provider.initiateAuthorization();

    // First state should still be valid
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    const tokenSet = await provider.exchangeAuthorizationCode({
      authorizationCode: `code#${first.state}`,
    });
    expect(tokenSet.accessToken).toBe("at");
  });
});
