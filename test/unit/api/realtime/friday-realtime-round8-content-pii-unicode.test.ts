/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-8 F2b — RED-FIRST proofs that CONTENT-field
 * value-PII redaction is now Unicode-obfuscation resistant (not just secrets).
 *
 * Before this round, the realtime payload's Unicode-resistant pass covered SECRETS only;
 * content PII still relied on the shared ASCII + fullwidth-DIGIT guard, so a letter-based
 * Unicode-obfuscated EMAIL survived VERBATIM in `payload_json` and on the delivered
 * envelope (e.g. `ｖｉｃｔｉｍ．ｆｗ@example.com`, whose ASCII `@example.com` and trivially
 * de-obfuscatable fullwidth local part both persisted), and a zero-width / combining split
 * only PARTIALLY redacted (`victim‌[EMAIL]` / `415̀[PHONE_US]` fragment residual).
 *
 * The fix extends the realtime-payload Unicode redaction from secrets-only to the COMPLETE
 * PII+secret set over the SAME NFKD detection copy, redacting the FULL original span with
 * the guard's canonical `[<TYPE>]` marker before any ASCII pass can fragment it. These
 * assertions FAIL against the pre-round-8 implementation (raw / de-obfuscated bytes present,
 * or a fragment residual). They cover BOTH sinks — raw `payload_json` (at rest) AND the
 * delivered envelope — via the REAL event bus + repository, plus fast unit exact-span
 * checks, and prove NO-DEGRADE on benign multilingual content and identifier fields.
 */

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import {
  redactEventPayload,
  createFridayRealtimeEventBus,
  createFridayRealtimeEventRepository,
} from "#api";
import type { FridayRealtimeEventEnvelope } from "#api";
import { createFridayRealtimePseudonymizer } from "../../../../src/api/realtime/friday-realtime-pseudonym.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-round8"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";

function activePseudonymizer() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
}

/** In-memory FridaySqliteLayer with the full migration set (v106 owner + epoch). */
function simpleTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection: (fn) => fn(db),
      close() {},
    },
    withWriteTransaction: (fn) => db.transaction(() => fn(db))(),
    withReadConnection: (fn) => fn(db),
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  } as FridaySqliteLayer;
}

/** Map each ASCII printable code point 0x21–0x7E to its FULLWIDTH form (+0xFEE0). */
function toFullwidth(ascii: string): string {
  return [...ascii]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x21 && cp <= 0x7e ? String.fromCodePoint(cp + 0xfee0) : ch;
    })
    .join("");
}

const ZWNJ = "‌"; // zero-width non-joiner (Cf / Default_Ignorable)
const COMBINING_ACUTE = "́"; // combining acute accent (\p{M})
const COMBINING_GRAVE = "̀";

// ─── Obfuscated EMAIL variants (de-obfuscated form is always victim@example.com family) ───

// Fullwidth local part, ASCII @example.com (the exact F2b example).
const FW_EMAIL = `${toFullwidth("victim.fw")}@example.com`;
const FW_EMAIL_DEOBFUSCATED = "victim.fw@example.com";

// Zero-width split between the local part and the '@'.
const ZW_EMAIL = `victim${ZWNJ}@example.com`;
const ZW_EMAIL_DEOBFUSCATED = "victim@example.com";

// Combining acute INSIDE the local part — the ASCII pass fragments this (leaves `ví…`).
const COMBINING_EMAIL = `vi${COMBINING_ACUTE}ctim@example.com`;

// Precomposed accent (single code point ï = U+00EF) vs its decomposed twin (i + U+0308):
// NFKD collapses both to the SAME detection copy, so they must redact IDENTICALLY.
const PRECOMPOSED_EMAIL = "naïve.user@example.com"; // ï precomposed
const DECOMPOSED_EMAIL = "naïve.user@example.com"; // i + combining diaeresis

// Phone with a combining grave splitting the digit run — the ASCII pass leaves `415̀…`.
const COMBINING_PHONE = `415${COMBINING_GRAVE}5550132`;

// Re-confirm fullwidth SSN / card still redact (guard already folds digits; the pass must
// not regress them).
const FW_SSN = toFullwidth("123-45-6789");
const FW_CARD = toFullwidth("4111111111111111"); // Luhn-valid

