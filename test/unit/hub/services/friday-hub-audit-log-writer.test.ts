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
});
