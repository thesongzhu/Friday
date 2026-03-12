import { describe, it, expect } from "vitest";
import {
  _validateLlmResponse,
  _parseJsonFromText,
} from "../../../../src/sessions/services/friday-session-memory-extraction-llm-client.js";

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
});
