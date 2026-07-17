import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { resolveFridayAuditLogPath, appendFridayAuditLog } from "#hub";
import type { FridayAuditLogWrite } from "#hub";

describe("FridayHubAuditLogWriter", () => {
  let tmpDir: string;
  let logPath: string;

  function makeEntry(action: string): FridayAuditLogWrite {
    return {
      id: `audit-${action}`,
      ts: new Date().toISOString(),
      actorType: "user",
      actorId: "user-1",
      action,
      resourceType: "skill",
      resourceId: "skill-1",
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-test-"));
    logPath = path.join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveFridayAuditLogPath", () => {
    it("returns path under .friday directory", () => {
      const result = resolveFridayAuditLogPath("/my/state");
      expect(result).toBe(path.join("/my/state", ".friday", "audit.jsonl"));
    });
  });

  describe("appendFridayAuditLog", () => {
    it("creates the file and appends a JSONL line", async () => {
      await appendFridayAuditLog(logPath, makeEntry("install"));
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.action).toBe("install");
    });

    it("appends multiple entries", async () => {
      await appendFridayAuditLog(logPath, makeEntry("install"));
      await appendFridayAuditLog(logPath, makeEntry("enable"));
      await appendFridayAuditLog(logPath, makeEntry("disable"));
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
    });

    it("creates parent directories", async () => {
      const deepPath = path.join(tmpDir, "a", "b", "c", "audit.jsonl");
      await appendFridayAuditLog(deepPath, makeEntry("install"));
      expect(fs.existsSync(deepPath)).toBe(true);
    });

    it("mirrors entries into stateDir/friday.db when using the canonical audit path", async () => {
      const stateDir = path.join(tmpDir, "state");
      fs.mkdirSync(path.join(stateDir, ".friday"), { recursive: true });
      const sqlitePath = path.join(stateDir, "friday.db");
      const db = new Database(sqlitePath);
      db.exec(`
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          ts TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          request_id TEXT,
          trace_id TEXT,
          ip TEXT,
          details_json TEXT
        );
      `);
      db.close();

      const canonicalLogPath = resolveFridayAuditLogPath(stateDir);
      await appendFridayAuditLog(canonicalLogPath, makeEntry("install"));

      const content = fs.readFileSync(canonicalLogPath, "utf8");
      expect(content).toContain("\"action\":\"install\"");

      const verifyDb = new Database(sqlitePath, { readonly: true });
      const row = verifyDb
        .prepare("SELECT action, actor_type, resource_type FROM audit_logs WHERE id = ?")
        .get("audit-install") as { action: string; actor_type: string; resource_type: string } | undefined;
      verifyDb.close();

      expect(row).toEqual({
        action: "install",
        actor_type: "user",
        resource_type: "skill",
      });
    });

    it("rotates when exceeding maxBytes", async () => {
      // Write many entries to exceed the small maxBytes
      for (let i = 0; i < 20; i++) {
        await appendFridayAuditLog(logPath, makeEntry(`action-${String(i)}`), {
          maxBytes: 500,
          keepLines: 5,
        });
      }
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(6); // keepLines + 1 for append-then-check
      // Most recent entries should be kept
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      expect(lastEntry.action).toBe("action-19");
    });

    it("handles concurrent appends without interleaving", async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(appendFridayAuditLog(logPath, makeEntry(`concurrent-${String(i)}`)));
      }
      await Promise.all(promises);
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(10);
      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});

// ─── SEC-EVENT-REDACTION-001: at-rest audit-log details redaction ───
//
// RED-first, real-seam (no mocks). Drives `appendFridayAuditLog` — the single choke point that
// serializes the caller `details` payload into BOTH the SQLite `audit_logs.details_json` column
// and the `audit.jsonl` mirror — and asserts PII-by-value + secret shapes are ABSENT from every
// at-rest sink, canonical columns and forensic identifiers survive, and the append-only mirror
// stays intact. On pristine `main` these assertions FAIL (raw values persisted); post-fix GREEN.
describe("FridayHubAuditLogWriter — SEC-EVENT-REDACTION-001 details redaction", () => {
  const AUDIT_SCHEMA = `
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      request_id TEXT,
      trace_id TEXT,
      ip TEXT,
      details_json TEXT
    );
  `;

  interface ReadBack {
    /** Raw SQLite `details_json` column string (sink A). */
    sqliteDetailsJson: string;
    /** Parsed SQLite `details_json` (readback of sink A). */
    sqliteDetails: Record<string, unknown>;
    /** Full SQLite row (canonical columns). */
    sqliteRow: Record<string, unknown>;
    /** Raw `audit.jsonl` mirror line for this id (sink B). */
    jsonlLine: string;
    /** Parsed `audit.jsonl` record (readback of sink B). */
    jsonlRecord: Record<string, unknown>;
  }

  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-redact-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function writeAndReadBack(entry: FridayAuditLogWrite): Promise<ReadBack> {
    const stateDir = fs.mkdtempSync(path.join(root, "state-"));
    fs.mkdirSync(path.join(stateDir, ".friday"), { recursive: true });
    const sqlitePath = path.join(stateDir, "friday.db");
    const setupDb = new Database(sqlitePath);
    setupDb.exec(AUDIT_SCHEMA);
    setupDb.close();

    const canonicalLogPath = resolveFridayAuditLogPath(stateDir);
    await appendFridayAuditLog(canonicalLogPath, entry);

    const verifyDb = new Database(sqlitePath, { readonly: true });
    const sqliteRow = verifyDb
      .prepare("SELECT id, ts, actor_type, actor_id, action, resource_type, resource_id, trace_id, details_json FROM audit_logs WHERE id = ?")
      .get(entry.id) as Record<string, unknown>;
    verifyDb.close();

    const sqliteDetailsJson = (sqliteRow.details_json as string | null) ?? "";
    const jsonlContent = fs.readFileSync(canonicalLogPath, "utf8");
    const jsonlLine = jsonlContent
      .trim()
      .split("\n")
      .filter(Boolean)
      .find((line) => (JSON.parse(line) as { id?: string }).id === entry.id) ?? "";

    return {
      sqliteDetailsJson,
      sqliteDetails: sqliteDetailsJson ? (JSON.parse(sqliteDetailsJson) as Record<string, unknown>) : {},
      sqliteRow,
      jsonlLine,
      jsonlRecord: JSON.parse(jsonlLine) as Record<string, unknown>,
    };
  }

  // Live-shaped PII / secrets. Fakes only. // pragma: allowlist secret
  const EMAIL = "jane.doe@example.com";
  const CHAT_ID_SIGNAL = "+14155552671"; // Signal chatId = sourceNumber (E.164) — PII
  const SSN = "123-45-6789";
  const CARD = "4111111111111111"; // Luhn test card // pragma: allowlist secret
  const FULLWIDTH_PHONE = "２１３５５５０１８８"; // folds to national 2135550188
  const FULLWIDTH_FOLDED = "2135550188";
  const SK_SECRET = "sk-abcdefghijklmnopqrstuv0123456789"; // pragma: allowlist secret
  const BEARER_TOKEN = "abcdefghijklmnopqrstuvwx"; // pragma: allowlist secret
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // pragma: allowlist secret
  const PEM_BODY = "MIIBOwIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu"; // pragma: allowlist secret
  const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`; // pragma: allowlist secret

  // Forensic identifiers that MUST survive verbatim (#1618 field-role lesson). Note the benign
  // requestId below is deliberately phone-SHAPED (national 10-digit, NO country code): a blunt
  // deep-redact would collapse it to "[PHONE_US]" and corrupt/merge distinct ids.
  const BENIGN_PHONE_SHAPED_ID = "2015550123";
  const RUN_ID = "run-42";
  const MESSAGE_ID = "wamid.HBgLABC123";
  const ROUTE_ID = "route-signal-in";
  // Channel session key embeds the chatId phone (`channel:<kind>:<chatId>`, normalized not hashed),
  // so its routing prefix must survive while the embedded phone is redacted.
  const SESSION_KEY = "channel:signal:+14155552671";
  // REAL caller shape (friday-hub-bootstrap channelMessageHandler): the channel correlation ids and
  // idempotency key are built as `channel:<kind>:<chatId>:<msg.id>` where chatId IS the user's phone
  // (Signal E.164 `+1…`, WhatsApp bare country-code `1…`). The embedded phone MUST be redacted while
  // the `channel:<kind>:` routing prefix and the trailing message id survive. Using the benign
  // non-embedding `2015550123` here (as the prior fixture did) sidesteps this shape and masks the leak.
  const CHAT_ID_WHATSAPP = "14155552671"; // WhatsApp chatId = msg.from — bare country-code, no '+'
  const CORRELATION_ID_SIGNAL = `channel:signal:${CHAT_ID_SIGNAL}:${MESSAGE_ID}`;
  const CORRELATION_ID_SIGNAL_REDACTED = `channel:signal:[PHONE_US]:${MESSAGE_ID}`;
  const CHANNEL_IDEMPOTENCY_KEY_SIGNAL = `${CORRELATION_ID_SIGNAL}:user`;
  const CHANNEL_IDEMPOTENCY_KEY_SIGNAL_REDACTED = `${CORRELATION_ID_SIGNAL_REDACTED}:user`;
  const CORRELATION_ID_WHATSAPP = `channel:whatsapp:${CHAT_ID_WHATSAPP}:${MESSAGE_ID}`;
  const CORRELATION_ID_WHATSAPP_REDACTED = `channel:whatsapp:[PHONE_US]:${MESSAGE_ID}`;

  // ── Finding 1: comprehensive secret coverage (field-name + generic assignment + github_pat_) ──
  // github_pat_ fine-grained token — the prior bespoke `gh[pousr]_` list does NOT match it. // pragma: allowlist secret
  const GITHUB_PAT = "github_pat_11ABCDEF0aBcDeFgHiJkL_0123456789abcdefghijklmnopqrstuvWXYZ0123abcd"; // pragma: allowlist secret
  const GENERIC_CRED_VALUE = "genericcredential123abcXYZ"; // pragma: allowlist secret
  // Opaque secret VALUES with NO distinctive shape — only catchable by their sensitive KEY name.
  const PLAIN_PASSWORD = "hunter2plaintextpw"; // pragma: allowlist secret
  const PLAIN_TOKEN = "opaqueplaintoken00"; // pragma: allowlist secret
  const PLAIN_SECRET = "opaqueplainsecret0"; // pragma: allowlist secret
  const PLAIN_ACCESS_TOKEN = "opaqueaccesstoken0"; // pragma: allowlist secret

  // ── Finding 3: international E.164 channel identities (must be redacted WITHOUT collapsing benign ids) ──
  const UK_PHONE = "+447911123456"; // Signal UK sourceNumber (E.164)
  const FR_PHONE = "+33612345678"; // France
  const DE_PHONE = "+4915112345678"; // Germany
  const JP_PHONE = "+81312345678"; // Japan
  const UK_FORMATTED = "+44 7911 123456"; // formatted with spaces
  const UK_FULLWIDTH = "＋４４７９１１１２３４５６"; // full-width digits + full-width plus
  const CORRELATION_ID_UK = `channel:signal:${UK_PHONE}:${MESSAGE_ID}`;
  const CORRELATION_ID_UK_REDACTED = `channel:signal:[PHONE]:${MESSAGE_ID}`;
  // Benign machine identifiers that MUST survive the international pass verbatim (no leading '+').
  const BENIGN_EPOCH_MS = "1737049200000"; // 13-digit epoch ms
  const BENIGN_LONG_NUMERIC_ID = "900123456789"; // 12-digit business id, no '+'
  const BENIGN_SHA = "9f8e7d6c5b4a3928170695f4e3d2c1b0"; // benign build SHA fixture // pragma: allowlist secret

  function piiEntry(id: string): FridayAuditLogWrite {
    return {
      id,
      ts: "2026-07-16T00:00:00.000Z",
      actorType: "service",
      actorId: "svc-signal",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-1",
      traceId: BENIGN_PHONE_SHAPED_ID,
      result: "error",
      errorCode: "CHANNEL_DELIVERY_FAILED",
      caller: "route-signal-in",
      details: {
        code: "CHANNEL_DELIVERY_FAILED",
        routeId: ROUTE_ID,
        // Real caller shape: channel correlation ids + idempotency key embed the chatId phone. The
        // embedded phone must be redacted; the `channel:<kind>:` prefix and message id must survive.
        correlationId: CORRELATION_ID_SIGNAL,
        channelCorrelationId: CORRELATION_ID_SIGNAL,
        idempotencyKey: CHANNEL_IDEMPOTENCY_KEY_SIGNAL,
        // Genuinely-opaque forensic id, deliberately phone-SHAPED (national 10-digit, no country
        // code) to prove benign ids are NOT collapsed by the residual E.164 pass.
        requestId: BENIGN_PHONE_SHAPED_ID,
        runId: RUN_ID,
        channelKind: "signal",
        chatId: CHAT_ID_SIGNAL,
        messageId: MESSAGE_ID,
        sessionKey: SESSION_KEY,
        errorMessage: `send to ${EMAIL} failed; ssn ${SSN}; card ${CARD}; alt ${FULLWIDTH_PHONE}`,
        apiKey: SK_SECRET,
        authHeader: `Bearer ${BEARER_TOKEN}`,
        jwt: JWT,
        privateKey: PEM,
      },
    };
  }

  it("RED→GREEN: strips email / E.164 phone / full-width phone / SSN / card / secrets from SQLite details_json, audit.jsonl, and readback", async () => {
    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlRecord } = await writeAndReadBack(
      piiEntry("redact-1"),
    );

    // Every raw PII / secret substring must be ABSENT from BOTH at-rest sink strings.
    const rawSinks = [sqliteDetailsJson, jsonlLine];
    const forbidden = [
      EMAIL,
      "14155552671", // chatId E.164 digits
      FULLWIDTH_PHONE,
      FULLWIDTH_FOLDED,
      SSN,
      CARD,
      SK_SECRET,
      BEARER_TOKEN,
      JWT,
      PEM_BODY,
      "BEGIN RSA PRIVATE KEY", // pragma: allowlist secret
    ];
    for (const sink of rawSinks) {
      expect(sink.length).toBeGreaterThan(0);
      for (const secret of forbidden) {
        expect(sink).not.toContain(secret);
      }
    }

    // Readback (sink A parsed) carries the redaction markers, not the values.
    const details = sqliteDetails as Record<string, string>;
    expect(details.chatId).toBe("[PHONE_US]");
    expect(details.errorMessage).toContain("[EMAIL]");
    expect(details.errorMessage).toContain("[SSN_US]");
    expect(details.errorMessage).toContain("[CREDIT_CARD]");
    expect(details.errorMessage).toContain("[PHONE_US]"); // folded full-width phone
    expect(details.errorMessage).not.toContain(EMAIL);
    expect(details.apiKey).toBe("[REDACTED_SECRET]");
    expect(details.authHeader).toBe("Bearer [REDACTED_SECRET]");
    expect(details.jwt).toBe("[REDACTED_SECRET]");
    expect(details.privateKey).toBe("[REDACTED_SECRET]");
    // Phone-derived sessionKey: routing prefix preserved, embedded phone redacted (no residual leak).
    expect(details.sessionKey).toBe("channel:signal:[PHONE_US]");

    // Channel correlation ids + idempotency key (REAL caller shape `channel:<kind>:<phone>:<msgid>`):
    // the embedded chatId phone is redacted while the routing prefix and message id survive. This is
    // the #1618 over-exemption class — the SAME phone must not be redacted in chatId yet leak here.
    expect(details.correlationId).toBe(CORRELATION_ID_SIGNAL_REDACTED);
    expect(details.channelCorrelationId).toBe(CORRELATION_ID_SIGNAL_REDACTED);
    expect(details.idempotencyKey).toBe(CHANNEL_IDEMPOTENCY_KEY_SIGNAL_REDACTED);
    expect(details.correlationId).toContain("channel:signal:");
    expect(details.correlationId).not.toContain("14155552671");
    expect(details.channelCorrelationId).not.toContain("14155552671");
    expect(details.idempotencyKey).not.toContain("14155552671");

    // Sink B parsed must agree with sink A (both fed by the same redacted record).
    const jsonlDetails = jsonlRecord.details as Record<string, string>;
    expect(jsonlDetails.chatId).toBe("[PHONE_US]");
    expect(jsonlDetails.apiKey).toBe("[REDACTED_SECRET]");
    expect(jsonlDetails.correlationId).toBe(CORRELATION_ID_SIGNAL_REDACTED);
    expect(jsonlDetails.channelCorrelationId).toBe(CORRELATION_ID_SIGNAL_REDACTED);
    expect(jsonlDetails.idempotencyKey).toBe(CHANNEL_IDEMPOTENCY_KEY_SIGNAL_REDACTED);
  });

  it("preserves forensic identifier fields verbatim — does NOT collapse or corrupt distinct ids (#1618 field-role lesson)", async () => {
    const { sqliteDetailsJson, sqliteDetails } = await writeAndReadBack(piiEntry("preserve-1"));
    const details = sqliteDetails as Record<string, string>;

    // Genuinely-opaque forensic ids survive verbatim (never masked, never collapsed).
    expect(details.routeId).toBe(ROUTE_ID);
    expect(details.runId).toBe(RUN_ID);
    expect(details.messageId).toBe(MESSAGE_ID);
    // The phone-SHAPED benign requestId (national 10-digit, NO country code) survives: the residual
    // E.164 pass requires a leading `1` country code, so a benign national-format id is NOT collapsed
    // to [PHONE_US] and distinct ids stay distinct.
    expect(details.requestId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(details.requestId).not.toBe("[PHONE_US]");
    // Proof of preservation at the raw-sink level: the benign phone-shaped id is present.
    expect(sqliteDetailsJson).toContain(BENIGN_PHONE_SHAPED_ID);
    // Distinct opaque ids are not merged to a single marker.
    expect(details.messageId).not.toBe(details.runId);
    expect(details.runId).not.toBe(details.routeId);
    // The channel correlation id keeps its message-id tail (only the phone segment is redacted), so it
    // stays a distinct, non-collapsed value.
    expect(details.correlationId).not.toBe("[PHONE_US]");
    expect(details.correlationId).toContain(MESSAGE_ID);
  });

  it("redacts the WhatsApp bare country-code chatId phone (no `+`) embedded in channel correlation ids", async () => {
    // WhatsApp `msg.from` arrives WITHOUT the `+` (bare `1XXXXXXXXXX`); the residual E.164 pass must
    // still catch it (leading `1` country code), not only the Signal `+1…` form.
    const entry = piiEntry("whatsapp-1");
    const d = entry.details as Record<string, unknown>;
    d.channelKind = "whatsapp";
    d.chatId = CHAT_ID_WHATSAPP;
    d.correlationId = CORRELATION_ID_WHATSAPP;
    d.channelCorrelationId = CORRELATION_ID_WHATSAPP;
    d.idempotencyKey = `${CORRELATION_ID_WHATSAPP}:user`;

    const { sqliteDetailsJson, sqliteDetails, jsonlLine } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, string>;

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain("14155552671");
    }
    expect(details.correlationId).toBe(CORRELATION_ID_WHATSAPP_REDACTED);
    expect(details.channelCorrelationId).toBe(CORRELATION_ID_WHATSAPP_REDACTED);
    expect(details.idempotencyKey).toBe(`${CORRELATION_ID_WHATSAPP_REDACTED}:user`);
    expect(details.correlationId).toContain("channel:whatsapp:");
    expect(details.chatId).toBe("[PHONE_US]");
  });

  it("leaves canonical audit columns and benign details byte-identical (NO-DEGRADE)", async () => {
    const benignDetails = {
      correlationId: "corr-abc",
      note: "delivery ok",
      attempt: 3,
      nested: { stage: "final", retries: 0 },
      tags: ["signal", "outbound"],
    };
    const entry: FridayAuditLogWrite = {
      id: "benign-1",
      ts: "2026-07-16T01:02:03.000Z",
      actorType: "user",
      actorId: "user-7",
      action: "channel.delivered",
      resourceType: "channel_signal",
      resourceId: "msg-9",
      traceId: "trace-xyz",
      details: benignDetails,
    };

    const { sqliteRow, sqliteDetails, jsonlRecord } = await writeAndReadBack(entry);

    // Canonical columns untouched.
    expect(sqliteRow.id).toBe("benign-1");
    expect(sqliteRow.ts).toBe("2026-07-16T01:02:03.000Z");
    expect(sqliteRow.actor_type).toBe("user");
    expect(sqliteRow.actor_id).toBe("user-7");
    expect(sqliteRow.action).toBe("channel.delivered");
    expect(sqliteRow.resource_type).toBe("channel_signal");
    expect(sqliteRow.resource_id).toBe("msg-9");
    expect(sqliteRow.trace_id).toBe("trace-xyz");

    // Benign details round-trip byte-identical (structure + key order preserved).
    expect(sqliteDetails).toEqual(benignDetails);
    expect(JSON.stringify(sqliteDetails)).toBe(JSON.stringify(benignDetails));

    // jsonl record canonical fields intact.
    expect(jsonlRecord.id).toBe("benign-1");
    expect(jsonlRecord.action).toBe("channel.delivered");
    expect(jsonlRecord.resourceType).toBe("channel_signal");
    expect(jsonlRecord.traceId).toBe("trace-xyz");
    expect(jsonlRecord.details).toEqual(benignDetails);
  });

  it("keeps the append-only mirror intact across multiple redacted entries (one line each, canonical columns preserved)", async () => {
    const stateDir = fs.mkdtempSync(path.join(root, "append-"));
    fs.mkdirSync(path.join(stateDir, ".friday"), { recursive: true });
    const sqlitePath = path.join(stateDir, "friday.db");
    const setupDb = new Database(sqlitePath);
    setupDb.exec(AUDIT_SCHEMA);
    setupDb.close();
    const canonicalLogPath = resolveFridayAuditLogPath(stateDir);

    await appendFridayAuditLog(canonicalLogPath, piiEntry("append-1"));
    await appendFridayAuditLog(canonicalLogPath, piiEntry("append-2"));
    await appendFridayAuditLog(canonicalLogPath, piiEntry("append-3"));

    const lines = fs
      .readFileSync(canonicalLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      // Append-only: each canonical record is intact and PII-free.
      expect(record.action).toBe("channel.channel_delivery_failed");
      expect(record.resourceType).toBe("channel_signal");
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain("14155552671");
      expect(line).not.toContain(SK_SECRET);
      expect((record.details as Record<string, string>).chatId).toBe("[PHONE_US]");
    }
  });

  // ─── Finding 1: comprehensive secret coverage (bespoke partial list → full coverage) ───
  it("RED→GREEN finding 1: redacts sensitive field-name values, generic key=value assignments, and github_pat_ from every at-rest sink", async () => {
    const entry: FridayAuditLogWrite = {
      id: "secret-cov-1",
      ts: "2026-07-16T02:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-2",
      details: {
        // (a) sensitive field NAMES holding opaque, SHAPELESS values — only catchable by their key.
        password: PLAIN_PASSWORD,
        token: PLAIN_TOKEN,
        secret: PLAIN_SECRET,
        accessToken: PLAIN_ACCESS_TOKEN,
        api_key: GENERIC_CRED_VALUE,
        // (b) generic key=value credential assignment embedded in free text.
        errorMessage: `startup failed: api_key=${GENERIC_CRED_VALUE} was rejected`,
        // (c) github_pat_ fine-grained token inside a NON-secret-named field (the prior bespoke
        //     `gh[pousr]_` list did not match `github_pat_`).
        note: `deploy used ${GITHUB_PAT} to auth`,
      },
    };

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlRecord } = await writeAndReadBack(entry);

    // Every secret canary is ABSENT from BOTH at-rest sink strings (raw SQLite + JSONL).
    const forbidden = [PLAIN_PASSWORD, PLAIN_TOKEN, PLAIN_SECRET, PLAIN_ACCESS_TOKEN, GENERIC_CRED_VALUE, GITHUB_PAT];
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      for (const secret of forbidden) {
        expect(sink).not.toContain(secret);
      }
    }

    const details = sqliteDetails as Record<string, string>;
    // Sensitive field-names → whole value nuked to the marker.
    expect(details.password).toBe("[REDACTED_SECRET]");
    expect(details.token).toBe("[REDACTED_SECRET]");
    expect(details.secret).toBe("[REDACTED_SECRET]");
    expect(details.accessToken).toBe("[REDACTED_SECRET]");
    expect(details.api_key).toBe("[REDACTED_SECRET]");
    // Generic assignment in free text → value redacted, credential label kept.
    expect(details.errorMessage).toContain("api_key=[REDACTED_SECRET]");
    expect(details.errorMessage).not.toContain(GENERIC_CRED_VALUE);
    // github_pat_ inside a benign-named field → redacted, surrounding text preserved.
    expect(details.note).toContain("[REDACTED_SECRET]");
    expect(details.note).toContain("deploy used");
    expect(details.note).not.toContain(GITHUB_PAT);

    // Sink B (JSONL readback) agrees with sink A.
    const jsonlDetails = jsonlRecord.details as Record<string, string>;
    expect(jsonlDetails.password).toBe("[REDACTED_SECRET]");
    expect(jsonlDetails.api_key).toBe("[REDACTED_SECRET]");
    expect(jsonlDetails.note).not.toContain(GITHUB_PAT);
  });

  // ─── Finding 2: field-role handling is RECURSIVE / path-aware through nested objects + arrays ───
  it("RED→GREEN finding 2: nested benign identifiers survive byte-identical while nested PII/secrets are removed", async () => {
    const entry: FridayAuditLogWrite = {
      id: "nested-role-1",
      ts: "2026-07-16T03:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-3",
      details: {
        note: "outer",
        nested: {
          // Benign phone-SHAPED forensic id (national 10-digit, NO country code) NESTED one level
          // deep. Top-level-only field-role deep-redacts this to [PHONE_US] and corrupts it.
          requestId: BENIGN_PHONE_SHAPED_ID,
          runId: RUN_ID,
          // Nested PII + secret that MUST still be removed.
          chatId: CHAT_ID_SIGNAL,
          userEmail: EMAIL,
          password: PLAIN_PASSWORD,
          deeper: {
            correlationId: CORRELATION_ID_SIGNAL,
            apiKey: SK_SECRET,
          },
        },
        // Array of objects: each element re-establishes its per-key roles.
        events: [
          { requestId: BENIGN_PHONE_SHAPED_ID, chatId: CHAT_ID_SIGNAL },
          { spanId: "span-7", note2: `contact ${EMAIL}` },
        ],
        // Content array of scalars: a phone-shaped string here IS content → redacted.
        freeNotes: [`ring ${CHAT_ID_SIGNAL}`, "all good"],
      },
    };

    const { sqliteDetailsJson, sqliteDetails, jsonlLine } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, unknown>;
    const nested = details.nested as Record<string, unknown>;
    const deeper = nested.deeper as Record<string, unknown>;
    const events = details.events as Array<Record<string, unknown>>;
    const freeNotes = details.freeNotes as string[];

    // Nested benign forensic ids preserved byte-identical (NOT collapsed to [PHONE_US]).
    expect(nested.requestId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(nested.requestId).not.toBe("[PHONE_US]");
    expect(nested.runId).toBe(RUN_ID);
    expect(events[0].requestId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(events[1].spanId).toBe("span-7");
    expect(sqliteDetailsJson).toContain(BENIGN_PHONE_SHAPED_ID);

    // Nested PII / secrets removed at every depth.
    expect(nested.chatId).toBe("[PHONE_US]");
    expect(nested.userEmail).toBe("[EMAIL]");
    expect(nested.password).toBe("[REDACTED_SECRET]");
    expect(deeper.correlationId).toBe(CORRELATION_ID_SIGNAL_REDACTED); // forensic even when nested
    expect(deeper.apiKey).toBe("[REDACTED_SECRET]");
    expect(events[0].chatId).toBe("[PHONE_US]");
    expect(events[1].note2).toContain("[EMAIL]");
    // Content array element (scalar) is redacted; the benign sibling round-trips.
    expect(freeNotes[0]).toBe("ring [PHONE_US]");
    expect(freeNotes[1]).toBe("all good");

    // No raw PII / secret leaked to either sink.
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink).not.toContain(EMAIL);
      expect(sink).not.toContain("14155552671");
      expect(sink).not.toContain(SK_SECRET);
      expect(sink).not.toContain(PLAIN_PASSWORD);
    }
  });

  // ─── Finding 3: international E.164 channel identities (US-only → international) ───
  it("RED→GREEN finding 3: redacts international E.164 channel identities (multiple ccs, formatted, full-width) WITHOUT collapsing benign machine ids", async () => {
    const entry: FridayAuditLogWrite = {
      id: "intl-phone-1",
      ts: "2026-07-16T04:00:00.000Z",
      actorType: "service",
      actorId: "svc-signal",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-4",
      details: {
        channelKind: "signal",
        chatId: UK_PHONE,
        sessionKey: `channel:signal:${UK_PHONE}`,
        // correlationId is forensic — the embedded international phone must STILL be stripped.
        correlationId: CORRELATION_ID_UK,
        senderId: FR_PHONE,
        errorMessage: `failed to ${DE_PHONE} and ${JP_PHONE}; formatted ${UK_FORMATTED}; wide ${UK_FULLWIDTH}`,
        // Benign machine identifiers (no leading '+') that MUST survive verbatim.
        requestId: BENIGN_LONG_NUMERIC_ID,
        epochMs: BENIGN_EPOCH_MS,
        buildSha: BENIGN_SHA,
      },
    };

    const { sqliteDetailsJson, sqliteDetails, jsonlLine } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, string>;

    // Every international phone digit-string is ABSENT from both at-rest sinks.
    const forbiddenIntl = ["447911123456", "33612345678", "4915112345678", "81312345678", UK_FULLWIDTH];
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      for (const digits of forbiddenIntl) {
        expect(sink).not.toContain(digits);
      }
    }

    // International phones → [PHONE]; the forensic correlationId keeps its routing prefix + msg tail.
    expect(details.chatId).toBe("[PHONE]");
    expect(details.sessionKey).toBe("channel:signal:[PHONE]");
    expect(details.correlationId).toBe(CORRELATION_ID_UK_REDACTED);
    expect(details.senderId).toBe("[PHONE]");
    expect(details.errorMessage).not.toContain("4915112345678");
    expect(details.errorMessage).toContain("[PHONE]");

    // Benign machine identifiers survive byte-identical (no leading '+' → never matched).
    expect(details.requestId).toBe(BENIGN_LONG_NUMERIC_ID);
    expect(details.epochMs).toBe(BENIGN_EPOCH_MS);
    expect(details.buildSha).toBe(BENIGN_SHA);
    expect(sqliteDetailsJson).toContain(BENIGN_LONG_NUMERIC_ID);
    expect(sqliteDetailsJson).toContain(BENIGN_EPOCH_MS);
  });

  // ─── Reviewer round-3 F-1: placeholder collision → out-of-band (object-identity) restore ───
  it("RED→GREEN F-1: a content string equal to / containing the internal cut sentinel round-trips byte-identical (no collision, no corruption)", async () => {
    // The round-2 redactor cut forensic subtrees to an in-band NUL-delimited STRING sentinel and
    // restored by value-equality. A content value that forged that sentinel was overwritten with a
    // DIFFERENT field's value. The out-of-band (object-identity) marker makes this impossible for
    // ANY content value. Reviewer's reproducing input reproduced here exactly.
    const SENTINEL = "\u0000\u0000AUDIT_FORENSIC_0\u0000\u0000";
    const entry: FridayAuditLogWrite = {
      id: "collision-1",
      ts: "2026-07-17T00:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-5",
      details: {
        correlationId: "MACHINE_ID_XYZ", // forensic → cut FIRST (sentinel #0 under round-2)
        evil: SENTINEL, // content string forging the sentinel verbatim
        evilSubstring: `prefix ${SENTINEL} suffix`, // sentinel as a substring
      },
    };

    const { sqliteDetails, jsonlRecord } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, string>;

    // The forensic id is preserved; the forging content value is NOT overwritten by it.
    expect(details.correlationId).toBe("MACHINE_ID_XYZ");
    expect(details.evil).toBe(SENTINEL);
    expect(details.evil).not.toBe("MACHINE_ID_XYZ");
    expect(details.evilSubstring).toBe(`prefix ${SENTINEL} suffix`);

    // Sink B agrees.
    const jsonlDetails = jsonlRecord.details as Record<string, string>;
    expect(jsonlDetails.evil).toBe(SENTINEL);
    expect(jsonlDetails.correlationId).toBe("MACHINE_ID_XYZ");
  });

  // ─── Reviewer round-3 F-2: intl phone must not over-redact benign signed amounts ───
  it("RED→GREEN F-2: the international phone pass leaves benign signed amounts intact while still redacting real E.164", async () => {
    const entry: FridayAuditLogWrite = {
      id: "amount-1",
      ts: "2026-07-17T01:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-6",
      details: {
        priceDelta: "+100000.00",
        smallDelta: "+1234.56",
        shortNum: "+12345678",
        roundNum: "+1000000000",
        grouped: "+1,000,000",
        // Real E.164 channel phones in the SAME record must STILL be redacted.
        chatId: "+447911123456",
        note: "billed to +4915112345678 on file",
      },
    };

    const { sqliteDetails } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, string>;

    // Benign amounts preserved byte-identical (decimal/grouping or sub-11-digit → not a phone).
    expect(details.priceDelta).toBe("+100000.00");
    expect(details.smallDelta).toBe("+1234.56");
    expect(details.shortNum).toBe("+12345678");
    expect(details.roundNum).toBe("+1000000000");
    expect(details.grouped).toBe("+1,000,000");
    // Real international channel phones still redacted.
    expect(details.chatId).toBe("[PHONE]");
    expect(details.note).toBe("billed to [PHONE] on file");
  });

  // ─── Reviewer round-3 F-3: +E.164 phone redacted BEFORE the card detector (no +[CREDIT_CARD]) ───
  it("RED→GREEN F-3: a Luhn-valid +E.164 phone is marked [PHONE], never +[CREDIT_CARD] (phone pass runs before redactDeep's card detector)", async () => {
    const entry: FridayAuditLogWrite = {
      id: "phone-before-card-1",
      ts: "2026-07-17T02:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-7",
      details: {
        senderId: "+4915112345678", // DE, 13 Luhn-valid digits → cards in redactDeep unless pre-redacted
        note: "sent to +4915112345678",
      },
    };

    const { sqliteDetailsJson, sqliteDetails } = await writeAndReadBack(entry);
    const details = sqliteDetails as Record<string, string>;

    expect(details.senderId).toBe("[PHONE]");
    expect(details.note).toBe("sent to [PHONE]");
    // No CARD mislabel and no stray leading '+' anywhere in the sink.
    expect(sqliteDetailsJson).not.toContain("[CREDIT_CARD]");
    expect(sqliteDetailsJson).not.toContain("+[");
    expect(sqliteDetailsJson).not.toContain("4915112345678");
  });

  // ─── Advisor round-4 blocking finding: forensic preservation is LEAF-and-TYPE-aware, never a
  //     subtree exemption ───
  //
  // The round-3 forensic treatment cut the ENTIRE value subtree under a forensic-named key
  // (`requestId`/`traceId`/`correlationId`/…) out of the PII guard and restored it applying ONLY the
  // secret-shape + phone passes — so nested email/SSN/card/password and DIRECT PII on a forensic leaf
  // survived VERBATIM. These tests drive the real writer and raw-read BOTH at-rest sinks (SQLite
  // `details_json` + `audit.jsonl`); they are RED on 381d7cf5 and GREEN post-fix.
  const ADVISOR_CANARY_EMAIL = "advisor-canary@example.com";
  // Shape-less credential (no recognizable secret shape) — catchable ONLY by its sensitive KEY name.
  const OPAQUE_CREDENTIAL = "opaque-credential-no-recognized-shape"; // pragma: allowlist secret

  it("RED→GREEN advisor-4 (nested): PII/secrets nested UNDER a forensic-named object/array key are removed (no subtree exemption)", async () => {
    const entry: FridayAuditLogWrite = {
      id: "forensic-subtree-1",
      ts: "2026-07-17T03:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-8",
      details: {
        // Forensic key holding an OBJECT — round-3 exempted the whole subtree; these MUST be redacted.
        requestId: {
          userEmail: ADVISOR_CANARY_EMAIL,
          userSsn: SSN,
          card: CARD,
          password: OPAQUE_CREDENTIAL, // shape-less credential under a sensitive key name
        },
        // Forensic key holding an ARRAY of PII objects — each element re-establishes per-key roles.
        traceId: [
          { userEmail: ADVISOR_CANARY_EMAIL, userSsn: SSN },
          { password: OPAQUE_CREDENTIAL, card: CARD },
        ],
        // Forensic key holding an object with NESTED BENIGN forensic ids + benign content — these
        // MUST survive byte-identical while the sibling PII is removed (NO-DEGRADE inside recursion).
        correlationId: {
          innerRunId: RUN_ID, // nested forensic-keyed benign opaque id → preserved
          label: "delivery", // benign content → preserved
          chatId: CHAT_ID_SIGNAL, // nested PII (content) → redacted
        },
      },
    };

    const { sqliteDetailsJson, sqliteDetails, jsonlLine } = await writeAndReadBack(entry);

    // Every nested canary is ABSENT from BOTH raw at-rest sinks.
    const forbidden = [ADVISOR_CANARY_EMAIL, SSN, CARD, OPAQUE_CREDENTIAL, "14155552671"];
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      for (const secret of forbidden) {
        expect(sink).not.toContain(secret);
      }
    }

    const details = sqliteDetails as Record<string, unknown>;
    const req = details.requestId as Record<string, string>;
    expect(req.userEmail).toBe("[EMAIL]");
    expect(req.userSsn).toBe("[SSN_US]");
    expect(req.card).toBe("[CREDIT_CARD]");
    expect(req.password).toBe("[REDACTED_SECRET]");

    const trace = details.traceId as Array<Record<string, string>>;
    expect(trace[0].userEmail).toBe("[EMAIL]");
    expect(trace[0].userSsn).toBe("[SSN_US]");
    expect(trace[1].password).toBe("[REDACTED_SECRET]");
    expect(trace[1].card).toBe("[CREDIT_CARD]");

    // NO-DEGRADE inside the recursion: nested benign forensic id + benign content survive; nested PII redacted.
    const corr = details.correlationId as Record<string, string>;
    expect(corr.innerRunId).toBe(RUN_ID);
    expect(corr.label).toBe("delivery");
    expect(corr.chatId).toBe("[PHONE_US]");
  });

  it("RED→GREEN advisor-4 (direct leaf): DIRECT PII/secret on a forensic-named SCALAR leaf is redacted; benign-opaque leaves preserved", async () => {
    const entry: FridayAuditLogWrite = {
      id: "forensic-leaf-1",
      ts: "2026-07-17T04:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-9",
      details: {
        // DIRECT PII on forensic leaves — round-3 preserved these verbatim; they MUST be redacted.
        traceId: ADVISOR_CANARY_EMAIL, // email on a forensic leaf
        correlationId: SSN, // bare SSN on a forensic leaf
        spanId: CARD, // bare Luhn card on a forensic leaf
        // Benign-opaque forensic leaves — MUST survive (NO-DEGRADE).
        requestId: RUN_ID,
        messageId: MESSAGE_ID,
        // Phone-shaped benign id — preserved (phone shape does NOT disqualify a forensic id).
        nodeId: BENIGN_PHONE_SHAPED_ID,
        // Channel-embedded phone in a forensic id — phone redacted, routing prefix + msg tail survive.
        channelCorrelationId: CORRELATION_ID_SIGNAL,
      },
    };

    const { sqliteDetailsJson, sqliteDetails, jsonlLine } = await writeAndReadBack(entry);

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(ADVISOR_CANARY_EMAIL);
      expect(sink).not.toContain(SSN);
      expect(sink).not.toContain(CARD);
      expect(sink).not.toContain("14155552671"); // channel-embedded phone digits
    }

    const details = sqliteDetails as Record<string, string>;
    // Direct PII on forensic leaves → redacted (not preserved just because the key is forensic-named).
    expect(details.traceId).toBe("[EMAIL]");
    expect(details.correlationId).toBe("[SSN_US]");
    expect(details.spanId).toBe("[CREDIT_CARD]");
    // Benign-opaque forensic leaves preserved byte-identical.
    expect(details.requestId).toBe(RUN_ID);
    expect(details.messageId).toBe(MESSAGE_ID);
    expect(details.nodeId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(details.nodeId).not.toBe("[PHONE_US]");
    // Channel-embedded phone redacted, routing prefix + message id survive.
    expect(details.channelCorrelationId).toBe(CORRELATION_ID_SIGNAL_REDACTED);
    expect(details.channelCorrelationId).toContain("channel:signal:");
    expect(details.channelCorrelationId).toContain(MESSAGE_ID);
  });
});

// ── PRIV-UNICODE-REDACTION-001 — Unicode-obfuscation de-obfuscation at the details sink ──
//
// Round-4→5 blocking finding: an independent real-SQLite + audit.jsonl probe proved two
// Unicode-obfuscation bypasses persisted VERBATIM in BOTH at-rest sinks:
//   (1) an Arabic-Indic-digit E.164 phone (`+١٤١٥…`) — the ASCII / full-width phone matchers do not
//       recognize Arabic-Indic (U+0660–0669) / Extended Arabic-Indic (U+06F0–06F9) / other Nd digits;
//   (2) an `sk-` credential broken by a U+200B ZERO WIDTH SPACE — the secret-shape regex did not
//       normalize zero-width / format code points.
// These drive the REAL `appendFridayAuditLog` and raw-read BOTH the SQLite `audit_logs.details_json`
// column AND the `audit.jsonl` mirror. They are RED on f944407a and GREEN after the additive shared
// Unicode-aware detection layer. Benign multilingual text MUST survive BYTE-IDENTICAL (no degrade).
describe("FridayHubAuditLogWriter — PRIV-UNICODE-REDACTION-001 details Unicode de-obfuscation", () => {
  const AUDIT_SCHEMA = `
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      request_id TEXT,
      trace_id TEXT,
      ip TEXT,
      details_json TEXT
    );
  `;

  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-audit-unicode-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function writeAndReadBack(entry: FridayAuditLogWrite): Promise<{
    sqliteDetailsJson: string;
    sqliteDetails: Record<string, unknown>;
    jsonlLine: string;
    jsonlDetails: Record<string, unknown>;
  }> {
    const stateDir = fs.mkdtempSync(path.join(root, "state-"));
    fs.mkdirSync(path.join(stateDir, ".friday"), { recursive: true });
    const sqlitePath = path.join(stateDir, "friday.db");
    const setupDb = new Database(sqlitePath);
    setupDb.exec(AUDIT_SCHEMA);
    setupDb.close();

    const canonicalLogPath = resolveFridayAuditLogPath(stateDir);
    await appendFridayAuditLog(canonicalLogPath, entry);

    const verifyDb = new Database(sqlitePath, { readonly: true });
    const sqliteRow = verifyDb
      .prepare("SELECT details_json FROM audit_logs WHERE id = ?")
      .get(entry.id) as { details_json: string | null } | undefined;
    verifyDb.close();

    const sqliteDetailsJson = (sqliteRow?.details_json as string | null) ?? "";
    const jsonlContent = fs.readFileSync(canonicalLogPath, "utf8");
    const jsonlLine =
      jsonlContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .find((line) => (JSON.parse(line) as { id?: string }).id === entry.id) ?? "";

    return {
      sqliteDetailsJson,
      sqliteDetails: sqliteDetailsJson ? (JSON.parse(sqliteDetailsJson) as Record<string, unknown>) : {},
      jsonlLine,
      jsonlDetails: (JSON.parse(jsonlLine) as { details?: Record<string, unknown> }).details ?? {},
    };
  }

  // ── Obfuscated PII / secret fixtures (ASCII-folded canary in the comment) ──
  // Arabic-Indic (U+0660–0669) US E.164 → folds to +14155552671 → [PHONE_US].
  const AR_INDIC_US_PHONE = "+١٤١٥٥٥٥٢٦٧١";
  const AR_INDIC_US_DIGITS = "14155552671";
  // Extended Arabic-Indic (U+06F0–06F9) UK E.164 (no leading `1`) → +447911123456 → [PHONE] (intl).
  const EXT_AR_UK_PHONE = "+۴۴۷۹۱۱۱۲۳۴۵۶";
  const EXT_AR_UK_DIGITS = "447911123456";
  // Devanagari (U+0966–096F) Luhn-valid card → 4111111111111111 → [CREDIT_CARD].
  const DEVANAGARI_CARD = "४१११११११११११११११"; // pragma: allowlist secret
  const CARD_DIGITS = "4111111111111111"; // pragma: allowlist secret
  // U+200B-obfuscated SSN → strip ZWSP → 123-45-6789 → [SSN_US].
  const ZW_SSN = "123-45-​6789";
  // U+200B-obfuscated Luhn card → strip ZWSP → 4111111111111111 → [CREDIT_CARD].
  const ZW_CARD = "4111​1111​1111​1111"; // pragma: allowlist secret
  // Vector (2): `sk-` broken by a U+200B ZERO WIDTH SPACE → [REDACTED_SECRET].
  const SK_CANARY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret
  const ZW_SK_SECRET = `sk-​${SK_CANARY}`; // pragma: allowlist secret
  // U+200D (ZWJ)-obfuscated fine-grained GitHub PAT → [REDACTED_SECRET].
  const GH_PAT_CANARY = "github_pat_11ABCDEF0aBcDeFgHiJkL0123456789abcdefghij"; // pragma: allowlist secret
  const ZW_GH_PAT = "github_pat_‍11ABCDEF0aBcDeFgHiJkL0123456789abcdefghij"; // pragma: allowlist secret
  // Full-width (CJK Forms) national phone → folds to 2135550188 → [PHONE_US].
  const FULLWIDTH_PHONE = "２１３５５５０１８８";
  const FULLWIDTH_DIGITS = "2135550188";

  // ── NO-DEGRADE benign multilingual fixtures — MUST survive BYTE-IDENTICAL ──
  const BENIGN_ARABIC_PROSE = "طلبك رقم ٣ جاهز"; // "your order no. 3 is ready" — short digit run
  const BENIGN_CJK = "订单号 42 已完成"; // "order 42 complete"
  const BENIGN_ZWJ_EMOJI = "family 👨‍👩‍👧 dinner"; // ZWJ emoji must survive
  const BENIGN_COMBINING = "café résumé"; // combining marks
  const BENIGN_ERROR_MESSAGE = "connection reset by peer"; // no secret
  // Benign phone-SHAPED forensic id written in Arabic-Indic digits → folds to 2015550123. Under a
  // forensic key it MUST survive verbatim (#1618 field-role lesson, carried into Unicode): the
  // identifier-leaf Unicode residual omits the PII-by-value pass, so this is never collapsed.
  const BENIGN_AR_FORENSIC_ID = "٢٠١٥٥٥٠١٢٣";

  function unicodeEntry(id: string, details: Record<string, unknown>): FridayAuditLogWrite {
    return {
      id,
      ts: "2026-07-17T00:00:00.000Z",
      actorType: "service",
      actorId: "svc-signal",
      action: "channel.channel_delivery_failed",
      resourceType: "channel_signal",
      resourceId: "msg-u",
      result: "error",
      errorCode: "CHANNEL_DELIVERY_FAILED",
      details,
    };
  }

  it("RED→GREEN (vector 1): strips an Arabic-Indic-digit E.164 phone from senderId (content) AND routeId (forensic) in BOTH sinks", async () => {
    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-ar-phone", {
        senderId: AR_INDIC_US_PHONE, // content field
        routeId: AR_INDIC_US_PHONE, // forensic identifier field
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(AR_INDIC_US_PHONE); // raw Arabic digits absent
      expect(sink).not.toContain(AR_INDIC_US_DIGITS); // folded ASCII digits absent
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.senderId).toBe("[PHONE_US]");
      expect(details.routeId).toBe("[PHONE_US]");
    }
  });

  it("RED→GREEN (vector 2): strips an `sk-` credential broken by a U+200B ZERO WIDTH SPACE in errorMessage in BOTH sinks", async () => {
    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-zw-secret", {
        errorMessage: `send failed: ${ZW_SK_SECRET} rejected`,
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(SK_CANARY); // the credential body is absent
      expect(sink).not.toContain("sk-\\u200b"); // and no escaped-ZWSP `sk-` residue
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.errorMessage).toContain("[REDACTED_SECRET]");
      expect(details.errorMessage).not.toContain(SK_CANARY);
      // Surrounding benign text is preserved (no whole-field nuke).
      expect(details.errorMessage).toContain("send failed:");
      expect(details.errorMessage).toContain("rejected");
    }
  });

  it("redacts the full PRIV-UNICODE corpus (Arabic-Indic / Extended Arabic-Indic / Devanagari / full-width / zero-width) in BOTH sinks", async () => {
    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-corpus", {
        arIndicPhone: AR_INDIC_US_PHONE,
        extArUkPhone: EXT_AR_UK_PHONE,
        devanagariCard: DEVANAGARI_CARD,
        fullwidthPhone: FULLWIDTH_PHONE,
        zwSsn: ZW_SSN,
        zwCard: ZW_CARD,
        zwSecret: ZW_SK_SECRET,
        zwGithubPat: ZW_GH_PAT,
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      for (const canary of [
        AR_INDIC_US_DIGITS,
        EXT_AR_UK_DIGITS,
        CARD_DIGITS,
        FULLWIDTH_DIGITS,
        "123-45-6789",
        SK_CANARY,
        GH_PAT_CANARY,
      ]) {
        expect(sink).not.toContain(canary);
      }
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.arIndicPhone).toBe("[PHONE_US]");
      expect(details.extArUkPhone).toBe("[PHONE]");
      expect(details.devanagariCard).toBe("[CREDIT_CARD]");
      expect(details.fullwidthPhone).toBe("[PHONE_US]");
      expect(details.zwSsn).toBe("[SSN_US]");
      expect(details.zwCard).toBe("[CREDIT_CARD]");
      expect(details.zwSecret).toBe("[REDACTED_SECRET]");
      expect(details.zwGithubPat).toBe("[REDACTED_SECRET]");
    }
  });

  it("NO-DEGRADE: benign multilingual text (Arabic prose / CJK / ZWJ emoji / combining marks / benign id) survives BYTE-IDENTICAL in BOTH sinks", async () => {
    const details = {
      arabicProse: BENIGN_ARABIC_PROSE,
      cjk: BENIGN_CJK,
      zwjEmoji: BENIGN_ZWJ_EMOJI,
      combining: BENIGN_COMBINING,
      errorMessage: BENIGN_ERROR_MESSAGE,
      requestId: BENIGN_AR_FORENSIC_ID, // forensic, phone-shaped when folded — must NOT be redacted
    };
    const { sqliteDetails, jsonlDetails, sqliteDetailsJson, jsonlLine } = await writeAndReadBack(
      unicodeEntry("unicode-benign", details),
    );

    for (const readBack of [sqliteDetails, jsonlDetails]) {
      expect(readBack.arabicProse).toBe(BENIGN_ARABIC_PROSE);
      expect(readBack.cjk).toBe(BENIGN_CJK);
      expect(readBack.zwjEmoji).toBe(BENIGN_ZWJ_EMOJI);
      expect(readBack.combining).toBe(BENIGN_COMBINING);
      expect(readBack.errorMessage).toBe(BENIGN_ERROR_MESSAGE);
      // #1618 under Unicode: a benign phone-shaped forensic id is preserved, NOT collapsed.
      expect(readBack.requestId).toBe(BENIGN_AR_FORENSIC_ID);
      expect(readBack.requestId).not.toBe("[PHONE_US]");
    }
    // The ZWJ emoji + combining marks are present byte-identical in the raw sink bytes too.
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink).toContain(BENIGN_ZWJ_EMOJI);
      expect(sink).toContain(BENIGN_COMBINING);
    }
  });

  // ── Round-6 blocking finding (Option A): the FORENSIC-LEAF preservation gate must decide over the
  //    de-obfuscated DETECTION COPY, not the raw value ──
  //
  // An independent adversarial probe (real SQLite `audit_logs.details_json` + `audit.jsonl`) proved
  // that a Unicode-obfuscated EMAIL / SSN / CREDIT-CARD placed on a FORENSIC-named key
  // (`traceId` / `spanId` / `correlationId` / `requestId` / `messageId` / …) persisted VERBATIM in
  // BOTH at-rest sinks. The identical ASCII values on the SAME forensic keys ARE redacted (advisor-4
  // leaf test above), so the design intends redaction — only the Unicode form escaped, because
  // `isBenignOpaqueForensicScalar` ran its email/SSN/card disqualification over the RAW value
  // (ASCII-only: no digit fold, no zero-width strip) and the identifier-leaf residual deliberately
  // omits PII-by-value (benign-phone protection). RED on b50a6067; GREEN once the gate de-obfuscates.
  //
  // Map to ANY Nd decimal-digit block by numeric value (separators kept verbatim) so the obfuscated
  // fixtures are unambiguous about their code points.
  function toNdDigits(ascii: string, zeroCp: number): string {
    return ascii.replace(/[0-9]/g, (d) => String.fromCodePoint(zeroCp + Number(d)));
  }

  it("RED→GREEN round-6: an obfuscated email/SSN/card on a FORENSIC-named key is redacted in BOTH sinks (gate over the de-obfuscated copy)", async () => {
    // The reviewer's exact table.
    const AR_INDIC_SSN = toNdDigits("123-45-6789", 0x0660); // Arabic-Indic → 123-45-6789 → [SSN_US]
    const AR_INDIC_CARD = toNdDigits("4111111111111111", 0x0660); // Arabic-Indic Luhn card → [CREDIT_CARD] // pragma: allowlist secret
    const ZW_SPLIT_EMAIL = "victim@examp​le.com"; // U+200B in the domain → victim@example.com → [EMAIL]
    const SSN_FOLDED = "123-45-6789";
    const CARD_FOLDED = "4111111111111111"; // pragma: allowlist secret
    const EMAIL_FOLDED = "victim@example.com";

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-forensic-pii", {
        traceId: AR_INDIC_SSN, // forensic key, Arabic-Indic SSN
        spanId: AR_INDIC_CARD, // forensic key, Arabic-Indic card
        correlationId: ZW_SPLIT_EMAIL, // forensic key, zero-width-split email
        // NO-DEGRADE controls in the SAME record: benign-opaque forensic leaves survive verbatim,
        // and a benign phone-SHAPED forensic id (folds to phone_us, which does NOT disqualify).
        requestId: "run-abc-123",
        messageId: "wamid.XYZ",
        nodeId: BENIGN_AR_FORENSIC_ID, // Arabic-Indic 2015550123 → phone_us → still preserved
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      // Neither the raw obfuscated form NOR the folded ASCII form may survive in either sink.
      expect(sink).not.toContain(AR_INDIC_SSN);
      expect(sink).not.toContain(AR_INDIC_CARD);
      expect(sink).not.toContain(ZW_SPLIT_EMAIL);
      expect(sink).not.toContain(SSN_FOLDED);
      expect(sink).not.toContain(CARD_FOLDED);
      expect(sink).not.toContain(EMAIL_FOLDED);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.traceId).toBe("[SSN_US]");
      expect(details.spanId).toBe("[CREDIT_CARD]");
      expect(details.correlationId).toBe("[EMAIL]");
      // NO-DEGRADE: benign-opaque + phone-shaped forensic leaves preserved byte-identical.
      expect(details.requestId).toBe("run-abc-123");
      expect(details.messageId).toBe("wamid.XYZ");
      expect(details.nodeId).toBe(BENIGN_AR_FORENSIC_ID);
      expect(details.nodeId).not.toBe("[PHONE_US]");
    }
  });

  it("RED→GREEN round-6: further obfuscation forms (Extended-Arabic / Devanagari / ZWNJ / WORD JOINER / BOM) of email/SSN/card on forensic keys are redacted in BOTH sinks", async () => {
    const EXT_AR_SSN = toNdDigits("123-45-6789", 0x06f0); // Extended Arabic-Indic → [SSN_US]
    const DEVANAGARI_CARD_F = toNdDigits("4111111111111111", 0x0966); // Devanagari → [CREDIT_CARD] // pragma: allowlist secret
    const ZWNJ_SSN = "123-45-‌6789"; // U+200C ZERO WIDTH NON-JOINER → [SSN_US]
    const WJ_CARD = "4111⁠1111⁠1111⁠1111"; // U+2060 WORD JOINER → [CREDIT_CARD] // pragma: allowlist secret
    const BOM_EMAIL = "victim@exa﻿mple.com"; // U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM → [EMAIL]
    const SSN_FOLDED = "123-45-6789";
    const CARD_FOLDED = "4111111111111111"; // pragma: allowlist secret
    const EMAIL_FOLDED = "victim@example.com";

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-forensic-pii-forms", {
        traceId: EXT_AR_SSN, // forensic
        spanId: DEVANAGARI_CARD_F, // forensic
        correlationId: BOM_EMAIL, // forensic
        runId: ZWNJ_SSN, // forensic
        nodeId: WJ_CARD, // forensic
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(EXT_AR_SSN);
      expect(sink).not.toContain(DEVANAGARI_CARD_F);
      expect(sink).not.toContain(BOM_EMAIL);
      expect(sink).not.toContain(ZWNJ_SSN);
      expect(sink).not.toContain(WJ_CARD);
      expect(sink).not.toContain(SSN_FOLDED);
      expect(sink).not.toContain(CARD_FOLDED);
      expect(sink).not.toContain(EMAIL_FOLDED);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.traceId).toBe("[SSN_US]");
      expect(details.spanId).toBe("[CREDIT_CARD]");
      expect(details.correlationId).toBe("[EMAIL]");
      expect(details.runId).toBe("[SSN_US]");
      expect(details.nodeId).toBe("[CREDIT_CARD]");
    }
  });

  // ── Round-7 blocking finding (PRIV-UNICODE-REDACTION-001): COMBINING MARKS + NFKC compatibility
  //    forms defeat shape recognition ──
  //
  // An independent real-append probe (real SQLite `audit_logs.details_json` + `audit.jsonl`) proved
  // that an ordinary Unicode COMBINING MARK (General_Category Mn/Mc/Me) spliced into a token breaks
  // the SSN / card / email / secret shape matchers — `123-45-6́789` and `sk-́…` persisted
  // VERBATIM in BOTH at-rest sinks, because the shared detection normalizer folded Nd digits and
  // stripped Cf/default-ignorable but passed combining marks through unchanged. The class fix extends
  // the normalizer to (a) apply NFKC compatibility folding (mathematical alphanumerics `\u{1D5CC}` →
  // `s`, fullwidth, ligatures, circled/superscript) and (b) strip combining marks (Mn/Mc/Me) on the
  // DETECTION COPY only, while storage stays byte-identical. RED on 027fabf1; GREEN post-fix.

  // Map ASCII digits to Mathematical Bold Digits (U+1D7CE + d) — NFKC-folds to ASCII by value.
  function toMathBoldDigits(ascii: string): string {
    return ascii.replace(/[0-9]/g, (d) => String.fromCodePoint(0x1d7ce + Number(d)));
  }
  // Map ASCII lowercase letters to Mathematical Sans-Serif Small (U+1D5BA + offset) — NFKC → ASCII.
  function toMathSansLower(ascii: string): string {
    return ascii.replace(/[a-z]/g, (c) => String.fromCodePoint(0x1d5ba + (c.charCodeAt(0) - 0x61)));
  }
  // Map ASCII digits to Circled Digits (0 → U+24EA, 1-9 → U+2460 + (d-1)) — NFKC → ASCII by value.
  function toCircledDigits(ascii: string): string {
    return ascii.replace(/[0-9]/g, (d) => {
      const n = Number(d);
      return n === 0 ? "⓪" : String.fromCodePoint(0x2460 + (n - 1));
    });
  }

  const CB = "́"; // COMBINING ACUTE ACCENT (Mn) — the Advisor's obfuscation code point

  it("RED→GREEN round-7 (combining marks): SSN/card/email/secret obfuscated by combining marks are redacted on CONTENT keys in BOTH sinks", async () => {
    // The Advisor's exact probe (`123-45-6́789`, `sk-́…`) plus interspersed marks.
    const CB_SSN = `123-45-6${CB}789`; // → 123-45-6789 → [SSN_US]
    const CB_SSN_MULTI = `1${CB}23-4${CB}5-67${CB}89`; // marks at multiple positions → 123-45-6789
    const CB_CARD = `411111111111${CB}1111`; // → 4111111111111111 → [CREDIT_CARD] // pragma: allowlist secret
    const CB_EMAIL = `victim@exa${CB}mple.com`; // combining mark on a letter → victim@example.com → [EMAIL]
    const SK_BODY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret
    const CB_SK_SECRET = `sk-${CB}${SK_BODY}`; // the Advisor's `sk-́…` probe → [REDACTED_SECRET] // pragma: allowlist secret
    const GH_BODY = "github_pat_11ABCDEF0aBcDeFgHiJkL0123456789abcdefghij"; // pragma: allowlist secret
    const CB_GH_PAT = `github_pat_${CB}11ABCDEF0aBcDeFgHiJkL0123456789abcdefghij`; // pragma: allowlist secret

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-combining-content", {
        ssn: CB_SSN,
        ssnMulti: CB_SSN_MULTI,
        card: CB_CARD,
        errorMessage: `mail ${CB_EMAIL}; key ${CB_SK_SECRET}`,
        note: `deploy used ${CB_GH_PAT}`,
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      // Neither the raw combining-obfuscated form NOR the folded ASCII shape survives.
      expect(sink).not.toContain(CB_SSN);
      expect(sink).not.toContain(CB_SSN_MULTI);
      expect(sink).not.toContain(CB_CARD);
      expect(sink).not.toContain(CB_EMAIL);
      expect(sink).not.toContain(CB_SK_SECRET);
      expect(sink).not.toContain(CB_GH_PAT);
      expect(sink).not.toContain("123-45-6789");
      expect(sink).not.toContain("4111111111111111"); // pragma: allowlist secret
      expect(sink).not.toContain("victim@example.com");
      expect(sink).not.toContain(SK_BODY);
      expect(sink).not.toContain(GH_BODY);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.ssn).toBe("[SSN_US]");
      expect(details.ssnMulti).toBe("[SSN_US]");
      expect(details.card).toBe("[CREDIT_CARD]");
      expect(details.errorMessage).toContain("[EMAIL]");
      expect(details.errorMessage).toContain("[REDACTED_SECRET]");
      expect(details.note).toContain("[REDACTED_SECRET]");
      expect(details.note).toContain("deploy used");
    }
  });

  it("RED→GREEN round-7 (combining marks on FORENSIC keys): combining-obfuscated email/SSN/card on forensic keys are redacted in BOTH sinks (gate de-obfuscates)", async () => {
    // Same #1618 forensic-leaf gate as round-6, now over combining-mark obfuscation.
    const CB_SSN = `123-45-6${CB}789`;
    const CB_CARD = `411111111111${CB}1111`; // pragma: allowlist secret
    const CB_EMAIL = `victim@exa${CB}mple.com`;

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-combining-forensic", {
        traceId: CB_SSN, // forensic key
        spanId: CB_CARD, // forensic key
        correlationId: CB_EMAIL, // forensic key
        // NO-DEGRADE controls: benign-opaque forensic leaves survive verbatim.
        requestId: "run-abc-123",
        messageId: "wamid.XYZ",
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(CB_SSN);
      expect(sink).not.toContain(CB_CARD);
      expect(sink).not.toContain(CB_EMAIL);
      expect(sink).not.toContain("123-45-6789");
      expect(sink).not.toContain("4111111111111111"); // pragma: allowlist secret
      expect(sink).not.toContain("victim@example.com");
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.traceId).toBe("[SSN_US]");
      expect(details.spanId).toBe("[CREDIT_CARD]");
      expect(details.correlationId).toBe("[EMAIL]");
      expect(details.requestId).toBe("run-abc-123");
      expect(details.messageId).toBe("wamid.XYZ");
    }
  });

  it("RED→GREEN round-7 (NFKC class closure): mathematical-alphanumeric / circled / superscript obfuscated secret + PII redacted on CONTENT and FORENSIC keys in BOTH sinks", async () => {
    const MATH_SK_SECRET = `${toMathSansLower("sk")}-${"abcdefghijklmnop0123456789"}`; // 𝗌𝗄-… → [REDACTED_SECRET] // pragma: allowlist secret
    const MATH_CARD = toMathBoldDigits("4111111111111111"); // math-digit card (re-confirm) → [CREDIT_CARD] // pragma: allowlist secret
    const CIRCLED_SSN = toCircledDigits("123-45-6789").replace(/-/g, "-"); // circled digits → 123-45-6789 → [SSN_US]
    const SUPERSCRIPT_CARD = "⁴¹¹¹¹¹¹¹¹¹¹¹¹¹¹¹"; // ⁴¹¹… → 4111111111111111 // pragma: allowlist secret
    const SK_BODY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-nfkc-class", {
        errorMessage: `secret ${MATH_SK_SECRET} leaked`, // content
        cardContent: MATH_CARD, // content
        spanId: CIRCLED_SSN, // forensic key → de-obfuscated + redacted
        traceId: SUPERSCRIPT_CARD, // forensic key → de-obfuscated + redacted
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(MATH_SK_SECRET);
      expect(sink).not.toContain(MATH_CARD);
      expect(sink).not.toContain(CIRCLED_SSN);
      expect(sink).not.toContain(SUPERSCRIPT_CARD);
      expect(sink).not.toContain(SK_BODY);
      expect(sink).not.toContain("4111111111111111"); // pragma: allowlist secret
      expect(sink).not.toContain("123-45-6789");
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.errorMessage).toContain("[REDACTED_SECRET]");
      expect(details.cardContent).toBe("[CREDIT_CARD]");
      expect(details.spanId).toBe("[SSN_US]");
      expect(details.traceId).toBe("[CREDIT_CARD]");
    }
  });

  it("NO-DEGRADE round-7: benign combining / diacritic multilingual text + benign math-word survive BYTE-IDENTICAL in BOTH sinks; benign phone-shaped forensic id preserved", async () => {
    const BENIGN_COMBINING_CAFE = "café résumé"; // café résumé via combining acute
    const BENIGN_ARABIC_HARAKAT = "مَرْحَبًا بِكَ"; // Arabic with harakat (Mn marks)
    const BENIGN_HEBREW_NIQQUD = "שָׁלוֹם עוֹלָם"; // Hebrew with niqqud (Mn marks)
    const BENIGN_DEVANAGARI = "नमस्ते दुनिया"; // Devanagari with matras (Mc/Mn marks)
    const BENIGN_VIETNAMESE = "Xin chào thế giới"; // Vietnamese (precomposed diacritics)
    const BENIGN_MATH_WORD = "\u{1D5DB}\u{1D5D8}\u{1D5DF}\u{1D5DF}\u{1D5E2}"; // 𝗛𝗘𝗟𝗟𝗢 — benign math word, no PII shape
    const BENIGN_AR_FORENSIC = "٢٠١٥٥٥٠١٢٣"; // ٢٠١٥٥٥٠١٢٣ → 2015550123 (phone_us)

    const details = {
      cafe: BENIGN_COMBINING_CAFE,
      harakat: BENIGN_ARABIC_HARAKAT,
      niqqud: BENIGN_HEBREW_NIQQUD,
      devanagari: BENIGN_DEVANAGARI,
      vietnamese: BENIGN_VIETNAMESE,
      mathWord: BENIGN_MATH_WORD,
      requestId: BENIGN_AR_FORENSIC, // forensic, phone-shaped when folded → must NOT be redacted
    };
    const { sqliteDetails, jsonlDetails, sqliteDetailsJson, jsonlLine } = await writeAndReadBack(
      unicodeEntry("unicode-benign-round7", details),
    );

    for (const readBack of [sqliteDetails, jsonlDetails]) {
      expect(readBack.cafe).toBe(BENIGN_COMBINING_CAFE);
      expect(readBack.harakat).toBe(BENIGN_ARABIC_HARAKAT);
      expect(readBack.niqqud).toBe(BENIGN_HEBREW_NIQQUD);
      expect(readBack.devanagari).toBe(BENIGN_DEVANAGARI);
      expect(readBack.vietnamese).toBe(BENIGN_VIETNAMESE);
      expect(readBack.mathWord).toBe(BENIGN_MATH_WORD);
      expect(readBack.requestId).toBe(BENIGN_AR_FORENSIC);
      expect(readBack.requestId).not.toBe("[PHONE_US]");
    }
    // Raw sink bytes carry the combining/diacritic/math forms verbatim (no detection-copy leakage).
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink).toContain(BENIGN_COMBINING_CAFE);
      expect(sink).toContain(BENIGN_MATH_WORD);
    }
  });

  // -- Round-8 blocking finding (PRIV-UNICODE-REDACTION-001): canonical-equivalence bypass --
  //
  // Round-7 folded the DETECTION COPY with NFKC, on the premise that a precomposed accented form
  // "becomes base + mark". That premise is FALSE: NFKC PRESERVES precomposed accented letters --
  // it does NOT decompose them. A precomposed s-with-acute (U+015B, ONE code point) stays a LETTER,
  // not a \p{M} mark, so the combining-mark strip did nothing and a PRECOMPOSED (NFC) accented
  // base leaked: the secret matcher never folded it to `sk-...`. An independent real-append probe
  // proved the NFC-precomposed credential body persisted VERBATIM in BOTH the SQLite
  // `audit_logs.details_json` column AND `audit.jsonl`. The class fix switches the fold from NFKC
  // to NFKD (compatibility DECOMPOSITION): NFKD folds EVERY compatibility form NFKC folded AND
  // decomposes a precomposed accented character to base + combining mark(s), so the mark strip
  // then collapses BOTH the precomposed and the decomposed spelling to the SAME base. RED on
  // 748ae6a0 for the PRECOMPOSED form; GREEN post-fix. Storage stays byte-identical (detection-copy
  // only). All accented fixtures use explicit \u escapes so precomposed vs decomposed is unambiguous.
  //
  // Email uses a DOMAIN-side accent: the raw guard's ASCII email regex fails entirely on the
  // accented domain (verified: 0 raw matches), so the Unicode residual is the sole PII pass and
  // maps the whole email span (incl. the accent) back to the original -> a clean [EMAIL]. (A
  // LOCAL-part accent is a DIFFERENT, pre-existing partial-match in the raw guard that is identical
  // for both spellings and is NOT a canonical-equivalence bypass; it is out of this normalizer's
  // scope.) SSN/card use combining marks: ASCII digits admit NO precomposed accented variant, so
  // their canonical spelling IS the combining-mark form -- carried over from round-7 under NFKD.
  const ACUTE = "\u0301"; // COMBINING ACUTE ACCENT (Mn)
  const CEDILLA = "\u0327"; // COMBINING CEDILLA (Mn)

  it("RED->GREEN round-8 (canonical-equivalence matrix): PRECOMPOSED-accented sk- / github_pat_ / email AND decomposed / combining twins are redacted in BOTH sinks", async () => {
    const SK_BODY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret
    const GH_TAIL = "11ABCDEF0aBcDeFgHiJkL0123456789abcdefghij"; // pragma: allowlist secret

    // sk- provider key - base `s`. NFKC KEPT the precomposed s-acute (round-7 leak); NFKD -> s+U+0301.
    const SK_PRE = `\u015Bk-${SK_BODY}`; // U+015B (ONE precomposed code point) // pragma: allowlist secret
    const SK_DEC = `s${ACUTE}k-${SK_BODY}`; // s + U+0301 decomposed twin // pragma: allowlist secret
    // github_pat_ - base `g`. Precomposed g-cedilla (U+0123) vs g + U+0327 (combining cedilla).
    const GH_PRE = `\u0123ithub_pat_${GH_TAIL}`; // U+0123 precomposed // pragma: allowlist secret
    const GH_DEC = `g${CEDILLA}ithub_pat_${GH_TAIL}`; // g + U+0327 decomposed twin // pragma: allowlist secret
    const GH_FOLDED = `github_pat_${GH_TAIL}`; // pragma: allowlist secret
    // email - DOMAIN-side accent: precomposed e-acute (U+00E9) vs e + U+0301 -> victim@example.com.
    const EMAIL_PRE = "victim@\u00E9xample.com";
    const EMAIL_DEC = `victim@e${ACUTE}xample.com`;
    const EMAIL_FOLDED = "victim@example.com";
    // SSN / card - combining-mark obfuscation (digits have no precomposed accent); full-class carry-over.
    const SSN_CB = `123-45-6${ACUTE}789`; // -> 123-45-6789 -> [SSN_US]
    const CARD_CB = `411111111111${ACUTE}1111`; // -> 4111111111111111 -> [CREDIT_CARD] // pragma: allowlist secret

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-precomposed-matrix", {
        skPre: SK_PRE, // content
        skDec: SK_DEC, // content (decomposed twin - control; already covered by round-7)
        ghPre: GH_PRE, // content
        ghDec: GH_DEC, // content
        emailPre: EMAIL_PRE, // content
        emailDec: EMAIL_DEC, // content
        ssn: SSN_CB, // content
        card: CARD_CB, // content
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      // Neither the precomposed, decomposed, nor folded credential/PII body survives in either sink.
      expect(sink).not.toContain(SK_BODY);
      expect(sink).not.toContain(GH_TAIL);
      expect(sink).not.toContain(GH_FOLDED);
      expect(sink).not.toContain(EMAIL_PRE);
      expect(sink).not.toContain(EMAIL_DEC);
      expect(sink).not.toContain(EMAIL_FOLDED);
      expect(sink).not.toContain("123-45-6789");
      expect(sink).not.toContain("4111111111111111"); // pragma: allowlist secret
      // No raw precomposed-prefixed token residue (the accented base is inside the redacted span).
      expect(sink).not.toContain(SK_PRE);
      expect(sink).not.toContain(GH_PRE);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.skPre).toBe("[REDACTED_SECRET]");
      expect(details.skDec).toBe("[REDACTED_SECRET]");
      expect(details.ghPre).toBe("[REDACTED_SECRET]");
      expect(details.ghDec).toBe("[REDACTED_SECRET]");
      expect(details.emailPre).toBe("[EMAIL]");
      expect(details.emailDec).toBe("[EMAIL]");
      // Canonical-equivalence: precomposed and decomposed spellings redact IDENTICALLY.
      expect(details.skPre).toBe(details.skDec);
      expect(details.ghPre).toBe(details.ghDec);
      expect(details.emailPre).toBe(details.emailDec);
      expect(details.ssn).toBe("[SSN_US]");
      expect(details.card).toBe("[CREDIT_CARD]");
    }
  });

  it("RED->GREEN round-8 (precomposed on FORENSIC keys): a precomposed-accented email/secret on a forensic-named key is redacted in BOTH sinks (gate de-obfuscates)", async () => {
    // The #1618 forensic-leaf gate classifies over the de-obfuscated (NFKD) copy, so a precomposed
    // accented EMAIL / SECRET on a forensic key is disqualified and routed to content redaction.
    const EMAIL_PRE = "victim@\u00E9xample.com"; // precomposed domain accent -> victim@example.com
    const SK_BODY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret
    const SK_PRE = `\u015Bk-${SK_BODY}`; // s-acute precomposed // pragma: allowlist secret

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-precomposed-forensic", {
        correlationId: EMAIL_PRE, // forensic key -> precomposed email must be redacted
        traceId: SK_PRE, // forensic key -> precomposed secret must be redacted
        // NO-DEGRADE control: a benign-opaque forensic leaf survives verbatim.
        requestId: "run-abc-123",
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(EMAIL_PRE);
      expect(sink).not.toContain("victim@example.com");
      expect(sink).not.toContain(SK_PRE);
      expect(sink).not.toContain(SK_BODY);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details.correlationId).toBe("[EMAIL]");
      expect(details.traceId).toBe("[REDACTED_SECRET]");
      expect(details.requestId).toBe("run-abc-123");
    }
  });

  it("NO-DEGRADE round-8: benign PRECOMPOSED accented multilingual text survives BYTE-IDENTICAL in BOTH sinks", async () => {
    // cafe resume / Vietnamese / Latin, all PRECOMPOSED (NFC, explicit \u escapes). NFKD is
    // DETECTION-COPY only; benign precomposed prose folds to no PII/secret shape and is returned
    // verbatim (storage byte-identical). Hunt for NFKD false-positive over-redaction below.
    const CAFE_PRE = "caf\u00E9 r\u00E9sum\u00E9";
    const VIET_PRE = "Xin ch\u00E0o th\u1EBF gi\u1EDBi";
    const LATIN_PRE = "Z\u00FCrich Krak\u00F3w Malm\u00F6 pi\u00F1ata fa\u00E7ade S\u00E3o";
    const ERR = "connection reset by peer";
    const { sqliteDetails, jsonlDetails, sqliteDetailsJson, jsonlLine } = await writeAndReadBack(
      unicodeEntry("unicode-benign-precomposed", {
        cafe: CAFE_PRE,
        viet: VIET_PRE,
        latin: LATIN_PRE,
        err: ERR,
      }),
    );

    for (const readBack of [sqliteDetails, jsonlDetails]) {
      expect(readBack.cafe).toBe(CAFE_PRE);
      expect(readBack.viet).toBe(VIET_PRE);
      expect(readBack.latin).toBe(LATIN_PRE);
      expect(readBack.err).toBe(ERR);
    }
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink).toContain(CAFE_PRE);
      expect(sink).toContain(VIET_PRE);
      expect(sink).toContain(LATIN_PRE);
    }
  });

  // -- Round-8 residual: a LOCAL-PART (fragmenting) accent must redact CLEANLY, NFC === NFD --
  //
  // The round-8 fold closed the canonical-equivalence bypass in the DETECTION COPY, but one
  // residual remained in the WRITER's pass ordering: the ASCII PII guard (Pass 2, redactDeep on
  // the RAW value) runs BEFORE the Unicode residual (Pass 3). When the obfuscating accent sits in
  // the email LOCAL-PART, the ASCII email regex fragments the value -- it matches the still-valid
  // ASCII suffix (`ctim@example.com`) and leaves the accented prefix (`vic-acute` / `vi`+U+0301),
  // so Pass 3's full-span redaction never applied and the sinks kept `v[i-acute][EMAIL]`. Worse,
  // NFC (precomposed) and NFD (base+mark) left DIFFERENT residual bytes -- a canonical-equivalence
  // inconsistency. Fix: the Pass-1 CONTENT PRE-PASS now also runs the Unicode-aware content leaf on
  // the ORIGINAL value (it is a strict no-op on pure ASCII / benign accented text), so an
  // obfuscated email/secret/PII is redacted on its FULL original span BEFORE Pass 2 can fragment
  // it. RED on 9edd12ca (fragment residual, NFC != NFD); GREEN post-fix (clean [EMAIL], NFC === NFD).
  const LP_ACUTE = "\u0301"; // COMBINING ACUTE ACCENT (Mn)

  it("RED->GREEN round-8 (local-part / fragmenting accent): a local-part-accented email is CLEANLY full-span redacted (no fragment), NFC === NFD, in BOTH sinks", async () => {
    const EMAIL_LP_PRE = "v\u00EDctim@example.com"; // precomposed i-acute in the LOCAL part
    const EMAIL_LP_DEC = `vi${LP_ACUTE}ctim@example.com`; // i + U+0301 decomposed twin
    const EMAIL_FOLDED = "victim@example.com";
    // A secret whose accent sits mid-body, plus combining SSN/card -- all clean full redactions.
    const SK_BODY = "abcdefghijklmnop0123456789"; // pragma: allowlist secret
    const SK_MIDBODY = "sk-abcd\u00E9fghijklmnop0123456789"; // e-acute mid-body -> sk-abcdefghijklmnop... // pragma: allowlist secret
    const SSN_CB = `123-45-6${LP_ACUTE}789`; // -> 123-45-6789 -> [SSN_US]
    const CARD_CB = `411111111111${LP_ACUTE}1111`; // -> 4111111111111111 -> [CREDIT_CARD] // pragma: allowlist secret

    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-localpart-fragment", {
        emailLpPre: EMAIL_LP_PRE, // content
        emailLpDec: EMAIL_LP_DEC, // content
        // A FORENSIC-named key carrying the same local-part-accented email: the forensic-leaf gate
        // de-obfuscates, disqualifies it, and routes it to the content path -> clean full-span [EMAIL].
        correlationId: EMAIL_LP_PRE, // forensic key
        secretMid: SK_MIDBODY, // content
        ssn: SSN_CB, // content
        card: CARD_CB, // content
        // NO-DEGRADE control: a benign-opaque forensic leaf survives verbatim.
        requestId: "run-abc-123",
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      expect(sink).not.toContain(EMAIL_LP_PRE);
      expect(sink).not.toContain(EMAIL_LP_DEC);
      expect(sink).not.toContain(EMAIL_FOLDED);
      expect(sink).not.toContain("ctim@example.com"); // no fragmented email suffix
      expect(sink).not.toContain("\u00ED"); // no precomposed i-acute residue
      expect(sink).not.toContain(SK_BODY);
      expect(sink).not.toContain("123-45-6789");
      expect(sink).not.toContain("4111111111111111"); // pragma: allowlist secret
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      // Clean full-span redaction: EXACTLY the marker, no accented-prefix fragment.
      expect(details.emailLpPre).toBe("[EMAIL]");
      expect(details.emailLpDec).toBe("[EMAIL]");
      // Canonical-equivalence: NFC (precomposed) and NFD (base+mark) redact to IDENTICAL bytes.
      expect(details.emailLpPre).toBe(details.emailLpDec);
      // Forensic key with the same fragmenting email -> also clean full-span [EMAIL] (no residue).
      expect(details.correlationId).toBe("[EMAIL]");
      expect(details.secretMid).toBe("[REDACTED_SECRET]");
      expect(details.ssn).toBe("[SSN_US]");
      expect(details.card).toBe("[CREDIT_CARD]");
      // NO-DEGRADE: benign-opaque forensic leaf preserved verbatim.
      expect(details.requestId).toBe("run-abc-123");
    }
  });

  // ── Round-9 (Unicode-obfuscated sensitive KEY names) ──
  //
  // Round-8b closed Unicode obfuscation on VALUES. But the FIELD-NAME classifier
  // (`isSensitiveSecretFieldName`) still normalized ASCII hyphen/underscore/whitespace + lowercase
  // ONLY, so a sensitive KEY hidden behind a zero-width / combining / full-width / math-alnum /
  // precomposed-accent obfuscation ESCAPED classification. A shapeless credential VALUE (no secret
  // SHAPE — no `sk-`/`ghp_`/JWT/PEM/Bearer/`key=value`) is catchable ONLY by its KEY, so it persisted
  // VERBATIM in BOTH at-rest sinks. An independent real-`appendFridayAuditLog` probe confirmed
  // `api<U+200B>Key`, `to<U+0301>ken`, full-width `ｓｅｃｒｅｔ` credential values survived. RED on
  // 47c70192; GREEN once the key classifier canonicalizes the KEY through the SHARED
  // `buildUnicodeDetectionCopy` primitive (NFKD → strip \p{M} → strip Cf/Default_Ignorable → fold Nd)
  // BEFORE the existing ASCII normalization. The STORED key bytes stay ORIGINAL — only classification
  // uses the normalized form.

  // A shapeless opaque credential: no secret SHAPE, so it is catchable ONLY by its KEY.
  const SHAPELESS_CRED = "Xk9mQ2vLpR7tZwA"; // pragma: allowlist secret
  // Obfuscated sensitive KEY names (ASCII-fold canary in comment).
  const ZW_API_KEY = "api​Key"; // ZWSP → apikey (obfuscated field NAME, not a secret) // pragma: allowlist secret
  const COMBINING_TOKEN = "tóken"; // combining acute over `o` → token
  const FULLWIDTH_SECRET = "ｓｅｃｒｅｔ"; // full-width → secret
  const MATH_PASSWORD =
    "\u{1D429}\u{1D41A}\u{1D42C}\u{1D42C}\u{1D430}\u{1D428}\u{1D42B}\u{1D41D}"; // math-bold 𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝 → password
  const PRECOMPOSED_PASSWORD = "pásswörd"; // precomposed á / ö → password (obfuscated field NAME, not a secret) // pragma: allowlist secret

  it("RED→GREEN round-9: a shapeless credential under a Unicode-obfuscated sensitive KEY is nuked to the secret marker at top level, nested, AND inside arrays — in BOTH sinks (stored key bytes ORIGINAL)", async () => {
    const { sqliteDetailsJson, sqliteDetails, jsonlLine, jsonlDetails } = await writeAndReadBack(
      unicodeEntry("unicode-obfuscated-keys", {
        [ZW_API_KEY]: SHAPELESS_CRED, // top level, ZWSP-obfuscated `apiKey`
        nested: { [COMBINING_TOKEN]: SHAPELESS_CRED }, // one level down, combining-obfuscated `token`
        list: [
          { [FULLWIDTH_SECRET]: SHAPELESS_CRED }, // array element object, full-width `secret`
          { [MATH_PASSWORD]: SHAPELESS_CRED }, // array element object, math-bold `password`
        ],
        deeper: { level2: { [PRECOMPOSED_PASSWORD]: SHAPELESS_CRED } }, // two levels down, precomposed `password`
      }),
    );

    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      expect(sink.length).toBeGreaterThan(0);
      // The shapeless credential VALUE never survives in either sink at any depth.
      expect(sink).not.toContain(SHAPELESS_CRED);
      // The ORIGINAL obfuscated KEY BYTES are preserved (only the VALUE is redacted, not the key).
      expect(sink).toContain(ZW_API_KEY);
      expect(sink).toContain(FULLWIDTH_SECRET);
      expect(sink).toContain(PRECOMPOSED_PASSWORD);
    }
    for (const details of [sqliteDetails, jsonlDetails]) {
      expect(details[ZW_API_KEY]).toBe("[REDACTED_SECRET]");
      expect((details.nested as Record<string, unknown>)[COMBINING_TOKEN]).toBe("[REDACTED_SECRET]");
      const list = details.list as Array<Record<string, unknown>>;
      expect(list[0][FULLWIDTH_SECRET]).toBe("[REDACTED_SECRET]");
      expect(list[1][MATH_PASSWORD]).toBe("[REDACTED_SECRET]");
      expect(
        ((details.deeper as Record<string, unknown>).level2 as Record<string, unknown>)[
          PRECOMPOSED_PASSWORD
        ],
      ).toBe("[REDACTED_SECRET]");
      // The obfuscated key itself is preserved as an OWN key (byte-identical), never renamed.
      expect(Object.prototype.hasOwnProperty.call(details, ZW_API_KEY)).toBe(true);
    }
  });

  it("NO-DEGRADE round-9: benign multilingual / near-miss KEY names (CJK / Arabic / accented / emoji-adjacent / full-width plural / compound) keep keys AND values BYTE-IDENTICAL in BOTH sinks", async () => {
    const benign = {
      用户名: "alice", // CJK `用户名` (username)
      اسم: "bob", // Arabic `اسم` (name)
      café: "latte", // accented `café` → cafe, not a credential
      "🔑icon": "star", // emoji-adjacent — folds to `🔑icon`, not a credential token
      ｔｏｋｅｎｓ: "three", // full-width `ｔｏｋｅｎｓ` → tokens (plural ≠ token)
      ｋｅｙ: "opaqueValue123", // full-width `ｋｅｙ` → key (bare `key` intentionally NOT sensitive)
      ｐａｓｓｗｏｒｄＨｉｎｔ: "your first pet", // full-width `passwordHint` → passwordhint (compound ≠ password)
    };
    const { sqliteDetails, jsonlDetails, sqliteDetailsJson, jsonlLine } = await writeAndReadBack(
      unicodeEntry("unicode-benign-keys", benign),
    );

    for (const details of [sqliteDetails, jsonlDetails]) {
      for (const [k, v] of Object.entries(benign)) {
        // Key survives as an own key (not renamed / normalized) and its value is byte-identical.
        expect(Object.prototype.hasOwnProperty.call(details, k)).toBe(true);
        expect(details[k]).toBe(v);
      }
    }
    // Raw sink bytes carry the ORIGINAL keys AND values, and never the secret marker.
    for (const sink of [sqliteDetailsJson, jsonlLine]) {
      for (const [k, v] of Object.entries(benign)) {
        expect(sink).toContain(k);
        expect(sink).toContain(v);
      }
      expect(sink).not.toContain("[REDACTED_SECRET]");
    }
  });
});
