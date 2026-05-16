import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFridaySqliteLayer } from "#state";

import { FridayDomainError } from "../../../src/errors/friday-domain-error.js";
import {
  composeFridayTaskWorkflowChannelIssuedDisclosure,
  createFridayTaskWorkflowRepository,
  createFridayTaskWorkflowService,
  getFridayTaskWorkflowChannelDispatchedAction,
  hashFridayChannelIdentifier,
} from "../../../src/task-workflows/index.js";
import type { FridayTaskWorkflowService } from "../../../src/task-workflows/index.js";

let tmpDir: string;
let db: ReturnType<typeof createFridaySqliteLayer>;
let nextId = 0;
let frozenNow = "2026-05-16T00:00:00.000Z";

function makeService(): FridayTaskWorkflowService {
  const repository = createFridayTaskWorkflowRepository();
  return createFridayTaskWorkflowService({
    db,
    repository,
    idGenerator: () => {
      nextId += 1;
      return `id-${nextId.toString(16).padStart(8, "0")}`;
    },
    nowIso: () => frozenNow,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-tw-channel-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  db = createFridaySqliteLayer({
    dbPath,
    readPoolSize: 1,
    pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
  });
  nextId = 0;
  frozenNow = "2026-05-16T00:00:00.000Z";
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    // ok
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Phase 13.5D channel command flow", () => {
  it("hashes channel chat/message/sender ids and never stores raw values", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "channel command flow test",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const result = service.issueChannelCommand(workflow.id, {
      channelKind: "discord",
      channelChatId: "guild-123/channel-456",
      channelMessageId: "msg-789",
      senderId: "user-101",
      intentKind: "progress_query",
    });
    expect(result.command.confirmationToken).toMatch(/^twcc_[0-9a-f]{36}$/);
    expect(result.command.status).toBe("issued");
    expect(result.command.dispatchedAction).toBeNull();
    // Hash sanity: hash(channelKind:channelChatId) must equal what the
    // helper produces, and must NOT equal the raw chat id.
    expect(result.command.channelChatHash).toBe(
      hashFridayChannelIdentifier("discord:guild-123/channel-456"),
    );
    expect(result.command.channelChatHash).not.toContain("guild-123");
    expect(result.command.channelMessageHash).not.toContain("msg-789");
    expect(result.command.senderHash).not.toContain("user-101");
    // The outbound disclosure is Friday-authored and never echoes raw inbound
    // text. It always carries the workflow id, action, and confirmation token.
    expect(result.outboundDisclosure).toContain(workflow.id);
    expect(result.outboundDisclosure).toContain(result.command.confirmationToken);
    expect(result.outboundDisclosure).not.toContain("guild-123/channel-456");
    expect(result.outboundDisclosure).not.toContain("msg-789");
    expect(result.outboundDisclosure).not.toContain("user-101");
  });

  it("confirms an issued command, marks it dispatched, and records the canonical action label", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "confirm flow",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const issued = service.issueChannelCommand(workflow.id, {
      channelKind: "discord",
      channelChatId: "chat-1",
      channelMessageId: "msg-1",
      senderId: "sender-1",
      intentKind: "closeout_request",
    });
    frozenNow = "2026-05-16T00:01:00.000Z";
    const confirmed = service.confirmChannelCommand(workflow.id, {
      confirmationToken: issued.command.confirmationToken,
    });
    expect(confirmed.command.status).toBe("dispatched");
    expect(confirmed.command.dispatchedAction).toBe(
      getFridayTaskWorkflowChannelDispatchedAction("closeout_request"),
    );
    expect(confirmed.command.confirmedAt).toBe("2026-05-16T00:01:00.000Z");
    expect(confirmed.command.dispatchedAt).toBe("2026-05-16T00:01:00.000Z");
    expect(confirmed.outboundDisclosure).toContain("Confirmed");
    expect(confirmed.outboundDisclosure).toContain(workflow.id);
  });

  it("refuses double confirmation of the same token", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "double confirm refusal",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const issued = service.issueChannelCommand(workflow.id, {
      channelKind: "discord",
      channelChatId: "chat-1",
      channelMessageId: "msg-1",
      senderId: "sender-1",
      intentKind: "progress_query",
    });
    service.confirmChannelCommand(workflow.id, {
      confirmationToken: issued.command.confirmationToken,
    });
    expect(() =>
      service.confirmChannelCommand(workflow.id, {
        confirmationToken: issued.command.confirmationToken,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CHANNEL_COMMAND_CLOSED",
      }) as unknown as Error,
    );
  });

  it("marks expired tokens as expired and refuses confirmation", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "expiry handling",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    const issued = service.issueChannelCommand(workflow.id, {
      channelKind: "discord",
      channelChatId: "chat-1",
      channelMessageId: "msg-1",
      senderId: "sender-1",
      intentKind: "progress_query",
      ttlMs: 1000,
    });
    // Advance frozen now beyond the expiresAt window.
    frozenNow = "2026-05-16T01:00:00.000Z";
    expect(() =>
      service.confirmChannelCommand(workflow.id, {
        confirmationToken: issued.command.confirmationToken,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CHANNEL_COMMAND_EXPIRED",
      }) as unknown as Error,
    );
    const list = service.listChannelCommands(workflow.id);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("expired");
  });

  it("refuses unknown tokens for the workflow", () => {
    const service = makeService();
    const workflow = service.create({
      charter: "unknown token",
      taskKind: "general",
      contextPackage: {
        allowedFiles: ["src/x.ts"],
        allowedTools: [],
        allowedApis: [],
        boundaryIds: ["api.task_workflows.core"],
      },
    });
    expect(() =>
      service.confirmChannelCommand(workflow.id, {
        confirmationToken: "no-such-token",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "TASK_WORKFLOW_CHANNEL_COMMAND_NOT_FOUND",
      }) as unknown as Error,
    );
  });

  it("never persists raw channel text on the issued disclosure helper", () => {
    const disclosure = composeFridayTaskWorkflowChannelIssuedDisclosure({
      workflowId: "wf-test",
      intentKind: "supervisor_mode_preview",
      confirmationToken: "twcc_FAKE",
      expiresAt: "2026-05-16T01:00:00Z",
    });
    expect(disclosure).toContain("wf-test");
    expect(disclosure).toContain("twcc_FAKE");
    // No surprising substrings that suggest the helper echoes other input.
    expect(disclosure).not.toContain("guild-");
    expect(disclosure).not.toContain("user-");
  });
});
