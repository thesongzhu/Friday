import { describe, it, expect, vi, afterEach } from "vitest";
import {
  _validateLlmResponse,
  _parseJsonFromText,
  createFridaySessionMemoryExtractionLlmClient,
} from "../../../../src/sessions/services/friday-session-memory-extraction-llm-client.js";
import type { FridayProviderService } from "#providers";
import type { FridayResolvedProviderRoute } from "#providers";
import { FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES } from "../../../../src/sessions/friday-session-memory-extraction.constants.js";

describe("FridaySessionMemoryExtractionLlmClient", () => {
  describe("parseJsonFromText", () => {
    it("parses raw JSON", () => {
      const result = _parseJsonFromText('{"items":[]}');
      expect(result).toEqual({ items: [] });
    });

    it("parses JSON in code fences", () => {
      const result = _parseJsonFromText('```json\n{"items":[]}\n```');
      expect(result).toEqual({ items: [] });
    });

    it("parses JSON embedded in text", () => {
      const result = _parseJsonFromText('Here is the result: {"items":[]} end');
      expect(result).toEqual({ items: [] });
    });

    it("throws on unparseable input", () => {
      expect(() => _parseJsonFromText("not json at all")).toThrow();
    });
  });

  describe("validateLlmResponse", () => {
    const validIds = new Set(["msg-1", "msg-2", "msg-3"]);

    it("validates a correct response", () => {
      const result = _validateLlmResponse(
        {
          items: [
            {
              kind: "fact",
              content: "User prefers dark mode",
              sourceMessageIds: ["msg-1"],
              tags: ["ui"],
            },
          ],
        },
        validIds,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].kind).toBe("fact");
      expect(result.items[0].content).toBe("User prefers dark mode");
      expect(result.items[0].sourceMessageIds).toEqual(["msg-1"]);
    });

    it("filters out invalid kinds", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "invalid", content: "test", sourceMessageIds: ["msg-1"] },
            { kind: "decision", content: "Use React", sourceMessageIds: ["msg-2"] },
          ],
        },
        validIds,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].kind).toBe("decision");
    });

    it("filters out items with empty content", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "", sourceMessageIds: ["msg-1"] },
            { kind: "fact", content: "Valid", sourceMessageIds: ["msg-2"] },
          ],
        },
        validIds,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("Valid");
    });

    it("filters out source message IDs not in valid set", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "Something", sourceMessageIds: ["msg-1", "unknown-id"] },
          ],
        },
        validIds,
      );

      expect(result.items[0].sourceMessageIds).toEqual(["msg-1"]);
    });

    it("drops items where all sourceMessageIds are invalid (empty after filtering)", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "Ghost item", sourceMessageIds: ["unknown-1", "unknown-2"] },
            { kind: "fact", content: "Valid item", sourceMessageIds: ["msg-1"] },
          ],
        },
        validIds,
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("Valid item");
    });

    it("drops items with empty sourceMessageIds array", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "No refs", sourceMessageIds: [] },
          ],
        },
        validIds,
      );

      expect(result.items).toHaveLength(0);
    });

    it("returns empty items for empty response", () => {
      const result = _validateLlmResponse({ items: [] }, validIds);
      expect(result.items).toHaveLength(0);
    });

    it("throws when response is not an object", () => {
      expect(() => _validateLlmResponse(null, validIds)).toThrow();
      expect(() => _validateLlmResponse("string", validIds)).toThrow();
    });

    it("throws when items is missing", () => {
      expect(() => _validateLlmResponse({}, validIds)).toThrow(/items/);
    });

    it("handles non-array tags gracefully", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "Test", sourceMessageIds: ["msg-1"], tags: "not-an-array" },
          ],
        },
        validIds,
      );

      expect(result.items[0].tags).toBeUndefined();
    });

    it("filters non-string tags", () => {
      const result = _validateLlmResponse(
        {
          items: [
            { kind: "fact", content: "Test", sourceMessageIds: ["msg-1"], tags: ["valid", 42, "ok"] },
          ],
        },
        validIds,
      );

      expect(result.items[0].tags).toEqual(["valid", "ok"]);
    });
  });

  // ─── B3 hanging-fetch boundary ───

  describe("B3 hanging-fetch: extractMemoryItems aborts on timeout", () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("aborts a hung extraction fetch via AbortSignal.timeout and surfaces PROVIDER_ERROR 504", async () => {
      const NOW = "2026-02-17T10:00:00.000Z";
      const route: FridayResolvedProviderRoute = {
        provider: {
          id: "prov-1",
          kind: "openai",
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          enabled: true,
          config: {
            api: "openai-chat-completions" as FridayResolvedProviderRoute["provider"]["config"]["api"],
            authMode: "api-key",
            keySource: { kind: "none" },
            supportedModels: ["gpt-4o-mini"],
            taskProfiles: {
              "memory-extraction": {
                model: "gpt-4o-mini",
                temperature: 0,
              },
            },
          },
          createdAt: NOW,
          updatedAt: NOW,
        } as unknown as FridayResolvedProviderRoute["provider"],
        model: "gpt-4o-mini",
      };

      // Mock fetch to hang until the AbortSignal fires.
      globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
            return;
          }
          signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            reject(err);
          });
        });
      }) as typeof fetch;

      const providerService: FridayProviderService = {
        runWithFallback: vi.fn().mockImplementation(async (params) => {
          const result = await params.run(route, "sk-test");
          return {
            result,
            route,
            attempts: [],
            routingDecision: {
              strategy: "direct",
              reason: "test",
              budget: { withinBudget: true, remainingUsd: 100, monthlyLimitUsd: 100, spentUsd: 0 },
            },
          };
        }),
      } as unknown as FridayProviderService;

      const client = createFridaySessionMemoryExtractionLlmClient({
        providerService,
        fetchTimeoutMs: 60,
      });

      const start = Date.now();
      await expect(
        client.extractMemoryItems(
          [
            { id: "msg-1", sessionId: "sess-1", role: "user", content: "Test", createdAt: NOW } as never,
          ],
          5,
          { tenantId: "tenant-1", userId: "user-1" } as never,
        ),
      ).rejects.toMatchObject({
        code: FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES.PROVIDER_ERROR,
        httpStatus: 504,
      });
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(5_000); // fail-fast proof
    });
  });
});
