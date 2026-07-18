import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendFridayAuditLog, resolveFridayAuditLogPath } from "#hub";
import type { FridayAuditLogWrite } from "#hub";
import { createFridayMemoryPiiGuard } from "../../../src/memory/guard/services/friday-memory-pii-guard.js";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayMemoryItem } from "../../../src/memory/model/friday-memory.types.js";

// ─── SEC-EVENT-REDACTION-001 round-15: CROSS-SINK PARITY. The 0600 owner-scoped audit sink
//     (`appendFridayAuditLog` → `details_json`) whole-value-nukes a credential under a sensitive KEY
//     NAME via `isSensitiveSecretFieldName`. Before round-15 the PUBLIC memory egress (`redactDeep` /
//     `filterItem` / `redactLearnedFactValue`) did NOT — it ran only the shape+PII value scrubber, so
//     a SHAPELESS credential under a sensitive key escaped the public surfaces VERBATIM while the audit
//     sink redacted the SAME input (the round-14 verification gap: public egress LESS protected than
//     the private audit sink). Round-15 wires the SAME predicate into the memory object branch so the
//     two sinks CONVERGE. These tests drive BOTH real sinks on the SAME input and assert equality.
//     RED on 14e4c4f4 (memory returns credentials verbatim ≠ audit's markers), GREEN after. ───

const M = "[REDACTED_SECRET]";

// Opaque, SHAPELESS credentials — catchable ONLY by their sensitive KEY NAME (no distinctive substring).
const PLAIN_PW = "hunter2plainword"; // pragma: allowlist secret
const OPAQUE_TOKEN = "opaquevaluewithnoshape"; // pragma: allowlist secret
const OPAQUE_SECRET = "justplainopaquesecret"; // pragma: allowlist secret
const OPAQUE_CLIENT_SECRET = "opaqueclientsecretval"; // pragma: allowlist secret
const OPAQUE_AUTHZ = "opaqueauthorizationvv"; // pragma: allowlist secret
// Built at runtime so no literal `sk_live_…` appears in source (GitHub push protection).
const SK_LIVE = ["sk_live", "0123456789abcdefghijABCDwxyz"].join("_"); // pragma: allowlist secret

// The SAME payload fed to every sink. Sensitive-secret KEY NAMES chosen so `redactKey` (memory redacts
// KEYS; audit does not) leaves them byte-identical — none carries a secret SHAPE or PII — so the ONLY
// difference the two sinks could exhibit is the VALUE disposition (the property under test). Benign
// siblings are pure-ASCII with no PII/secret shape, so both sinks return them verbatim (E1 avoided).
function sharedPayload(): Record<string, unknown> {
  return {
    password: PLAIN_PW,
    apiKey: SK_LIVE,
    token: OPAQUE_TOKEN,
    secret: OPAQUE_SECRET,
    clientSecret: OPAQUE_CLIENT_SECRET,
    authorization: OPAQUE_AUTHZ,
    note: "just a note",
    color: "blue",
  };
}

const EXPECTED: Record<string, unknown> = {
  password: M,
  apiKey: M,
  token: M,
  secret: M,
  clientSecret: M,
  authorization: M,
  note: "just a note",
  color: "blue",
};

