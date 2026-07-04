import { describe, it, expect, vi, afterEach } from "vitest";
import { createFridayProviderFallback } from "#providers";
import type {
  FridayModelRoutingConfig,
  FridayProviderProfile,
} from "#providers";

describe("FridayProviderFallback", () => {
  function makeProvider(
    id: string,
    kind: FridayProviderProfile["kind"] = "openai",
    enabled = true,
    defaultModel = "gpt-4o",
    supportedModels = ["gpt-4o", "gpt-4o-mini"],
  ): FridayProviderProfile {
    return {
      id,
      kind,
      name: `Provider ${id}`,
      baseUrl: `https://${id}.example.com`,
      enabled,
      defaultModel,
      config: {
        api: "openai-completions",
        authMode: "api-key",
        keySource: { kind: "none" },
        supportedModels,
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  describe("resolveCandidates", () => {
    it("returns default provider first, then fallbacks", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1"),
        makeProvider("p2", "anthropic"),
        makeProvider("p3", "google"),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["p2", "p3"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates).toHaveLength(3);
      expect(candidates[0].provider.id).toBe("p1");
      expect(candidates[1].provider.id).toBe("p2");
      expect(candidates[2].provider.id).toBe("p3");
    });

    it("deduplicates providers", () => {
      const fb = createFridayProviderFallback();
      const providers = [makeProvider("p1"), makeProvider("p2")];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["p1", "p2", "p1"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates).toHaveLength(2);
      expect(candidates[0].provider.id).toBe("p1");
      expect(candidates[1].provider.id).toBe("p2");
    });

    it("excludes disabled providers", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1"),
        makeProvider("p2", "anthropic", false), // disabled
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["p2"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].provider.id).toBe("p1");
    });

    it("skips unknown provider ids", () => {
      const fb = createFridayProviderFallback();
      const providers = [makeProvider("p1")];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["non-existent"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates).toHaveLength(1);
    });

    it("uses exact requestedModel match when supported", () => {
      const fb = createFridayProviderFallback();
      const providers = [makeProvider("p1")];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        defaultModel: "gpt-4o",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "gpt-4o-mini",
      });

      expect(candidates[0].model).toBe("gpt-4o-mini");
    });

    it("matches requestedModel aliases when provider support adds a numeric suffix", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider(
          "p1",
          "anthropic",
          true,
          "claude-opus-4-20250514",
          ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
        ),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "Claude_Opus_4",
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].model).toBe("claude-opus-4-20250514");
    });

    it("skips unsupported default provider and promotes matching fallback", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1", "openai", true, "gpt-4o", ["gpt-4o"]),
        makeProvider(
          "p2",
          "anthropic",
          true,
          "claude-opus-4-20250514",
          ["claude-opus-4-20250514"],
        ),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["p2"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "claude-opus-4",
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].provider.id).toBe("p2");
      expect(candidates[0].model).toBe("claude-opus-4-20250514");
    });

    it("returns no candidates when requestedModel is unsupported everywhere", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1", "openai", true, "gpt-4o", ["gpt-4o"]),
        makeProvider("p2", "anthropic", true, "claude-sonnet-4-20250514", ["claude-sonnet-4-20250514"]),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: ["p2"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "claude-opus-4-6",
      });

      expect(candidates).toEqual([]);
    });

    it("does not downgrade a specific requested model to a broader sibling", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1", "openai", true, "gpt-4o", ["gpt-4o"]),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "gpt-4o-mini",
      });

      expect(candidates).toEqual([]);
    });

    it("keeps supportedModels order stable when multiple numeric-suffix alias matches exist", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider(
          "p1",
          "anthropic",
          true,
          "claude-opus-4-20250528",
          ["claude-opus-4-20250528", "claude-opus-4-20250514"],
        ),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "claude-opus-4",
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].model).toBe("claude-opus-4-20250528");
    });

    it("treats blank requestedModel as no requested model", () => {
      const fb = createFridayProviderFallback();
      const providers = [makeProvider("p1", "openai", true, "model-b", ["model-a", "model-b"])];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        defaultModel: "routing-default",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
        requestedModel: "   ",
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].model).toBe("model-b");
    });

    it("uses routing.defaultModel when the current provider supports it", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider("p1", "openai", true, "gpt-4o", ["gpt-4o", "gpt-4-turbo"]),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        defaultModel: "gpt-4-turbo",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates[0].model).toBe("gpt-4-turbo");
    });

    it("falls back to each provider's own supported default when routing.defaultModel is provider-specific", () => {
      const fb = createFridayProviderFallback();
      const providers = [
        makeProvider(
          "anthropic-default",
          "anthropic",
          true,
          "claude-opus-4-20250514",
          ["claude-opus-4-20250514"],
        ),
        makeProvider(
          "openai-fallback",
          "openai",
          true,
          "gpt-4.1-mini",
          ["gpt-4.1-mini", "gpt-4o-mini"],
        ),
      ];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "anthropic-default",
        defaultModel: "claude-opus-4-20250514",
        fallbackProviderIds: ["openai-fallback"],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toMatchObject({
        provider: expect.objectContaining({ id: "anthropic-default" }),
        model: "claude-opus-4-20250514",
      });
      expect(candidates[1]).toMatchObject({
        provider: expect.objectContaining({ id: "openai-fallback" }),
        model: "gpt-4.1-mini",
      });
    });

    it("falls back to provider.defaultModel when no routing model", () => {
      const fb = createFridayProviderFallback();
      const providers = [makeProvider("p1", "openai", true, "provider-default", ["provider-default", "model-b"])];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates[0].model).toBe("provider-default");
    });

    it("falls back to first supported model as last resort", () => {
      const fb = createFridayProviderFallback();
      const provider: FridayProviderProfile = {
        id: "p1",
        kind: "openai",
        name: "Provider p1",
        baseUrl: "https://p1.example.com",
        enabled: true,
        defaultModel: undefined,
        config: {
          api: "openai-completions",
          authMode: "api-key",
          keySource: { kind: "none" },
          supportedModels: ["model-a", "model-b"],
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const providers = [provider];
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "p1",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers,
      });

      expect(candidates[0].model).toBe("model-a");
    });

    it("returns empty array when no enabled providers match", () => {
      const fb = createFridayProviderFallback();
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "non-existent",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({
        routing,
        providers: [],
      });

      expect(candidates).toHaveLength(0);
    });
  });

  describe("runWithFallback", () => {
    it("returns result from first successful candidate", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      const result = await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => `result-from-${route.provider.id}`,
      });

      expect(result.result).toBe("result-from-p1");
      expect(result.route.provider.id).toBe("p1");
      expect(result.attempts).toHaveLength(0);
    });

    it("falls back to next candidate on failure", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      const result = await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("rate limited");
          return "success";
        },
      });

      expect(result.result).toBe("success");
      expect(result.route.provider.id).toBe("p2");
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].providerId).toBe("p1");
      expect(result.attempts[0].error).toBe("rate limited");
    });

    it("throws when all candidates fail", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await expect(
        fb.runWithFallback({
          candidates: [
            { provider: p1, model: "gpt-4o" },
            { provider: p2, model: "gpt-4o" },
          ],
          run: async () => {
            throw new Error("fail");
          },
        }),
      ).rejects.toThrow("All providers failed (2)");
    });

    it("throws when no candidates available", async () => {
      const fb = createFridayProviderFallback();

      await expect(
        fb.runWithFallback({
          candidates: [],
          run: async () => "unreachable",
        }),
      ).rejects.toThrow("no candidates available");
    });

    it("uses only explicit DeepSeek routing and never invokes an OpenAI provider", async () => {
      // Unconditional proof (no live/skip gate) for locked decision #1: explicit
      // DeepSeek routing with no fallback resolves to DeepSeek alone — an
      // also-registered OpenAI provider must NOT be auto-injected or invoked.
      const fb = createFridayProviderFallback();
      const deepseek = makeProvider("ds", "deepseek", true, "deepseek-v4-pro", ["deepseek-v4-pro"]);
      const openai = makeProvider("oai", "openai", true, "gpt-4o-mini", ["gpt-4o-mini"]);
      const routing: FridayModelRoutingConfig = {
        defaultProviderId: "ds",
        fallbackProviderIds: [],
      };

      const candidates = fb.resolveCandidates({ routing, providers: [openai, deepseek] });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].provider.kind).toBe("deepseek");
      expect(candidates.some((c) => c.provider.kind === "openai")).toBe(false);

      const invokedKinds: string[] = [];
      const result = await fb.runWithFallback({
        candidates,
        run: async (route) => {
          invokedKinds.push(route.provider.kind);
          return `ok-${route.provider.kind}`;
        },
      });

      expect(result.result).toBe("ok-deepseek");
      expect(invokedKinds).toEqual(["deepseek"]);
      expect(invokedKinds).not.toContain("openai");
    });

    it("retries the same DeepSeek provider once on retry-after rate limit before giving up", async () => {
      const fb = createFridayProviderFallback();
      const deepseek = makeProvider("ds", "deepseek", true, "deepseek-v4-flash", ["deepseek-v4-flash"]);
      let calls = 0;

      const result = await fb.runWithFallback({
        candidates: [{ provider: deepseek, model: "deepseek-v4-flash" }],
        run: async () => {
          calls += 1;
          if (calls === 1) {
            const err: any = new Error("rate limited");
            err.status = 429;
            err.retryAfterMs = 250;
            throw err;
          }
          return "ok-after-retry";
        },
      });

      expect(result.result).toBe("ok-after-retry");
      expect(result.route.provider.id).toBe("ds");
      expect(calls).toBe(2);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        providerId: "ds",
        providerKind: "deepseek",
        model: "deepseek-v4-flash",
        reason: "transient",
        status: 429,
      });
    });

    it("retries the same provider once with backoff when transient errors omit retry-after", async () => {
      const sleptMs: number[] = [];
      const fb = createFridayProviderFallback({
        sameProviderRetryBaseDelayMs: 125,
        sameProviderRetryMaxDelayMs: 1_000,
        sleepMs: async (ms) => {
          sleptMs.push(ms);
        },
      });
      const deepseek = makeProvider("ds", "deepseek", true, "deepseek-v4-flash", ["deepseek-v4-flash"]);
      let calls = 0;

      const result = await fb.runWithFallback({
        candidates: [{ provider: deepseek, model: "deepseek-v4-flash" }],
        run: async () => {
          calls += 1;
          if (calls === 1) {
            const err: any = new Error("socket hang up while contacting provider");
            err.code = "ECONNRESET";
            throw err;
          }
          return "ok-after-backoff";
        },
      });

      expect(result.result).toBe("ok-after-backoff");
      expect(result.route.provider.id).toBe("ds");
      expect(calls).toBe(2);
      expect(sleptMs).toEqual([125]);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        providerId: "ds",
        providerKind: "deepseek",
        model: "deepseek-v4-flash",
        reason: "transient",
        code: "ECONNRESET",
      });
    });

    it("records all failed attempts in order", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1", "openai");
      const p2 = makeProvider("p2", "anthropic");
      const p3 = makeProvider("p3", "google");

      try {
        await fb.runWithFallback({
          candidates: [
            { provider: p1, model: "m1" },
            { provider: p2, model: "m2" },
            { provider: p3, model: "m3" },
          ],
          run: async (route) => {
            throw new Error(`fail-${route.provider.id}`);
          },
        });
      } catch (err) {
        // Check the error message contains attempt info
        expect((err as Error).message).toContain("3");
      }
    });
  });

  // ─── A1: Error Classification ───

  describe("error classification", () => {
    const transientPatterns = [
      "429",
      "rate_limit",
      "quota",
      "capacity",
      "throttl",
      "timeout",
      "timed out",
      "ETIMEDOUT",
      "ECONNRESET",
      "socket hang up",
    ];

    describe.each(transientPatterns)(
      "transient pattern '%s' triggers cooldown",
      (pattern) => {
        it(`sets cooldown for "${pattern}"`, async () => {
          const fb = createFridayProviderFallback();
          const p1 = makeProvider("p1");
          const p2 = makeProvider("p2");

          await fb.runWithFallback({
            candidates: [
              { provider: p1, model: "gpt-4o" },
              { provider: p2, model: "gpt-4o" },
            ],
            run: async (route) => {
              if (route.provider.id === "p1") throw new Error(`Error: ${pattern} encountered`);
              return "ok";
            },
          });

          expect(fb.isInCooldown("p1")).toBe(true);
        });
      },
    );

    it("auth errors set cooldown", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("401 invalid_api_key");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("keeps cooldown state scoped to the current fallback instance", async () => {
      let now = Date.parse("2026-02-24T12:00:00.000Z");
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");
      const fb = createFridayProviderFallback({
        nowMs: () => now,
        cooldownMs: 120_000,
      });

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("429 rate_limit");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);

      now += 1;
      const restartedFallback = createFridayProviderFallback({
        nowMs: () => now,
        cooldownMs: 120_000,
      });

      expect(restartedFallback.isInCooldown("p1")).toBe(false);
    });

    it("unknown permanent errors do not set cooldown", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("validation failed");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(false);
    });

    it("structured non-Error transient — object with status 429 triggers cooldown", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            // Throw a plain object, not an Error instance
            throw { status: 429, message: "rate limited" };
          }
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("structured non-Error with status + code triggers cooldown", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            throw { status: 429, code: "ETIMEDOUT", message: "rate limited" };
          }
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("structured non-Error with only code — no message", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            throw { code: "ECONNRESET" };
          }
          return "ok";
        },
      });

      // ECONNRESET matches the "econnreset" transient error pattern
      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("Error instance with .code and .status triggers cooldown via extractErrorText", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            const err: any = new Error("connection failed");
            err.code = "ECONNRESET";
            err.status = 503;
            throw err;
          }
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("redacts key material in attempt error logs", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      const result = await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            throw new Error("429 sk-test-abc123456789012345678901234567890123456789");
          }
          return "ok";
        },
      });

      expect(result.attempts).toHaveLength(2);
      for (const attempt of result.attempts) {
        expect(attempt.error).toContain("[REDACTED]");
        expect(attempt.error).not.toContain("sk-test-abc");
      }
    });

    it("redacts Google AIza API keys and ya29 OAuth tokens in attempt error logs", async () => {
      // Google keys are 39 chars and contain `-`/`_`, so they match neither the prefix list
      // nor the generic 40+ `[A-Za-z0-9/+]` token — they previously leaked verbatim (HOLE).
      // Intentionally-fake test fixtures (not real credentials). pragma: allowlist secret
      const googleKey = "AIzaSyD-9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123"; // pragma: allowlist secret
      const oauthToken = "ya29.a0AfB_byD-abcDEF_ghiJKL1234567890mnopQRSTuvwx"; // pragma: allowlist secret
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      const result = await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") {
            throw new Error(`401 invalid key ${googleKey} token=${oauthToken}`);
          }
          return "ok";
        },
      });

      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].error).toContain("[REDACTED]");
      expect(result.attempts[0].error).not.toContain(googleKey);
      expect(result.attempts[0].error).not.toContain("AIzaSyD-9aBc");
      expect(result.attempts[0].error).not.toContain(oauthToken);
      expect(result.attempts[0].error).not.toContain("ya29.a0AfB");
    });
  });

  // ─── A2: Cooldown Behavior ───

  describe("cooldown behavior", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("cooldown is set immediately after transient failure", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      expect(fb.isInCooldown("p1")).toBe(false);

      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("timeout exceeded");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);
    });

    it("cooled provider is deprioritized on next run", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");
      const callOrder: string[] = [];

      // First run: p1 fails with transient error, p2 succeeds
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("429 rate limit");
          return "ok";
        },
      });

      // Second run: record which order candidates are tried
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          callOrder.push(route.provider.id);
          return "ok";
        },
      });

      // p2 should be tried first (p1 is cooled down)
      expect(callOrder[0]).toBe("p2");
    });

    it("cooled provider is still used as last resort", async () => {
      const fb = createFridayProviderFallback();
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");
      const callOrder: string[] = [];

      // First run: p1 fails with transient error
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("ECONNRESET");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);

      // Second run: p2 also fails, so p1 (cooled) should be the last resort
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          callOrder.push(route.provider.id);
          if (route.provider.id === "p2") throw new Error("also broken");
          return "recovered";
        },
      });

      // p2 tried first (non-cooled), then p1 as last resort
      expect(callOrder).toEqual(["p2", "p1"]);
    });

    it("cooldown expires after the configured duration", async () => {
      let clock = 1_000_000;
      const fb = createFridayProviderFallback({
        nowMs: () => clock,
        cooldownMs: 120_000,
      });
      const p1 = makeProvider("p1");
      const p2 = makeProvider("p2");

      // First run: p1 fails with transient error at t=1_000_000
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          if (route.provider.id === "p1") throw new Error("429 throttled");
          return "ok";
        },
      });

      expect(fb.isInCooldown("p1")).toBe(true);

      // Advance clock by 121 seconds (past 120s cooldown)
      clock += 121_000;

      expect(fb.isInCooldown("p1")).toBe(false);

      // Verify p1 is tried first again (no longer deprioritized)
      const callOrder: string[] = [];
      await fb.runWithFallback({
        candidates: [
          { provider: p1, model: "gpt-4o" },
          { provider: p2, model: "gpt-4o" },
        ],
        run: async (route) => {
          callOrder.push(route.provider.id);
          return "ok";
        },
      });

      expect(callOrder[0]).toBe("p1");
    });
  });
});
