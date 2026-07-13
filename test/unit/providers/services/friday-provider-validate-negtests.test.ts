import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayProviderService, resetMasterKeyCache } from "#providers";
import type { FridayProviderService } from "#providers";
import {
  createTestDb,
  createTestIdGenerator,
} from "../../satellites/_helpers/create-test-db.helper.js";

/**
 * BYOK credential-entry validation NEGATIVE tests.
 *
 * These drive the REAL create/validate decision path of the live provider
 * service (createProvider validate-before-persist + validateProvider re-check +
 * runWithFallback task gate) with a MOCKED provider fetch. No real provider is
 * ever contacted and no real API key is used — every key here is synthetic.
 *
 * Each test is written so that a naive/wrong implementation (persist-before-
 * validate, accept-on-timeout, or a revoked key that still completes a task)
 * would FAIL it.
 */
describe("BYOK provider validation negatives (mocked provider, live seam)", () => {
  let db: FridaySqliteLayer;
  let service: FridayProviderService;
  let originalMasterKey: string | undefined;
  const NOW = "2026-02-17T10:00:00.000Z";
  const originalFetch = globalThis.fetch;
  const TEST_MASTER_KEY = Buffer.alloc(32, 13).toString("hex");

  // Synthetic (non-real) API key material — never a real credential.
  const SYNTHETIC_KEY = "synthetic-byok-not-a-real-key"; // pragma: allowlist secret

  function fetchAlways(status: number): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status }),
    ) as unknown as typeof fetch;
  }

  function fetchNetworkError(): typeof fetch {
    return vi.fn(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.example.invalid");
    }) as unknown as typeof fetch;
  }

  function makeApiKeyProviderInput(overrides?: { validateOnSave?: boolean }) {
    return {
      kind: "openai" as const,
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      authMode: "api-key" as const,
      api: "openai-completions" as const,
      apiKey: SYNTHETIC_KEY, // pragma: allowlist secret
      supportedModels: ["gpt-4o"],
      defaultModel: "gpt-4o",
      validateOnSave: overrides?.validateOnSave ?? true,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    originalMasterKey = process.env.FRIDAY_MASTER_KEY;
    process.env.FRIDAY_MASTER_KEY = TEST_MASTER_KEY;
    resetMasterKeyCache();
    service = createFridayProviderService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
    globalThis.fetch = fetchAlways(200);
  });

  afterEach(() => {
    db.close();
    if (originalMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = originalMasterKey;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    resetMasterKeyCache();
  });

  it("invalid-key (integration): validate-before-persist rejects and never persists", async () => {
    // A 401 from the provider means the entered key is invalid.
    globalThis.fetch = fetchAlways(401);

    await expect(service.createProvider(makeApiKeyProviderInput())).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
      httpStatus: 422,
    });

    // Truthful state: nothing persisted — the invalid key did not slip into storage.
    await expect(service.listProviders()).resolves.toHaveLength(0);
  });

  it("offline (integration): unreachable provider fails closed and never persists", async () => {
    // A network-level failure (DNS/connection) must not be accepted as valid.
    globalThis.fetch = fetchNetworkError();

    await expect(service.createProvider(makeApiKeyProviderInput())).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE",
      httpStatus: 422,
    });

    await expect(service.listProviders()).resolves.toHaveLength(0);
  });

  it("timeout: a hanging provider endpoint fails closed (no accept-on-timeout) and never persists", async () => {
    vi.useFakeTimers();
    try {
      // A provider endpoint that never responds. It only settles when the
      // validator's own AbortController fires (5s timeout). We must NOT accept
      // the provider just because the call did not return a hard error.
      globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => {
            reject(
              Object.assign(new Error("The operation was aborted."), {
                name: "AbortError",
              }),
            );
          };
          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }
          // otherwise: hang forever (until aborted)
        }),
      ) as unknown as typeof fetch;

      const settled = service
        .createProvider(makeApiKeyProviderInput())
        .then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        );

      // Drive the real 5s validation timeout.
      await vi.advanceTimersByTimeAsync(5_100);
      const outcome = await settled;

      // Fail-closed: the timeout must NOT be treated as a successful validation.
      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({
        ok: false,
        err: { code: "PROVIDER_UNREACHABLE" },
      });

      // And nothing was persisted on timeout.
      await expect(service.listProviders()).resolves.toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revoked: a previously-valid key that now returns 401/403 is surfaced as revoked and blocks provider tasks", async () => {
    // 1) Save + validate a provider while the key still works (200 → ok).
    globalThis.fetch = fetchAlways(200);
    const created = await service.createProvider(makeApiKeyProviderInput());
    expect(created.config.validation?.status).toBe("ok"); // was genuinely valid
    // Persisted as a secret-ref (not raw / not env) after passing validation.
    expect(created.config.keySource.kind).toBe("secret-ref");

    // Control: a provider that was never validated has status "never" — this is
    // the state that "revoked" must remain DISTINCT from.
    const neverValid = await service.createProvider({
      kind: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      authMode: "api-key",
      api: "anthropic-messages",
      apiKey: SYNTHETIC_KEY, // pragma: allowlist secret
      supportedModels: ["claude-sonnet-4-6"],
      defaultModel: "claude-sonnet-4-6",
      enabled: false, // keep out of the routing task-gate below
      validateOnSave: false,
    });
    expect(neverValid.config.validation?.status).toBe("never");

    // 2) The upstream key is revoked → provider now answers 403.
    globalThis.fetch = fetchAlways(403);
    const revalidated = await service.validateProvider(created.id);
    expect(revalidated.status).toBe("failed");
    expect(revalidated.errorCode).toBe("PROVIDER_AUTH_INVALID"); // revoked (auth), not "unreachable"

    // The persisted validation flipped ok → failed (i.e. genuinely revoked,
    // distinct from a never-valid provider which starts at "never").
    const after = await service.getProvider(created.id);
    expect(after?.config.validation?.status).toBe("failed");

    // 3) A revoked provider must NOT complete a provider task.
    await service.setRoutingConfig({
      defaultProviderId: created.id,
      fallbackProviderIds: [],
    });
    const run = vi.fn(async () => "should-not-run");
    await expect(service.runWithFallback({ run })).rejects.toMatchObject({
      code: "PROVIDER_NO_CANDIDATES",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("replay: replaying a create that fails validation never bypasses validate-before-persist (no double-persist)", async () => {
    globalThis.fetch = fetchAlways(401);
    const input = makeApiKeyProviderInput();

    // First attempt is rejected by validate-before-persist.
    await expect(service.createProvider({ ...input })).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
    });
    // Replaying the exact same request must be handled the same way — it must
    // not slip past validation on the second try, and must not double-persist.
    await expect(service.createProvider({ ...input })).rejects.toMatchObject({
      code: "PROVIDER_AUTH_INVALID",
    });

    await expect(service.listProviders()).resolves.toHaveLength(0);
  });
});
