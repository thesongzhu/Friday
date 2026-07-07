import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UI-W1 Friday Chat screen contract", () => {
  const source = () => readFileSync("ui/src/routes/chat-page.tsx", "utf8");

  it("marks chat as the selected desktop Friday Chat workbench surface", () => {
    const chatSource = source();

    expect(chatSource).toContain('data-ui-screen="desktop-friday-chat"');
    expect(chatSource).toContain('data-ui-component="friday-chat-workbench"');
    expect(chatSource).toContain('data-ui-component="friday-chat-inspector"');
    expect(chatSource).toContain("one workbench area, not chat-first");
    expect(chatSource).toContain("private by default");
  });

  it("keeps the design-required inline proof cards visible and truth-labelled", () => {
    const chatSource = source();

    expect(chatSource).toContain('data-ui-component="chat-approval-proof-card"');
    expect(chatSource).toContain("security_approval_bound_principal_gate_cat10_netnew");
    expect(chatSource).toContain('data-ui-component="chat-memory-candidate-card"');
    expect(chatSource).toContain("memory_review_no_silent_write_decide_candidate");
    expect(chatSource).toContain('data-ui-component="chat-clarify-card"');
    expect(chatSource).toContain("agent_loop_planning_clarify_approval_dangerous_action");
    expect(chatSource).toContain('data-truth="wired_registry"');
    expect(chatSource).toContain("wired_registry !== runtime PASS");
  });

  it("truth-labels the sticky composer send path without claiming runtime execution", () => {
    const chatSource = source();

    expect(chatSource).toContain('data-ui-component="friday-chat-sticky-composer"');
    expect(chatSource).toContain('data-action="send_to_friday"');
    expect(chatSource).toContain('data-cap="ask_friday_chat_compose_send"');
    expect(chatSource).toContain('data-truth="wired_registry"');
    expect(chatSource).toContain("Sent to Hub, not executed");
  });
});
