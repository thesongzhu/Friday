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
});
