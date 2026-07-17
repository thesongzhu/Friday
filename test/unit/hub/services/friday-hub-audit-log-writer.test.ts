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
  // correlation id is deliberately phone-SHAPED: a blunt deep-redact would collapse it to
  // "[PHONE_US]" and corrupt/merge distinct ids.
  const BENIGN_PHONE_SHAPED_ID = "2015550123";
  const RUN_ID = "run-42";
  const MESSAGE_ID = "wamid.HBgLABC123";
  const ROUTE_ID = "route-signal-in";
  // Channel session key embeds the chatId phone (`channel:<kind>:<chatId>`, normalized not hashed),
  // so its routing prefix must survive while the embedded phone is redacted.
  const SESSION_KEY = "channel:signal:+14155552671";

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
        correlationId: BENIGN_PHONE_SHAPED_ID,
        channelCorrelationId: BENIGN_PHONE_SHAPED_ID,
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

    // Sink B parsed must agree with sink A (both fed by the same redacted record).
    const jsonlDetails = jsonlRecord.details as Record<string, string>;
    expect(jsonlDetails.chatId).toBe("[PHONE_US]");
    expect(jsonlDetails.apiKey).toBe("[REDACTED_SECRET]");
  });

  it("preserves forensic identifier fields verbatim — does NOT collapse or corrupt distinct ids (#1618 field-role lesson)", async () => {
    const { sqliteDetailsJson, sqliteDetails } = await writeAndReadBack(piiEntry("preserve-1"));
    const details = sqliteDetails as Record<string, string>;

    // The phone-SHAPED benign id survives on every identifier field (never merged to [PHONE_US]).
    expect(details.correlationId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(details.channelCorrelationId).toBe(BENIGN_PHONE_SHAPED_ID);
    expect(details.routeId).toBe(ROUTE_ID);
    expect(details.runId).toBe(RUN_ID);
    expect(details.messageId).toBe(MESSAGE_ID);
    // Proof of preservation at the raw-sink level: the benign phone-shaped id is present.
    expect(sqliteDetailsJson).toContain(BENIGN_PHONE_SHAPED_ID);
    // Distinct-entity proof: correlationId and channelCorrelationId are NOT masked to one marker.
    expect(details.correlationId).not.toBe("[PHONE_US]");
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
});
