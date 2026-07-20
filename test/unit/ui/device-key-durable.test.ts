// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — durable browser device key (Advisor #1628 #2) ───
//
// Advisor #1628 finding #2 (second half): the browser owner key was in-memory only,
// so it did NOT survive a reload — the device-bound owner could not be recovered.
// CR-1 persists the non-extractable P-256 CryptoKey in IndexedDB. IndexedDB stores
// the key via the STRUCTURED CLONE algorithm; a structured-cloned CryptoKey keeps
// `extractable === false` (raw bytes are never materialised), so the key is durable
// WITHOUT becoming extractable.
//
// This suite runs the REAL provider. IndexedDB is a browser API (absent in Node),
// so the durable-store contract is exercised with an in-memory store that runs the
// record through the SAME `structuredClone` algorithm IndexedDB uses — a faithful
// stand-in for the persistence mechanism (the IndexedDB glue itself is thin
// browser wiring). A direct structuredClone(CryptoKey) proof pins the crux: the
// non-extractable flag survives the clone and the key still signs. TRUTH LABEL:
// every key here is a SOFTWARE WebCrypto key; nothing claims hardware backing.

import { describe, it, expect } from "vitest";

import {
  createWebCryptoDeviceKeyProvider,
  type DeviceClaimTranscript,
  type DeviceKeyStore,
  type DurableDeviceKeyRecord,
} from "../../../ui/src/lib/auth/device-key.js";
import { createFridayOwnerClaimPoPVerifier } from "../../../src/api/auth/device-attest/index.js";
import type { OwnerClaimTranscript } from "../../../src/api/auth/device-attest/index.js";

const NOW = "2026-07-13T00:00:00.000Z";

function sampleTranscript(hash: string): DeviceClaimTranscript {
  return {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: "test-hub",
    installId: "install-1",
    osUser: "ui",
    deviceId: "device-durable",
    action: "owner-login",
    origin: "https://friday.localhost",
    channel: "ui-loopback",
    nonce: "server-issued-nonce",
    expiresAt: "2026-07-13T00:02:00.000Z",
    devicePublicKeyHash: hash,
  };
}

/**
 * In-memory DeviceKeyStore that persists the record through `structuredClone` — the
 * SAME algorithm IndexedDB applies on put/get. This faithfully reproduces IndexedDB
 * persistence of a non-extractable CryptoKey (double-clone: once on save, once on
 * load, exactly as a real write-then-read round-trip does).
 */
function createStructuredCloneStore(): DeviceKeyStore & {
  peek(): DurableDeviceKeyRecord | null;
  saveCalls(): number;
} {
  let slot: DurableDeviceKeyRecord | null = null;
  let saves = 0;
  return {
    async load() {
      return slot ? structuredClone(slot) : null;
    },
    async save(record) {
      saves += 1;
      slot = structuredClone(record); // IndexedDB clones on write
    },
    peek() {
      return slot ? structuredClone(slot) : null;
    },
    saveCalls() {
      return saves;
    },
  };
}

describe("CR-1 durable browser device key (IndexedDB structured-clone persistence)", () => {
  it("PROOF (crux): structuredClone of a non-extractable CryptoKey preserves extractable=false and can still sign", async () => {
    const { subtle } = globalThis.crypto;
    const keyPair = (await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(keyPair.privateKey.extractable).toBe(false);

    // The exact operation IndexedDB performs when persisting the key object.
    const cloned = structuredClone({ publicKey: keyPair.publicKey, privateKey: keyPair.privateKey });
    expect(cloned.privateKey.extractable).toBe(false);

    const bytes = new TextEncoder().encode("possession proof");
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cloned.privateKey, bytes);
    const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cloned.publicKey, sig, bytes);
    expect(ok).toBe(true);

    // And the cloned private key still cannot be exported (raw bytes never exposed).
    await expect(subtle.exportKey("pkcs8", cloned.privateKey)).rejects.toBeInstanceOf(Error);
  });

  it("survives a reload: a fresh provider over the SAME store recovers the SAME key (hash + deviceId) and still signs", async () => {
    const store = createStructuredCloneStore();

    // Session 1: generate + persist.
    const provider1 = createWebCryptoDeviceKeyProvider(store);
    const first = await provider1.getOrCreateDeviceKey();
    expect(store.saveCalls()).toBe(1);
    expect(first.devicePublicKeyHash).toMatch(/^[0-9a-f]{64}$/);

    // Session 2 (simulated reload): a BRAND-NEW provider instance reads the persisted
    // key back — same public key hash AND same stable deviceId, no new key minted.
    const provider2 = createWebCryptoDeviceKeyProvider(store);
    const recovered = await provider2.getOrCreateDeviceKey();
    expect(recovered.devicePublicKeyHash).toBe(first.devicePublicKeyHash);
    expect(recovered.deviceId).toBe(first.deviceId);
    expect(recovered.devicePublicKeySpkiBase64).toBe(first.devicePublicKeySpkiBase64);
    expect(store.saveCalls()).toBe(1); // recovery did NOT persist a new key

    // The recovered key produces a real PoP that the REAL server verifier accepts.
    const transcript = sampleTranscript(recovered.devicePublicKeyHash);
    const signature = await provider2.signTranscript(transcript);
    const verifier = createFridayOwnerClaimPoPVerifier();
    const result = verifier.verifyPossession({
      transcript: transcript as unknown as OwnerClaimTranscript,
      devicePublicKey: { encoding: "spki-der-base64", value: recovered.devicePublicKeySpkiBase64 },
      signature,
      nowMs: Date.parse(NOW),
    });
    expect(result.ok).toBe(true);
  });

  it("the persisted (reloaded) private key stays NON-EXTRACTABLE", async () => {
    const store = createStructuredCloneStore();
    const provider = createWebCryptoDeviceKeyProvider(store);
    await provider.getOrCreateDeviceKey();

    const record = store.peek();
    expect(record).not.toBeNull();
    expect(record!.keyPair.privateKey.extractable).toBe(false);
    // Raw private-key bytes can never be exported from the persisted key.
    await expect(
      globalThis.crypto.subtle.exportKey("pkcs8", record!.keyPair.privateKey),
    ).rejects.toBeInstanceOf(Error);
  });

  it("in-memory ONLY (no store): a fresh provider mints a DIFFERENT key — recovery is impossible without persistence", async () => {
    const a = await createWebCryptoDeviceKeyProvider().getOrCreateDeviceKey();
    const b = await createWebCryptoDeviceKeyProvider().getOrCreateDeviceKey();
    expect(b.devicePublicKeyHash).not.toBe(a.devicePublicKeyHash);
    expect(b.deviceId).not.toBe(a.deviceId);
  });

  it("fails closed when the store SAVE fails (does not silently continue with a non-durable key)", async () => {
    const failingStore: DeviceKeyStore = {
      async load() {
        return null;
      },
      async save() {
        throw new Error("indexedDB quota exceeded");
      },
    };
    const provider = createWebCryptoDeviceKeyProvider(failingStore);
    await expect(provider.getOrCreateDeviceKey()).rejects.toThrow(/quota exceeded/);
  });
});
