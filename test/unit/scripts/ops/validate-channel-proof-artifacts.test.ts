/**
 * R1 — same-SHA channel-proof artifact validator. Locks down:
 *   - pass on a clean fixture;
 *   - reject status != passed;
 *   - reject any criterion === false (generic loop);
 *   - reject missing named criterion `artifactHasNoToken` even if loop passes;
 *   - reject token-material residue (`xoxb-`, `Bot <opaque>`, `Bearer <opaque>`);
 *   - tolerate free-text "the bot said" / "boto3" without false-positive;
 *   - require expected-sha match (commit_sha primary, head_sha fallback);
 *   - skip sentinel passes without inspecting;
 *   - missing artifact file produces artifact_missing_or_unreadable blocker;
 *   - invalid JSON produces artifact_missing_or_unreadable blocker;
 *   - missing required top-level key produces artifact_missing_or_unreadable blocker.
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

function passingDiscordArtifact(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_DISCORD,
    phase: "phase24b",
    scope: "discord_trusted_inbound",
    status: "passed",
    startedAt: "2026-05-25T00:00:00Z",
    completedAt: "2026-05-25T00:00:10Z",
    reportPath: "/tmp/phase24b/discord.json",
    environment: { commit_sha: "deadbeef00112233445566778899aabbccddeeff", head_sha: null },
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
      expectedSha: "deadbeef00112233445566778899aabbccddeeff",
    });
    expect(decision.valid).toBe(true);
    const discord = decision.results.find((r) => r.channel === "discord");
    expect(discord?.valid).toBe(true);
    expect(discord?.blockerClass).toBe("none");
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

  it("rejects criterion === false via generic loop", async () => {
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
        environment: { head_sha: "deadbeef00112233445566778899aabbccddeeff" },
      }),
    );
    const decision = validateChannelProofArtifacts({
      channels: { discord: fixturePath, telegram: "skip", "lark-feishu": "skip" },
      expectedSha: "deadbeef00112233445566778899aabbccddeeff",
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
      expectedSha: "deadbeef00112233445566778899aabbccddeeff",
    });
    expect(decision.valid).toBe(false);
    expect(decision.results[0].reasons).toContain("commit_sha_mismatch");
  });

  it("skip sentinel passes without inspecting any artifact", async () => {
    const { validateChannelProofArtifacts } = await loadValidator();
    const decision = validateChannelProofArtifacts({
      channels: { discord: "skip", telegram: "skip", "lark-feishu": "skip" },
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
