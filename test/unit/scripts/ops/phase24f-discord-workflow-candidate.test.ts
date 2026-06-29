import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type ListenerModule = typeof import("../../../../scripts/ops/phase24f-discord-workflow-candidate-listener.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/ops/phase24f-discord-workflow-candidate-listener.mjs"),
).href;

async function loadListener(): Promise<ListenerModule> {
  return (await import(scriptUrl)) as ListenerModule;
}

const SAVED_ENV: Record<string, string | undefined> = {};
const REQUIRED_ENV = [
  "FRIDAY_DISCORD_BOT_TOKEN",
  "FRIDAY_DISCORD_SETUP_USER_ID",
  "FRIDAY_DISCORD_CHANNEL_ID",
  "FRIDAY_DISCORD_BOT_USER_ID",
];

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
    botToken: "discord-token-fixture", // pragma: allowlist secret
    setupUserId: "user-1",
    guildId: "guild-1",
    channelId: "channel-1",
    botUserId: "bot-1",
    requireMention: true,
    timeoutMs: 1000,
    acceptAfterMs: Date.parse("2026-05-28T00:00:00Z") - 1000,
    githubRunId: null,
    githubSha: null,
    rejectCandidateId: null,
    approveCandidateId: null,
    rejectNonce: "phase24f-reject-test",
    approveNonce: "phase24f-approve-test",
  };
}

function messagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    content: "reject reflex phase24f-reject-1 phase24f-reject-test <@bot-1>",
    timestamp: "2026-05-28T00:00:01.000Z",
    channel_id: "channel-1",
    guild_id: "guild-1",
    author: { id: "user-1", username: "trusted-user", bot: false },
    mentions: [{ id: "bot-1" }],
    ...overrides,
  };
}

