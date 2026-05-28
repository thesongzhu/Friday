/**
 * Same-SHA channel-proof artifact validator. Locks down:
 *   - pass on a clean fixture (Step 1-9 happy path);
 *   - reject status != passed (Step 4);
 *   - reject the explicit named criterion `artifactHasNoToken` when === false (Step 5 named-enforcement);
 *   - reject missing named criterion `artifactHasNoToken` even when other criteria are true (Step 5 missing-enforcement);
 *   - PASS when listener reports status=passed + failures=[] even if
 *     observational/diagnostic criteria (e.g. `<channel>ShortReceiptObserved`)
 *     are false — the validator defers to the listener's authoritative
 *     verdict for non-named criteria (regression test for the dogfood D5
 *     over-rejection incident);
 *   - reject token-material residue (`xoxb-`, `Bot <opaque>`, `Bearer <opaque>`) — Step 8;
 *   - tolerate free-text "the bot said" / "boto3" without false-positive;
 *   - require expected-sha match (commit_sha primary, head_sha fallback) — Step 9;
 *   - skip sentinel passes without inspecting;
 *   - missing artifact file produces artifact_missing_or_unreadable blocker;
 *   - invalid JSON produces artifact_missing_or_unreadable blocker;
 *   - missing required top-level key produces artifact_missing_or_unreadable blocker;
 *   - reject failures array with entries even if status === passed (Step 6).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type ValidatorModule = typeof import("../../../../scripts/ops/validate-channel-proof-artifacts.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/ops/validate-channel-proof-artifacts.mjs"),
).href;

async function loadValidator(): Promise<ValidatorModule> {
  return (await import(scriptUrl)) as ValidatorModule;
}

const SCHEMA_DISCORD = "friday.phase24b.discord_trusted_inbound_proof.v1";
const SCHEMA_DISCORD_WORKFLOW = "friday.phase24f.discord_workflow_candidate_approval_rejection_proof.v1";
const SCHEMA_LARK_WORKFLOW = "friday.phase24g.lark_feishu_workflow_candidate_approval_rejection_proof.v1";
const SCHEMA_TELEGRAM_NATURAL_TRIGGER = "friday.phase24h.telegram_natural_trigger_execution_proof.v1";

// Test fixture SHA only — not a real commit. Pragma needed because the
// repo-wide detect-secrets baseline flags 40-char hex strings as
// "Hex High Entropy String".
const FAKE_SHA = "deadbeef00112233445566778899aabbccddeeff"; // pragma: allowlist secret

function passingDiscordArtifact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_DISCORD,
    phase: "phase24b",
    scope: "discord_trusted_inbound",
    status: "passed",
    startedAt: "2026-05-25T00:00:00Z",
    completedAt: "2026-05-25T00:00:10Z",
    reportPath: "/tmp/phase24b/discord.json",
    environment: { commit_sha: FAKE_SHA, head_sha: null },
    criteria: {
      wsClientConnected: true,
      listenerReceivedMessageReceive: true,
      authorBotFalse: true,
      artifactHasNoToken: true,
    },
    diagnostics: {},
    observedDiscordEvent: { type: "DISCORD_MESSAGE_CREATE_V1" },
    failures: [],
    ...overrides,
  };
}

function passingWorkflowArtifact(
  schemaVersion: string,
  observedEventKey: "observedDiscordEvent" | "observedLarkFeishuEvent" | "observedTelegramEvent",
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion,
    phase: "phase24-workflow-candidate",
    scope: "workflow_candidate",
    status: "passed",
    startedAt: "2026-05-25T00:00:00Z",
    completedAt: "2026-05-25T00:00:10Z",
    reportPath: "/tmp/phase24/workflow-candidate.json",
    environment: { commit_sha: FAKE_SHA, head_sha: null },
    criteria: {
      artifactHasNoToken: true,
      rejectInboundObserved: true,
      approveInboundObserved: true,
    },
    diagnostics: {},
    [observedEventKey]: { type: "WORKFLOW_CANDIDATE_EVENT" },
    failures: [],
    ...overrides,
  };
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "validate-channel-proof-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeFixture(name: string, body: unknown): Promise<string> {
  const filePath = path.join(tmpDir, name);
  await fs.writeFile(filePath, JSON.stringify(body), "utf8");
  return filePath;
}

describe("validateChannelProofArtifacts", () => {
  it("passes on a clean discord fixture; matching commit_sha", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture("pass.json", passingDiscordArtifact());
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(true);
    const discord = decision.results.find((r) => r.channel === "discord");
    expect(discord?.valid).toBe(true);
    expect(discord?.blockerClass).toBe("none");
  });

  it("CLI-style explicit-channel mode rejects omitted channel flags instead of default-skipping them", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture("explicit-mode-pass.json", passingDiscordArtifact());
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      explicitChannels: ["discord", "telegram", "lark-feishu"],
      requireExplicitChannels: true,
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(false);
    const missing = decision.results.find((r) => r.channel === "discord-workflow-candidate");
    expect(missing?.valid).toBe(false);
    expect(missing?.reasons).toContain("channel_flag_missing:--discord-workflow-candidate");
  });

  it("passes on clean Discord and Lark/Feishu workflow-candidate artifacts", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const discordPath = await writeFixture(
      "pass-discord-workflow.json",
      passingWorkflowArtifact(SCHEMA_DISCORD_WORKFLOW, "observedDiscordEvent"),
    );
    const larkPath = await writeFixture(
      "pass-lark-workflow.json",
      passingWorkflowArtifact(SCHEMA_LARK_WORKFLOW, "observedLarkFeishuEvent"),
    );
    const decision = validateChannelProofArtifacts({
      channels: {
        discord: "skip",
        telegram: "skip",
        "lark-feishu": "skip",
        "discord-workflow-candidate": discordPath,
        "lark-feishu-workflow-candidate": larkPath,
      },
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(true);
    expect(decision.results.find((r) => r.channel === "discord-workflow-candidate")?.blockerClass).toBe("none");
    expect(decision.results.find((r) => r.channel === "lark-feishu-workflow-candidate")?.blockerClass).toBe("none");
  });

  it("passes on a clean Telegram natural-trigger artifact", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const naturalTriggerPath = await writeFixture(
      "pass-telegram-natural-trigger.json",
      passingWorkflowArtifact(SCHEMA_TELEGRAM_NATURAL_TRIGGER, "observedTelegramEvent", {
        phase: "Phase24H",
        scope: "telegram_natural_trigger",
        criteria: {
          artifactHasNoToken: true,
          deepseekDefaultConfigured: true,
          deepseekAnsweredPositiveRun: false,
          deepseekAnsweredNegativeRun: false,
          memoryRecallOccurred: true,
          workflowDiscoveryOccurred: true,
          parentRuntimeWorkflowRunExecuted: true,
          workflowRunTerminalSuccess: true,
          negativeUnsafeBlocked: true,
        },
      }),
    );
    const decision = validateChannelProofArtifacts({
      channels: {
        discord: "skip",
        telegram: "skip",
        "lark-feishu": "skip",
        "telegram-natural-trigger": naturalTriggerPath,
      },
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(true);
    expect(decision.results.find((r) => r.channel === "telegram-natural-trigger")?.blockerClass).toBe("none");
  });

  it("rejects status != passed", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture("status-not-passed.json", passingDiscordArtifact({ status: "blocked" }));
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons.some((r: string) => r === "status_not_passed:blocked")).toBe(true);
  });

  it("rejects when explicitly-named criterion artifactHasNoToken === false (validator enforces this one independently)", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "criterion-false.json",
      passingDiscordArtifact({ criteria: { artifactHasNoToken: false } }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons).toContain("criterion_not_true:artifactHasNoToken");
  });

  it("PASSES when listener reports status=passed + failures=[] even if observational/diagnostic criteria are false (defers to listener verdict)", async () => {
    // Regression: dogfood D5 surfaced listener artifacts that wrote optional
    // diagnostic criteria (e.g., `<channel>ShortReceiptObserved`,
    // `assistantSessionReplyObserved`) into `criteria` outside the
    // listener's authoritative `requiredCriteria` set. The previous
    // validator iterated all criteria and over-rejected those artifacts
    // despite status=passed and failures=[]. Lock the new behavior.
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "listener-passed-with-diag-false.json",
      passingDiscordArtifact({
        criteria: {
          // The validator's REQUIRED_NAMED_CRITERIA still must be true.
          artifactHasNoToken: true,
          // The listener owns whether these gate pass; here it said pass.
          discordShortReceiptObserved: false,
          assistantSessionReplyObserved: false,
        },
      }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(true);
    expect(decision.results[0].blockerClass).toBe("none");
  });

  it("rejects missing named criterion artifactHasNoToken even if other criteria are all true", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "criterion-missing.json",
      passingDiscordArtifact({ criteria: { wsClientConnected: true } }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons).toContain("criterion_missing:artifactHasNoToken");
  });

  it("rejects token residue: xoxb- prefix", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const leaked = passingDiscordArtifact({
      diagnostics: { rawSnippet: "configured token: xoxb-FAKEEXAMPLEEXAMPLE" },
    });
    const fixturePath = await writeFixture("residue-xoxb.json", leaked);
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].blockerClass).toBe("artifact_upload_broken");
  });

  it("rejects token residue: Bot <opaque>", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const leaked = passingDiscordArtifact({
      diagnostics: { authHeader: "Bot OTIxNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3.opaque.value" },
    });
    const fixturePath = await writeFixture("residue-bot.json", leaked);
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].blockerClass).toBe("artifact_upload_broken");
  });

  it("does NOT false-positive on the natural-language word 'bot' (no opaque token after it)", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const safe = passingDiscordArtifact({
      diagnostics: { humanText: "the bot said hi", anotherWord: "boto3 is a lib" },
    });
    const fixturePath = await writeFixture("safe-text.json", safe);
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(true);
  });

  it("falls back to head_sha when commit_sha is absent", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "head-sha-fallback.json",
      passingDiscordArtifact({
        environment: { head_sha: FAKE_SHA },
      }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(true);
  });

  it("rejects commit_sha mismatch", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "sha-mismatch.json",
      passingDiscordArtifact({ environment: { commit_sha: "00000000" } }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: FAKE_SHA,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons).toContain("commit_sha_mismatch");
  });

  it("skip sentinel passes without inspecting any artifact", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const decision = validateChannelProofArtifacts({
      channels: {
        discord: "skip",
        telegram: "skip",
        "lark-feishu": "skip",
        "telegram-workflow-candidate": "skip",
        "discord-workflow-candidate": "skip",
        "lark-feishu-workflow-candidate": "skip",
      },
      expectedSha: null,
    });
    expect(decision.valid).toBe(true);
    for (const result of decision.results) {
      expect((result as { skipped?: boolean }).skipped).toBe(true);
    }
  });

  it("missing file produces artifact_missing_or_unreadable", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const decision = validateChannelProofArtifacts({
      channels: { discord: path.join(tmpDir, "does-not-exist.json"), telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].blockerClass).toBe("artifact_missing_or_unreadable");
  });

  it("missing required top-level key produces artifact_missing_or_unreadable", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture("missing-key.json", { schemaVersion: SCHEMA_DISCORD });
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].blockerClass).toBe("artifact_missing_or_unreadable");
  });

  it("rejects failures array with entries even if status === passed", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const fixturePath = await writeFixture(
      "failures-nonempty.json",
      passingDiscordArtifact({ failures: ["unexpected"] }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: null,
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons.some((r: string) => r.startsWith("failures_present"))).toBe(true);
  });
});
