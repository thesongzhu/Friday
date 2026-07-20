import { describe, expect, it } from "vitest";

import {
  buildSessionCreateEnvelope,
  buildSessionMessageAppendEnvelope,
  parseSessionCreateResult,
  parseSessionMessageAppendResult,
  type FridayRustHubSessionCreateRequest,
  type FridayRustHubSessionMessageAppendRequest,
} from "../../../../src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js";

// (CORE-A CR-3) The session create/append wire builders map the TS request onto the EXACT snake_case
// `friday-protocol` `SessionCreateRequestWire` / `SessionMessageAppendRequestWire` shapes. Like the
// sibling MemoryDecision wire, `Message::SessionCreateRequest` is a SINGLE-FIELD WRAPPER
// (`{ request: SessionCreateRequestWire }`) on an internally-tagged (`#[serde(tag = "kind")]`)
// `Message`, so serde NESTS the inner fields under a `request` key (NOT flat under `message`). A flat
// shape 503s server-side on `Envelope::decode`. The golden fixtures below pin the byte-exact
// `{kind,request}` nesting against the Rust round-trip test
// (friday-protocol/src/lib.rs `session_lifecycle_wire_round_trips_and_uses_the_request_result_wrapper`).

describe("buildSessionCreateEnvelope (SessionCreateRequestWire wire mapping)", () => {
  it("emits EXACTLY the golden {kind, request:{...snake_case}} envelope (all axes present)", () => {
    const request: FridayRustHubSessionCreateRequest = {
      sessionId: "discord:default:chat-1",
      channel: "discord",
      chatId: "chat-1",
      userId: "owner-1",
      accountId: "default",
      chatKind: "dm",
      metadataJson: '{"source":"cr3"}',
    };
    const env = buildSessionCreateEnvelope(request);
    expect(env.msg_id).toBe("session-create-discord:default:chat-1");
    const message = env.message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "SessionCreateRequest",
      request: {
        session_id: "discord:default:chat-1",
        channel: "discord",
        chat_id: "chat-1",
        user_id: "owner-1",
        account_id: "default",
        chat_kind: "dm",
        metadata_json: '{"source":"cr3"}',
      },
    });
    // The wrapper key is `request` (flat-shape 503 regression guard) + NO camelCase leak.
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
    const inner = message.request as Record<string, unknown>;
    expect("sessionId" in inner).toBe(false);
    expect("chatKind" in inner).toBe(false);
  });

  it("OMITS absent optional axes (byte-clean; round-trips to None Rust-side)", () => {
    const env = buildSessionCreateEnvelope({ sessionId: "system:default:heartbeat" });
    const inner = (env.message as Record<string, unknown>).request as Record<string, unknown>;
    // Only the required session_id rides the wire; no null-valued keys.
    expect(Object.keys(inner)).toEqual(["session_id"]);
    expect("channel" in inner).toBe(false);
    expect("metadata_json" in inner).toBe(false);
  });
});

describe("buildSessionMessageAppendEnvelope (SessionMessageAppendRequestWire wire mapping)", () => {
  it("emits EXACTLY the golden {kind, request:{session_id, role, content, refs}} envelope", () => {
    const request: FridayRustHubSessionMessageAppendRequest = {
      sessionId: "discord:default:chat-1",
      role: "user",
      content: "remember teal",
      refs: "run-7",
    };
    const message = buildSessionMessageAppendEnvelope(request).message as Record<string, unknown>;
    expect(message).toEqual({
      kind: "SessionMessageAppendRequest",
      request: {
        session_id: "discord:default:chat-1",
        role: "user",
        content: "remember teal",
        refs: "run-7",
      },
    });
    expect(Object.keys(message).sort()).toEqual(["kind", "request"]);
  });

  it("OMITS refs when absent (conditional-spread; byte-clean)", () => {
    const inner = (
      buildSessionMessageAppendEnvelope({
        sessionId: "discord:default:chat-1",
        role: "assistant",
        content: "ok",
      }).message as Record<string, unknown>
    ).request as Record<string, unknown>;
    expect(Object.keys(inner).sort()).toEqual(["content", "role", "session_id"]);
    expect("refs" in inner).toBe(false);
  });
});

describe("parseSessionCreateResult (SessionCreateResultWire wire mapping)", () => {
  it("unwraps the nested `result` and surfaces the refs-only receipt with the rust_wired label", () => {
    const parsed = parseSessionCreateResult({
      kind: "SessionCreateResult",
      result: { session_id: "discord:default:chat-1", created_at: 900, updated_at: 1000 },
    });
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      sessionId: "discord:default:chat-1",
      createdAt: 900,
      updatedAt: 1000,
    });
  });

  it("fails closed (undefined) on a missing wrapper / id / timestamp (never a fake receipt)", () => {
    expect(parseSessionCreateResult({ kind: "SessionCreateResult" })).toBeUndefined();
    expect(
      parseSessionCreateResult({ result: { created_at: 900, updated_at: 1000 } }),
    ).toBeUndefined();
    // created_at ill-typed (string) → fail closed.
    expect(
      parseSessionCreateResult({ result: { session_id: "s", created_at: "900", updated_at: 1000 } }),
    ).toBeUndefined();
  });
});

describe("parseSessionMessageAppendResult (SessionMessageAppendResultWire wire mapping)", () => {
  it("surfaces the refs-only receipt (seq=0 is a VALID ordinal, not falsy-rejected)", () => {
    const parsed = parseSessionMessageAppendResult({
      kind: "SessionMessageAppendResult",
      result: {
        message_id: "discord:default:chat-1:m0",
        seq: 0,
        created_at: 1002,
        updated_at: 1002,
      },
    });
    expect(parsed).toEqual({
      truthLabel: "rust_wired",
      messageId: "discord:default:chat-1:m0",
      seq: 0,
      createdAt: 1002,
      updatedAt: 1002,
    });
  });

  it("fails closed (undefined) on a missing wrapper / message id / seq", () => {
    expect(parseSessionMessageAppendResult({ kind: "SessionMessageAppendResult" })).toBeUndefined();
    expect(
      parseSessionMessageAppendResult({ result: { seq: 0, created_at: 1, updated_at: 1 } }),
    ).toBeUndefined();
    // seq ill-typed (string) → fail closed.
    expect(
      parseSessionMessageAppendResult({
        result: { message_id: "m", seq: "0", created_at: 1, updated_at: 1 },
      }),
    ).toBeUndefined();
  });
});