describe("phase24f Discord workflow-candidate listener exports", () => {
  beforeEach(() => {
    snapshotEnv([
      ...REQUIRED_ENV,
      "FRIDAY_DISCORD_REQUIRE_MENTION",
      "PHASE24F_DISCORD_REJECT_NONCE",
      "PHASE24F_DISCORD_APPROVE_NONCE",
      "PHASE24F_DISCORD_REJECT_CANDIDATE_ID",
      "PHASE24F_DISCORD_APPROVE_CANDIDATE_ID",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
    ]);
    for (const key of REQUIRED_ENV) delete process.env[key];
  });

  afterEach(() => {
    restoreEnv();
  });

  it("missingRequiredEnv lists every empty required env var", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_DISCORD_BOT_TOKEN = "token";
    process.env.FRIDAY_DISCORD_SETUP_USER_ID = "";
    process.env.FRIDAY_DISCORD_CHANNEL_ID = "channel-1";
    process.env.FRIDAY_DISCORD_BOT_USER_ID = "";
    const missing = listener.missingRequiredEnv(listener.readEnvConfig());
    expect(missing).toContain("FRIDAY_DISCORD_SETUP_USER_ID");
    expect(missing).toContain("FRIDAY_DISCORD_BOT_USER_ID");
    expect(missing).not.toContain("FRIDAY_DISCORD_BOT_TOKEN");
    expect(missing).not.toContain("FRIDAY_DISCORD_CHANNEL_ID");
  });

  it("reads deterministic candidate IDs from env for mention-required live operator commands", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_DISCORD_BOT_TOKEN = "token";
    process.env.FRIDAY_DISCORD_SETUP_USER_ID = "user-1";
    process.env.FRIDAY_DISCORD_CHANNEL_ID = "channel-1";
    process.env.FRIDAY_DISCORD_BOT_USER_ID = "bot-1";
    process.env.PHASE24F_DISCORD_REJECT_CANDIDATE_ID = "phase24f-reject-run-123";
    process.env.PHASE24F_DISCORD_APPROVE_CANDIDATE_ID = "phase24f-approve-run-123";
    process.env.GITHUB_RUN_ID = "123";
    process.env.GITHUB_SHA = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

    const config = listener.readEnvConfig();

    expect(config.rejectCandidateId).toBe("phase24f-reject-run-123");
    expect(config.approveCandidateId).toBe("phase24f-approve-run-123");
    expect(config.requireMention).toBe(true);
    expect(listener.buildRejectOperatorMessage(config.rejectCandidateId, config)).toBe(
      "reject reflex phase24f-reject-run-123 phase24f-reject-run-123-abcabcab <@bot-1>",
    );
    expect(listener.buildApproveOperatorMessage(config.approveCandidateId, config)).toBe(
      "approve reflex phase24f-approve-run-123 <@bot-1>",
    );
  });

  it("builds mention-compatible command text with the mention at the end", async () => {
    const listener = await loadListener();
    const config = baseConfig();
    expect(listener.buildRejectOperatorMessage("candidate-1", config)).toBe(
      "reject reflex candidate-1 phase24f-reject-test <@bot-1>",
    );
    expect(listener.buildApproveOperatorMessage("candidate-2", config)).toBe("approve reflex candidate-2 <@bot-1>");
  });

  it("accepts a fresh trusted sender/channel command and rejects wrong sender/channel/mention", async () => {
    const listener = await loadListener();
    const config = baseConfig();
    const ok = listener.inspectDiscordPayload(messagePayload(), config, Date.parse("2026-05-28T00:00:02Z"));
    expect(ok.rawTargetMatched).toBe(true);
    expect(ok.normalizerAccepted).toBe(true);
    expect(ok.containsRejectCommand).toBe(true);
    expect(ok.containsRejectNonce).toBe(true);

    expect(listener.inspectDiscordPayload(messagePayload({ author: { id: "other-user", bot: false } }), config).rawTargetMatched).toBe(false);
    expect(listener.inspectDiscordPayload(messagePayload({ channel_id: "other-channel" }), config).rawTargetMatched).toBe(false);
    expect(listener.inspectDiscordPayload(messagePayload({ mentions: [] }), config).rawTargetMatched).toBe(false);
  });

  it("diagnoses approve commands that miss the required bot mention", async () => {
    const listener = await loadListener();
    const config = baseConfig();
    const inspection = listener.inspectDiscordPayload(
      messagePayload({
        content: "approve reflex phase24f-approve-run-123",
        mentions: [],
      }),
      config,
      Date.parse("2026-05-28T00:00:02Z"),
    );

    expect(inspection.containsApproveCommand).toBe(true);
    expect(inspection.mentionMatched).toBe(false);
    expect(inspection.normalizerAccepted).toBe(false);
    expect(inspection.rawTargetMatched).toBe(false);
  });

  it("accepts approve commands when the required bot mention is placed first", async () => {
    const listener = await loadListener();
    const config = baseConfig();
    const inspection = listener.inspectDiscordPayload(
      messagePayload({
        content: "<@bot-1> approve reflex phase24f-approve-run-123",
        mentions: [{ id: "bot-1" }],
      }),
      config,
      Date.parse("2026-05-28T00:00:02Z"),
    );

    expect(inspection.containsApproveCommand).toBe(true);
    expect(inspection.mentionMatched).toBe(true);
    expect(inspection.normalizerAccepted).toBe(true);
    expect(inspection.normalized).toMatchObject({ text: "approve reflex phase24f-approve-run-123" });
    expect(inspection.rawTargetMatched).toBe(true);
  });

  it("initialReport carries the Phase24F schema and seeds artifactHasNoToken false", async () => {
    const listener = await loadListener();
    const report = listener.initialReport(baseConfig(), "/tmp/phase24f.json");
    expect(report.schemaVersion).toBe("friday.phase24f.discord_workflow_candidate_approval_rejection_proof.v1");
    expect((report.criteria as { artifactHasNoToken: boolean }).artifactHasNoToken).toBe(false);
    expect(report.status).toBe("running");
  });

  it("treats TS session mirror as diagnostic after real outbound ack evidence", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../scripts/ops/phase24f-discord-workflow-candidate-listener.mjs"), "utf8");
    expect(source).not.toContain("PHASE24F_REJECT_ACK_SESSION_MIRROR_MISSING");
    expect(source).not.toContain("PHASE24F_APPROVE_ACK_SESSION_MIRROR_MISSING");
    expect(source).toContain("sessionMirrorWarnings");
    expect(source.indexOf("const workflowsAfterReject = listWorkflowsByTag")).toBeLessThan(
      source.indexOf("const rejectAck = await waitForCandidateAck"),
    );

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
