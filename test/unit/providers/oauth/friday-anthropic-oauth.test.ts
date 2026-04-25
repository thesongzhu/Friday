import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayAnthropicOAuthProvider,
  parseFridayAnthropicAuthorizationCode,
  generateFridayPkce,
  FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
  FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL,
  FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL,
  FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI,
  FRIDAY_ANTHROPIC_OAUTH_SCOPES,
} from "#providers";

describe("parseFridayAnthropicAuthorizationCode", () => {
  it("parses code#state format", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc123#stateXYZ");
    expect(result.code).toBe("abc123");
    expect(result.state).toBe("stateXYZ");
  });

  it("handles code with no state (no #)", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc123");
    expect(result.code).toBe("abc123");
    expect(result.state).toBe("");
  });

  it("handles code with empty state after #", () => {
    const result = parseFridayAnthropicAuthorizationCode("abc123#");
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
  it("generates verifier and challenge as non-empty strings", async () => {
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
  const NOW_MS = 1708272000000; // 2024-02-18T16:00:00.000Z
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  function createProvider() {
    return createFridayAnthropicOAuthProvider({
      fetchImpl: mockFetch as typeof fetch,
      nowMs: () => NOW_MS,
    });
  }

  describe("constants", () => {
    it("exposes expected OAuth constants", () => {
      expect(FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL).toBe("https://claude.ai/oauth/authorize");
      expect(FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL).toBe("https://console.anthropic.com/v1/oauth/token");
      expect(FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI).toBe("https://console.anthropic.com/oauth/code/callback");
      expect(FRIDAY_ANTHROPIC_OAUTH_SCOPES).toBe("org:create_api_key user:profile user:inference");
    });
  });

  describe("initiateAuthorization", () => {
    it("returns authorization URL with PKCE parameters", async () => {
      const provider = createProvider();
      const request = await provider.initiateAuthorization();

      expect(request.authorizationUrl).toContain(FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL);
      expect(request.authorizationUrl).toContain("client_id=" + FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID);
      expect(request.authorizationUrl).toContain("response_type=code");
      expect(request.authorizationUrl).toContain("code_challenge_method=S256");
      expect(request.state).toBeTruthy();
      expect(request.codeVerifier).toBeTruthy();
      expect(request.scopes).toEqual(["org:create_api_key", "user:profile", "user:inference"]);
    });

    it("uses state different from verifier (SEC-006: separate values)", async () => {
      const provider = createProvider();
      const request = await provider.initiateAuthorization();
      expect(request.state).not.toBe(request.codeVerifier);
      expect(request.state).toBeTruthy();
      expect(request.codeVerifier).toBeTruthy();
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("exchanges code for tokens", async () => {
      const provider = createProvider();

      // First initiate to register the verifier
      const initResult = await provider.initiateAuthorization();

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "at-123",
            refresh_token: "rt-456",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "org:create_api_key user:profile user:inference",
          }),
          { status: 200 },
        ),
      );

      const tokenSet = await provider.exchangeAuthorizationCode({
        authorizationCode: `mycode#${initResult.state}`,
      });

      expect(tokenSet.accessToken).toBe("at-123");
      expect(tokenSet.refreshToken).toBe("rt-456");
      expect(tokenSet.tokenType).toBe("Bearer");
      expect(tokenSet.scope).toBe("org:create_api_key user:profile user:inference");
      expect(tokenSet.expiresAt).toBeTruthy();

      // Verify fetch was called with correct params
      expect(mockFetch).toHaveBeenCalledWith(
        FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
      expect(callBody.grant_type).toBe("authorization_code");
      expect(callBody.client_id).toBe(FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID);
      expect(callBody.code).toBe("mycode");
      expect(callBody.state).toBe(initResult.state);
      expect(callBody.code_verifier).toBe(initResult.codeVerifier);
    });

    it("throws on non-ok response", async () => {
      const provider = createProvider();

      // Must initiate first to register state
      const initResult = await provider.initiateAuthorization();

      mockFetch.mockResolvedValueOnce(
        new Response("invalid_grant", { status: 400 }),
      );

      await expect(
        provider.exchangeAuthorizationCode({
          authorizationCode: `bad#${initResult.state}`,
        }),
      ).rejects.toThrow("Token exchange failed (HTTP 400)");
    });

    it("rejects exchange with unknown state even when codeVerifier provided (SEC-006)", async () => {
      const provider = createProvider();

      // Do NOT initiate — state is unknown
      await expect(
        provider.exchangeAuthorizationCode({
          authorizationCode: "code#unknown-state",
          codeVerifier: "attacker-provided-verifier",
        }),
      ).rejects.toThrow("No PKCE verifier found for the provided state");
    });

    it("calculates expiresAt with 5-minute buffer", async () => {
      const provider = createProvider();

      // Must initiate first to register state
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

      const tokenSet = await provider.exchangeAuthorizationCode({
        authorizationCode: `code#${initResult.state}`,
      });

      // Expected: NOW_MS + 3600*1000 - 5*60*1000
      const expectedMs = NOW_MS + 3600 * 1000 - 5 * 60 * 1000;
      expect(tokenSet.expiresAt).toBe(new Date(expectedMs).toISOString());
    });
  });

  describe("refreshAccessToken", () => {
    it("refreshes token successfully", async () => {
      const provider = createProvider();

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-at",
            refresh_token: "new-rt",
            expires_in: 7200,
            token_type: "Bearer",
            scope: "org:create_api_key user:profile user:inference",
          }),
          { status: 200 },
        ),
      );

      const tokenSet = await provider.refreshAccessToken("old-refresh-token");

      expect(tokenSet.accessToken).toBe("new-at");
      expect(tokenSet.refreshToken).toBe("new-rt");

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
      expect(callBody.grant_type).toBe("refresh_token");
      expect(callBody.client_id).toBe(FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID);
      expect(callBody.refresh_token).toBe("old-refresh-token");
    });

    it("throws on refresh failure", async () => {
      const provider = createProvider();

      mockFetch.mockResolvedValueOnce(
        new Response("token_expired", { status: 400 }),
      );

      await expect(
        provider.refreshAccessToken("expired-token"),
      ).rejects.toThrow("Token refresh failed (HTTP 400)");
    });
  });

  describe("PKCE state/verifier separation (SEC-006)", () => {
    it("state and codeVerifier are distinct values", async () => {
      const provider = createProvider();
      const request = await provider.initiateAuthorization();
      expect(request.state).not.toBe(request.codeVerifier);
      expect(request.state.length).toBeGreaterThan(0);
      expect(request.codeVerifier!.length).toBeGreaterThan(0);
    });

    it("rejects exchange with unknown state (no stored verifier)", async () => {
      const provider = createProvider();

      await expect(
        provider.exchangeAuthorizationCode({
          authorizationCode: "code#unknown-state",
        }),
      ).rejects.toThrow("No PKCE verifier found for the provided state");
    });

    it("sends correct (different) verifier in token request body", async () => {
      const provider = createProvider();
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

      await provider.exchangeAuthorizationCode({
        authorizationCode: `mycode#${initResult.state}`,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string) as Record<string, unknown>;
      expect(callBody.state).toBe(initResult.state);
      expect(callBody.code_verifier).toBe(initResult.codeVerifier);
      expect(callBody.state).not.toBe(callBody.code_verifier);
    });

    it("cleans up expired pending verifiers on initiation (SEC-006 TTL)", async () => {
      let currentTime = NOW_MS;
      const provider = createFridayAnthropicOAuthProvider({
        fetchImpl: mockFetch as typeof fetch,
        nowMs: () => currentTime,
      });

      // Initiate first authorization
      const first = await provider.initiateAuthorization();

      // Advance time by 11 minutes (past 10-minute TTL)
      currentTime = NOW_MS + 11 * 60 * 1000;

      // Initiate second — should clean up the first
      await provider.initiateAuthorization();

      // First state should now be expired/cleaned up
      await expect(
        provider.exchangeAuthorizationCode({
          authorizationCode: `code#${first.state}`,
        }),
      ).rejects.toThrow("No PKCE verifier found for the provided state");
    });

    it("rejects stale verifiers on exchange even without new initiation (SEC-006 TTL)", async () => {
      let currentTime = NOW_MS;
      const provider = createFridayAnthropicOAuthProvider({
        fetchImpl: mockFetch as typeof fetch,
        nowMs: () => currentTime,
      });

      const auth = await provider.initiateAuthorization();

      // Advance time past 10-minute TTL
      currentTime = NOW_MS + 11 * 60 * 1000;

      // Exchange should reject — state exists but is expired
      await expect(
        provider.exchangeAuthorizationCode({
          authorizationCode: `code#${auth.state}`,
        }),
      ).rejects.toThrow("PKCE authorization state has expired");
    });
  });

  describe("adapter identity", () => {
    it("has correct id and displayName", () => {
      const provider = createProvider();
      expect(provider.id).toBe("anthropic");
      expect(provider.displayName).toBe("Anthropic (Claude Pro/Max)");
    });
  });
});
