import { describe, it, expect } from "vitest";

import {
  createFridayRealtimePseudonymizer,
  deriveFridayRealtimePseudonymKey,
} from "../../../../src/api/realtime/friday-realtime-pseudonym.js";
import { pseudonymizeEventIdentifiers } from "../../../../src/api/realtime/friday-event-payload-redactor.js";

const OWNER = "admin-001";
const KEY = "test-pseudonym-key-0123456789abcdef"; // pragma: allowlist secret

function active() {
  return createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: KEY });
}

describe("realtime identifier pseudonymizer", () => {
  it("is deterministic + distinct + non-reversible for identifier values", () => {
    const p = active();
    const a1 = p.value("alice@example.com");
    const a2 = p.value("alice@example.com");
    const b = p.value("bob@example.com");
    expect(a1).toBe(a2); // deterministic (restart-stable)
    expect(a1).not.toBe(b); // distinct raw -> distinct pseudonym
    expect(a1).not.toContain("alice@example.com"); // non-reversible: no raw bytes
    expect(a1.startsWith("o1_")).toBe(true); // versioned opaque marker
  });

  it("is owner-scoped (same value under a different owner -> different pseudonym)", () => {
    const p1 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "owner-1", key: KEY });
    const p2 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "owner-2", key: KEY });
    expect(p1.value("run-1")).not.toBe(p2.value("run-1"));
  });

  it("length-prefixed owner separation prevents owner||value boundary collisions", () => {
    // owner "ab" + value "c" must NOT collide with owner "a" + value "bc".
    const p1 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "ab", key: KEY });
    const p2 = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "a", key: KEY });
    expect(p1.value("c")).not.toBe(p2.value("bc"));
  });

  it("NON-FORGEABLE — a forged opaque-shaped input is re-keyed, never trusted", () => {
    const p = active();
    // An attacker supplies a marker-shaped id; it is HMAC'd like any raw value, so it
    // maps to a DIFFERENT opaque value (does not pass through / collide with a real one).
    const forged = "o1_" + "f".repeat(40);
    const rekeyed = p.value(forged);
    expect(rekeyed).not.toBe(forged); // NOT trusted / passed through
    expect(rekeyed.startsWith("o1_")).toBe(true);
    // Under a different owner the SAME forged input maps elsewhere (owner-scoped MAC).
    const other = createFridayRealtimePseudonymizer({ resolveOwnerId: () => "owner-x", key: KEY });
    expect(other.value(forged)).not.toBe(rekeyed);
    // A forged marker-shaped streamId id-part is likewise re-keyed (cannot target a stream).
    const s = p.streamId(`run:${forged}`);
    expect(s).not.toBe(`run:${forged}`);
  });

  it("preserves the topic prefix and re-keys only the streamId id-part", () => {
    const p = active();
    const s = p.streamId("execution:alice@example.com");
    expect(s.startsWith("execution:")).toBe(true); // topic authz prefix preserved
    expect(s).not.toContain("alice@example.com");
    // SYMMETRY: streamId id-part equals the pseudonym of the raw id value.
    expect(s).toBe(`execution:${p.value("alice@example.com")}`);
  });

  it("is a byte-identical no-op when inactive (no owner / no key) — legacy/test safe", () => {
    const noOwner = createFridayRealtimePseudonymizer({ resolveOwnerId: () => null, key: KEY });
    const noKey = createFridayRealtimePseudonymizer({ resolveOwnerId: () => OWNER, key: undefined });
    expect(noOwner.active).toBe(false);
    expect(noKey.active).toBe(false);
    expect(noOwner.streamId("run:run-1")).toBe("run:run-1");
    expect(noOwner.value("alice@example.com")).toBe("alice@example.com");
    expect(noKey.streamId("run:run-1")).toBe("run:run-1");
  });

  it("derives a stable key from the master key (HKDF, restart-safe)", () => {
    const master = Buffer.alloc(32, 7);
    const k1 = deriveFridayRealtimePseudonymKey(master);
    const k2 = deriveFridayRealtimePseudonymKey(master);
    expect(k1).toBe(k2); // deterministic across restart
    expect(k1).not.toBe(deriveFridayRealtimePseudonymKey(Buffer.alloc(32, 8))); // key-separated
  });

  it("pseudonymizeEventIdentifiers pseudonymizes identifier fields, leaves content, is symmetric with streamId", () => {
    const p = active();
    const payload = {
      executionId: "alice@example.com", // identifier -> pseudonymized
      runId: "run-1", // identifier -> pseudonymized
      count: 3, // content number -> untouched
      errorMessage: "reach carol@example.com", // content -> left for content-PII pass
      nested: { contactId: "bob@example.com" }, // nested identifier -> pseudonymized
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
