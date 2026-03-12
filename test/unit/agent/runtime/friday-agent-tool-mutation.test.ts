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

  it("classifies skill_run as mutating", () => {
    expect(isMutatingToolCall("skill_run", {})).toBe(true);
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

  // ─── Conditional: browser ───

  it("classifies browser click as mutating", () => {
    expect(isMutatingToolCall("browser", { action: "click" })).toBe(true);
  });

  it("classifies browser type as mutating", () => {
    expect(isMutatingToolCall("browser", { action: "type" })).toBe(true);
  });

  it("classifies browser navigate as non-mutating", () => {
    expect(isMutatingToolCall("browser", { action: "navigate" })).toBe(false);
  });

  it("classifies browser with non-mutating action as non-mutating", () => {
    expect(isMutatingToolCall("browser", { action: "screenshot" })).toBe(false);
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
