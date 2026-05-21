import { describe, it, expect } from "vitest";
import {
  summarizeToolCall,
  type FridayToolCallSummary,
} from "../../../../src/agent/services/friday-tool-call-summary.js";
import type { FridayAgentToolResult } from "../../../../src/agent/model/friday-agent.types.js";

function makeResult(overrides: Partial<FridayAgentToolResult> = {}): FridayAgentToolResult {
  return {
    content: "some result text",
    ...overrides,
  };
}

describe("summarizeToolCall", () => {
  describe("toolCategory classification", () => {
    it("classifies read tools", () => {
      for (const tool of ["read", "glob", "grep", "web_fetch", "web_search", "skills_list", "request_tool_pack", "tool_search"]) {
        const summary = summarizeToolCall(tool, {}, makeResult(), 0, 0);
        expect(summary.toolCategory).toBe("read");
      }
    });

    it("classifies write tools", () => {
      for (const tool of ["write", "edit"]) {
        const summary = summarizeToolCall(tool, {}, makeResult(), 0, 0);
        expect(summary.toolCategory).toBe("write");
      }
    });

    it("classifies query tools", () => {
      for (const tool of ["system", "todo_read"]) {
        const summary = summarizeToolCall(tool, {}, makeResult(), 0, 0);
        expect(summary.toolCategory).toBe("query");
      }
    });

    it("classifies navigate tools", () => {
      for (const tool of ["browser", "canvas", "desktop"]) {
        const summary = summarizeToolCall(tool, {}, makeResult(), 0, 0);
        expect(summary.toolCategory).toBe("navigate");
      }
    });

    it("classifies mutate tools", () => {
      for (const tool of ["exec", "shell", "skill_run", "workflow_run", "todo_write"]) {
        const summary = summarizeToolCall(tool, {}, makeResult(), 0, 0);
        expect(summary.toolCategory).toBe("mutate");
      }
    });

    it("classifies unknown tools as other", () => {
      const summary = summarizeToolCall("some_custom_tool", {}, makeResult(), 0, 0);
      expect(summary.toolCategory).toBe("other");
    });
  });

  describe("outputShape detection", () => {
    it("detects error shape", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ isError: true, content: "error message" }), 0, 0);
      expect(summary.outputShape).toBe("error");
    });

    it("detects empty shape", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: "" }), 0, 0);
      expect(summary.outputShape).toBe("empty");
    });

    it("detects empty shape for whitespace-only content", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: "   \n  " }), 0, 0);
      expect(summary.outputShape).toBe("empty");
    });

    it("detects json shape for object content", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: '{"key": "value"}' }), 0, 0);
      expect(summary.outputShape).toBe("json");
    });

    it("detects json shape for array content", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: '[1, 2, 3]' }), 0, 0);
      expect(summary.outputShape).toBe("json");
    });

    it("detects json shape with leading whitespace", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: '  {"key": "value"}' }), 0, 0);
      expect(summary.outputShape).toBe("json");
    });

    it("detects text shape for plain text", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: "Hello world" }), 0, 0);
      expect(summary.outputShape).toBe("text");
    });
  });

  describe("argKeys extraction", () => {
    it("extracts top-level keys from args", () => {
      const summary = summarizeToolCall("exec", { command: "ls", cwd: "/tmp" }, makeResult(), 0, 0);
      expect(summary.argKeys).toEqual(["command", "cwd"]);
    });

    it("returns empty array for empty args", () => {
      const summary = summarizeToolCall("read", {}, makeResult(), 0, 0);
      expect(summary.argKeys).toEqual([]);
    });

    it("does not include values in argKeys", () => {
      const summary = summarizeToolCall("exec", { secret: "my-api-key-123" }, makeResult(), 0, 0);
      expect(summary.argKeys).toEqual(["secret"]);
      expect(JSON.stringify(summary)).not.toContain("my-api-key-123");
    });
  });

  describe("metadata fields", () => {
    it("captures tool name", () => {
      const summary = summarizeToolCall("browser", {}, makeResult(), 0, 0);
      expect(summary.toolName).toBe("browser");
    });

    it("captures resultIsError", () => {
      const ok = summarizeToolCall("read", {}, makeResult({ isError: false }), 0, 0);
      expect(ok.resultIsError).toBe(false);

      const err = summarizeToolCall("read", {}, makeResult({ isError: true }), 0, 0);
      expect(err.resultIsError).toBe(true);
    });

    it("defaults resultIsError to false when undefined", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ isError: undefined }), 0, 0);
      expect(summary.resultIsError).toBe(false);
    });

    it("captures resultLengthChars", () => {
      const summary = summarizeToolCall("read", {}, makeResult({ content: "abc" }), 0, 0);
      expect(summary.resultLengthChars).toBe(3);
    });

    it("captures turnIndex and toolIndex", () => {
      const summary = summarizeToolCall("read", {}, makeResult(), 5, 3);
      expect(summary.turnIndex).toBe(5);
      expect(summary.toolIndex).toBe(3);
    });
  });
});
