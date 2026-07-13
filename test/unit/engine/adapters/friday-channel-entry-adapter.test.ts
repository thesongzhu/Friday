import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFridayChannelEntryAdapter,
  FRIDAY_CHANNEL_AGENT_SCOPE,
  FRIDAY_CHANNEL_CONTROL_ROUTE,
} from "../../../../src/engine/adapters/friday-channel-entry-adapter.js";
import { FRIDAY_SUPPORTED_CHANNEL_KINDS } from "../../../../src/channels/friday-channel-config.js";
import type { FridayChannelAttachment } from "../../../../src/channels/friday-channel.types.js";
import type {
  FridayEngineRunResult,
  FridayRunTerminalStatus,
} from "../../../../src/engine/friday-orchestration-engine.types.js";

describe("FridayChannelEntryAdapter", () => {
  it("derives tenantContext from inbound channel messages", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-1",
      resolveDisabledToolNames: () => [],
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-1",
      channelKind: "discord",
      senderId: "user-42",
      chatId: "chat-7",
      chatType: "direct",
      text: "hello",
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "user-42",
      scopes: [FRIDAY_CHANNEL_AGENT_SCOPE],
      disabledToolNames: [],
      taskAlreadyInHistory: true,
      executionContext: expect.objectContaining({
        surface: "channel",
        interactive: true,
        channelKind: "discord",
        channelChatType: "direct",
        channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
      }),
      tenantContext: {
        hubId: "default",
        userId: "user-42",
        channelKind: "discord",
      },
    }));
  });

  it.each([...FRIDAY_SUPPORTED_CHANNEL_KINDS])(
    "routes %s messages through the unified channel engine contract",
    async (channelKind) => {
      const executeRun = vi.fn().mockResolvedValue({
        runId: `run-${channelKind}`,
        status: "completed",
        toolCallCount: 0,
        durationMs: 10,
      });

      const adapter = createFridayChannelEntryAdapter({
        engine: {
          executeRun,
        },
        idGenerator: () => `run-${channelKind}`,
        resolveDisabledToolNames: () => [],
        resolveSessionKey: (message) => `channel:${message.channelKind}:${message.chatId}`,
      });

      await adapter.handleMessage({
        id: `msg-${channelKind}`,
        channelKind,
        senderId: "user-42",
        chatId: "chat-7",
        chatType: "direct",
        text: "A",
        replyToMessageId: `assistant-${channelKind}`,
      });

      expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
        task: "A",
        runId: `run-${channelKind}`,
        sessionKey: `channel:${channelKind}:chat-7`,
        replyToMessageId: `assistant-${channelKind}`,
        taskAlreadyInHistory: true,
        idempotencyPrefix: `channel-${channelKind}`,
        executionContext: expect.objectContaining({
          surface: "channel",
          channelKind,
          channelChatType: "direct",
          channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
        }),
        tenantContext: {
          hubId: "default",
          userId: "user-42",
          channelKind,
        },
      }));
    },
  );

  it("keeps chat channels on the full agent route without hub-admin scope", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-2",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-2",
      resolveDisabledToolNames: (channelKind) => channelKind === "telegram" ? ["dangerous-local-test-tool"] : [],
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-2",
      channelKind: "telegram",
      senderId: "user-99",
      chatId: "chat-9",
      chatType: "direct",
      text: "帮我查资料并整理成 PDF",
    });

    const input = executeRun.mock.calls[0]?.[0];
    expect(input?.executionContext).toEqual(expect.objectContaining({
      surface: "channel",
      channelChatType: "direct",
      channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
    }));
    expect(input?.scopes).toEqual([FRIDAY_CHANNEL_AGENT_SCOPE]);
    expect(input?.scopes).not.toContain("hub.admin");
    expect(input?.disabledToolNames).toEqual(["dangerous-local-test-tool"]);
  });

  it("forwards Feishu capability consultations to the full agent route without converting them to setup", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-feishu-consult",
      status: "completed",
      response: "可以，我先确认入口和项目范围。",
      toolCallCount: 2,
      durationMs: 20,
      usageInput: 10,
      usageOutput: 12,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-feishu-consult",
      resolveDisabledToolNames: () => [],
      resolveSessionKey: (message) => `channel:${message.channelKind}:${message.chatId}`,
    });

    const task = "Friday 能不能帮我把公司内部一个混乱项目审计清楚、列出问题、排优先级、必要时生成报告和自动化？";
    await adapter.handleMessage({
      id: "msg-feishu-consult",
      channelKind: "feishu",
      senderId: "feishu-user-1",
      chatId: "feishu-chat-1",
      chatType: "direct",
      text: task,
      timezone: "Asia/Shanghai",
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task,
      runId: "run-feishu-consult",
      sessionKey: "channel:feishu:feishu-chat-1",
      timezone: "Asia/Shanghai",
      scopes: [FRIDAY_CHANNEL_AGENT_SCOPE],
      disabledToolNames: [],
      executionContext: expect.objectContaining({
        surface: "channel",
        interactive: true,
        channelKind: "feishu",
        channelChatType: "direct",
        channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE,
      }),
      tenantContext: {
        hubId: "default",
        userId: "feishu-user-1",
        channelKind: "feishu",
      },
    }));
  });

  it("allows image-only channel messages to reach the agent", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-3",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-3",
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-image",
      channelKind: "feishu",
      senderId: "user-image",
      chatId: "chat-image",
      chatType: "direct",
      text: "",
      images: ["data:image/png;base64,iVBORw=="],
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "Analyze the attached image.",
      images: ["data:image/png;base64,iVBORw=="],
    }));
  });

  it("passes normalized attachments through the channel task prompt", async () => {
    const executeRun = vi.fn().mockResolvedValue({
      runId: "run-4",
      status: "completed",
      toolCallCount: 0,
      durationMs: 10,
    });

    const adapter = createFridayChannelEntryAdapter({
      engine: {
        executeRun,
      },
      idGenerator: () => "run-4",
      resolveSessionKey: (message) => `${message.channelKind}:default:${message.chatId}`,
    });

    await adapter.handleMessage({
      id: "msg-file",
      channelKind: "feishu",
      senderId: "user-file",
      chatId: "chat-file",
      chatType: "direct",
      text: "",
      attachments: [
        {
          id: "att-1",
          kind: "file",
          filename: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 3,
          localPath: "/tmp/friday-channel-attachments/report.pdf",
          status: "resolved",
        },
      ],
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "Analyze the attached media.",
      taskPrompt: expect.stringContaining("/tmp/friday-channel-attachments/report.pdf"),
    }));
  });
});

