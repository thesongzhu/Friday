import { describe, it, expect } from "vitest";

import { createFridayBriefSlackCollector } from "../../../../src/brief/collectors/friday-brief-slack-collector.js";
import { buildDefaultFridayBriefConfig } from "../../../../src/brief/friday-brief-config.types.js";

function ctx(overrides: Partial<{
  fromIso: string;
  toIso: string;
  config: ReturnType<typeof buildDefaultFridayBriefConfig>;
  signal: AbortSignal;
  userId: string;
}> = {}) {
  return {
    fromIso: "2026-04-24T00:00:00.000Z",
    toIso: "2026-04-24T20:00:00.000Z",
    config: buildDefaultFridayBriefConfig(),
    signal: new AbortController().signal,
    userId: "u-1",
    ...overrides,
  };
}

function fakeFetch(responseByUrl: Map<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = [...responseByUrl.keys()].find((key) => url.includes(key));
    if (!method) {
      throw new Error(`no fake response for ${url}`);
    }
    const payload = responseByUrl.get(method);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("createFridayBriefSlackCollector", () => {
  it("skips when disabled", async () => {
    const collector = createFridayBriefSlackCollector({
      resolveSecret: () => undefined,
    });
    const result = await collector.collect(ctx());
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("source_disabled");
  });

  it("skips when enabled but token is missing", async () => {
    const collector = createFridayBriefSlackCollector({
      resolveSecret: () => undefined,
    });
    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.slack.enabled = true;
    cfg.sources.slack.tokenRefKey = "slack.bot";

    const result = await collector.collect(ctx({ config: cfg }));
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("missing_token");
  });

  it("collects messages from matching channels and filters by userId", async () => {
    const responses = new Map<string, unknown>([
      [
        "conversations.list",
        {
          ok: true,
          channels: [
            { id: "C1", name: "general", is_channel: true },
            { id: "D1", name: "dm-jane", is_im: true },
          ],
        },
      ],
      [
        "conversations.history",
        {
          ok: true,
          messages: [
            { ts: "1714000000.000100", user: "U123", text: "I shipped the fix." },
            { ts: "1714000200.000200", user: "U999", text: "from someone else" },
            { ts: "1714000300.000300", user: "U123", subtype: "channel_join", text: "joined" },
          ],
        },
      ],
    ]);

    const collector = createFridayBriefSlackCollector({
      resolveSecret: () => "xoxb-test-token",
      fetchImpl: fakeFetch(responses),
    });

    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.slack.enabled = true;
    cfg.sources.slack.tokenRefKey = "slack.bot";
    cfg.sources.slack.userId = "U123";
    cfg.sources.slack.includeDms = true;

    const result = await collector.collect(ctx({ config: cfg }));

    expect(result.skipped).toBe(false);
    expect(result.events.length).toBeGreaterThan(0);
    const fromUser = result.events.filter((e) => e.summary.includes("I shipped the fix"));
    expect(fromUser.length).toBeGreaterThan(0);
    const joinSubtype = result.events.filter((e) => e.summary.includes("joined"));
    expect(joinSubtype).toHaveLength(0);
  });

  it("records error when slack API returns ok:false", async () => {
    const badFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const collector = createFridayBriefSlackCollector({
      resolveSecret: () => "xoxb-bad",
      fetchImpl: badFetch,
    });

    const cfg = buildDefaultFridayBriefConfig();
    cfg.sources.slack.enabled = true;
    cfg.sources.slack.tokenRefKey = "slack.bot";

    const result = await collector.collect(ctx({ config: cfg }));
    expect(result.skipped).toBe(false);
    expect(result.error?.message).toContain("invalid_auth");
  });
});
