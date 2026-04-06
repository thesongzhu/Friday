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

  it("classifies readonly wave-1 starter skill_run calls as non-mutating", () => {
    expect(isMutatingToolCall("skill_run", { skillId: "idea-clarifier" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "browser-qa-report" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "workspace-diff-review" })).toBe(false);
  });

  it("classifies readonly wave-2 and wave-3 starter skill_run calls as non-mutating", () => {
    expect(isMutatingToolCall("skill_run", { skillId: "page-benchmark-report" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "release-canary-check" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "engineering-retro" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "product-scope-review" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "design-plan-review" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "security-review" })).toBe(false);
  });

  it("classifies release-doc-sync skill_run as mutating", () => {
    expect(isMutatingToolCall("skill_run", { skillId: "release-doc-sync" })).toBe(true);
  });

  it("classifies browser-qa-fix skill_run as mutating", () => {
    expect(isMutatingToolCall("skill_run", { skillId: "browser-qa-fix" })).toBe(true);
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

  // ─── OC-008: browser act sub-action inspection ───

  it("classifies browser act+click as mutating (OC-008)", () => {
    expect(isMutatingToolCall("browser", { action: "act", act: "click" })).toBe(true);
  });

  it("classifies browser act+type as mutating (OC-008)", () => {
    expect(isMutatingToolCall("browser", { action: "act", act: "type" })).toBe(true);
  });

  it("classifies browser act+fill as mutating (OC-008)", () => {
    expect(isMutatingToolCall("browser", { action: "act", act: "fill" })).toBe(true);
  });

  it("classifies browser act+submit as non-mutating when not in mutating set (OC-008)", () => {
    // "submit" is not in the mutatingActions set, so it should be non-mutating
    expect(isMutatingToolCall("browser", { action: "act", act: "submit" })).toBe(false);
  });

  it("classifies browser act+screenshot as non-mutating (OC-008)", () => {
    expect(isMutatingToolCall("browser", { action: "act", act: "screenshot" })).toBe(false);
  });

  it("classifies browser act with no sub-action as non-mutating (OC-008)", () => {
    // "act" alone is not in mutatingActions, so when args.act is missing, returns false
    expect(isMutatingToolCall("browser", { action: "act" })).toBe(false);
  });

  it("classifies readonly system actions as non-mutating", () => {
    expect(isMutatingToolCall("system", { action: "snapshot" })).toBe(false);
    expect(isMutatingToolCall("system", { action: "search_file" })).toBe(false);
  });

  it("classifies mutating system actions as mutating", () => {
    expect(isMutatingToolCall("system", { action: "open_url" })).toBe(true);
    expect(isMutatingToolCall("system", { action: "approve" })).toBe(true);
  });

  it("classifies readonly desktop actions as non-mutating", () => {
    expect(isMutatingToolCall("desktop", { action: "session_info" })).toBe(false);
    expect(isMutatingToolCall("desktop", { action: "screenshot" })).toBe(false);
    expect(isMutatingToolCall("desktop", { action: "check_permissions" })).toBe(false);
  });

  it("classifies mutating desktop actions as mutating", () => {
    expect(isMutatingToolCall("desktop", { action: "execute" })).toBe(true);
    expect(isMutatingToolCall("desktop", { action: "start_recording" })).toBe(true);
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
