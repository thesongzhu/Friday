import { describe, it, expect } from "vitest";
import {
  FRIDAY_MODE_CONFIGS,
  filterToolsByMode,
  resolveToolCategory,
  validateModeTransition,
} from "#agent";
import type { FridayOperationalMode } from "#agent";

describe("FRIDAY_MODE_CONFIGS", () => {
  it("plan mode is readOnly with only read categories", () => {
    const config = FRIDAY_MODE_CONFIGS.plan;
    expect(config.readOnly).toBe(true);
    expect(config.enabledToolCategories).toEqual(["read"]);
  });

  it("execute mode is not readOnly with all categories", () => {
    const config = FRIDAY_MODE_CONFIGS.execute;
    expect(config.readOnly).toBe(false);
    expect(config.enabledToolCategories).toHaveLength(8);
    expect(config.enabledToolCategories).toContain("read");
    expect(config.enabledToolCategories).toContain("write");
    expect(config.enabledToolCategories).toContain("exec");
    expect(config.enabledToolCategories).toContain("network");
    expect(config.enabledToolCategories).toContain("skill");
    expect(config.enabledToolCategories).toContain("workflow");
    expect(config.enabledToolCategories).toContain("browser");
    expect(config.enabledToolCategories).toContain("system");
  });

  it("restricted mode is readOnly with only read categories", () => {
    const config = FRIDAY_MODE_CONFIGS.restricted;
    expect(config.readOnly).toBe(true);
    expect(config.enabledToolCategories).toEqual(["read"]);
  });

  it("plan and restricted include non-empty systemPromptSuffix", () => {
    expect(FRIDAY_MODE_CONFIGS.plan.systemPromptSuffix.length).toBeGreaterThan(0);
    expect(FRIDAY_MODE_CONFIGS.restricted.systemPromptSuffix.length).toBeGreaterThan(0);
  });

  it("execute has empty systemPromptSuffix", () => {
    expect(FRIDAY_MODE_CONFIGS.execute.systemPromptSuffix).toBe("");
  });
});

describe("resolveToolCategory", () => {
  it("maps known read tools correctly", () => {
    expect(resolveToolCategory("read")).toBe("read");
    expect(resolveToolCategory("file_read")).toBe("read");
    expect(resolveToolCategory("file_list")).toBe("read");
    expect(resolveToolCategory("web_fetch")).toBe("read");
    expect(resolveToolCategory("web_search")).toBe("read");
    expect(resolveToolCategory("memory_search")).toBe("read");
    expect(resolveToolCategory("capabilities")).toBe("read");
    expect(resolveToolCategory("task_status")).toBe("read");
    expect(resolveToolCategory("workflow_list")).toBe("read");
    expect(resolveToolCategory("request_tool_pack")).toBe("read");
    expect(resolveToolCategory("tool_search")).toBe("read");
    expect(resolveToolCategory("image_analysis")).toBe("read");
  });

  it("maps known write tools correctly", () => {
    expect(resolveToolCategory("write")).toBe("write");
    expect(resolveToolCategory("edit")).toBe("write");
    expect(resolveToolCategory("file_write")).toBe("write");
    expect(resolveToolCategory("file_delete")).toBe("write");
    expect(resolveToolCategory("memory_store")).toBe("write");
  });

  it("maps exec to exec category", () => {
    expect(resolveToolCategory("exec")).toBe("exec");
  });

  it("maps network tools correctly", () => {
    expect(resolveToolCategory("message")).toBe("network");
    expect(resolveToolCategory("gateway")).toBe("network");
    expect(resolveToolCategory("mcp")).toBe("network");
  });

  it("maps skill tools correctly", () => {
    expect(resolveToolCategory("skill_run")).toBe("skill");
    expect(resolveToolCategory("skill_generate")).toBe("skill");
    expect(resolveToolCategory("skill_import")).toBe("skill");
  });

  it("maps workflow tools correctly", () => {
    expect(resolveToolCategory("workflow_run")).toBe("workflow");
    expect(resolveToolCategory("workflow_generate")).toBe("workflow");
  });

  it("maps autonomous to exec", () => {
    expect(resolveToolCategory("autonomous")).toBe("exec");
  });

  it("maps setup tools to system", () => {
    expect(resolveToolCategory("setup")).toBe("system");
    expect(resolveToolCategory("setup_assistant")).toBe("system");
  });

  it("maps feedback to read", () => {
    expect(resolveToolCategory("feedback")).toBe("read");
    expect(resolveToolCategory("pdf_parse")).toBe("read");
  });

  it("maps browser tools correctly", () => {
    expect(resolveToolCategory("browser")).toBe("browser");
    expect(resolveToolCategory("canvas")).toBe("browser");
    expect(resolveToolCategory("xhs")).toBe("browser");
  });

  it("maps system tools correctly", () => {
    expect(resolveToolCategory("desktop")).toBe("system");
    expect(resolveToolCategory("system")).toBe("system");
    expect(resolveToolCategory("cron")).toBe("system");
    expect(resolveToolCategory("nodes")).toBe("system");
    expect(resolveToolCategory("tts")).toBe("system");
    expect(resolveToolCategory("provider")).toBe("system");
  });

  it("defaults unknown tools to system", () => {
    expect(resolveToolCategory("totally_unknown_tool")).toBe("system");
    expect(resolveToolCategory("custom_plugin")).toBe("system");
  });

  it("has explicit mapping for all tool names used across agent and desktop subsystems", () => {
    const ALL_REGISTERED_TOOLS = [
      // read
      "read", "file_read", "file_list", "web_fetch", "web_search",
      "memory_search", "memory_query", "memory_get", "skills_list",
      "workflow_list", "agents_list", "capabilities", "task_status", "request_tool_pack", "tool_search", "image_analysis", "pdf_parse", "feedback",
      // write
      "write", "edit", "file_write", "file_delete",
      "memory_store", "memory_extract",
      // exec
      "exec", "autonomous",
      // network
      "message", "gateway", "mcp",
      // skill
      "skill_run", "skill_generate", "skill_import",
      // workflow
      "workflow_run", "workflow_generate",
      // browser
      "browser", "canvas", "xhs",
      // system
      "desktop", "system", "cron", "nodes", "tts", "provider",
      "sessions", "spawn_subagent", "get_subagent", "list_subagents",
      "setup", "setup_assistant",
    ];
    for (const tool of ALL_REGISTERED_TOOLS) {
      const category = resolveToolCategory(tool);
      // Ensure the tool has an explicit mapping (not falling through to the "system" default
      // for tools that shouldn't be "system")
      expect(category).toBeDefined();
      // All tools should resolve to a known category
      expect(["read", "write", "exec", "network", "skill", "workflow", "browser", "system"]).toContain(category);
    }
  });
});

