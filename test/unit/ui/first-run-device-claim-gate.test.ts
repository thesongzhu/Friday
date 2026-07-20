// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — first-run device-claim gate wiring ───
//
// Source-level wiring assertions (mirrors local-bootstrap-auth-gate.test.ts style):
// the router routes first-run to the DEVICE-CLAIM gate ONLY when the backend
// reports device-owner authority is enabled (deviceClaimAvailable), else keeps the
// passphrase gate; the gate is HONEST (real device-key seam, fail-closed, no
// silent passphrase fallback as authoritative, no browser-storage token seeding).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("CR-1 first-run device-claim gate wiring", () => {
  it("router routes first-run to the device-claim gate ONLY when deviceClaimAvailable, else passphrase", () => {
    const src = readFileSync("ui/src/router.tsx", "utf8");
    // Both gates are wired.
    expect(src).toContain("FirstRunDeviceClaimGate");
    expect(src).toContain("FirstRunPassphraseGate");
    // Device gate is gated on the server-derived deviceClaimAvailable flag.
    expect(src).toContain("bootstrapStatusQuery.data.deviceClaimAvailable === true");
    // The passphrase gate remains the fallback branch (not removed).
    expect(src).toContain("bootstrapStatusQuery.data?.bootstrapRequired");
  });

  it("device-claim gate uses the real device-key seam, fails closed, and never seeds tokens", () => {
    const src = readFileSync("ui/src/routes/first-run-device-claim-gate.tsx", "utf8");
    // Runs the device-owner login (challenge → claim → device-key login) via auth.
    expect(src).toContain("deviceOwnerLogin");
    // Fail-closed on missing capability — no fabricated attestation / passphrase.
    expect(src).toContain("deviceKeyAvailable");
    expect(src).not.toContain("localStorage.setItem");
    expect(src).not.toContain("postBootstrapLocalPassphrase");
    // Re-evaluates bootstrap status after success (same signal as the passphrase gate).
    expect(src).toContain('queryKey: ["auth", "bootstrap", "status"]');
  });

  it("auth client exposes the three device-claim legs", () => {
    const src = readFileSync("ui/src/lib/api/auth.ts", "utf8");
    expect(src).toContain("postBootstrapChallenge");
    expect(src).toContain("postDeviceClaim");
    expect(src).toContain("deviceKeyLogin");
  });

  it("device-key seam is a real WebCrypto provider, not a mock, and fails closed", () => {
    const src = readFileSync("ui/src/lib/auth/device-key.ts", "utf8");
    // Real crypto: WebCrypto keygen + ECDSA P-256 + low-S normalization.
    expect(src).toContain("globalThis.crypto.subtle.generateKey");
    expect(src).toContain("ECDSA");
    expect(src).toContain("normalizeLowS");
    // Fail-closed capability guard (no fabricated attestation).
    expect(src).toContain("DeviceKeyUnavailableError");
    expect(src).toContain("isAvailable");
  });
});