function serialize(v: unknown): string {
  return JSON.stringify(v);
}

// ─── Unit: exact full-span redaction (strongest "no fragment residual" proof) ───

describe("round-8 F2b — content EMAIL redaction is Unicode-obfuscation resistant (exact span)", () => {
  it("fullwidth email → FULL span replaced by [EMAIL] (no raw, no de-obfuscated, no fragment)", () => {
    const out = redactEventPayload({ note: `reach me at ${FW_EMAIL} now` }) as { note: string };
    expect(out.note).toBe("reach me at [EMAIL] now");
    const s = serialize(out);
    expect(s).not.toContain(FW_EMAIL);
    expect(s).not.toContain(FW_EMAIL_DEOBFUSCATED);
    expect(s).not.toContain("@example.com");
    expect(s).not.toContain(toFullwidth("victim"));
  });

  it("zero-width-split email → FULL span replaced (no victim‌[EMAIL] fragment, ZWNJ gone)", () => {
    const out = redactEventPayload({ note: `reach me at ${ZW_EMAIL} now` }) as { note: string };
    expect(out.note).toBe("reach me at [EMAIL] now");
    const s = serialize(out);
    expect(s).not.toContain(ZW_EMAIL_DEOBFUSCATED);
    expect(s).not.toContain("victim");
    expect(s).not.toContain("@example.com");
    expect(s).not.toContain(ZWNJ); // no zero-width fragment residual
  });

  it("combining-accent email → FULL span replaced (no ví… fragment, combining mark gone)", () => {
    const out = redactEventPayload({ note: `reach me at ${COMBINING_EMAIL} now` }) as {
      note: string;
    };
    expect(out.note).toBe("reach me at [EMAIL] now");
    const s = serialize(out);
    expect(s).not.toContain("victim@example.com");
    expect(s).not.toContain("ctim@example.com"); // the pre-fix ASCII fragment
    expect(s).not.toContain("@example.com");
    expect(s).not.toContain(COMBINING_ACUTE);
  });

  it("canonical equivalence: precomposed and decomposed accented emails redact IDENTICALLY", () => {
    const outP = redactEventPayload({ note: `p ${PRECOMPOSED_EMAIL}` }) as { note: string };
    const outD = redactEventPayload({ note: `p ${DECOMPOSED_EMAIL}` }) as { note: string };
    expect(outP.note).toBe("p [EMAIL]");
    expect(outD.note).toBe("p [EMAIL]");
    expect(serialize(outP)).not.toContain("example.com");
    expect(serialize(outD)).not.toContain("example.com");
  });

  it("combining-split phone → FULL [PHONE_US] span (no 415̀… fragment)", () => {
    const out = redactEventPayload({ note: `call ${COMBINING_PHONE} back` }) as { note: string };
    expect(out.note).toBe("call [PHONE_US] back");
    const s = serialize(out);
    expect(s).not.toContain("4155550132");
    expect(s).not.toContain("5550132"); // the pre-fix ASCII fragment
    expect(s).not.toContain(COMBINING_GRAVE);
  });

  it("re-confirm: fullwidth SSN and fullwidth card still redact full-span (no regression)", () => {
    const ssnOut = redactEventPayload({ note: `ssn ${FW_SSN}` }) as { note: string };
    expect(ssnOut.note).toBe("ssn [SSN_US]");
    expect(serialize(ssnOut)).not.toContain("6789");

    const cardOut = redactEventPayload({ note: `card ${FW_CARD}` }) as { note: string };
    expect(cardOut.note).toBe("card [CREDIT_CARD]");
    expect(serialize(cardOut)).not.toContain("4111111111111111");
    expect(serialize(cardOut)).not.toContain(toFullwidth("4111111111111111"));
  });
});

// ─── NO-DEGRADE: benign content is byte-identical; identifier fields keep identity ───

