import { describe, it, expect } from "vitest";
import { isMutatingToolCall } from "#agent";

describe("isMutatingToolCall", () => {
  // ─── Always mutating ───

  it("classifies write as mutating", () => {
    expect(isMutatingToolCall("write", {})).toBe(true);
  });

  it("classifies edit as mutating", () => {
    expect(isMutatingToolCall("edit", {})).toBe(true);
  });

  it("classifies exec as mutating", () => {
    expect(isMutatingToolCall("exec", {})).toBe(true);
  });

  it("classifies memory_store as mutating", () => {
    expect(isMutatingToolCall("memory_store", {})).toBe(true);
  });

  it("classifies workflow_run as mutating", () => {
    expect(isMutatingToolCall("workflow_run", {})).toBe(true);
  });

  it("classifies unknown skill_run calls as mutating", () => {
    expect(isMutatingToolCall("skill_run", {})).toBe(true);
  });

  it("classifies readonly diagnosis skill_run calls as non-mutating", () => {
    expect(isMutatingToolCall("skill_run", { skillId: "system-health-snapshot" })).toBe(false);
  });

  // ─── Always read-only ───

  it("classifies read as non-mutating", () => {
    expect(isMutatingToolCall("read", {})).toBe(false);
  });

  it("classifies web_fetch as non-mutating", () => {
    expect(isMutatingToolCall("web_fetch", {})).toBe(false);
  });

  it("classifies memory_search as non-mutating", () => {
    expect(isMutatingToolCall("memory_search", {})).toBe(false);
  });

  it("classifies memory_query as non-mutating", () => {
    expect(isMutatingToolCall("memory_query", {})).toBe(false);
  });

  it("classifies spawn_subagent and subagent queries as non-mutating", () => {
    expect(isMutatingToolCall("spawn_subagent", {})).toBe(false);
    expect(isMutatingToolCall("get_subagent", {})).toBe(false);
    expect(isMutatingToolCall("list_subagents", {})).toBe(false);
  });

  it("classifies capabilities as non-mutating", () => {
    expect(isMutatingToolCall("capabilities", {})).toBe(false);
  });

  // ─── Conditional: browser ───

  it("classifies browser click as mutating", () => {
    expect(isMutatingToolCall("browser", { action: "click" })).toBe(true);
  });

  it("classifies browser type as mutating", () => {
    expect(isMutatingToolCall("browser", { action: "type" })).toBe(true);
  });

  it("classifies browser open and navigate as mutating", () => {
    expect(isMutatingToolCall("browser", { action: "open" })).toBe(true);
    expect(isMutatingToolCall("browser", { action: "navigate" })).toBe(true);
  });

  it("classifies browser with non-mutating action as non-mutating", () => {
    expect(isMutatingToolCall("browser", { action: "screenshot" })).toBe(false);
  });

  it("classifies readonly system actions as non-mutating", () => {
    expect(isMutatingToolCall("system", { action: "snapshot" })).toBe(false);
    expect(isMutatingToolCall("system", { action: "search_file" })).toBe(false);
  });

  it("classifies mutating system actions as mutating", () => {
    expect(isMutatingToolCall("system", { action: "open_url" })).toBe(true);
    expect(isMutatingToolCall("system", { action: "approve" })).toBe(true);
  });

  it("classifies readonly gateway actions as non-mutating", () => {
    expect(isMutatingToolCall("gateway", { action: "status" })).toBe(false);
    expect(isMutatingToolCall("gateway", { action: "config_get" })).toBe(false);
  });

  it("classifies mutating gateway actions as mutating", () => {
    expect(isMutatingToolCall("gateway", { action: "restart" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "config_set" })).toBe(true);
  });

  // ─── Conditional: xhs ───

  it("classifies xhs publish_note as mutating", () => {
    expect(isMutatingToolCall("xhs", { action: "publish_note" })).toBe(true);
  });

  it("classifies xhs with read action as non-mutating", () => {
    expect(isMutatingToolCall("xhs", { action: "search" })).toBe(false);
  });

  // ─── Unknown tools ───

  it("classifies unknown tools as mutating for safety", () => {
    expect(isMutatingToolCall("unknown_tool", {})).toBe(true);
  });
});
