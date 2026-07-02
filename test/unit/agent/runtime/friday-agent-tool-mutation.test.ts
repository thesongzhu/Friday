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

  it("classifies workflow_list as read-only", () => {
    expect(isMutatingToolCall("workflow_list", {})).toBe(false);
  });

  it("classifies all skill_run calls as non-mutating (skills run in sandbox)", () => {
    // skill_run is always read-only — skills execute in their own sandbox
    expect(isMutatingToolCall("skill_run", {})).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "system-health-snapshot" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "idea-clarifier" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "browser-qa-report" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "release-doc-sync" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "browser-qa-fix" })).toBe(false);
    expect(isMutatingToolCall("skill_run", { skillId: "user-generated-skill" })).toBe(false);
  });

  // ─── Always read-only ───

  it("classifies read as non-mutating", () => {
    expect(isMutatingToolCall("read", {})).toBe(false);
  });

  it("classifies web_fetch as non-mutating", () => {
    expect(isMutatingToolCall("web_fetch", {})).toBe(false);
  });

  it("classifies pdf_parse as non-mutating", () => {
    expect(isMutatingToolCall("pdf_parse", { path: "source.pdf" })).toBe(false);
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

  it("classifies request_tool_pack as non-mutating", () => {
    expect(isMutatingToolCall("request_tool_pack", { pack: "code" })).toBe(false);
  });

  it("classifies tool_search as non-mutating", () => {
    expect(isMutatingToolCall("tool_search", { query: "select:provider" })).toBe(false);
  });

  it("classifies MCP call_tool as mutating while keeping discovery/read actions non-mutating", () => {
    expect(isMutatingToolCall("mcp", { action: "call_tool", toolName: "write_scratchpad" })).toBe(true);
    expect(isMutatingToolCall("mcp", { action: "list_tools" })).toBe(false);
    expect(isMutatingToolCall("mcp", { action: "read_resource" })).toBe(false);
    expect(isMutatingToolCall("mcp", { action: "get_prompt" })).toBe(false);
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

  it("classifies Guide Lens observation as read-only and preference writes as mutating", () => {
    expect(isMutatingToolCall("guide_lens", { action: "state" })).toBe(false);
    expect(isMutatingToolCall("guide_lens", { action: "snapshot" })).toBe(false);
    expect(isMutatingToolCall("guide_lens", { action: "show_overlay" })).toBe(false);
    expect(isMutatingToolCall("guide_lens", { action: "update_preferences" })).toBe(true);
    expect(isMutatingToolCall("guide_lens", { action: "update_avatar" })).toBe(true);
  });

  // ─── Conditional: xhs ───

  it("classifies xhs legacy publish_note as mutating", () => {
    expect(isMutatingToolCall("xhs", { action: "publish_note" })).toBe(true);
  });

  it("classifies current xhs browser/egress actions conservatively", () => {
    expect(isMutatingToolCall("xhs", { action: "login" })).toBe(true);
    expect(isMutatingToolCall("xhs", { action: "post" })).toBe(true);
    expect(isMutatingToolCall("xhs", { action: "comments" })).toBe(true);
    expect(isMutatingToolCall("xhs", { action: "search" })).toBe(false);
    expect(isMutatingToolCall("xhs", { action: "status" })).toBe(false);
  });

  // ─── Unknown tools ───

  it("classifies unknown tools as mutating for safety", () => {
    expect(isMutatingToolCall("unknown_tool", {})).toBe(true);
  });

  // ─── exec wrapper / dangerous-flag alignment (P2 safety-labeling: env/find/echo holes) ───
  // isMutatingToolCall must agree with the exec risk gate's unwrapCommand: a read-only program
  // name at the START of the command must NOT mask a mutating INNER command or dangerous flags.

  it("classifies env-wrapped destructive command as mutating", () => {
    // `env FOO=bar rm -rf /tmp/x` previously matched the leading `env` read-only token → false (HOLE)
    expect(isMutatingToolCall("exec", { command: "env FOO=bar rm -rf /tmp/x" })).toBe(true);
    expect(isMutatingToolCall("exec", { command: "FOO=bar BAR=baz rm -rf /tmp/x" })).toBe(true);
  });

  it("classifies env-wrapped mutating (non-destructive) command as mutating", () => {
    // inner program (git commit) is mutating even though wrapped by env
    expect(isMutatingToolCall("exec", { command: "env GIT_AUTHOR=x git commit -m y" })).toBe(true);
  });

  it("keeps env-wrapped read-only command non-mutating", () => {
    expect(isMutatingToolCall("exec", { command: "env LANG=C ls -la" })).toBe(false);
    expect(isMutatingToolCall("exec", { command: "env FOO=bar cat /etc/hosts" })).toBe(false);
  });

  it("classifies find with destructive -delete flag as mutating", () => {
    // `find … -delete` previously matched the leading `find` read-only token → false (HOLE).
    // (`find … -exec rm {} ;` is separately rejected as "blocked" by shell-metachar detection at
    //  the execution gate, so it never runs regardless of this label.)
    expect(isMutatingToolCall("exec", { command: "find /tmp -name '*.log' -delete" })).toBe(true);
  });

  it("keeps read-only find non-mutating", () => {
    expect(isMutatingToolCall("exec", { command: "find . -name '*.ts'" })).toBe(false);
  });

  it("classifies shell -c opaque command string as mutating", () => {
    expect(isMutatingToolCall("exec", { command: "bash -c 'rm -rf /tmp/x'" })).toBe(true);
    expect(isMutatingToolCall("exec", { command: "sh -c \"echo hi > /etc/x\"" })).toBe(true);
  });

  it("keeps plain read-only exec non-mutating (regression guard)", () => {
    expect(isMutatingToolCall("exec", { command: "ls -la" })).toBe(false);
    expect(isMutatingToolCall("exec", { command: "grep -r foo src" })).toBe(false);
    expect(isMutatingToolCall("exec", { command: "printenv" })).toBe(false);
  });

  it("classifies plain mutating exec as mutating (regression guard)", () => {
    expect(isMutatingToolCall("exec", { command: "mkdir foo" })).toBe(true);
    expect(isMutatingToolCall("exec", { command: "git commit -m x" })).toBe(true);
  });
});