// ─── PRIV-RAW-AUDIO per-run cleanup (unlink owned temp files on run-terminal) ───
//
// The channel-entry adapter is the single shared seam for every channel: it
// awaits engine.executeRun and holds both msg.attachments[].localPath and the
// terminal run status. These tests write REAL files to disk, hand them to
// handleMessage as owned attachments, and assert the exact localPath is unlinked
// on genuinely-terminal statuses / reject, kept on suspended statuses, and that
// cleanup never touches a foreign file sharing the same dir.
describe("FridayChannelEntryAdapter per-run attachment cleanup", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-perrun-cleanup-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a real temp file carrying `marker` and return an owned attachment for it. */
  function writeOwnedAttachment(
    marker: string,
    overrides: Partial<FridayChannelAttachment> = {},
  ): FridayChannelAttachment {
    const localPath = path.join(dir, `${marker}.bin`);
    fs.writeFileSync(localPath, marker);
    return {
      id: `att-${marker}`,
      kind: "audio",
      filename: "voice.mp3",
      contentType: "audio/mpeg",
      localPath,
      status: "resolved",
      ...overrides,
    };
  }

  function makeAdapter(executeRun: ReturnType<typeof vi.fn>) {
    return createFridayChannelEntryAdapter({
      engine: { executeRun },
      idGenerator: () => "run-cleanup",
      resolveSessionKey: (message) => `${message.channelKind}:${message.chatId}`,
    });
  }

  function inbound(attachments: FridayChannelAttachment[]) {
    return {
      id: "msg-cleanup",
      channelKind: "feishu",
      senderId: "user-c",
      chatId: "chat-c",
      chatType: "direct" as const,
      text: "transcribe this",
      attachments,
    };
  }

  const TERMINAL_DELETE: FridayRunTerminalStatus[] = [
    "completed",
    "failed",
    "cancelled",
    "failed_tests",
    "timeout",
  ];
  const SUSPENDED_KEEP: FridayRunTerminalStatus[] = [
    "awaiting_plan_approval",
    "awaiting_clarification",
  ];

  it.each(TERMINAL_DELETE)(
    "unlinks the owned attachment localPath on terminal status %s",
    async (status) => {
      const marker = `TERMINAL_${status}`;
      const attachment = writeOwnedAttachment(marker);
      expect(fs.existsSync(attachment.localPath!)).toBe(true);

      const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => ({
        runId: "run-cleanup",
        status,
        toolCallCount: 0,
        durationMs: 5,
      }));
      const adapter = makeAdapter(executeRun);

      const result = await adapter.handleMessage(inbound([attachment]));

      expect(result.status).toBe(status);
      // Exact owned path unlinked immediately on terminal.
      expect(fs.existsSync(attachment.localPath!)).toBe(false);
    },
  );

  it("reads the file DURING the run then unlinks it (no use-after-unlink / no-degrade)", async () => {
    const marker = "NO_DEGRADE_READ_DURING_RUN";
    const attachment = writeOwnedAttachment(marker);

    let bytesSeenDuringRun: string | undefined;
    const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => {
      // The run must still be able to READ the file mid-execution.
      bytesSeenDuringRun = fs.readFileSync(attachment.localPath!, "utf8");
      return { runId: "run-cleanup", status: "completed", toolCallCount: 0, durationMs: 5 };
    });
    const adapter = makeAdapter(executeRun);

    await adapter.handleMessage(inbound([attachment]));

    expect(bytesSeenDuringRun).toContain(marker); // proves the file was live during the run
    expect(fs.existsSync(attachment.localPath!)).toBe(false); // and gone after terminal
  });

  it.each(SUSPENDED_KEEP)(
    "keeps the owned attachment file on suspended status %s (resume needs it)",
    async (status) => {
      const marker = `SUSPENDED_${status}`;
      const attachment = writeOwnedAttachment(marker);

      const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => ({
        runId: "run-cleanup",
        status,
        toolCallCount: 0,
        durationMs: 5,
      }));
      const adapter = makeAdapter(executeRun);

      await adapter.handleMessage(inbound([attachment]));

      // File SURVIVES — deleting it would break engine.resumeRun (use-after-unlink).
      expect(fs.existsSync(attachment.localPath!)).toBe(true);
      expect(fs.readFileSync(attachment.localPath!, "utf8")).toBe(marker);
    },
  );

  it("deletes the owned file AND re-throws the original error when the run rejects", async () => {
    const marker = "REJECT_THEN_DELETE";
    const attachment = writeOwnedAttachment(marker);
    const boom = new Error("engine blew up mid-run");

    const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => {
      throw boom;
    });
    const adapter = makeAdapter(executeRun);

    // Original error propagates (never swallowed).
    await expect(adapter.handleMessage(inbound([attachment]))).rejects.toBe(boom);
    // Uncertain-terminal reject → privacy-safe delete still happened.
    expect(fs.existsSync(attachment.localPath!)).toBe(false);
  });

  it("is correlation-safe: never touches a foreign file sharing the same dir", async () => {
    const ownedMarker = "OWNED_ONLY";
    const attachment = writeOwnedAttachment(ownedMarker);

    // A foreign file NOT on msg.attachments, in the SAME directory.
    const foreignPath = path.join(dir, "foreign-not-owned.bin");
    fs.writeFileSync(foreignPath, "FOREIGN_NOT_ON_MESSAGE");

    const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => ({
      runId: "run-cleanup",
      status: "completed",
      toolCallCount: 0,
      durationMs: 5,
    }));
    const adapter = makeAdapter(executeRun);

    await adapter.handleMessage(inbound([attachment]));

    expect(fs.existsSync(attachment.localPath!)).toBe(false); // owned removed …
    expect(fs.existsSync(foreignPath)).toBe(true); // … foreign untouched (no dir scan)
    expect(fs.readFileSync(foreignPath, "utf8")).toBe("FOREIGN_NOT_ON_MESSAGE");
  });

  it("is idempotent on double-invoke (ENOENT no-op, no throw)", async () => {
    const marker = "DOUBLE_INVOKE";
    const attachment = writeOwnedAttachment(marker);

    const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => ({
      runId: "run-cleanup",
      status: "completed",
      toolCallCount: 0,
      durationMs: 5,
    }));
    const adapter = makeAdapter(executeRun);

    await adapter.handleMessage(inbound([attachment]));
    expect(fs.existsSync(attachment.localPath!)).toBe(false);

    // Second invoke with the same (now-stale) attachment must not throw.
    const second = await adapter.handleMessage(inbound([attachment]));
    expect(second.status).toBe("completed");
    expect(fs.existsSync(attachment.localPath!)).toBe(false);
  });

  it("skips non-owned paths: unresolved status and http sourceUrl-style paths are left alone", async () => {
    // (a) status !== "resolved" → not successfully saved → do not unlink.
    const deferredMarker = "DEFERRED_STATUS";
    const deferred = writeOwnedAttachment(deferredMarker, { status: "deferred" });
    // (b) an http(s) localPath is a remote ref, not an owned local temp file.
    const httpAttachment: FridayChannelAttachment = {
      id: "att-http",
      kind: "file",
      status: "resolved",
      localPath: "https://example.invalid/remote-file.bin",
    };

    const executeRun = vi.fn(async (): Promise<FridayEngineRunResult> => ({
      runId: "run-cleanup",
      status: "completed",
      toolCallCount: 0,
      durationMs: 5,
    }));
    const adapter = makeAdapter(executeRun);

    // Must not throw despite the http "path", and must leave the deferred file alone.
    const result = await adapter.handleMessage(inbound([deferred, httpAttachment]));
    expect(result.status).toBe("completed");
    expect(fs.existsSync(deferred.localPath!)).toBe(true);
    expect(fs.readFileSync(deferred.localPath!, "utf8")).toBe(deferredMarker);
  });
});
