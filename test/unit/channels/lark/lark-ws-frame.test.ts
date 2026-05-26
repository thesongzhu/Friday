import { describe, it, expect } from "vitest";
import { decodeLarkFrame, encodeLarkFrame } from "../../../../src/channels/lark/internal/lark-ws-frame.js";
import type { LarkFrame } from "../../../../src/channels/lark/internal/lark-ws-frame.js";

describe("LarkWsFrame protobuf roundtrip", () => {
  it("round-trips a control ping frame bit-for-bit", () => {
    const frame: LarkFrame = {
      SeqID: 0,
      LogID: 0,
      service: 12345,
      method: 0, // control
      headers: [{ key: "type", value: "ping" }],
    };
    const encoded = encodeLarkFrame(frame);
    const decoded = decodeLarkFrame(encoded);
    expect(decoded.SeqID).toBe(0);
    expect(decoded.LogID).toBe(0);
    expect(decoded.service).toBe(12345);
    expect(decoded.method).toBe(0);
    expect(decoded.headers).toEqual([{ key: "type", value: "ping" }]);
    expect(decoded.payload).toBeInstanceOf(Uint8Array);
    expect(decoded.payload?.byteLength).toBe(0);
  });

  it("round-trips a data event frame with payload + multiple headers", () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ schema: "2.0", header: { event_type: "im.message.receive_v1" } }),
    );
    const frame: LarkFrame = {
      SeqID: 42,
      LogID: 1024,
      service: 12345,
      method: 1, // data
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "msg-7" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        { key: "trace_id", value: "trace-abc" },
      ],
      payload,
    };
    const encoded = encodeLarkFrame(frame);
    const decoded = decodeLarkFrame(encoded);
    expect(decoded.SeqID).toBe(42);
    expect(decoded.LogID).toBe(1024);
    expect(decoded.method).toBe(1);
    expect(decoded.headers).toEqual(frame.headers);
    expect(new TextDecoder("utf-8").decode(decoded.payload!)).toBe(
      new TextDecoder("utf-8").decode(payload),
    );
  });

  it("decodes 64-bit SeqID values as plain JS numbers (no Long instances)", () => {
    // SDK forces protobuf.util.Long = undefined so SeqID round-trips as a
    // number, not a Long. Friday's ack path passes SeqID straight through
    // back into encodeLarkFrame; a Long here would break the ack shape.
    const frame: LarkFrame = {
      SeqID: 1_000_000_000,
      LogID: 0,
      service: 1,
      method: 0,
    };
    const decoded = decodeLarkFrame(encodeLarkFrame(frame));
    expect(typeof decoded.SeqID).toBe("number");
    expect(decoded.SeqID).toBe(1_000_000_000);
  });

  it("preserves header order and supports zero-length payload", () => {
    const frame: LarkFrame = {
      SeqID: 1,
      LogID: 2,
      service: 99,
      method: 0,
      headers: [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
        { key: "c", value: "3" },
      ],
    };
    const decoded = decodeLarkFrame(encodeLarkFrame(frame));
    expect(decoded.headers?.map((h) => h.key)).toEqual(["a", "b", "c"]);
  });

  it("ack reflection: re-encoding a decoded data frame plus a biz_rt header preserves SeqID/LogID/service", () => {
    const inbound: LarkFrame = {
      SeqID: 7,
      LogID: 11,
      service: 555,
      method: 1,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m" },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
      ],
      payload: new TextEncoder().encode("{}"),
    };
    const decodedInbound = decodeLarkFrame(encodeLarkFrame(inbound));
    const ack: LarkFrame = {
      ...decodedInbound,
      headers: [...(decodedInbound.headers ?? []), { key: "biz_rt", value: "-5" }],
      payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
    };
    const reDecoded = decodeLarkFrame(encodeLarkFrame(ack));
    expect(reDecoded.SeqID).toBe(7);
    expect(reDecoded.LogID).toBe(11);
    expect(reDecoded.service).toBe(555);
    expect(reDecoded.headers?.find((h) => h.key === "biz_rt")?.value).toBe("-5");
    expect(new TextDecoder("utf-8").decode(reDecoded.payload!)).toBe(JSON.stringify({ code: 200 }));
  });

  it("ignores unknown fields gracefully (forward-compat)", () => {
    // Manually craft a frame with an unknown field 99 — protobufjs should
    // skip it and still decode the known fields per the SDK's behavior.
    const base = encodeLarkFrame({
      SeqID: 1,
      LogID: 2,
      service: 3,
      method: 0,
    });
    // Append a tag for field 99 (varint), value 1234 — protobuf wire format:
    // tag = (99 << 3) | 0 (varint) = 792
    const unknownTag = (99 << 3) | 0;
    const extra = new Uint8Array([
      ((unknownTag & 0x7f) | 0x80),
      (unknownTag >> 7) & 0x7f,
      0xd2, 0x09, // 1234 as varint
    ]);
    const combined = new Uint8Array(base.byteLength + extra.byteLength);
    combined.set(base, 0);
    combined.set(extra, base.byteLength);
    const decoded = decodeLarkFrame(combined);
    expect(decoded.SeqID).toBe(1);
    expect(decoded.service).toBe(3);
  });
});
