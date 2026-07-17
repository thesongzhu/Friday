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
