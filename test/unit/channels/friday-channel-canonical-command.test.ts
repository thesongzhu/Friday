// Phase 14.5E module_28e Slice 6.3 — channel canonical command + risk
// preview routing. These tests verify the verb/target → riskLevel table
// is deterministic, that low/medium commands route to in-channel
// confirmation, and that high-risk commands route to the owner-link
// request shape.

import { describe, expect, it } from "vitest";

import {
  buildFridayChannelDispatchReplyText,
  buildFridayChannelOwnerLinkPath,
  parseFridayChannelCanonicalCommand,
  routeFridayChannelDispatch,
  type FridayChannelCanonicalCommandParseInput,
} from "#channels";

function baseInput(text: string): FridayChannelCanonicalCommandParseInput {
  return {
    channelKind: "discord",
    chatId: "chat-123",
    chatType: "group",
    senderId: "user-abc",
    text,
  };
}

describe("parseFridayChannelCanonicalCommand", () => {
  it("returns null for empty input", () => {
    expect(parseFridayChannelCanonicalCommand(baseInput(""))).toBeNull();
    expect(parseFridayChannelCanonicalCommand(baseInput("   "))).toBeNull();
  });

  it("returns null for unrecognized commands", () => {
    expect(parseFridayChannelCanonicalCommand(baseInput("hello world"))).toBeNull();
    expect(parseFridayChannelCanonicalCommand(baseInput("friday hello"))).toBeNull();
  });

  it("maps low-risk verbs to riskLevel=low", () => {
    expect(parseFridayChannelCanonicalCommand(baseInput("status"))?.riskLevel).toBe("low");
    expect(parseFridayChannelCanonicalCommand(baseInput("friday health"))?.riskLevel).toBe("low");
    expect(parseFridayChannelCanonicalCommand(baseInput("diagnose"))?.riskLevel).toBe("low");
  });

  it("maps preview-style verbs to riskLevel=medium", () => {
    expect(parseFridayChannelCanonicalCommand(baseInput("preview repair"))?.riskLevel).toBe("medium");
    expect(parseFridayChannelCanonicalCommand(baseInput("Friday Repair Preview"))?.riskLevel).toBe("medium");
    expect(parseFridayChannelCanonicalCommand(baseInput("fix preview"))?.riskLevel).toBe("medium");
  });

  it("maps execute-style and rotation verbs to riskLevel=high", () => {
    expect(parseFridayChannelCanonicalCommand(baseInput("apply repair"))?.riskLevel).toBe("high");
    expect(parseFridayChannelCanonicalCommand(baseInput("rollback"))?.riskLevel).toBe("high");
    expect(parseFridayChannelCanonicalCommand(baseInput("rotate credential"))?.riskLevel).toBe("high");
    expect(parseFridayChannelCanonicalCommand(baseInput("approve action-xyz"))?.riskLevel).toBe("high");
    expect(parseFridayChannelCanonicalCommand(baseInput("execute action-xyz"))?.riskLevel).toBe("high");
  });

  it("yields the same command for the same input (deterministic)", () => {
    const first = parseFridayChannelCanonicalCommand(baseInput("friday status"));
    const second = parseFridayChannelCanonicalCommand(baseInput("friday status"));
    expect(first).toEqual(second);
  });

  it("captures the trailing actionId for approve/execute verbs", () => {
    const approve = parseFridayChannelCanonicalCommand(baseInput("approve action-9999"));
    expect(approve?.args.actionId).toBe("action-9999");
    const execute = parseFridayChannelCanonicalCommand(baseInput("execute action-9999"));
    expect(execute?.args.actionId).toBe("action-9999");
  });
});

describe("routeFridayChannelDispatch", () => {
  it("returns no_match for unrecognized text", () => {
    expect(routeFridayChannelDispatch(baseInput("hello"))).toEqual({ kind: "no_match" });
  });

  it("routes low/medium risk to in-channel risk preview", () => {
    const lowOutcome = routeFridayChannelDispatch(baseInput("status"));
    expect(lowOutcome.kind).toBe("risk_preview");
    if (lowOutcome.kind === "risk_preview") {
      expect(lowOutcome.preview.confirmation).toBe("in_channel");
      expect(lowOutcome.preview.command.riskLevel).toBe("low");
    }
    const mediumOutcome = routeFridayChannelDispatch(baseInput("preview repair"));
    expect(mediumOutcome.kind).toBe("risk_preview");
    if (mediumOutcome.kind === "risk_preview") {
      expect(mediumOutcome.preview.confirmation).toBe("in_channel");
      expect(mediumOutcome.preview.command.riskLevel).toBe("medium");
    }
  });

  it("routes high risk to an owner-link request, never to in-channel confirmation", () => {
    const highOutcome = routeFridayChannelDispatch(baseInput("apply repair"));
    expect(highOutcome.kind).toBe("owner_link_required");
    if (highOutcome.kind === "owner_link_required") {
      expect(highOutcome.request.riskLevel).toBe("high");
      expect(highOutcome.request.ownerLinkPath.startsWith("/v1/channels/actions/")).toBe(true);
      expect(highOutcome.request.ownerLinkPath.endsWith("/owner-approve")).toBe(true);
    }
  });

  it("re-uses approve/execute actionId arg in the owner-link path", () => {
    const outcome = routeFridayChannelDispatch(baseInput("approve action-9999"));
    expect(outcome.kind).toBe("owner_link_required");
    if (outcome.kind === "owner_link_required") {
      expect(outcome.request.actionId).toBe("action-9999");
      expect(outcome.request.ownerLinkPath).toBe(buildFridayChannelOwnerLinkPath("action-9999"));
    }
  });
});

describe("buildFridayChannelDispatchReplyText", () => {
  it("returns null for no_match outcomes", () => {
    expect(
      buildFridayChannelDispatchReplyText({ kind: "no_match" }),
    ).toBeNull();
  });

  it("renders the low/medium preview text with the no-auto-execute note", () => {
    const outcome = routeFridayChannelDispatch(baseInput("status"));
    expect(outcome.kind).toBe("risk_preview");
    const reply = buildFridayChannelDispatchReplyText(outcome);
    expect(reply).toContain("Friday canonical command: status runtime");
    expect(reply).toContain("Preview only");
    expect(reply).toContain("Friday will not auto-execute");
    // Owner-link must never appear in a low/medium reply.
    expect(reply).not.toContain("/v1/channels/actions/");
    expect(reply).not.toContain("owner-approve");
  });

  it("renders the high-risk preview text with the owner-link path and no execution promise", () => {
    const outcome = routeFridayChannelDispatch(baseInput("apply repair"));
    expect(outcome.kind).toBe("owner_link_required");
    const reply = buildFridayChannelDispatchReplyText(outcome);
    expect(reply).toContain("[risk=high]");
    expect(reply).toContain("owner-signed approval");
    expect(reply).toContain("/v1/channels/actions/");
    expect(reply).toContain("/owner-approve");
    // The reply must not advertise auto-execute or include any token
    // material that would let the channel approve the action.
    expect(reply?.toLowerCase()).not.toContain("token");
    expect(reply?.toLowerCase()).not.toContain("auto-execute");
  });
});
