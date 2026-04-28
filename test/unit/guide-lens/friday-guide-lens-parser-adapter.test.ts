import { afterEach, describe, expect, it, vi } from "vitest";
import { createFridayGuideLensHttpParserAdapter } from "../../../src/guide-lens/index.js";

describe("createFridayGuideLensHttpParserAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts loopback parser responses in OmniParser/Midscene-compatible shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        provider: "midscene",
        ocr_text: "Continue",
        ui_elements: [{
          id: "continue",
          type: "button",
          text: "Continue",
          bbox: [40, 50, 160, 90],
          score: 0.91,
          clickable: true,
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createFridayGuideLensHttpParserAdapter({
      endpointUrl: "http://127.0.0.1:8765/parse",
      provider: "midscene",
    });

    const result = await adapter.parse({
      provider: "midscene",
      snapshot: {
        surface: "screenshot",
        screenshotText: "Continue",
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.provider).toBe("midscene");
    expect(result.elements?.[0]).toEqual(expect.objectContaining({
      id: "continue",
      role: "button",
      source: "parser",
      interactable: true,
      bounds: { x: 40, y: 50, width: 120, height: 40 },
    }));
  });

  it("rejects non-loopback parser endpoints", () => {
    expect(() => createFridayGuideLensHttpParserAdapter({
      endpointUrl: "https://example.com/parse",
      provider: "custom",
    })).toThrow("loopback-only");
  });
});
