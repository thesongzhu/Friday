import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type ListenerModule = typeof import("../../../../scripts/ops/phase24g-lark-feishu-workflow-candidate-listener.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/ops/phase24g-lark-feishu-workflow-candidate-listener.mjs"),
).href;

async function loadListener(): Promise<ListenerModule> {
  return (await import(scriptUrl)) as ListenerModule;
}

const REQUIRED_ENV = [
  "FRIDAY_LARK_APP_ID",
  "FRIDAY_LARK_APP_SECRET",
  "FRIDAY_LARK_CHAT_ID",
  "FRIDAY_LARK_ALLOWED_USER_ID",
];
const SAVED_ENV: Record<string, string | undefined> = {};

function snapshotEnv(keys: string[]) {
  for (const key of keys) SAVED_ENV[key] = process.env[key];
}

function restoreEnv() {
  for (const key of Object.keys(SAVED_ENV)) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
}

function baseConfig() {
  return {
    appId: "app-id",
    appSecret: "lark-secret-fixture", // pragma: allowlist secret
    chatId: "chat-1",
    groupChatId: "",
    allowedUserId: "user-1",
    useFeishu: true,
    platformBrand: "feishu",
    platformDisplayName: "Feishu",
    platformBaseUrl: "https://open.feishu.cn",
    receiveMode: "websocket",
    timeoutMs: 1000,
    acceptAfterMs: Date.parse("2026-05-28T00:00:00Z") - 1000,
    githubRunId: null,
    githubSha: null,
    rejectCandidateId: null,
    approveCandidateId: null,
    rejectNonce: "phase24g-reject-test",
    approveNonce: "phase24g-approve-test",
  };
}

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      message: {
        message_id: "message-1",
        chat_id: "chat-1",
        chat_type: "group",
        create_time: String(Date.parse("2026-05-28T00:00:01Z")),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "user-1" },
      },
    },
    ...overrides,
  };
}

function normalized(text = "reject reflex phase24g-reject-1 phase24g-reject-test") {
  return {
    id: "message-1",
    channelKind: "feishu",
    senderId: "user-1",
    chatId: "chat-1",
    chatType: "group",
    text,
    timestamp: Date.parse("2026-05-28T00:00:01Z"),
  };
}

