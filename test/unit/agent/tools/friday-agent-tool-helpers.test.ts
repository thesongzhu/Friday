import { describe, it, expect } from "vitest";
import {
  FridayAgentToolInputError,
  readStringParam,
  readNumberParam,
  readBooleanParam,
  readRecordParam,
  readStringOrNumberParam,
  readStringArrayParam,
  jsonResult,
  textResult,
  errorResult,
  truncateOutput,
} from "#agent";

describe("FridayAgentToolHelpers", () => {
  // ─── readStringParam ───

  describe("readStringParam", () => {
    it("returns string value", () => {
      expect(readStringParam({ name: "test" }, "name")).toBe("test");
    });

    it("trims whitespace", () => {
      expect(readStringParam({ name: "  hello  " }, "name")).toBe("hello");
    });

    it("returns undefined for missing key", () => {
      expect(readStringParam({}, "name")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(readStringParam({ name: "" }, "name")).toBeUndefined();
    });

    it("throws on missing required param", () => {
      expect(() => readStringParam({}, "name", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("uses custom label in error message", () => {
      expect(() =>
        readStringParam({}, "name", { required: true, label: "File path" }),
      ).toThrow("File path is required");
    });

    it("returns undefined for non-string values", () => {
      expect(readStringParam({ name: 42 }, "name")).toBeUndefined();
    });
  });

  // ─── readNumberParam ───

  describe("readNumberParam", () => {
    it("returns number value", () => {
      expect(readNumberParam({ count: 42 }, "count")).toBe(42);
    });

    it("parses string numbers", () => {
      expect(readNumberParam({ count: "42" }, "count")).toBe(42);
    });

    it("returns undefined for missing key", () => {
      expect(readNumberParam({}, "count")).toBeUndefined();
    });

    it("throws on missing required param", () => {
      expect(() => readNumberParam({}, "count", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("truncates to integer when requested", () => {
      expect(readNumberParam({ count: 3.7 }, "count", { integer: true })).toBe(3);
    });

    it("returns undefined for NaN", () => {
      expect(readNumberParam({ count: "abc" }, "count")).toBeUndefined();
    });
  });

  // ─── readBooleanParam ───

  describe("readBooleanParam", () => {
    it("returns boolean value", () => {
      expect(readBooleanParam({ flag: true }, "flag")).toBe(true);
      expect(readBooleanParam({ flag: false }, "flag")).toBe(false);
    });

    it("returns undefined for non-boolean values", () => {
      expect(readBooleanParam({ flag: "true" }, "flag")).toBeUndefined();
      expect(readBooleanParam({}, "flag")).toBeUndefined();
    });
  });

  // ─── readRecordParam ───

  describe("readRecordParam", () => {
    it("returns object value", () => {
      const env = { FOO: "bar" };
      expect(readRecordParam({ env }, "env")).toEqual({ FOO: "bar" });
    });

    it("returns undefined for non-object values", () => {
      expect(readRecordParam({ env: "string" }, "env")).toBeUndefined();
      expect(readRecordParam({ env: null }, "env")).toBeUndefined();
      expect(readRecordParam({ env: [1, 2] }, "env")).toBeUndefined();
    });
  });

  // ─── readStringOrNumberParam ───

  describe("readStringOrNumberParam", () => {
    it("returns number value as-is", () => {
      expect(readStringOrNumberParam({ val: 42 }, "val")).toBe(42);
    });

    it("returns string value as-is when not numeric", () => {
      expect(readStringOrNumberParam({ val: "hello" }, "val")).toBe("hello");
    });

    it("coerces numeric string to number", () => {
      expect(readStringOrNumberParam({ val: "42" }, "val")).toBe(42);
    });

    it("coerces float string to number", () => {
      expect(readStringOrNumberParam({ val: "3.14" }, "val")).toBe(3.14);
    });

    it("returns undefined for missing key", () => {
      expect(readStringOrNumberParam({}, "val")).toBeUndefined();
    });

    it("throws on missing required param", () => {
      expect(() => readStringOrNumberParam({}, "val", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("throws on empty string when required", () => {
      expect(() => readStringOrNumberParam({ val: "  " }, "val", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("returns undefined for non-finite number", () => {
      expect(readStringOrNumberParam({ val: NaN }, "val")).toBeUndefined();
      expect(readStringOrNumberParam({ val: Infinity }, "val")).toBeUndefined();
    });

    it("uses custom label in error message", () => {
      expect(() =>
        readStringOrNumberParam({}, "val", { required: true, label: "Age" }),
      ).toThrow("Age is required");
    });
  });

  // ─── readStringArrayParam ───

  describe("readStringArrayParam", () => {
    it("returns string array as-is", () => {
      expect(readStringArrayParam({ tags: ["a", "b"] }, "tags")).toEqual(["a", "b"]);
    });

    it("wraps single string in array", () => {
      expect(readStringArrayParam({ tags: "single" }, "tags")).toEqual(["single"]);
    });

    it("filters out non-string elements", () => {
      expect(readStringArrayParam({ tags: ["a", 42, "b", null] }, "tags")).toEqual(["a", "b"]);
    });

    it("returns undefined for missing key", () => {
      expect(readStringArrayParam({}, "tags")).toBeUndefined();
    });

    it("throws on missing required param", () => {
      expect(() => readStringArrayParam({}, "tags", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("throws on empty string when required", () => {
      expect(() => readStringArrayParam({ tags: "" }, "tags", { required: true })).toThrow(
        FridayAgentToolInputError,
      );
    });

    it("returns undefined for empty array when not required", () => {
      expect(readStringArrayParam({ tags: [] }, "tags")).toBeUndefined();
    });

    it("uses custom label in error message", () => {
      expect(() =>
        readStringArrayParam({}, "tags", { required: true, label: "Tag list" }),
      ).toThrow("Tag list is required");
    });
  });

  // ─── Result formatters ───

  describe("jsonResult", () => {
    it("serializes payload to JSON", () => {
      const result = jsonResult({ key: "value" });
      expect(result.content).toBe('{\n  "key": "value"\n}');
      expect(result.isError).toBeUndefined();
    });
  });

  describe("textResult", () => {
    it("wraps text in result", () => {
      const result = textResult("hello");
      expect(result.content).toBe("hello");
      expect(result.isError).toBeUndefined();
    });
  });

  describe("errorResult", () => {
    it("wraps text in error result", () => {
      const result = errorResult("something failed");
      expect(result.content).toBe("something failed");
      expect(result.isError).toBe(true);
    });
  });

  // ─── truncateOutput ───

  describe("truncateOutput", () => {
    it("returns text unchanged if under limit", () => {
      expect(truncateOutput("short", 1000)).toBe("short");
    });

    it("truncates text exceeding byte limit", () => {
      const longText = "a".repeat(200);
      const result = truncateOutput(longText, 100);
      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain("[truncated]");
    });

    it("handles multi-byte characters", () => {
      const text = "é".repeat(100); // 2 bytes each in UTF-8
      const result = truncateOutput(text, 100);
      expect(Buffer.byteLength(result.replace("\n... [truncated]", ""), "utf8")).toBeLessThanOrEqual(100);
    });
  });

  // ─── FridayAgentToolInputError ───

  describe("FridayAgentToolInputError", () => {
    it("has correct name and status", () => {
      const error = new FridayAgentToolInputError("test error");
      expect(error.name).toBe("FridayAgentToolInputError");
      expect(error.status).toBe(400);
      expect(error.message).toBe("test error");
    });
  });
});
