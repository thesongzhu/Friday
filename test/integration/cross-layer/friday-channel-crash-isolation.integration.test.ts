import { describe, expect, it } from "vitest";
import { createFridayChannelRegistry } from "../../../src/channels/friday-channel-registry.js";
import type {
  FridayChannelPlugin,
  FridayChannelMessage,
  FridayChannelSendOptions,
} from "../../../src/channels/friday-channel.types.js";

function createMockPlugin(
  kind: string,
  options?: { throwOnStart?: boolean },
): FridayChannelPlugin {
  return {
    kind,
    async init() {},
    async start(onMessage: (msg: FridayChannelMessage) => void) {
      if (options?.throwOnStart) {
        throw new Error(`${kind} failed to start`);
      }
    },
    async stop() {},
    async send(_options: FridayChannelSendOptions) {
      return { messageId: `${kind}-msg-1` };
    },
  };
}

describe("friday channel crash isolation", () => {
  it("startAllBestEffort isolates channel failures — healthy channel still starts", async () => {
    const registry = createFridayChannelRegistry();

    const healthyPlugin = createMockPlugin("healthy-channel");
    const crashingPlugin = createMockPlugin("crashing-channel", {
      throwOnStart: true,
    });

    registry.register(healthyPlugin);
    registry.register(crashingPlugin);

    const messages: FridayChannelMessage[] = [];
    const handler = (msg: FridayChannelMessage) => messages.push(msg);

    const summary = await registry.startAllBestEffort(handler);

    expect(summary.startedKinds).toContain("healthy-channel");
    expect(summary.startedKinds).not.toContain("crashing-channel");
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.kind).toBe("crashing-channel");
    expect(summary.failed[0]!.message).toContain("failed to start");
  });

  it("healthy channel is still usable after sibling crash", async () => {
    const registry = createFridayChannelRegistry();

    const healthyPlugin = createMockPlugin("alpha");
    const crashingPlugin = createMockPlugin("beta", { throwOnStart: true });

    registry.register(healthyPlugin);
    registry.register(crashingPlugin);

    await registry.startAllBestEffort(() => {});

    const entry = registry.get("alpha");
    expect(entry).toBeDefined();
    expect(entry!.running).toBe(true);

    const betaEntry = registry.get("beta");
    expect(betaEntry).toBeDefined();
    expect(betaEntry!.running).toBe(false);
  });

  it("startAll rolls back healthy channels when any channel fails", async () => {
    const registry = createFridayChannelRegistry();

    const healthyPlugin = createMockPlugin("good-ch");
    const crashingPlugin = createMockPlugin("bad-ch", { throwOnStart: true });

    registry.register(healthyPlugin);
    registry.register(crashingPlugin);

    await expect(registry.startAll(() => {})).rejects.toThrow(
      /Failed to start/,
    );

    const goodEntry = registry.get("good-ch");
    expect(goodEntry?.running).toBe(false);
  });

  it("describe() reports health status for failed channels", async () => {
    const registry = createFridayChannelRegistry();

    const crashingPlugin = createMockPlugin("crash-report", {
      throwOnStart: true,
    });
    registry.register(crashingPlugin);

    await registry.startAllBestEffort(() => {});

    const view = registry.describe("crash-report");
    expect(view).toBeDefined();
    expect(view!.running).toBe(false);
    expect(view!.health.lastError).toContain("failed to start");
    expect(view!.health.blockedReason).toBe("start_failed");
  });
});
