import { describe, it, expect } from "vitest";
import {
  FRIDAY_MCP_SAFE_CATALOG,
  isMcpSafeCatalogTool,
  buildMcpServerToolFilter,
} from "../../../src/hub/friday-mcp-safe-catalog.js";

describe("FRIDAY_MCP_SAFE_CATALOG", () => {
  it("contains only read-only, non-mutating tools", () => {
    const expected = new Set([
      "capabilities",
      "task_status",
      "skills_list",
      "agents_list",
      "web_search",
      "web_fetch",
      "read",
      "pdf_parse",
      "memory_search",
    ]);
    expect(FRIDAY_MCP_SAFE_CATALOG).toEqual(expected);
  });

  it("does not contain dangerous tools", () => {
    const dangerous = [
      "exec", "write", "edit", "system", "desktop",
      "spawn_subagent", "message", "browser", "autonomous",
      "skill_run", "workflow_run", "cron", "provider",
      "mcp", "nodes", "gateway", "feedback", "canvas",
      "memory_store", "skill_generate", "workflow_generate",
      "setup", "setup_assistant", "tts", "xhs",
      "skill_import", "image_analysis", "memory_extract",
    ];
    for (const tool of dangerous) {
      expect(FRIDAY_MCP_SAFE_CATALOG.has(tool)).toBe(false);
    }
  });
});

describe("isMcpSafeCatalogTool", () => {
  it("returns true for catalog members", () => {
    expect(isMcpSafeCatalogTool("capabilities")).toBe(true);
    expect(isMcpSafeCatalogTool("task_status")).toBe(true);
    expect(isMcpSafeCatalogTool("read")).toBe(true);
  });

  it("returns false for non-members", () => {
    expect(isMcpSafeCatalogTool("exec")).toBe(false);
    expect(isMcpSafeCatalogTool("system")).toBe(false);
    expect(isMcpSafeCatalogTool("sessions")).toBe(false);
    expect(isMcpSafeCatalogTool("")).toBe(false);
  });
});

describe("buildMcpServerToolFilter", () => {
  describe("empty env allowlist (default)", () => {
    const { isToolAllowed } = buildMcpServerToolFilter([]);

    it("allows all safe catalog tools", () => {
      for (const tool of FRIDAY_MCP_SAFE_CATALOG) {
        expect(isToolAllowed(tool)).toBe(true);
      }
    });

    it("blocks unsafe tools", () => {
      expect(isToolAllowed("exec")).toBe(false);
      expect(isToolAllowed("write")).toBe(false);
      expect(isToolAllowed("system")).toBe(false);
      expect(isToolAllowed("desktop")).toBe(false);
      expect(isToolAllowed("spawn_subagent")).toBe(false);
    });
  });

  describe("non-empty env allowlist", () => {
    it("narrows within safe catalog", () => {
      const { isToolAllowed } = buildMcpServerToolFilter(["capabilities", "task_status"]);

      expect(isToolAllowed("capabilities")).toBe(true);
      expect(isToolAllowed("task_status")).toBe(true);
      expect(isToolAllowed("web_search")).toBe(false);
      expect(isToolAllowed("read")).toBe(false);
      expect(isToolAllowed("pdf_parse")).toBe(false);
    });

    it("cannot re-expose unsafe tools", () => {
      const { isToolAllowed } = buildMcpServerToolFilter(["exec", "system", "capabilities"]);

      expect(isToolAllowed("exec")).toBe(false);
      expect(isToolAllowed("system")).toBe(false);
      expect(isToolAllowed("capabilities")).toBe(true);
    });

    it("returns false for all when env list has only unsafe tools", () => {
      const { isToolAllowed } = buildMcpServerToolFilter(["exec", "write", "desktop"]);

      expect(isToolAllowed("exec")).toBe(false);
      expect(isToolAllowed("write")).toBe(false);
      expect(isToolAllowed("desktop")).toBe(false);
      expect(isToolAllowed("capabilities")).toBe(false);
    });
  });
});
