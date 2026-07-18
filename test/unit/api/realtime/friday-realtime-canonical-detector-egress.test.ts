/**
 * SEC-REALTIME-EVENT-PII-BY-VALUE / #1618 rebase onto the CANONICAL secret + Unicode detectors
 * (#1619) — RED-FIRST proof that deleting the realtime-local duplicate detector
 * (`friday-realtime-secret-unicode-scan.ts`) and re-pointing the seam at the shared
 * `findSecretShapeSpans` / `redactSecretShapesInString` (over `redactUnicodeObfuscated`) redacts
 * on the REAL realtime egress AT LEAST what the duplicate did, and STRICTLY MORE.
 *
 * WHY THESE CASES ARE RED ON THE PRE-REBASE (duplicate-detector) BEHAVIOR:
 *   - `hf_…` (HuggingFace) / `gsk_…` (Groq) / `glpat-…` (GitLab): the deleted duplicate's
 *     `SECRET_DETECTORS` list carried ONLY PEM / Bearer / sk- / gh_ / JWT / assignment — it had NO
 *     `hf_` / `gsk_` / `glpat-` shape, so such a credential leaked VERBATIM through the realtime
 *     content seam at rest AND on the wire. The canonical `findSecretShapeSpans` classifies all
 *     three, so the rebase strictly UPGRADES coverage (no-degrade: strictly more).
 * The Bearer / assignment / obfuscated-PII cases re-confirm the seam still redacts what round-7/8/9
 * proved, now through the canonical detector — no regression from the substitution.
 *
 * Every secret fixture is assembled from STRING PARTS at runtime (never a contiguous literal), so
 * the file carries no scannable secret and needs no `.secrets.baseline` entry. The de-obfuscated
 * canary bodies are asserted ABSENT from both sinks.
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

const OWNER = "admin-canon";
const KEY = "durable-master-derived-pseudonym-key-canon"; // pragma: allowlist secret
const NOW = "2026-02-25T12:00:00.000Z";
const ZWSP = "​"; // zero-width space (Cf — stripped by the detection copy)
const COMBINING_ACUTE = "́"; // combining mark (\p{M} — stripped)

/** Map each ASCII printable code point 0x21–0x7E to its FULLWIDTH form (+0xFEE0). */
function toFullwidth(ascii: string): string {
  return [...ascii]
    .map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x21 && cp <= 0x7e ? String.fromCodePoint(cp + 0xfee0) : ch;
    })
    .join("");
}

// ─── Secrets assembled from PARTS (no contiguous literal; de-obfuscated bodies asserted absent) ───
const HF_BODY = "aB3".repeat(12) + "Zq9x"; // 40 base62 chars (>= hf_ {34} gate)
const HF_TOKEN = "hf" + "_" + HF_BODY; // HuggingFace — NOT in the deleted duplicate's list
const GSK_TOKEN = "gsk" + "_" + ("kR7".repeat(14) + "aa"); // Groq — 44 base62 (>= {40})
const GLPAT_TOKEN = "glpat" + "-" + ("xY2".repeat(8) + "abcd"); // GitLab PAT — 28 chars (>= {20})
const SK_BODY = "canary" + "Realtime" + "0".repeat(12); // 26 chars (>= sk- {16})
const SK_TOKEN = "sk" + "-" + SK_BODY;
const ASSIGN_VALUE = "canary" + "AssignVal" + "01"; // 17-char assignment credential
const AT_SEP = "@";
const EMAIL_LOCAL = "victim";
const EMAIL = EMAIL_LOCAL + AT_SEP + "example.com";

function simpleTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  return {
    dbPath: ":memory:",
    writer: db,
    reads: { size: 1, withReadConnection: (fn) => fn(db), close() {} },
    withWriteTransaction: (fn) => db.transaction(() => fn(db))(),
    withReadConnection: (fn) => fn(db),
    checkpoint() {},
    optimize() {},
    close() {
      db.close();
    },
  } as FridaySqliteLayer;
}

