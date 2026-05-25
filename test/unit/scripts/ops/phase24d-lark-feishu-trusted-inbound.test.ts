/**
 * R1 — Lark/Feishu trusted-inbound harness. Locks down the exported helpers:
 *   - missingRequiredEnv flags every empty required env var;
 *   - buildProbeNonce sanitises run/sha into [A-Za-z0-9._-];
 *   - scrub redacts the primary appSecret AND any
 *     FRIDAY_LARK_VERIFICATION_TOKEN / FRIDAY_LARK_ENCRYPT_KEY present in env
 *     (defense-in-depth so safeError still scrubs in early-failure branches
 *     where `config` is undefined);
 *   - containsTokenMaterial detects every secret in the redaction set;
 *   - initialReport carries the schemaVersion stable token and seeds every
 *     required criterion as false.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type ListenerModule = typeof import("../../../../scripts/ops/phase24d-lark-feishu-trusted-inbound-listener.mjs");

const scriptUrl = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/ops/phase24d-lark-feishu-trusted-inbound-listener.mjs"),
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

// Test fixtures only — not real credentials. Pragma needed because the
// repo-wide detect-secrets baseline runs entropy checks on every file.
const FAKE_PRIMARY_APP_SECRET = "primary-app-secret-abcdef1234567890"; // pragma: allowlist secret
const FAKE_VERIFY_TOKEN = "verify-token-XYZ-1234567890"; // pragma: allowlist secret
const FAKE_ENCRYPT_KEY = "encrypt-key-XYZ-1234567890"; // pragma: allowlist secret

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

describe("phase24d listener exports", () => {
  beforeEach(() => {
    snapshotEnv([
      ...REQUIRED_ENV,
      "FRIDAY_LARK_USE_FEISHU",
      "FRIDAY_LARK_RECEIVE_MODE",
      "FRIDAY_LARK_VERIFICATION_TOKEN",
      "FRIDAY_LARK_ENCRYPT_KEY",
      "FRIDAY_LARK_GROUP_CHAT_ID",
      "PHASE24D_LARK_FEISHU_PROBE_NONCE",
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
    ]);
    for (const key of REQUIRED_ENV) delete process.env[key];
    delete process.env.FRIDAY_LARK_VERIFICATION_TOKEN;
    delete process.env.FRIDAY_LARK_ENCRYPT_KEY;
    delete process.env.PHASE24D_LARK_FEISHU_PROBE_NONCE;
  });
  afterEach(() => {
    restoreEnv();
  });

  it("missingRequiredEnv lists every empty required env var", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_APP_ID = "lark-app-id-value";
    process.env.FRIDAY_LARK_APP_SECRET = "";
    process.env.FRIDAY_LARK_CHAT_ID = "lark-chat-id-value";
    process.env.FRIDAY_LARK_ALLOWED_USER_ID = "";
    const config = listener.readEnvConfig();
    const missing = listener.missingRequiredEnv(config);
    expect(missing).toContain("FRIDAY_LARK_APP_SECRET");
    expect(missing).toContain("FRIDAY_LARK_ALLOWED_USER_ID");
    expect(missing).not.toContain("FRIDAY_LARK_APP_ID");
    expect(missing).not.toContain("FRIDAY_LARK_CHAT_ID");
  });

  it("buildProbeNonce sanitises run/sha to allowed characters", async () => {
    const listener = await loadListener();
    process.env.GITHUB_RUN_ID = "12345!@#$%";
    process.env.GITHUB_SHA = "abc!@#def!@#";
    const nonce = listener.buildProbeNonce();
    expect(nonce).toMatch(/^phase24d-run-12345-[A-Za-z0-9._-]+$/);
  });

  it("scrub redacts FRIDAY_LARK_VERIFICATION_TOKEN and FRIDAY_LARK_ENCRYPT_KEY in addition to the primary appSecret", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_VERIFICATION_TOKEN = FAKE_VERIFY_TOKEN;
    process.env.FRIDAY_LARK_ENCRYPT_KEY = FAKE_ENCRYPT_KEY;
    const blob = {
      a: `appSecret=${FAKE_PRIMARY_APP_SECRET}`,
      b: `verifyToken=${process.env.FRIDAY_LARK_VERIFICATION_TOKEN}`,
      c: `encryptKey=${process.env.FRIDAY_LARK_ENCRYPT_KEY}`,
    };
    const scrubbed = listener.scrub(blob, FAKE_PRIMARY_APP_SECRET) as typeof blob;
    expect(scrubbed.a).not.toContain(FAKE_PRIMARY_APP_SECRET);
    expect(scrubbed.b).not.toContain(FAKE_VERIFY_TOKEN);
    expect(scrubbed.c).not.toContain(FAKE_ENCRYPT_KEY);
  });

  it("scrub still redacts env-derived secrets even when called with an empty primary token (safeError early-failure path)", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_APP_SECRET = FAKE_PRIMARY_APP_SECRET;
    process.env.FRIDAY_LARK_VERIFICATION_TOKEN = FAKE_VERIFY_TOKEN;
    const blob = {
      a: `appSecret=${process.env.FRIDAY_LARK_APP_SECRET}`,
      b: `verifyToken=${process.env.FRIDAY_LARK_VERIFICATION_TOKEN}`,
    };
    const scrubbed = listener.scrub(blob, "") as typeof blob;
    expect(scrubbed.a).not.toContain(FAKE_PRIMARY_APP_SECRET);
    expect(scrubbed.b).not.toContain(FAKE_VERIFY_TOKEN);
  });

  it("containsTokenMaterial detects any secret in the redaction set", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_VERIFICATION_TOKEN = FAKE_VERIFY_TOKEN;
    expect(listener.containsTokenMaterial(`x=${FAKE_PRIMARY_APP_SECRET}`, FAKE_PRIMARY_APP_SECRET)).toBe(true);
    expect(listener.containsTokenMaterial(`x=${FAKE_VERIFY_TOKEN}`, FAKE_PRIMARY_APP_SECRET)).toBe(true);
    expect(listener.containsTokenMaterial("nothing leaks here", FAKE_PRIMARY_APP_SECRET)).toBe(false);
  });

  it("initialReport carries the schemaVersion stable token and seeds artifactHasNoToken as false (required criterion)", async () => {
    const listener = await loadListener();
    process.env.FRIDAY_LARK_APP_ID = "lark-app-id-value";
    process.env.FRIDAY_LARK_APP_SECRET = FAKE_PRIMARY_APP_SECRET;
    process.env.FRIDAY_LARK_CHAT_ID = "lark-chat-id-value";
    process.env.FRIDAY_LARK_ALLOWED_USER_ID = "lark-allowed-user-id-value";
    const config = listener.readEnvConfig();
    const report = listener.initialReport(config, "/tmp/x.json");
    expect(report.schemaVersion).toBe("friday.phase24d.lark_feishu_trusted_inbound_proof.v1");
    expect((report.criteria as { artifactHasNoToken: boolean }).artifactHasNoToken).toBe(false);
    expect(report.status).toBe("running");
  });
});