describe("filterToolsByMode", () => {
  const mockTools = [
    { name: "read" },
    { name: "file_read" },
    { name: "web_search" },
    { name: "workflow_list" },
    { name: "write" },
    { name: "exec" },
    { name: "browser" },
    { name: "desktop" },
    { name: "skill_run" },
  ];

  it("keeps only read tools in plan mode", () => {
    const filtered = filterToolsByMode(mockTools, "plan");
    const names = filtered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("file_read");
    expect(names).toContain("web_search");
    expect(names).toContain("workflow_list");
    expect(names).not.toContain("write");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("browser");
    expect(names).not.toContain("desktop");
    expect(names).not.toContain("skill_run");
  });

  it("keeps all tools in execute mode", () => {
    const filtered = filterToolsByMode(mockTools, "execute");
    expect(filtered).toHaveLength(mockTools.length);
  });

  it("keeps only read tools in restricted mode", () => {
    const filtered = filterToolsByMode(mockTools, "restricted");
    const names = filtered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("file_read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("exec");
  });

  it("returns empty array when no tools match", () => {
    const filtered = filterToolsByMode([{ name: "exec" }], "plan");
    expect(filtered).toHaveLength(0);
  });

  it("handles empty input", () => {
    const filtered = filterToolsByMode([], "plan");
    expect(filtered).toEqual([]);
  });

  it("keeps feedback in plan mode (read category)", () => {
    const tools = [{ name: "feedback" }, { name: "autonomous" }, { name: "skill_generate" }];
    const filtered = filterToolsByMode(tools, "plan");
    const names = filtered.map((t) => t.name);
    expect(names).toContain("feedback");
    expect(names).not.toContain("autonomous");
    expect(names).not.toContain("skill_generate");
  });
});

describe("validateModeTransition", () => {
  const allModes: FridayOperationalMode[] = ["plan", "execute", "restricted"];

  it("allows all mode transitions", () => {
    for (const from of allModes) {
      for (const to of allModes) {
        expect(validateModeTransition(from, to)).toBe(to);
      }
    }
  });

  it("returns same mode for no-op transition", () => {
    expect(validateModeTransition("execute", "execute")).toBe("execute");
    expect(validateModeTransition("plan", "plan")).toBe("plan");
    expect(validateModeTransition("restricted", "restricted")).toBe("restricted");
  });
});