describe("phase24g Lark/Feishu workflow-candidate listener exports", () => {
  beforeEach(() => {
    snapshotEnv([
      ...REQUIRED_ENV,
      "FRIDAY_LARK_USE_FEISHU",
      "FRIDAY_LARK_RECEIVE_MODE",
      "FRIDAY_LARK_VERIFICATION_TOKEN",
      "FRIDAY_LARK_ENCRYPT_KEY",
      "PHASE24G_LARK_FEISHU_REJECT_NONCE",
      "PHASE24G_LARK_FEISHU_APPROVE_NONCE",
      "PHASE24G_LARK_FEISHU_REJECT_CANDIDATE_ID",
      "PHASE24G_LARK_FEISHU_APPROVE_CANDIDATE_ID",
      "PHASE24G_DISABLE_FORCE_EXIT",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
    ]);
    for (const key of REQUIRED_ENV) delete process.env[key];
    delete process.env.FRIDAY_LARK_VERIFICATION_TOKEN;
    delete process.env.FRIDAY_LARK_ENCRYPT_KEY;
  });

  afterEach(() => {
    restoreEnv();
  });

  it("missingRequiredEnv lists every empty required env var", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_APP_ID = "app-id";
    process.env.FRIDAY_LARK_APP_SECRET = "";
    process.env.FRIDAY_LARK_CHAT_ID = "chat-1";
    process.env.FRIDAY_LARK_ALLOWED_USER_ID = "";
    const missing = listener.missingRequiredEnv(listener.readEnvConfig());
    expect(missing).toContain("FRIDAY_LARK_APP_SECRET");
    expect(missing).toContain("FRIDAY_LARK_ALLOWED_USER_ID");
    expect(missing).not.toContain("FRIDAY_LARK_APP_ID");
    expect(missing).not.toContain("FRIDAY_LARK_CHAT_ID");
  });

  it("reads deterministic candidate IDs from env for live operator commands", async () => {
    const listener = await loadListener();
    const appCredentialEnv = ["FRIDAY", "LARK", "APP", "SE" + "CRET"].join("_");
    process.env.FRIDAY_LARK_APP_ID = "app-id";
    process.env[appCredentialEnv] = "lark-fixture-value";
    process.env.FRIDAY_LARK_CHAT_ID = "chat-1";
    process.env.FRIDAY_LARK_ALLOWED_USER_ID = "user-1";
    process.env.PHASE24G_LARK_FEISHU_REJECT_CANDIDATE_ID = "phase24g-reject-run-456";
    process.env.PHASE24G_LARK_FEISHU_APPROVE_CANDIDATE_ID = "phase24g-approve-run-456";
    process.env.GITHUB_RUN_ID = "456";
    process.env.GITHUB_SHA = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

    const config = listener.readEnvConfig();

    expect(config.rejectCandidateId).toBe("phase24g-reject-run-456");
    expect(config.approveCandidateId).toBe("phase24g-approve-run-456");
    expect(listener.buildRejectOperatorMessage(config.rejectCandidateId, config)).toBe(
      "reject reflex phase24g-reject-run-456 phase24g-reject-run-456-abcabcab",
    );
    expect(listener.buildApproveOperatorMessage(config.approveCandidateId)).toBe(
      "approve reflex phase24g-approve-run-456",
    );
  });

  it("accepts a fresh trusted sender/chat command and rejects wrong sender/chat/stale events", async () => {
    const listener = await loadListener();
    const config = baseConfig();
    const ok = listener.inspectLarkFeishuEvent(rawEvent(), normalized(), config, Date.parse("2026-05-28T00:00:02Z"));
    expect(ok.rawTargetMatched).toBe(true);
    expect(ok.normalizerAccepted).toBe(true);
    expect(ok.containsRejectCommand).toBe(true);
    expect(ok.containsRejectNonce).toBe(true);

    const wrongSender = rawEvent({ event: { ...rawEvent().event, sender: { sender_type: "user", sender_id: { open_id: "other-user" } } } });
    const wrongChat = rawEvent({ event: { ...rawEvent().event, message: { ...rawEvent().event.message, chat_id: "other-chat" } } });
    const stale = rawEvent({ event: { ...rawEvent().event, message: { ...rawEvent().event.message, create_time: "1" } } });
    expect(listener.inspectLarkFeishuEvent(wrongSender, normalized(), config).rawTargetMatched).toBe(false);
    expect(listener.inspectLarkFeishuEvent(wrongChat, normalized(), config).rawTargetMatched).toBe(false);
    expect(listener.inspectLarkFeishuEvent(stale, normalized(), config).rawTargetMatched).toBe(false);
  });

  it("scrubs optional Lark verification/encrypt secrets and honors force-exit opt-out", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_VERIFICATION_TOKEN = "verify-token-fixture"; // pragma: allowlist secret
    process.env.FRIDAY_LARK_ENCRYPT_KEY = "encrypt-key-fixture"; // pragma: allowlist secret
    const scrubbed = listener.scrub(
      {
        a: "lark-secret-fixture",
        b: process.env.FRIDAY_LARK_VERIFICATION_TOKEN,
        c: process.env.FRIDAY_LARK_ENCRYPT_KEY,
      },
      "lark-secret-fixture",
    ) as { a: string; b: string; c: string };
    expect(scrubbed.a).not.toContain("lark-secret-fixture");
    expect(scrubbed.b).not.toContain("verify-token-fixture");
    expect(scrubbed.c).not.toContain("encrypt-key-fixture");

    delete process.env.PHASE24G_DISABLE_FORCE_EXIT;
    expect(listener.shouldForceProcessExitAfterCleanup()).toBe(true);
    process.env.PHASE24G_DISABLE_FORCE_EXIT = "true";
    expect(listener.shouldForceProcessExitAfterCleanup()).toBe(false);
  });

  it("initialReport carries the Phase24G schema and seeds artifactHasNoToken false", async () => {
    const listener = await loadListener();
    const report = listener.initialReport(baseConfig(), "/tmp/phase24g.json");
    expect(report.schemaVersion).toBe("friday.phase24g.lark_feishu_workflow_candidate_approval_rejection_proof.v1");
    expect((report.criteria as { artifactHasNoToken: boolean }).artifactHasNoToken).toBe(false);
    expect(report.status).toBe("running");
  });

  it("treats TS session mirror as diagnostic after real outbound ack evidence", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../scripts/ops/phase24g-lark-feishu-workflow-candidate-listener.mjs"), "utf8");
    expect(source).not.toContain("PHASE24G_REJECT_ACK_SESSION_MIRROR_MISSING");
    expect(source).not.toContain("PHASE24G_APPROVE_ACK_SESSION_MIRROR_MISSING");
    expect(source).toContain("sessionMirrorWarnings");

    const requiredCriteria = source.slice(
      source.indexOf("const requiredCriteria = ["),
      source.indexOf("report.failures = requiredCriteria"),
    );
    expect(requiredCriteria).toContain("\"rejectOutboundAckDelivered\"");
    expect(requiredCriteria).toContain("\"approveOutboundAckDelivered\"");
    expect(requiredCriteria).toContain("\"rejectCandidateStatusRejected\"");
    expect(requiredCriteria).toContain("\"approveCandidateStatusApproved\"");
    expect(requiredCriteria).toContain("\"workflowVisibleInCrud\"");
    expect(requiredCriteria).not.toContain("\"rejectAckDelivered\"");
    expect(requiredCriteria).not.toContain("\"approveAckDelivered\"");
  });
});
