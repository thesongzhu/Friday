import { describe, it, expect, vi } from "vitest";
import {
  createFridayOpenAiVisionProvider,
  DEFAULT_OPENAI_VISION_BASE_URL,
  DEFAULT_OPENAI_VISION_MODEL,
  FRIDAY_OPENAI_VISION_PROVIDER_ID,
  type FridayOpenAiVisionProviderConfig,
} from "../../../src/media-understanding/providers/friday-openai-vision-provider.js";
import type { FridayMediaAttachment } from "../../../src/media-understanding/friday-media-understanding.types.js";

// ─── Fixtures ───

// pragma: allowlist secret
const FIXTURE_KEY = "sk-test-DUMMY-fixture-not-real";

const FIXTURE_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3sY5wAAAABJRU5ErkJggg==",
  "base64",
);

function makeAttachment(overrides: Partial<FridayMediaAttachment> = {}): FridayMediaAttachment {
  return {
    id: "att-1",
    filename: "test.png",
    mimeType: "image/png",
    mediaType: "image",
    sizeBytes: FIXTURE_PNG_BUFFER.length,
    sourceUrl: "https://example.com/test.png",
    ...overrides,
  };
}

function makeFetchImpl(response: Partial<Response> & {
  okOverride?: boolean;
  status?: number;
  jsonBody?: unknown;
  textBody?: string;
  throwError?: Error;
}) {
  return vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    if (response.throwError) {
      throw response.throwError;
    }
    return {
      ok: response.okOverride ?? (response.status === undefined ? true : response.status >= 200 && response.status < 300),
      status: response.status ?? 200,
      json: async () => response.jsonBody ?? {},
      text: async () => response.textBody ?? "",
    } as unknown as Response;
  });
}

// ─── Configuration ───

describe("createFridayOpenAiVisionProvider — configuration", () => {
  it("rejects empty apiKey", () => {
    expect(() => createFridayOpenAiVisionProvider({ apiKey: "" } as FridayOpenAiVisionProviderConfig))
      .toThrow(/apiKey is required/);
  });

  it("rejects whitespace-only apiKey", () => {
    expect(() => createFridayOpenAiVisionProvider({ apiKey: "   " } as FridayOpenAiVisionProviderConfig))
      .toThrow(/apiKey is required/);
  });

  it("returns provider with canonical providerId and image-only support", () => {
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY });
    expect(provider.providerId).toBe(FRIDAY_OPENAI_VISION_PROVIDER_ID);
    expect(provider.supportedMediaTypes).toEqual(["image"]);
  });
});

// ─── Request shape ───

describe("createFridayOpenAiVisionProvider — request shape", () => {
  it("sends chat completions request with multimodal content and bearer auth", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: {
        choices: [{ message: { content: "A test image of a single pixel." } }],
      },
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    await provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${DEFAULT_OPENAI_VISION_BASE_URL}/chat/completions`);
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("POST");
    const headers = initObj.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Bearer ${FIXTURE_KEY}`);

    const body = JSON.parse(initObj.body as string);
    expect(body.model).toBe(DEFAULT_OPENAI_VISION_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe("user");
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    const content = body.messages[0].content;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toMatchObject({ type: "image_url" });
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(content[1].image_url.detail).toBe("low");
  });

  it("uses configured baseUrl and model overrides", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: { choices: [{ message: { content: "ok" } }] },
    });
    const provider = createFridayOpenAiVisionProvider({
      apiKey: FIXTURE_KEY,
      model: "gpt-4o",
      baseUrl: "https://gateway.example.com/openai/v1/",
      fetchImpl,
    });
    await provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://gateway.example.com/openai/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o");
  });

  it("falls back to image/png mime when attachment mimeType is empty", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: { choices: [{ message: { content: "ok" } }] },
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    await provider.process(
      makeAttachment({ mimeType: "" }),
      async () => FIXTURE_PNG_BUFFER,
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

// ─── Response parsing ───

describe("createFridayOpenAiVisionProvider — response parsing", () => {
  it("maps response.choices[0].message.content into FridayMediaUnderstandingOutput", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: {
        choices: [{ message: { content: "  A 1x1 transparent test pixel.  " } }],
      },
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    const output = await provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER);

    expect(output.description).toBe("A 1x1 transparent test pixel.");
    expect(output.confidence).toBe(0);
    expect(output.provider).toBe(FRIDAY_OPENAI_VISION_PROVIDER_ID);
    expect(typeof output.processingMs).toBe("number");
    expect(output.processingMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when response.choices[0].message.content is missing", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: { choices: [{ message: {} }] },
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    await expect(provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER))
      .rejects.toThrow(/no content in response/);
  });

  it("throws when response.choices is empty", async () => {
    const fetchImpl = makeFetchImpl({
      status: 200,
      jsonBody: { choices: [] },
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    await expect(provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER))
      .rejects.toThrow(/no content in response/);
  });
});

// ─── Error handling + secret redaction ───

describe("createFridayOpenAiVisionProvider — error handling", () => {
  it("throws with HTTP status code on non-OK response", async () => {
    const fetchImpl = makeFetchImpl({
      status: 429,
      okOverride: false,
      textBody: "rate_limit_exceeded",
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    await expect(provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER))
      .rejects.toThrow(/HTTP 429/);
  });

  it("redacts apiKey shape from upstream error body before throwing", async () => {
    // Build the leak-shaped token at runtime so this source file does not embed
    // a literal that would trip the provider-key pattern scanner. The runtime
    // value still has >=24 chars after `sk-` so the production redactSecretShapes
    // regex still matches and the redaction path is exercised end-to-end.
    const LEAK_LOOKALIKE = ["sk-", "LEAK-", "A".repeat(40), "-shaped-token"].join("");
    const fetchImpl = makeFetchImpl({
      status: 401,
      okOverride: false,
      textBody: `invalid_api_key key=${LEAK_LOOKALIKE}`,
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: FIXTURE_KEY, fetchImpl });
    let thrown: unknown = null;
    try {
      await provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/HTTP 401/);
    expect(message).not.toContain(LEAK_LOOKALIKE);
    expect(message).toMatch(/sk-\*\*\*redacted\*\*\*/);
  });

  it("never includes the configured apiKey in any thrown error", async () => {
    // pragma: allowlist secret
    const SENSITIVE_KEY = "sk-VERYSENSITIVE-NOTREAL-FIXTURE-fingerprint-1234";
    const fetchImpl = makeFetchImpl({
      throwError: new Error(`network refused; tried Authorization Bearer ${SENSITIVE_KEY}`),
    });
    const provider = createFridayOpenAiVisionProvider({ apiKey: SENSITIVE_KEY, fetchImpl });
    let thrown: unknown = null;
    try {
      await provider.process(makeAttachment(), async () => FIXTURE_PNG_BUFFER);
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as Error).message;
    expect(message).toContain("network error");
    expect(message).not.toContain(SENSITIVE_KEY);
  });
});