describe("round-8 F2b — NO-DEGRADE (benign content + identifiers preserved)", () => {
  it("benign multilingual / accented payload is byte-identical", () => {
    const payload = {
      note: "café ☕ 日本語 naïve résumé — a normal message",
      region: "us-west-2",
      detail: "Ünïcödé header — no PII here",
    };
    const out = redactEventPayload(payload);
    expect(out).toEqual(payload);
    expect(serialize(out)).toBe(serialize(payload));
  });

  it("benign phone-shaped identifier VALUE is preserved (distinct ids stay distinct)", () => {
    const payload = { orderId: "4155550132", sessionId: "5551234567", note: "ok" };
    const out = redactEventPayload(payload) as typeof payload;
    // Identifier fields are exempt from value-PII redaction — no [PHONE_US] rewrite.
    expect(out.orderId).toBe("4155550132");
    expect(out.sessionId).toBe("5551234567");
    expect(out.orderId).not.toBe(out.sessionId);
    expect(serialize(out)).not.toContain("[PHONE_US]");
  });
});

// ─── Real Hub: BOTH sinks (raw payload_json at rest + delivered envelope) ───

describe("round-8 F2b — real bus + repo: obfuscated content PII clean in BOTH sinks", () => {
  function publishNote(note: string): { storedPayloadJson: string; deliveredPayload: unknown } {
    const db = simpleTestDb();
    try {
      const p = activePseudonymizer();
      const eventRepo = createFridayRealtimeEventRepository({ resolveOwnerId: () => OWNER });
      let counter = 0;
      const bus = createFridayRealtimeEventBus({
        idGenerator: () => `evt-${++counter}`,
        nowIso: () => NOW,
        db,
        eventRepo,
        pseudonymizer: p,
      });
      const delivered: FridayRealtimeEventEnvelope[] = [];
      bus.subscribe((env) => delivered.push(env));

      bus.publish(
        "run:content-pii",
        "workflow.run.failed" as never,
        { runId: "content-pii", error: { message: note } } as never,
      );

      const storedPayloadJson = db.withReadConnection(
        (r) =>
          (r
            .prepare("SELECT payload_json FROM realtime_events WHERE stream_id LIKE 'run:%'")
            .get() as { payload_json: string }).payload_json,
      );
      expect(delivered).toHaveLength(1);
      return { storedPayloadJson, deliveredPayload: delivered[0].payload };
    } finally {
      db.close();
    }
  }

  it("fullwidth email: no raw, no de-obfuscated, no @example.com in payload_json OR envelope", () => {
    const { storedPayloadJson, deliveredPayload } = publishNote(`stderr leaked ${FW_EMAIL}`);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).not.toContain(FW_EMAIL);
      expect(sink).not.toContain(FW_EMAIL_DEOBFUSCATED);
      expect(sink).not.toContain("@example.com");
      expect(sink).not.toContain(toFullwidth("victim"));
      expect(sink).toContain("[EMAIL]");
    }
  });

  it("zero-width-split email: no de-obfuscated bytes, no ZWNJ fragment in either sink", () => {
    const { storedPayloadJson, deliveredPayload } = publishNote(`user says ${ZW_EMAIL} thanks`);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).not.toContain(ZW_EMAIL_DEOBFUSCATED);
      expect(sink).not.toContain("victim");
      expect(sink).not.toContain("@example.com");
      expect(sink).not.toContain(ZWNJ);
      expect(sink).toContain("[EMAIL]");
    }
  });

  it("combining phone + fullwidth card: full-span markers, no raw/de-obfuscated in either sink", () => {
    const { storedPayloadJson, deliveredPayload } = publishNote(
      `call ${COMBINING_PHONE}; card ${FW_CARD}`,
    );
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).not.toContain("4155550132");
      expect(sink).not.toContain("5550132");
      expect(sink).not.toContain("4111111111111111");
      expect(sink).not.toContain(toFullwidth("4111111111111111"));
      expect(sink).toContain("[PHONE_US]");
      expect(sink).toContain("[CREDIT_CARD]");
    }
  });

  it("benign multilingual content persists byte-identical at rest (no over-redaction)", () => {
    const benign = "café ☕ 日本語 naïve résumé — normal";
    const { storedPayloadJson, deliveredPayload } = publishNote(benign);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).toContain(benign);
      expect(sink).not.toContain("[EMAIL]");
      expect(sink).not.toContain("[REDACTED]");
    }
  });
});
