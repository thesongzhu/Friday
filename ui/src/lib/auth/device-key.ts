// ─── SEC-SETUP-BOOTSTRAP-001 · CR-1 — device keypair seam (UI) ───
//
// A REAL device-key provider abstraction for the device-bound owner flow. It is
// NOT a mock and it NEVER fabricates attestation:
//   - `WebCryptoDeviceKeyProvider` generates a genuine non-extractable P-256
//     keypair via WebCrypto and produces genuine ECDSA proofs-of-possession over
//     the SAME canonical transcript bytes the server verifier reconstructs, so a
//     signature here is a real possession proof there.
//   - Key PROTECTION / OS attestation is derived SERVER-SIDE and stays
//     "unverified" until a native attestation bridge lands; this seam asserts
//     nothing about hardware backing. Minting a device-owner session additionally
//     requires the server's native-IPC precondition, so a software key here can
//     never masquerade as a hardware-attested one.
//   - When WebCrypto is unavailable (e.g. an insecure context), the provider is
//     `isAvailable() === false` and every operation FAILS CLOSED — the caller must
//     NOT silently fall back to a fabricated key.
//   - DURABLE ACROSS RELOAD (CR-1 · Advisor #1628 finding #2): the non-extractable
//     private key is persisted in IndexedDB as a structured-cloneable CryptoKey.
//     IndexedDB stores the live key OBJECT (never raw key bytes — a non-extractable
//     key cannot be exported), and structured clone PRESERVES `extractable=false`,
//     so the key survives a page reload WITHOUT ever becoming extractable. This is
//     what makes the device-owner claim + login recoverable across restart rather
//     than minting a fresh (unbound) key on every load.
//
// NATIVE/OPERATOR LEAF (flagged, not faked): hardware-backed (Secure Enclave /
// TPM) key generation and OS attestation remain the native bridge's responsibility
// — this WebCrypto provider is the software-dev seam that proves the wiring and its
// key protection stays server-derived "unverified". Durable browser-key storage
// (IndexedDB) is implemented here; hardware backing is NOT claimed.

/** Canonical owner-claim/login transcript (mirrors the server S2a shape). */
export interface DeviceClaimTranscript {
  transcriptVersion: "friday-owner-claim-v1";
  algorithm: "ECDSA_P256_SHA256";
  kind: "install_owner_claim";
  hubId: string;
  installId: string;
  osUser: string;
  deviceId: string;
  action: string;
  origin: string;
  channel: string;
  nonce: string;
  expiresAt: string;
  /** SHA-256 hex of the canonical SPKI DER of the device public key. */
  devicePublicKeyHash: string;
}

export interface DeviceClaimProof {
  transcript: DeviceClaimTranscript;
  /** IEEE P-1363 raw (r‖s, 64 bytes) ECDSA signature, base64 (canonical low-S). */
  signature: { encoding: "ieee-p1363-base64"; value: string };
}

export interface DeviceKeyMaterial {
  /** Device public key, SPKI DER, standard base64. */
  devicePublicKeySpkiBase64: string;
  /** SHA-256 hex of the canonical SPKI DER (the transcript-bound key hash). */
  devicePublicKeyHash: string;
  /** Stable-per-session device identifier. */
  deviceId: string;
}

/**
 * The device-key seam. A native bridge implementation (Secure Enclave / TPM) would
 * satisfy this SAME interface; the WebCrypto implementation below is the software
 * fallback. All operations reject when `isAvailable()` is false (fail-closed).
 */
export interface DeviceKeyProvider {
  isAvailable(): boolean;
  /** Generate (or return the session-cached) device key material. */
  getOrCreateDeviceKey(): Promise<DeviceKeyMaterial>;
  /**
   * Sign a canonical transcript, returning a canonical low-S IEEE P-1363 raw
   * signature as base64. Rejects if no key has been created yet.
   */
  signTranscript(transcript: DeviceClaimTranscript): Promise<DeviceClaimProof["signature"]>;
}

/** Thrown when the device-key capability is unavailable — the caller fails closed. */
export class DeviceKeyUnavailableError extends Error {
  constructor(message = "Device key capability is unavailable in this context.") {
    super(message);
    this.name = "DeviceKeyUnavailableError";
  }
}

// ─── Canonical transcript encoding (byte-identical to the server encoder) ───

const TRANSCRIPT_DOMAIN = "friday.owner-claim.transcript";

// NIST P-256 order (n) and n/2 for low-S malleability normalization.
const P256_ORDER_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
);
const P256_HALF_ORDER = P256_ORDER_N >> 1n;

