import { describe, expect, it, vi } from "vitest";
import {
  createFridayOpenAICodexOAuthProvider,
  FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL,
  FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_REDIRECT_URI,
  FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_VERIFICATION_URL,
  FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL,
} from "#providers";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${encodedPayload}.sig`;
}

describe("Friday OpenAI Codex OAuth adapter", () => {
  it("initiates device authorization with the OpenAI Codex verification URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_auth_id: "dev-auth-1",
        user_code: "ABCD-EFGH",
        interval: 2,
      }),
    );
    const adapter = createFridayOpenAICodexOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const request = await adapter.initiateDeviceAuthorization!();

    expect(fetchImpl).toHaveBeenCalledWith(
      `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("app_EMoamEEZ73f0CkXaXp7hrann"),
      }),
    );
    expect(request.oauthProvider).toBe("openai-codex");
    expect(request.verificationUrl).toBe(FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_VERIFICATION_URL);
    expect(request.userCode).toBe("ABCD-EFGH");
    expect(request.intervalMs).toBe(2_000);
    expect(request.deviceCodeId).toHaveLength(36);
  });

  it("completes device authorization, exchanges the authorization code, and exposes account metadata", async () => {
    const accessToken = makeJwt({
      exp: Math.floor(1_700_000_900_000 / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
        chatgpt_account_user_id: "acct-user-456",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        device_auth_id: "dev-auth-1",
        user_code: "ABCD-EFGH",
        interval: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({
        authorization_code: "auth-code-1",
        code_verifier: "verifier-1",
      }))
      .mockResolvedValueOnce(jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-1",
        expires_in: 900,
        token_type: "Bearer",
        scope: "openid profile email",
      }));
    const adapter = createFridayOpenAICodexOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const request = await adapter.initiateDeviceAuthorization!();
    const tokenSet = await adapter.completeDeviceAuthorization!({ deviceCodeId: request.deviceCodeId });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          device_auth_id: "dev-auth-1",
          user_code: "ABCD-EFGH",
        }),
      }),
    );
    const exchangeBody = fetchImpl.mock.calls[2]?.[1]?.body as URLSearchParams;
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL);
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code")).toBe("auth-code-1");
    expect(exchangeBody.get("code_verifier")).toBe("verifier-1");
    expect(exchangeBody.get("redirect_uri")).toBe(FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_REDIRECT_URI);
    expect(tokenSet.accessToken).toBe(accessToken);
    expect(tokenSet.refreshToken).toBe("refresh-1");
    expect(tokenSet.metadata).toEqual({
      accountId: "acct-123",
      accountUserId: "acct-user-456",
      chatgptPlanType: "plus",
      email: "codex@example.test",
      profileName: "codex@example.test",
    });
  });

  it("refreshes Codex OAuth tokens with the refresh-token grant", async () => {
    const accessToken = makeJwt({ exp: Math.floor(1_700_001_800_000 / 1000) });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: accessToken,
        refresh_token: "refresh-2",
        expires_in: 1800,
      }),
    );
    const adapter = createFridayOpenAICodexOAuthProvider({
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const tokenSet = await adapter.refreshAccessToken("refresh-1");
    const refreshBody = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh-1");
    expect(tokenSet.accessToken).toBe(accessToken);
    expect(tokenSet.refreshToken).toBe("refresh-2");
  });
});
