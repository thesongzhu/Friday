/**
 * Lark `pbbp2` Frame protobuf schema (loaded via protobufjs runtime).
 *
 * Vendor-adapted verbatim from `@larksuiteoapi/node-sdk` (MIT, lines
 * 88349–88795 of `es/index.js`). The original SDK ships a 750-LOC generated
 * encoder/decoder; here we declare the same wire-shape as a small `.proto`
 * string and let `protobufjs.parse()` produce the encoder/decoder at runtime.
 *
 * Wire-format reference (must match SDK exactly):
 *   field 1 (varint, uint64) SeqID
 *   field 2 (varint, uint64) LogID
 *   field 3 (varint, int32)  service
 *   field 4 (varint, int32)  method
 *   field 5 (length-delim)   headers (repeated Header)
 *   field 6 (length-delim)   payloadEncoding (string)
 *   field 7 (length-delim)   payloadType (string)
 *   field 8 (length-delim)   payload (bytes)
 *   field 9 (length-delim)   LogIDNew (string)
 *
 * The SDK calls `$protobuf.util.Long = undefined; $protobuf.configure()` so
 * the 64-bit fields decode as plain JS numbers rather than `Long` instances.
 * We do the same so equality checks (e.g. SeqID echo on ACK) match the SDK.
 */

import protobuf from "protobufjs";

// Force protobufjs to decode 64-bit ints as plain numbers (not `Long`).
// Must run before any encode/decode call. Mirrors SDK lines 88105–88106.
(protobuf.util as unknown as { Long: unknown }).Long = undefined;
protobuf.configure();

const SCHEMA = `
syntax = "proto3";
package pbbp2;

message Header {
  string key   = 1;
  string value = 2;
}

message Frame {
  uint64 SeqID            = 1;
  uint64 LogID            = 2;
  int32  service          = 3;
  int32  method           = 4;
  repeated Header headers = 5;
  string payloadEncoding  = 6;
  string payloadType      = 7;
  bytes  payload          = 8;
  string LogIDNew         = 9;
}
`;

const root = protobuf.parse(SCHEMA, { keepCase: true }).root;
const FrameType = root.lookupType("pbbp2.Frame");
const HeaderType = root.lookupType("pbbp2.Header");

export interface LarkFrameHeader {
  key: string;
  value: string;
}

export interface LarkFrame {
  SeqID: number;
  LogID: number;
  service: number;
  method: number;
  headers?: LarkFrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
}

export function encodeLarkFrame(frame: LarkFrame): Uint8Array {
  const message = FrameType.create(frame as unknown as Record<string, unknown>);
  return FrameType.encode(message).finish();
}

export function decodeLarkFrame(buffer: Uint8Array): LarkFrame {
  const decoded = FrameType.decode(buffer);
  const plain = FrameType.toObject(decoded, {
    longs: Number,
    bytes: Array,
    arrays: true,
    defaults: false,
  }) as Record<string, unknown>;
  // `toObject({ bytes: Array })` yields a plain number[]; convert back to
  // Uint8Array so downstream UTF-8 decoding and base64 encoding are correct.
  const payload = plain.payload as number[] | undefined;
  return {
    SeqID: Number(plain.SeqID ?? 0),
    LogID: Number(plain.LogID ?? 0),
    service: Number(plain.service ?? 0),
    method: Number(plain.method ?? 0),
    headers: (plain.headers as LarkFrameHeader[] | undefined) ?? [],
    payloadEncoding: typeof plain.payloadEncoding === "string" ? plain.payloadEncoding : "",
    payloadType: typeof plain.payloadType === "string" ? plain.payloadType : "",
    payload: payload ? Uint8Array.from(payload) : new Uint8Array(0),
    LogIDNew: typeof plain.LogIDNew === "string" ? plain.LogIDNew : "",
  };
}

// Exported for tests that want to round-trip without the wrapping helpers.
export const __internal = { FrameType, HeaderType };