function lengthPrefixed(value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false); // u32 big-endian
  out.set(body, 4);
  return out;
}

/**
 * Deterministically encode a transcript to `LP(domain) ‖ LP(field_0) ‖ …` where
 * LP(x) = u32be(len) ‖ utf8(x). Field order + domain MUST match the server's
 * `encodeOwnerClaimTranscript` exactly (asserted by a cross-encoder test).
 */
export function encodeOwnerClaimTranscript(t: DeviceClaimTranscript): Uint8Array {
  const parts = [
    lengthPrefixed(TRANSCRIPT_DOMAIN),
    lengthPrefixed(t.transcriptVersion),
    lengthPrefixed(t.algorithm),
    lengthPrefixed(t.kind),
    lengthPrefixed(t.hubId),
    lengthPrefixed(t.installId),
    lengthPrefixed(t.osUser),
    lengthPrefixed(t.deviceId),
    lengthPrefixed(t.action),
    lengthPrefixed(t.origin),
    lengthPrefixed(t.channel),
    lengthPrefixed(t.nonce),
    lengthPrefixed(t.expiresAt),
    lengthPrefixed(t.devicePublicKeyHash),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─── byte / bigint helpers ───

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt("0x" + toHex(bytes));
}

function bigIntTo32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Normalize a raw P-1363 signature to canonical low-S (s ≤ n/2). WebCrypto does
 * not guarantee low-S, and the server verifier REJECTS the high-S twin, so this
 * normalization is required for interop.
 */
export function normalizeLowS(raw: Uint8Array): Uint8Array {
  const r = raw.slice(0, 32);
  let s = bytesToBigInt(raw.slice(32, 64));
  if (s > P256_HALF_ORDER) s = P256_ORDER_N - s;
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(bigIntTo32(s), 32);
  return out;
}

// ─── Durable key store (IndexedDB) ───

/**
 * The durable device-key record persisted across page reloads. `keyPair` is the
 * LIVE non-extractable CryptoKeyPair — IndexedDB persists it via the structured
 * clone algorithm, which keeps `privateKey.extractable === false` (raw key bytes
 * are never materialised). `deviceId` is persisted alongside so the stable device
 * identity the claim bound to survives a reload too.
 */
export interface DurableDeviceKeyRecord {
  keyPair: CryptoKeyPair;
  deviceId: string;
}

/**
 * Persistence seam for the device key. The default browser implementation is
 * IndexedDB (`createIndexedDbDeviceKeyStore`); tests inject an in-memory store that
 * runs the record through the SAME structured-clone algorithm IndexedDB uses.
 */
export interface DeviceKeyStore {
  /** Return the persisted record, or null if none / unreadable. */
  load(): Promise<DurableDeviceKeyRecord | null>;
  /** Persist (overwrite) the record. Rejects if the write fails (fail closed). */
  save(record: DurableDeviceKeyRecord): Promise<void>;
}

const DEVICE_KEY_DB_NAME = "friday-device-key";
const DEVICE_KEY_STORE_NAME = "device-owner-keys";
const DEVICE_KEY_RECORD_ID = "primary";

/** True when the IndexedDB API is present (browser secure context). */
export function indexedDbDeviceKeyStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * IndexedDB-backed device-key store. Stores the CryptoKeyPair OBJECT (not raw
 * bytes) under a single fixed key. Because the private key is non-extractable and
 * structured clone preserves that flag, the reloaded key can sign but can never be
 * exported. All operations reject on IndexedDB error (the provider fails closed on
 * a save failure rather than silently continuing with a non-durable key).
 */
export function createIndexedDbDeviceKeyStore(): DeviceKeyStore {
  function openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DEVICE_KEY_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DEVICE_KEY_STORE_NAME)) {
          database.createObjectStore(DEVICE_KEY_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    });
  }

  return {
    async load(): Promise<DurableDeviceKeyRecord | null> {
      const database = await openDb();
      try {
        return await new Promise<DurableDeviceKeyRecord | null>((resolve, reject) => {
          const tx = database.transaction(DEVICE_KEY_STORE_NAME, "readonly");
          const req = tx.objectStore(DEVICE_KEY_STORE_NAME).get(DEVICE_KEY_RECORD_ID);
          req.onsuccess = () => {
            const value = req.result as DurableDeviceKeyRecord | undefined;
            resolve(value && value.keyPair ? value : null);
          };
          req.onerror = () => reject(req.error ?? new Error("indexedDB get failed"));
        });
      } finally {
        database.close();
      }
    },

    async save(record: DurableDeviceKeyRecord): Promise<void> {
      const database = await openDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(DEVICE_KEY_STORE_NAME, "readwrite");
          tx.objectStore(DEVICE_KEY_STORE_NAME).put(record, DEVICE_KEY_RECORD_ID);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("indexedDB put failed"));
          tx.onabort = () => reject(tx.error ?? new Error("indexedDB put aborted"));
        });
      } finally {
        database.close();
      }
    },
  };
}

