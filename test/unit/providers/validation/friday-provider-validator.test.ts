import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createFridayProviderValidator,
  FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
} from "#providers";

describe("FridayProviderValidator", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    globalThis.fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init ?? {})),
    ) as typeof fetch;
  }

  describe("openai validation", () => {
    it("returns ok on 200", async () => {
      mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
        credential: "sk-test",
      });
      expect(result.status).toBe("ok");
      expect(result.checkedAt).toBeTruthy();
    });

    it("returns auth invalid on 401", async () => {
      mockFetch(() => new Response("", { status: 401 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
        credential: "sk-bad",
      });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_AUTH_INVALID");
      expect(result.httpStatus).toBe(401);
    });

    it("returns unreachable on network error", async () => {
      mockFetch(() => {
        throw new Error("ECONNREFUSED");
      });

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
        credential: "sk-test",
      });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_UNREACHABLE");
      expect(result.errorMessage).toContain("ECONNREFUSED");
    });

    it("sets Authorization header with Bearer prefix", async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch((_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers ?? {}),
        ) as Record<string, string>;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });

      const validator = createFridayProviderValidator();
      await validator.validate({
        kind: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com",
        credential: "sk-test",
      });
      expect(capturedHeaders["Authorization"]).toBe("Bearer sk-test");
    });
  });

  describe("anthropic validation", () => {
    it("returns ok on 200", async () => {
      mockFetch(() => new Response("{}", { status: 200 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-test",
      });
      expect(result.status).toBe("ok");
    });

    it("uses the configured Anthropic model during validation", async () => {
      let capturedBody = "";
      mockFetch((_url, init) => {
        capturedBody = typeof init.body === "string" ? init.body : "";
        return new Response("{}", { status: 200 });
      });

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-test",
        model: "claude-sonnet-4-6",
      });

      expect(result.status).toBe("ok");
      expect(JSON.parse(capturedBody)).toMatchObject({
        model: "claude-sonnet-4-6",
      });
    });

    it("returns ok on 429 (rate limited but auth valid)", async () => {
      mockFetch(() => new Response("{}", { status: 429 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-test",
      });
      expect(result.status).toBe("ok");
    });

    it("returns auth invalid on 401", async () => {
      mockFetch(() => new Response("{}", { status: 401 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-bad",
      });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_AUTH_INVALID");
    });

    it("sets x-api-key header", async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch((_url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init.headers ?? {}),
        ) as Record<string, string>;
        return new Response("{}", { status: 200 });
      });

      const validator = createFridayProviderValidator();
      await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-test",
      });
      expect(capturedHeaders["x-api-key"]).toBe("sk-ant-test");
    });

    it("fails closed for Anthropic OAuth mode without contacting Anthropic", async () => {
      const fetchSpy = vi.fn();
      mockFetch((_url, init) => {
        fetchSpy(_url, init);
        return new Response("{}", { status: 200 });
      });

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-oat01-test-token",
        authMode: "oauth",
      });

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_AUTH_INVALID");
      expect(result.httpStatus).toBe(400);
      expect(result.errorMessage).toBe(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("fails closed for Anthropic token mode without contacting Anthropic", async () => {
      const fetchSpy = vi.fn();
      mockFetch((_url, init) => {
        fetchSpy(_url, init);
        return new Response("{}", { status: 200 });
      });

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        credential: "sk-ant-token01-test-token",
        authMode: "token",
      });

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_AUTH_INVALID");
      expect(result.httpStatus).toBe(400);
      expect(result.errorMessage).toBe(FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("google validation", () => {
    it("returns ok on 200", async () => {
      mockFetch(() => new Response("{}", { status: 200 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        credential: "AIza-test",
      });
      expect(result.status).toBe("ok");
    });

    it("passes key as x-goog-api-key header (H-2: not in URL)", async () => {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      mockFetch((url, init) => {
        capturedUrl = url;
        capturedHeaders = (init.headers ?? {}) as Record<string, string>;
        return new Response("{}", { status: 200 });
      });

      const validator = createFridayProviderValidator();
      await validator.validate({
        kind: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        credential: "AIza-test",
      });
      // H-2: API key must NOT leak in URL query parameters
      expect(capturedUrl).not.toContain("key=");
      expect(capturedHeaders["x-goog-api-key"]).toBe("AIza-test");
    });
  });

  describe("ollama validation", () => {
    it("returns ok on 200 (no auth needed)", async () => {
      mockFetch(() => new Response("{}", { status: 200 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "ollama",
        api: "ollama",
        baseUrl: "http://localhost:11434",
        credential: null,
      });
      expect(result.status).toBe("ok");
    });

    it("returns unreachable on connection failure", async () => {
      mockFetch(() => {
        throw new Error("ECONNREFUSED");
      });

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "ollama",
        api: "ollama",
        baseUrl: "http://localhost:11434",
        credential: null,
      });
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("PROVIDER_UNREACHABLE");
    });
  });

  describe("openai-compatible validation", () => {
    it("returns ok on 200", async () => {
      mockFetch(() => new Response("{}", { status: 200 }));

      const validator = createFridayProviderValidator();
      const result = await validator.validate({
        kind: "openai-compatible",
        api: "openai-completions",
        baseUrl: "https://custom-llm.example.com",
        credential: "token-123",
      });
      expect(result.status).toBe("ok");
    });
  });
});
