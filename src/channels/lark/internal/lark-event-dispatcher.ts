/**
 * Lark event dispatcher used by the native WS client.
 *
 * Vendor-adapted from `@larksuiteoapi/node-sdk` (MIT, lines 87710–87842 of
 * `es/index.js`). The SDK's `EventDispatcher` performs:
 *   1. Optional signature verification against `encryptKey` (HTTP-only —
 *      WS-mode calls pass `needCheck:false`, so we skip it here).
 *   2. `RequestHandle.parse(data)` to flatten the Lark event envelope:
 *        - v2 (`schema` in data): merge `{...rest, ...header, ...event}` and
 *          route by `header.event_type`.
 *        - v1 (`event` in data):  merge `{...rest, ...event}` and route by
 *          `event.type`.
 *      Friday's `friday-lark-channel.ts#parseMessageEventBase` reads
 *      `eventData.message` and `eventData.sender` from the post-parse object,
 *      so we MUST keep this flattening identical or inbound messages will
 *      silently stop normalizing.
 *
 * Friday only uses WS mode, so `encryptKey` and `verificationToken` are
 * accepted as opaque options for parity with the SDK constructor signature
 * but are not consulted on the WS path.
 */

import { LarkLoggerProxy } from "./lark-logger.js";
import type { LarkLogger, LarkLoggerLevelName } from "./lark-logger.js";

export type LarkEventHandler = (event: Record<string, unknown>) => unknown | Promise<unknown>;

export interface LarkEventDispatcherOptions {
  /** HTTP-mode signature secret; ignored on the WS path. */
  encryptKey?: string;
  /** HTTP-mode token; ignored on the WS path. */
  verificationToken?: string;
  loggerLevel?: LarkLoggerLevelName | number;
  logger?: LarkLogger;
}

export interface LarkInvokeOptions {
  /** Mirrors SDK's `invoke(data, {needCheck:false})` flag; WS path sets false. */
  needCheck?: boolean;
}

interface LarkRawEventEnvelope {
  schema?: string;
  header?: { event_type?: string };
  event?: { type?: string };
  [key: string]: unknown;
}

function flattenEnvelope(envelope: LarkRawEventEnvelope): { type: string | undefined; flattened: Record<string, unknown> } {
  // v2 envelope: { schema, header, event, ... } — header.event_type is the
  // routing key; merge {rest, header, event} so handlers see a flat object.
  if (typeof envelope.schema === "string") {
    const { header, event, ...rest } = envelope;
    const flattened: Record<string, unknown> = {
      ...rest,
      ...((header && typeof header === "object") ? header as Record<string, unknown> : {}),
      ...((event && typeof event === "object") ? event as Record<string, unknown> : {}),
    };
    return { type: header?.event_type, flattened };
  }
  // v1 envelope: { event, ... } — event.type is the routing key.
  const { event, ...rest } = envelope;
  const flattened: Record<string, unknown> = {
    ...rest,
    ...((event && typeof event === "object") ? event as Record<string, unknown> : {}),
  };
  return { type: event?.type, flattened };
}

export class LarkEventDispatcher {
  private readonly handles = new Map<string, LarkEventHandler>();
  private readonly logger: LarkLoggerProxy;
  /** Retained for parity with SDK option shape; unused on the WS path. */
  readonly encryptKey: string;
  /** Retained for parity with SDK option shape; unused on the WS path. */
  readonly verificationToken: string;

  constructor(options: LarkEventDispatcherOptions = {}) {
    this.encryptKey = options.encryptKey ?? "";
    this.verificationToken = options.verificationToken ?? "";
    this.logger = new LarkLoggerProxy(options.loggerLevel ?? "warn", options.logger);
  }

  register(handles: Record<string, LarkEventHandler>): this {
    for (const [key, handler] of Object.entries(handles)) {
      if (this.handles.has(key)) {
        this.logger.warn(`[lark-dispatcher] handler for ${key} already registered; overwriting`);
      }
      this.handles.set(key, handler);
    }
    return this;
  }

  async invoke(
    rawEvent: Record<string, unknown>,
    _options: LarkInvokeOptions = {},
  ): Promise<unknown> {
    const { type, flattened } = flattenEnvelope(rawEvent as LarkRawEventEnvelope);
    if (!type) {
      this.logger.debug("[lark-dispatcher] event missing event_type / event.type, ignoring");
      return undefined;
    }
    const handler = this.handles.get(type);
    if (!handler) {
      this.logger.debug(`[lark-dispatcher] no handler for ${type}`);
      return undefined;
    }
    return handler(flattened);
  }
}
