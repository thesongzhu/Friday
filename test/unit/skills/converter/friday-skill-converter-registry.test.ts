import { describe, it, expect, vi } from "vitest";
import { createFridaySkillConverterRegistry } from "#skills/converter";
import type {
  FridaySkillConverter,
  FridaySkillConversionSource,
  FridaySkillConverterDetection,
} from "#skills/converter";

function makeConverter(
  id: string,
  priority: number,
  detectResult: FridaySkillConverterDetection | null,
): FridaySkillConverter {
  return {
    id,
    displayName: `Converter ${id}`,
    priority,
    detect: async () => detectResult,
    convert: async () => ({
      converterId: id,
      detectedFormat: detectResult?.format ?? "unknown",
      drafts: [],
    }),
  };
}

describe("FridaySkillConverterRegistry", () => {
  it("starts with no converters", () => {
    const registry = createFridaySkillConverterRegistry();
    expect(registry.list()).toHaveLength(0);
  });

  it("registers a converter", () => {
    const registry = createFridaySkillConverterRegistry();
    const converter = makeConverter("test", 50, null);
    registry.register(converter);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.id).toBe("test");
  });

  it("replaces converter with same id", () => {
    const registry = createFridaySkillConverterRegistry();
    const v1 = makeConverter("test", 50, null);
    const v2 = makeConverter("test", 100, null);
    registry.register(v1);
    registry.register(v2);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.priority).toBe(100);
  });

  it("retrieves converter by id", () => {
    const registry = createFridaySkillConverterRegistry();
    const converter = makeConverter("abc", 50, null);
    registry.register(converter);
    expect(registry.getConverter("abc")).toBe(converter);
    expect(registry.getConverter("nonexistent")).toBeUndefined();
  });

  it("detect returns null when no converters match", async () => {
    const registry = createFridaySkillConverterRegistry();
    registry.register(makeConverter("a", 50, null));
    registry.register(makeConverter("b", 60, null));

    const source: FridaySkillConversionSource = { uri: "/test" };
    const result = await registry.detect(source);
    expect(result).toBeNull();
  });

  it("detect picks highest confidence", async () => {
    const registry = createFridaySkillConverterRegistry();

    registry.register(makeConverter("low", 50, {
      converterId: "low",
      format: "clawdbot-skill-md",
      confidence: 0.3,
      reasons: ["low confidence"],
    }));

    registry.register(makeConverter("high", 50, {
      converterId: "high",
      format: "friday-package",
      confidence: 0.9,
      reasons: ["high confidence"],
    }));

    const source: FridaySkillConversionSource = { uri: "/test" };
    const result = await registry.detect(source);
    expect(result).not.toBeNull();
    expect(result!.converterId).toBe("high");
    expect(result!.confidence).toBe(0.9);
  });

  it("detect breaks confidence ties by priority", async () => {
    const registry = createFridaySkillConverterRegistry();

    registry.register(makeConverter("low-prio", 10, {
      converterId: "low-prio",
      format: "clawdbot-skill-md",
      confidence: 0.8,
      reasons: ["same confidence"],
    }));

    registry.register(makeConverter("high-prio", 100, {
      converterId: "high-prio",
      format: "friday-package",
      confidence: 0.8,
      reasons: ["same confidence"],
    }));

    const source: FridaySkillConversionSource = { uri: "/test" };
    const result = await registry.detect(source);
    expect(result).not.toBeNull();
    expect(result!.converterId).toBe("high-prio");
  });

  it("detect with formatHint filters by format", async () => {
    const registry = createFridaySkillConverterRegistry();

    registry.register(makeConverter("native", 100, {
      converterId: "native",
      format: "friday-package",
      confidence: 1.0,
      reasons: ["native"],
    }));

    registry.register(makeConverter("clawdbot", 50, {
      converterId: "clawdbot",
      format: "clawdbot-skill-md",
      confidence: 0.9,
      reasons: ["clawdbot"],
    }));

    const source: FridaySkillConversionSource = {
      uri: "/test",
      formatHint: "clawdbot-skill-md",
    };
    const result = await registry.detect(source);
    expect(result).not.toBeNull();
    expect(result!.converterId).toBe("clawdbot");
    expect(result!.format).toBe("clawdbot-skill-md");
  });

  it("detect with formatHint returns null when no converter matches the format", async () => {
    const registry = createFridaySkillConverterRegistry();

    registry.register(makeConverter("native", 100, {
      converterId: "native",
      format: "friday-package",
      confidence: 1.0,
      reasons: ["native"],
    }));

    const source: FridaySkillConversionSource = {
      uri: "/test",
      formatHint: "n8n-node",
    };
    const result = await registry.detect(source);
    expect(result).toBeNull();
  });

  it("detect with formatHint 'auto' runs normal detection", async () => {
    const registry = createFridaySkillConverterRegistry();

    registry.register(makeConverter("native", 100, {
      converterId: "native",
      format: "friday-package",
      confidence: 1.0,
      reasons: ["native"],
    }));

    const source: FridaySkillConversionSource = {
      uri: "/test",
      formatHint: "auto",
    };
    const result = await registry.detect(source);
    expect(result).not.toBeNull();
    expect(result!.converterId).toBe("native");
  });

  it("short-circuits after a strong heuristic match instead of fanning out through every converter", async () => {
    const registry = createFridaySkillConverterRegistry();
    const openApiDetect = vi.fn(async () => ({
      converterId: "openai-gpt-action",
      format: "openai-gpt-action" as const,
      confidence: 0.95,
      reasons: ["matched openapi filename"],
    }));
    const fallbackDetect = vi.fn(async () => ({
      converterId: "n8n-node",
      format: "n8n-node" as const,
      confidence: 0.4,
      reasons: ["fallback"],
    }));

    registry.register({
      id: "n8n-node",
      displayName: "n8n",
      priority: 40,
      detect: fallbackDetect,
      convert: async () => ({ converterId: "n8n-node", detectedFormat: "n8n-node", drafts: [] }),
    });
    registry.register({
      id: "openai-gpt-action",
      displayName: "OpenAPI",
      priority: 10,
      detect: openApiDetect,
      convert: async () => ({ converterId: "openai-gpt-action", detectedFormat: "openai-gpt-action", drafts: [] }),
    });

    const result = await registry.detect({ uri: "/tmp/specs/openapi.yaml" });

    expect(result?.converterId).toBe("openai-gpt-action");
    expect(openApiDetect).toHaveBeenCalledTimes(1);
    expect(fallbackDetect).not.toHaveBeenCalled();
  });
});
