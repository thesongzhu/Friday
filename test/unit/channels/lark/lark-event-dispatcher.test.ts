import { describe, it, expect, vi } from "vitest";
import { LarkEventDispatcher } from "../../../../src/channels/lark/internal/lark-event-dispatcher.js";

describe("LarkEventDispatcher", () => {
  it("routes v2 (schema-style) events by header.event_type and flattens header + event into the handler payload", async () => {
    const handler = vi.fn(async () => ({ ack: true }));
    const dispatcher = new LarkEventDispatcher().register({
      "im.message.receive_v1": handler,
    });

    const envelope = {
      schema: "2.0",
      header: {
        event_id: "evt-1",
        event_type: "im.message.receive_v1",
        tenant_key: "t",
      },
      event: {
        message: { message_id: "msg-1", chat_id: "chat-1", chat_type: "p2p" },
        sender: { sender_id: { open_id: "ou-1", name: "alice" } },
      },
    };

    const result = await dispatcher.invoke(envelope, { needCheck: false });

    expect(result).toEqual({ ack: true });
    expect(handler).toHaveBeenCalledOnce();
    const passed = handler.mock.calls[0]![0] as Record<string, unknown>;
    // header fields lifted to top:
    expect(passed.event_id).toBe("evt-1");
    expect(passed.event_type).toBe("im.message.receive_v1");
    // event fields lifted to top — this is what friday-lark-channel reads:
    expect(passed.message).toEqual({ message_id: "msg-1", chat_id: "chat-1", chat_type: "p2p" });
    expect(passed.sender).toEqual({ sender_id: { open_id: "ou-1", name: "alice" } });
    // raw header/event are NOT kept around (matches SDK parse output)
    expect(passed.header).toBeUndefined();
    expect(passed.event).toBeUndefined();
  });

  it("routes v1 (event.type-style) events by event.type and flattens event into the handler payload", async () => {
    const handler = vi.fn(async () => undefined);
    const dispatcher = new LarkEventDispatcher().register({
      "message": handler,
    });

    const envelope = {
      uuid: "u-1",
      event: {
        type: "message",
        text: "hello",
      },
    };

    await dispatcher.invoke(envelope, { needCheck: false });
    const passed = handler.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed.uuid).toBe("u-1");
    expect(passed.text).toBe("hello");
    expect(passed.event).toBeUndefined();
  });

  it("returns undefined when no handler is registered for the event type", async () => {
    const dispatcher = new LarkEventDispatcher();
    const result = await dispatcher.invoke(
      { schema: "2.0", header: { event_type: "unhandled" }, event: {} },
      { needCheck: false },
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when the envelope is missing event_type / event.type", async () => {
    const dispatcher = new LarkEventDispatcher().register({
      "foo": vi.fn(async () => ({})),
    });
    const result = await dispatcher.invoke({ schema: "2.0", header: {} }, { needCheck: false });
    expect(result).toBeUndefined();
  });

  it("accepts encryptKey/verificationToken as opaque options without consulting them on the WS path", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const dispatcher = new LarkEventDispatcher({
      encryptKey: "this-would-decrypt-on-HTTP",
      verificationToken: "this-would-sign-on-HTTP",
    }).register({ "x": handler });

    const result = await dispatcher.invoke(
      { schema: "2.0", header: { event_type: "x" }, event: { foo: 1 } },
      { needCheck: false },
    );
    expect(result).toEqual({ ok: true });
    // Constructor-level options are exposed for parity but not enforced:
    expect(dispatcher.encryptKey).toBe("this-would-decrypt-on-HTTP");
    expect(dispatcher.verificationToken).toBe("this-would-sign-on-HTTP");
  });

  it("register returns this for chaining and overwrites prior handlers for the same key", async () => {
    const first = vi.fn(async () => ({ from: "first" }));
    const second = vi.fn(async () => ({ from: "second" }));
    const dispatcher = new LarkEventDispatcher()
      .register({ "k": first })
      .register({ "k": second });
    const result = await dispatcher.invoke(
      { schema: "2.0", header: { event_type: "k" }, event: {} },
      { needCheck: false },
    );
    expect(result).toEqual({ from: "second" });
    expect(first).not.toHaveBeenCalled();
  });
});
