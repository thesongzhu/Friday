/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / round-9 F2b-ND-1 — RED-FIRST proofs that the CONTENT-field
 * value-PII pass no longer OVER-redacts benign content by folding MORE than the shared guard.
 *
 * Round-8 ran the guard's PII detectors over a FULL-NFKD normalized copy. Full NFKD folds MORE
 * than the shared guard's DELIBERATE `foldWidthForMatching`: it collapses compatibility
 * WHITESPACE (U+3000/U+00A0/U+2007/U+202F → ASCII space) and No/Nl "digit-like" forms (circled
 * ①, superscript ¹ → ASCII digits). The guard intentionally does NOT fold those — precisely so
 * the card regex's `[ -]` separator class cannot bridge two distinct number groups into a false
 * Luhn card, and so a decorative circled-digit run is never fabricated into a card. As a result
 * benign content the guard PRESERVES byte-identical was falsely masked as `[CREDIT_CARD]`:
 *   ４１１１１１１１<U+3000>１１１１１１１１   (guard: preserved · round-8: [CREDIT_CARD] — BUG)
 *   ４１１１１１１１<U+00A0/2007/202F>…      (guard: preserved · round-8: [CREDIT_CARD] — BUG)
 *   ④①①①①①①①①①①①①①①①               (guard: preserved · round-8: [CREDIT_CARD] — BUG)
 *
 * The fix ALIGNS #1618's PII detection copy with the guard's deliberate fold set: it PRESERVES
 * compatibility whitespace and No/Nl digit-likes from the compatibility fold (matching the guard)
 * while KEEPING the extra obfuscation-stripping the guard lacks (zero-width/combining/precomposed
 * accent + fullwidth/math LETTER folds) that is the REAL F2b leak-closure. These assertions FAIL
 * against 69ca502f (benign content wrongly `[CREDIT_CARD]`) and prove, in BOTH sinks (raw
 * `payload_json` at rest AND the delivered envelope via the REAL bus+repo), that the benign inputs
 * are now PRESERVED byte-identical AND equal to the shared `guard.redactDeep` output (strict
 * Unicode-resistant SUPERSET restored — never a divergence), while the F2b closure stays GREEN.
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
import { createFridayMemoryPiiGuard } from "../../../../src/memory/guard/services/friday-memory-pii-guard.js";

const OWNER = "admin-001";
const KEY = "durable-master-derived-pseudonym-key-round9"; // pragma: allowlist secret
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

const IDEOGRAPHIC_SPACE = "　"; // U+3000 — NFKD → ASCII space (guard preserves it)
const NBSP = " "; // U+00A0 no-break space — NFKD → ASCII space
const FIGURE_SPACE = " "; // U+2007 — NFKD → ASCII space
const NARROW_NBSP = " "; // U+202F — NFKD → ASCII space

// Two 8-digit fullwidth groups that ONLY become the Luhn-valid 16-digit "4111111111111111"
// when a compatibility whitespace is (wrongly) folded to an ASCII space and the card regex's
// `[ -]` class bridges them ("41111111" + "11111111"). The guard never folds the whitespace,
// so both groups stay < 13 digits and NO card is matched — benign content preserved byte-identical.
const FW_FIRST = toFullwidth("41111111"); // 4 + 1×7 (fullwidth)
const FW_SECOND = toFullwidth("11111111"); // 1×8 (fullwidth)
function bridgedFullwidth(sep: string): string {
  return `${FW_FIRST}${sep}${FW_SECOND}`;
}

// Circled-digit run that NFKD folds to "4111111111111111" (Luhn-valid) but is category No, which
// the guard NEVER folds — decorative content, not a card.
const CIRCLED_CARD = "④" + "①".repeat(15); // ④ + ①×15 → "4" + "1"×15

// F2b closure references (must STAY redacted — the real leak-closure, NOT whitespace-dependent).
const FW_EMAIL = `${toFullwidth("victim.fw")}@example.com`;
const FW_CARD = toFullwidth("4111111111111111"); // 16 contiguous fullwidth digits, no bridge
const FW_SSN = toFullwidth("123-45-6789");

function serialize(v: unknown): string {
  return JSON.stringify(v);
}

function guardRedactDeepString(s: string): string {
  return createFridayMemoryPiiGuard("redact").redactDeep(s).value as string;
}

// ─── Unit: benign over-redaction is now PRESERVED byte-identical AND == guard.redactDeep ───