// ─── WebCrypto software provider ───

function subtleAvailable(): boolean {
  return (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle !== "undefined" &&
    typeof globalThis.crypto.subtle.generateKey === "function"
  );
}

/** Derive the public key material (SPKI base64 + hash) for a keypair + deviceId. */
async function deriveDeviceKeyMaterial(
  publicKey: CryptoKey,
  deviceId: string,
): Promise<DeviceKeyMaterial> {
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", publicKey));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", spki));
  return {
    devicePublicKeySpkiBase64: toBase64(spki),
    devicePublicKeyHash: toHex(digest),
    deviceId,
  };
}

function randomDeviceId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `wc-${c.randomUUID()}`;
  // Fallback random id (still non-fabricated — just a session identifier).
  const rnd = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(rnd);
  return `wc-${toHex(rnd)}`;
}

/**
 * Create a WebCrypto-backed device-key provider. The private key is
 * non-extractable and cached in memory for the session. When a `store` is supplied
 * (the browser default is IndexedDB), the key is DURABLE across page reloads: on
 * first use it is generated + persisted; on a later load it is read back from the
 * store (still non-extractable). WITHOUT a store the key is in-memory only (the old
 * behaviour) — used by cross-encoder / signature unit tests. Hardware backing is
 * the native/operator leaf (see file header); this seam never claims it.
 */
export function createWebCryptoDeviceKeyProvider(store?: DeviceKeyStore): DeviceKeyProvider {
  let cached: { keyPair: CryptoKeyPair; material: DeviceKeyMaterial } | null = null;

  return {
    isAvailable: subtleAvailable,

    async getOrCreateDeviceKey(): Promise<DeviceKeyMaterial> {
      if (!subtleAvailable()) throw new DeviceKeyUnavailableError();
      if (cached) return cached.material;

      // Durable recovery: reload a previously-persisted non-extractable keypair so
      // the owner binding survives a reload. A corrupt/unreadable record is treated
      // as "none" (regenerate); a genuine key just rehydrates and signs.
      if (store) {
        let record: DurableDeviceKeyRecord | null = null;
        try {
          record = await store.load();
        } catch {
          record = null;
        }
        if (record) {
          const material = await deriveDeviceKeyMaterial(record.keyPair.publicKey, record.deviceId);
          cached = { keyPair: record.keyPair, material };
          return material;
        }
      }

      const keyPair = (await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false, // private key non-extractable; public key stays exportable
        ["sign", "verify"],
      )) as CryptoKeyPair;

      const deviceId = randomDeviceId();
      const material = await deriveDeviceKeyMaterial(keyPair.publicKey, deviceId);
      // Persist BEFORE returning so the key is durable from first use. A save failure
      // fails closed (rejects) rather than silently continuing with a non-durable key.
      if (store) {
        await store.save({ keyPair, deviceId });
      }
      cached = { keyPair, material };
      return material;
    },

    async signTranscript(
      transcript: DeviceClaimTranscript,
    ): Promise<DeviceClaimProof["signature"]> {
      if (!subtleAvailable()) throw new DeviceKeyUnavailableError();
      if (!cached) {
        throw new DeviceKeyUnavailableError("Device key has not been created yet.");
      }
      const bytes = encodeOwnerClaimTranscript(transcript);
      const raw = new Uint8Array(
        await globalThis.crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          cached.keyPair.privateKey,
          // Copy into a fresh ArrayBuffer-backed view for BufferSource typing.
          bytes.slice(),
        ),
      );
      return { encoding: "ieee-p1363-base64", value: toBase64(normalizeLowS(raw)) };
    },
  };
}

// Default provider singleton (native bridge would replace this at wire time).
let defaultProvider: DeviceKeyProvider | null = null;

/**
 * The process/tab default device-key provider (WebCrypto software seam). When
 * IndexedDB is available (browser secure context) the provider is DURABLE — its
 * non-extractable key survives reload; otherwise it is in-memory only.
 */
export function getDeviceKeyProvider(): DeviceKeyProvider {
  if (!defaultProvider) {
    defaultProvider = createWebCryptoDeviceKeyProvider(
      indexedDbDeviceKeyStorageAvailable() ? createIndexedDbDeviceKeyStore() : undefined,
    );
  }
  return defaultProvider;
}
