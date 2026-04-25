import { describe, it, expect } from "vitest";

import { createFridayBriefDeliverer } from "../../../src/brief/friday-brief-deliverer.js";
import type {
  FridayBriefDeliveryClient,
  FridayBriefDeliveryPayload,
} from "../../../src/brief/delivery/friday-brief-delivery.types.js";
import type { FridayBriefChannelKind } from "../../../src/brief/friday-brief.types.js";

function makeClient(params: {
  kind: FridayBriefChannelKind;
  configured?: boolean;
  result?: "ok" | "throw";
  messageId?: string;
  onDeliver?: () => void;
}): FridayBriefDeliveryClient {
  return {
    kind: params.kind,
    isConfigured: () => params.configured ?? true,
    async deliver() {
      params.onDeliver?.();
      if ((params.result ?? "ok") === "throw") {
        throw new Error(`${params.kind} refused to deliver`);
      }
      return { messageId: params.messageId ?? `msg-${params.kind}` };
    },
  };
}

function makePayload(runId = "run-1"): FridayBriefDeliveryPayload {
  return {
    runId,
    transcript: "hi",
    language: "en-US",
    includeTranscript: false,
    audio: { filePath: "/tmp/x.mp3", mimeType: "audio/mpeg", bytes: 1, format: "mp3" },
  };
}

describe("createFridayBriefDeliverer", () => {
  it("delivers through the first configured channel and stops", async () => {
    let wecomCalled = 0;
    let telegramCalled = 0;
    const deliverer = createFridayBriefDeliverer({
      clients: [
        makeClient({ kind: "wecom", onDeliver: () => (wecomCalled += 1) }),
        makeClient({ kind: "telegram", onDeliver: () => (telegramCalled += 1) }),
      ],
      nowIso: () => "2026-04-24T00:00:00.000Z",
    });

    const output = await deliverer.deliver({
      fallbackOrder: ["wecom", "telegram", "email"],
      payload: makePayload(),
      signal: new AbortController().signal,
    });

    expect(wecomCalled).toBe(1);
    expect(telegramCalled).toBe(0);
    expect(output.deliveredVia).toBe("wecom");
    expect(output.attempts).toHaveLength(1);
    expect(output.attempts[0]?.ok).toBe(true);
    expect(output.attempts[0]?.audioAttached).toBe(true);
  });

  it("falls back to the next channel when the first one throws", async () => {
    let telegramCalled = 0;
    const deliverer = createFridayBriefDeliverer({
      clients: [
        makeClient({ kind: "wecom", result: "throw" }),
        makeClient({ kind: "telegram", onDeliver: () => (telegramCalled += 1) }),
      ],
      nowIso: () => "2026-04-24T00:00:00.000Z",
    });

    const output = await deliverer.deliver({
      fallbackOrder: ["wecom", "telegram", "email"],
      payload: makePayload(),
      signal: new AbortController().signal,
    });

    expect(telegramCalled).toBe(1);
    expect(output.deliveredVia).toBe("telegram");
    expect(output.attempts).toHaveLength(2);
    expect(output.attempts[0]?.ok).toBe(false);
    expect(output.attempts[0]?.error?.code).toBe("DELIVERY_ERROR");
    expect(output.attempts[1]?.ok).toBe(true);
  });

  it("records NOT_CONFIGURED without invoking the delivery method", async () => {
    let wecomCalled = 0;
    const deliverer = createFridayBriefDeliverer({
      clients: [
        makeClient({ kind: "wecom", configured: false, onDeliver: () => (wecomCalled += 1) }),
        makeClient({ kind: "telegram" }),
      ],
      nowIso: () => "2026-04-24T00:00:00.000Z",
    });

    const output = await deliverer.deliver({
      fallbackOrder: ["wecom", "telegram", "email"],
      payload: makePayload(),
      signal: new AbortController().signal,
    });

    expect(wecomCalled).toBe(0);
    expect(output.attempts[0]?.error?.code).toBe("NOT_CONFIGURED");
    expect(output.deliveredVia).toBe("telegram");
  });

  it("reports CLIENT_MISSING when a channel has no registered client", async () => {
    const deliverer = createFridayBriefDeliverer({
      clients: [makeClient({ kind: "email" })],
      nowIso: () => "2026-04-24T00:00:00.000Z",
    });

    const output = await deliverer.deliver({
      fallbackOrder: ["wecom", "telegram", "email"],
      payload: makePayload(),
      signal: new AbortController().signal,
    });

    expect(output.attempts[0]?.channel).toBe("wecom");
    expect(output.attempts[0]?.error?.code).toBe("CLIENT_MISSING");
    expect(output.attempts[1]?.error?.code).toBe("CLIENT_MISSING");
    expect(output.deliveredVia).toBe("email");
  });

  it("fails entirely when every channel rejects", async () => {
    const deliverer = createFridayBriefDeliverer({
      clients: [
        makeClient({ kind: "wecom", result: "throw" }),
        makeClient({ kind: "telegram", result: "throw" }),
        makeClient({ kind: "email", configured: false }),
      ],
      nowIso: () => "2026-04-24T00:00:00.000Z",
    });

    const output = await deliverer.deliver({
      fallbackOrder: ["wecom", "telegram", "email"],
      payload: makePayload(),
      signal: new AbortController().signal,
    });

    expect(output.deliveredVia).toBeUndefined();
    expect(output.attempts).toHaveLength(3);
    expect(output.attempts.every((a) => !a.ok)).toBe(true);
  });
});