describe("round-9 F2b-ND-1 — compat-whitespace-bridged fullwidth digits are PRESERVED (no false card)", () => {
  for (const [name, sep] of [
    ["U+3000 ideographic space", IDEOGRAPHIC_SPACE],
    ["U+00A0 no-break space", NBSP],
    ["U+2007 figure space", FIGURE_SPACE],
    ["U+202F narrow no-break space", NARROW_NBSP],
  ] as const) {
    it(`${name}: content preserved byte-identical + equals guard.redactDeep (no [CREDIT_CARD])`, () => {
      const input = bridgedFullwidth(sep);
      const out = redactEventPayload({ note: input }) as { note: string };
      // Strict-superset property restored: #1618's content output == the shared guard's output.
      expect(out.note).toBe(guardRedactDeepString(input));
      // And that shared output is the benign input, byte-identical (guard folds neither the
      // fullwidth digits into a bridge nor the compatibility whitespace into an ASCII space).
      expect(out.note).toBe(input);
      expect(out.note).not.toContain("[CREDIT_CARD]");
      expect(serialize(out)).not.toContain("[CREDIT_CARD]");
    });
  }
});

describe("round-9 F2b-ND-1 — circled/No-digit run is PRESERVED (guard folds no No-digit)", () => {
  it("circled-digit run preserved byte-identical + equals guard.redactDeep (no [CREDIT_CARD])", () => {
    const out = redactEventPayload({ note: CIRCLED_CARD }) as { note: string };
    expect(out.note).toBe(guardRedactDeepString(CIRCLED_CARD));
    expect(out.note).toBe(CIRCLED_CARD);
    expect(out.note).not.toContain("[CREDIT_CARD]");
  });

  it("circled run embedded in a sentence is preserved in situ (no partial mask)", () => {
    const input = `code ${CIRCLED_CARD} here`;
    const out = redactEventPayload({ note: input }) as { note: string };
    expect(out.note).toBe(guardRedactDeepString(input));
    expect(out.note).toBe(input);
  });
});

// ─── Unit: F2b closure STAYS GREEN (the real leak-closure must not regress) ───

describe("round-9 — F2b closure stays GREEN (fullwidth/obfuscated PII still full-span redacted)", () => {
  it("fullwidth-local-part email → [EMAIL] (full span, no @example.com)", () => {
    const out = redactEventPayload({ note: `reach me at ${FW_EMAIL} now` }) as { note: string };
    expect(out.note).toBe("reach me at [EMAIL] now");
    expect(serialize(out)).not.toContain("@example.com");
    expect(serialize(out)).not.toContain(toFullwidth("victim"));
  });

  it("contiguous fullwidth-DIGIT card (no bridging whitespace) → [CREDIT_CARD]", () => {
    const out = redactEventPayload({ note: `card ${FW_CARD}` }) as { note: string };
    expect(out.note).toBe("card [CREDIT_CARD]");
    expect(serialize(out)).not.toContain("4111111111111111");
    expect(serialize(out)).not.toContain(toFullwidth("4111111111111111"));
  });

  it("fullwidth SSN → [SSN_US]", () => {
    const out = redactEventPayload({ note: `ssn ${FW_SSN}` }) as { note: string };
    expect(out.note).toBe("ssn [SSN_US]");
    expect(serialize(out)).not.toContain("6789");
  });

  it("precomposed vs decomposed accented email redact IDENTICALLY (NFC ≡ NFD)", () => {
    const outP = redactEventPayload({ note: "p naïve.user@example.com" }) as { note: string }; // ï precomposed
    const outD = redactEventPayload({ note: "p naïve.user@example.com" }) as { note: string }; // i + combining diaeresis
    expect(outP.note).toBe("p [EMAIL]");
    expect(outD.note).toBe("p [EMAIL]");
  });
});

// ─── Real Hub: BOTH sinks (raw payload_json at rest + delivered envelope) ───

describe("round-9 F2b-ND-1 — real bus + repo: benign compat content preserved in BOTH sinks", () => {
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
        "run:fold-align",
        "workflow.run.failed" as never,
        { runId: "fold-align", error: { message: note } } as never,
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

  it("whitespace-bridged fullwidth digits: preserved (no [CREDIT_CARD]) in payload_json AND envelope", () => {
    const benign = `stats ${bridgedFullwidth(IDEOGRAPHIC_SPACE)} ok`;
    const { storedPayloadJson, deliveredPayload } = publishNote(benign);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).toContain(benign);
      expect(sink).not.toContain("[CREDIT_CARD]");
      expect(sink).not.toContain("[REDACTED]");
    }
  });

  it("circled-digit run: preserved (no [CREDIT_CARD]) in payload_json AND envelope", () => {
    const benign = `decor ${CIRCLED_CARD} end`;
    const { storedPayloadJson, deliveredPayload } = publishNote(benign);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).toContain(benign);
      expect(sink).not.toContain("[CREDIT_CARD]");
    }
  });

  it("F2b stays GREEN: contiguous fullwidth card still [CREDIT_CARD] in BOTH sinks", () => {
    const { storedPayloadJson, deliveredPayload } = publishNote(`card ${FW_CARD}`);
    for (const sink of [storedPayloadJson, serialize(deliveredPayload)]) {
      expect(sink).not.toContain("4111111111111111");
      expect(sink).not.toContain(toFullwidth("4111111111111111"));
      expect(sink).toContain("[CREDIT_CARD]");
    }
  });
});
