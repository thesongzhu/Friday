import { describe, it, expect } from "vitest";

import {
  createFridayRealtimePseudonymizer,
  isOpaqueIdentifier,
} from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { pseudonymizeEventIdentifiers } from "../../../../src/api/realtime/friday-event-payload-redactor.js";

const OWNER = "admin-001";
const SECRET = "test-token-secret-0123456789"; // pragma: allowlist secret

function active() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, secret: SECRET });
}

describe("realtime identifier pseudonymizer", () => {
  it("is deterministic + distinct + non-reversible for identifier values", () => {
    const p = active();
    const a1 = p.value("alice@example.com");
    const a2 = p.value("alice@example.com");
    const b = p.value("bob@example.com");
    expect(a1).toBe(a2); // deterministic (restart-stable)
    expect(a1).not.toBe(b); // distinct raw → distinct pseudonym
    expect(a1).not.toContain("alice@example.com"); // non-reversible: no raw bytes
    expect(isOpaqueIdentifier(a1)).toBe(true);
  });

  it("is owner-scoped (same value under a different owner → different pseudonym)", () => {
    const p1 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "owner-1", secret: SECRET });
    const p2 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "owner-2", secret: SECRET });
    expect(p1.value("run-1")).not.toBe(p2.value("run-1"));
  });

  it("is idempotent — re-pseudonymizing an opaque value is a no-op", () => {
    const p = active();
    const once = p.value("run-1");
    expect(p.value(once)).toBe(once); // client may echo the opaque id back
  });

  it("preserves the topic prefix and pseudonymizes only the streamId id-part", () => {
    const p = active();
    const s = p.streamId("execution:alice@example.com");
    expect(s.startsWith("execution:")).toBe(true); // topic authz prefix preserved
    expect(s).not.toContain("alice@example.com");
    // SYMMETRY: streamId id-part equals the pseudonym of the raw id value.
    expect(s).toBe(`execution:${p.value("alice@example.com")}`);
    // idempotent on an already-opaque streamId (client echoing an event's streamId)
    expect(p.streamId(s)).toBe(s);
  });

  it("a raw PII value never masquerades as opaque (always pseudonymized)", () => {
    const p = active();
    expect(isOpaqueIdentifier("alice@example.com")).toBe(false);
    expect(isOpaqueIdentifier("415-555-0132")).toBe(false);
    expect(p.streamId("run:alice@example.com")).not.toContain("alice@example.com");
  });

  it("is a byte-identical no-op when inactive (no owner / no secret) — legacy/test safe", () => {
    const noOwner = createFridayRealtimePseudonymizer({ resolveOwnerId: () => null, secret: SECRET });
    const noSecret = createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, secret: undefined });
    expect(noOwner.active).toBe(false);
    expect(noSecret.active).toBe(false);
    expect(noOwner.streamId("run:run-1")).toBe("run:run-1");
    expect(noOwner.value("alice@example.com")).toBe("alice@example.com");
    expect(noSecret.streamId("run:run-1")).toBe("run:run-1");
  });

  it("pseudonymizeEventIdentifiers pseudonymizes identifier fields, leaves content, is symmetric with streamId", () => {
    const p = active();
    const payload = {
      executionId: "alice@example.com", // identifier → pseudonymized
      runId: "run-1", // identifier → pseudonymized
      count: 3, // content number → untouched
      errorMessage: "reach carol@example.com", // content → left for content-PII pass
      nested: { contactId: "bob@example.com" }, // nested identifier → pseudonymized
    };
    const out = pseudonymizeEventIdentifiers(payload, (v) => p.value(v));
    const s = JSON.stringify(out);
    expect(s).not.toContain("alice@example.com");
    expect(s).not.toContain("bob@example.com");
    expect(out.executionId).toBe(p.value("alice@example.com"));
    expect(out.runId).toBe(p.value("run-1"));
    expect(out.count).toBe(3);
    expect(out.errorMessage).toBe("reach carol@example.com"); // content untouched here
    // SYMMETRY: streamId derived from the pseudonymized executionId matches streamId().
    expect(`execution:${out.executionId}`).toBe(p.streamId("execution:alice@example.com"));
  });

  it("does not mutate the original payload", () => {
    const p = active();
    const original = { runId: "run-1" };
    pseudonymizeEventIdentifiers(original, (v) => p.value(v));
    expect(original.runId).toBe("run-1");
  });
});
