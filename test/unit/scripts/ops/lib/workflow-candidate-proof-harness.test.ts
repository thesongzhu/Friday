import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type WorkflowHarnessModule = typeof import("../../../../../scripts/ops/lib/workflow-candidate-proof-harness.mjs");

const harnessUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../../scripts/ops/lib/workflow-candidate-proof-harness.mjs"),
).href;

async function loadHarness(): Promise<WorkflowHarnessModule> {
  return (await import(harnessUrl)) as WorkflowHarnessModule;
}

describe("workflow-candidate proof harness outbound ack observer", () => {
  it("records real channelRegistry.send delivery evidence for candidate acks", async () => {
    const { observeChannelOutboundAcks, waitForObservedChannelAck } = await loadHarness();
    const report = { diagnostics: {} as Record<string, unknown> };
    const persisted: string[] = [];
    const hub = {
      channelRegistry: {
        async send(kind: string, options: { chatId: string; text: string; replyTo?: string }) {
          return { messageId: `msg-${kind}-${options.chatId}` };
        },
      },
    };

    const observer = observeChannelOutboundAcks(hub, report, async (reason: string) => {
      persisted.push(reason);
    });

    await hub.channelRegistry.send("discord", {
      chatId: "chat-abcdef12",
      replyTo: "source-12345678",
      text: "Reflex candidate candidate-123 已更新为 approved。",
    });

    const ack = await waitForObservedChannelAck(observer, "candidate-123", "approved", 100);

    expect(ack).toMatchObject({
      kind: "discord",
      chatIdTail: "abcdef12",
      replyToMessageIdTail: "12345678",
      messageIdTail: "abcdef12",
      reflexCandidateAck: true,
    });
    expect(report.diagnostics.channelOutboundDeliveries).toEqual([ack]);
    expect(persisted).toEqual(["channel_outbound_delivery"]);

    observer.restore();
    await hub.channelRegistry.send("discord", {
      chatId: "chat-second",
      text: "Reflex candidate candidate-456 已更新为 rejected。",
    });
    expect(observer.deliveries).toHaveLength(1);
  });
});