describe("SEC-EVENT-REDACTION-001 — cross-sink parity (memory egress == audit sink, round-15)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-xsink-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function auditRedactedDetails(details: Record<string, unknown>): Promise<Record<string, unknown>> {
    const logPath = resolveFridayAuditLogPath(tmpDir);
    const entry: FridayAuditLogWrite = {
      id: "xsink-1",
      ts: "2026-07-17T00:00:00.000Z",
      actorType: "service",
      actorId: "svc-1",
      action: "test.parity",
      resourceType: "test",
      resourceId: "r-1",
      details,
    };
    await appendFridayAuditLog(logPath, entry);
    const line = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .find((l) => (JSON.parse(l) as { id?: string }).id === "xsink-1")!;
    return (JSON.parse(line) as { details: Record<string, unknown> }).details;
  }

  it("the SAME sensitive-key credential input → the SAME redaction in the AUDIT sink and MEMORY redactDeep", async () => {
    const auditDetails = await auditRedactedDetails(sharedPayload());
    const memoryGuard = createFridayMemoryPiiGuard("redact");
    const memoryValue = memoryGuard.redactDeep(sharedPayload()).value as Record<string, unknown>;

    // Both sinks nuke every sensitive-key credential to the marker and preserve benign siblings.
    expect(auditDetails).toEqual(EXPECTED);
    expect(memoryValue).toEqual(EXPECTED);
    // Cross-sink equality is the round-15 contract: memory egress == audit sink for sensitive-key creds.
    expect(memoryValue).toEqual(auditDetails);
  });

  it("MEMORY output filter (filterItem.metadata + redactLearnedFactValue) matches the audit sink too", async () => {
    const auditDetails = await auditRedactedDetails(sharedPayload());
    const filter = createFridayMemoryOutputFilter();

    // filterItem redacts item.metadata via the SAME redactDeep.
    const item: FridayMemoryItem = {
      id: "m-1",
      namespace: "default",
      key: "k-1",
      content: "content",
      source: "test",
      tags: [],
      metadata: sharedPayload(),
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const filteredMeta = filter.filterItem(item).metadata as Record<string, unknown>;
    expect(filteredMeta).toEqual(EXPECTED);
    expect(filteredMeta).toEqual(auditDetails);

    // redactLearnedFactValue (the public uix / asset-inventory carrier) agrees.
    const learned = filter.redactLearnedFactValue(sharedPayload()) as Record<string, unknown>;
    expect(learned).toEqual(EXPECTED);
    expect(learned).toEqual(auditDetails);

    // No credential byte survives in ANY sink's serialization.
    for (const sink of [auditDetails, filteredMeta, learned]) {
      const json = JSON.stringify(sink);
      for (const cred of [PLAIN_PW, OPAQUE_TOKEN, OPAQUE_SECRET, OPAQUE_CLIENT_SECRET, OPAQUE_AUTHZ, SK_LIVE]) {
        expect(json).not.toContain(cred);
      }
    }
  });

  // ─── round-16: the ADDED provider SHAPES under a NON-sensitive key redact identically in the audit
  //     sink and memory egress, RAW and Unicode-obfuscated — the SAME canonical detector backs both, so
  //     parity holds automatically. RED before the shapes are added (both leak, but this asserts the
  //     redaction convergence for the ADDED shapes specifically). ───
  const seg = (...p: string[]): string => p.join(""); // pragma: allowlist secret
  const SGPOOL = "ABCdefGHIjkl0123456789abcdefghijkLMNopqrstuvwxyz0123456789"; // pragma: allowlist secret
  const ADDED_SHAPE_PAYLOAD = (): Record<string, unknown> => ({
    // non-sensitive KEY NAMES (so the key-name nuke does NOT fire — the SHAPE detector must catch these)
    tokenpreview: seg("ya29.", "a0AfB_by-DtestTokenValue0123456789ABCDEFxyz"), // pragma: allowlist secret
    slackapp: seg("xapp-", "1-A0123ABCD-4567890123-abcdef0123456789abcdef"), // pragma: allowlist secret
    gitlabref: seg("glpat-", "ABCdef0123456789ghijkLMNop"), // pragma: allowlist secret
    mailer: seg("SG.", SGPOOL.slice(0, 22), ".", SGPOOL.slice(0, 43)), // pragma: allowlist secret
    doref: seg("dop_v1_", "0123456789abcdef".repeat(4)), // pragma: allowlist secret
    groqref: seg("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"), // pragma: allowlist secret
    // Unicode-obfuscated (full-width xai-) under a non-sensitive key — SEC-uni leg must catch it in both.
    grokref: seg("ｘａｉ－", "abcdefghijklmnop0123456789"), // pragma: allowlist secret
    note: "just a note",
  });

  it("round-16 ADDED shapes (raw + Unicode) redact identically in the AUDIT sink and MEMORY redactDeep", async () => {
    const auditDetails = await auditRedactedDetails(ADDED_SHAPE_PAYLOAD());
    const memoryGuard = createFridayMemoryPiiGuard("redact");
    const memoryValue = memoryGuard.redactDeep(ADDED_SHAPE_PAYLOAD()).value as Record<string, unknown>;
    // Cross-sink equality — memory egress == audit sink for the ADDED shapes.
    expect(memoryValue).toEqual(auditDetails);
    // Every shape key is the marker; the benign note survives; no shape byte leaks.
    const expected = ADDED_SHAPE_PAYLOAD();
    for (const key of Object.keys(expected)) {
      if (key === "note") {
        expect(memoryValue[key]).toBe("just a note");
      } else {
        expect(memoryValue[key], key).toBe(M);
      }
    }
    for (const sink of [auditDetails, memoryValue]) {
      const json = JSON.stringify(sink);
      for (const [key, v] of Object.entries(expected)) {
        if (key !== "note") expect(json, key).not.toContain(v as string);
      }
    }
  });

  // ─── round-17: the HuggingFace `hf_` shape under a NON-sensitive key redacts identically in the audit
  //     sink and memory egress, RAW and Unicode-obfuscated (ZWSP mid-body) — the SAME canonical detector
  //     backs both, so parity holds automatically. RED on d2e0e222 (both sinks leak `hf_` verbatim); GREEN
  //     after the `hf_` pattern is added. This is the memory==audit parity proof for the new shape. ───
  const HF_BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz01234567"; // pragma: allowlist secret — 34 base62 chars
  const HF_RAW = seg("hf_", HF_BODY); // pragma: allowlist secret
  const HF_ZWSP = seg("hf_", HF_BODY.slice(0, 17), "​", HF_BODY.slice(17)); // pragma: allowlist secret — ZWSP mid-body → hf_+34 after de-obfuscation
  const HF_PAYLOAD = (): Record<string, unknown> => ({
    // non-sensitive KEY NAMES so the key-name nuke does NOT fire — the SHAPE detector (raw ∪ Unicode) must.
    hftoken: HF_RAW,
    hfobf: HF_ZWSP,
    note: "just a note",
  });

  it("round-17 hf_ (raw + ZWSP mid-body) redacts identically in the AUDIT sink and MEMORY redactDeep", async () => {
    const auditDetails = await auditRedactedDetails(HF_PAYLOAD());
    const memoryGuard = createFridayMemoryPiiGuard("redact");
    const memoryValue = memoryGuard.redactDeep(HF_PAYLOAD()).value as Record<string, unknown>;
    // memory egress == audit sink for the new shape (raw AND Unicode-obfuscated).
    expect(memoryValue).toEqual(auditDetails);
    expect(memoryValue.hftoken).toBe(M);
    expect(memoryValue.hfobf).toBe(M);
    expect(memoryValue.note).toBe("just a note");
    // No hf_ credential byte survives in either sink's serialization (raw body or its de-obfuscated form).
    for (const sink of [auditDetails, memoryValue]) {
      const json = JSON.stringify(sink);
      expect(json).not.toContain(HF_BODY);
      expect(json).not.toContain(HF_RAW);
    }
  });

  // ─── SEC-SECRET-GLUED-PREFIX-001: a distinctive-prefix credential GLUED directly to a preceding word
  //     char (`keyhf_<34>`) under a NON-sensitive key had no word boundary before the prefix, so the
  //     canonical detector's leading `\b` skipped it and it egressed VERBATIM through BOTH the audit sink
  //     and memory read-back. The fix drops the leading `\b` on the high-entropy distinctive-prefix
  //     patterns, so the SAME canonical detector catches the glued credential in both sinks (parity holds
  //     automatically). Only the credential subspan is masked — the glued benign leading char survives.
  //     RED on bf6968f9 (both sinks return the glued token verbatim); GREEN after. ───
  const GSK_GLUED = seg("x", "gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDwx"); // pragma: allowlist secret
  const GLPAT_GLUED = seg("id", "glpat-", "ABCdef0123456789ghijkLMNop"); // pragma: allowlist secret
  const HF_GLUED = seg("key", "hf_", HF_BODY); // pragma: allowlist secret
  const GLUED_PAYLOAD = (): Record<string, unknown> => ({
    // non-sensitive KEY NAMES so the key-name nuke does NOT fire — the glued SHAPE must be caught.
    hfref: HF_GLUED,
    gskref: GSK_GLUED,
    glref: GLPAT_GLUED,
    note: "just a note",
  });

  it("glued distinctive-prefix credentials redact identically in the AUDIT sink and MEMORY redactDeep", async () => {
    const auditDetails = await auditRedactedDetails(GLUED_PAYLOAD());
    const memoryGuard = createFridayMemoryPiiGuard("redact");
    const memoryValue = memoryGuard.redactDeep(GLUED_PAYLOAD()).value as Record<string, unknown>;
    // Cross-sink equality — memory egress == audit sink for the glued credentials.
    expect(memoryValue).toEqual(auditDetails);
    // The credential subspan is masked, the benign glued leading char (`key`/`x`/`id`) survives.
    expect(memoryValue.hfref).toBe(`key${M}`);
    expect(memoryValue.gskref).toBe(`x${M}`);
    expect(memoryValue.glref).toBe(`id${M}`);
    expect(memoryValue.note).toBe("just a note");
    // No credential body survives in either sink's serialization.
    for (const sink of [auditDetails, memoryValue]) {
      const json = JSON.stringify(sink);
      for (const cred of [HF_GLUED.slice(3), GSK_GLUED.slice(1), GLPAT_GLUED.slice(2)]) {
        expect(json, cred).not.toContain(cred);
      }
    }
  });
});