function publish(note: string): { storedPayloadJson: string; deliveredPayload: unknown } {
  const db = simpleTestDb();
  try {
    const p = createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
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
      "run:canon",
      "workflow.run.failed" as never,
      { runId: "canon", error: { message: note } } as never,
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

function bothSinks(note: string): string[] {
  const { storedPayloadJson, deliveredPayload } = publish(note);
  return [storedPayloadJson, JSON.stringify(deliveredPayload)];
}

// ─── Secret VALUEs the OLD duplicate MISSED — now redacted via the canonical detector (RED→GREEN) ─

describe("#1618 rebase — canonical detector redacts provider secrets the duplicate list lacked", () => {
  it("hf_ (HuggingFace) content secret → [REDACTED] in payload_json AND envelope (was RED pre-rebase)", () => {
    for (const sink of bothSinks(`leaked token ${HF_TOKEN} oops`)) {
      expect(sink).not.toContain(HF_BODY);
      expect(sink).not.toContain(HF_TOKEN);
      expect(sink).toContain("[REDACTED]");
    }
  });

  it("gsk_ (Groq) and glpat- (GitLab) content secrets → [REDACTED] (canonical-only coverage)", () => {
    for (const sink of bothSinks(`g ${GSK_TOKEN} and ${GLPAT_TOKEN}`)) {
      expect(sink).not.toContain(GSK_TOKEN);
      expect(sink).not.toContain(GLPAT_TOKEN);
      expect(sink).toContain("[REDACTED]");
    }
  });
});

// ─── Bearer + assignment + sk-, obfuscated — still redacted through the canonical detector ───

describe("#1618 rebase — Bearer / assignment / sk- secret shapes (obfuscated) still redacted", () => {
  it("zero-width-split sk- secret → [REDACTED], de-obfuscated body absent in BOTH sinks", () => {
    const obf = "sk" + "-" + "canary" + ZWSP + "Realtime" + "0".repeat(12);
    for (const sink of bothSinks(`key ${obf} end`)) {
      expect(sink).not.toContain(SK_BODY); // de-obfuscated canary must not persist
      expect(sink).toContain("[REDACTED]");
    }
  });

  it("fullwidth-encoded Bearer credential → [REDACTED], token absent, scheme structure preserved", () => {
    const fwBearer = toFullwidth("Bearer") + " " + SK_TOKEN;
    for (const sink of bothSinks(`auth ${fwBearer} tail`)) {
      expect(sink).not.toContain(SK_BODY);
      expect(sink).not.toContain(SK_TOKEN);
      expect(sink).toContain("[REDACTED]");
    }
  });

  it("combining-mark-split assignment api_key=<value> → value [REDACTED], label preserved", () => {
    const obfAssign = "api" + "_" + "key=" + "canary" + COMBINING_ACUTE + "AssignVal" + "01";
    const [stored, delivered] = bothSinks(`cfg ${obfAssign} ok`);
    for (const sink of [stored, delivered]) {
      expect(sink).not.toContain(ASSIGN_VALUE);
      expect(sink).toContain("[REDACTED]");
      // The benign assignment LABEL is preserved (credential-subspan redaction, not whole-match).
      expect(sink).toContain("api_key=");
    }
  });
});

// ─── Obfuscated PII-by-value still redacted; benign content not over-redacted (no-degrade) ───

describe("#1618 rebase — obfuscated PII still full-span redacted; benign content preserved", () => {
  it("zero-width-split email → [EMAIL], full-width SSN → [SSN_US] in BOTH sinks", () => {
    const zwEmail = EMAIL_LOCAL + ZWSP + AT_SEP + "example.com";
    const fwSsn = toFullwidth("123-45-6789");
    for (const sink of bothSinks(`mail ${zwEmail} ssn ${fwSsn}`)) {
      expect(sink).not.toContain(EMAIL); // de-obfuscated email absent
      expect(sink).not.toContain("6789");
      expect(sink).toContain("[EMAIL]");
      expect(sink).toContain("[SSN_US]");
    }
  });

  it("no-degrade: benign multilingual + accented content round-trips byte-identical (unit seam)", () => {
    const benign = { note: "café росси 你好 naïve prose — no secrets here 42 items" };
    const out = redactEventPayload(benign) as { note: string };
    expect(out.note).toBe(benign.note);
  });
});
