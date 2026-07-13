import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { FridayDomainError } from "#errors";

// ─── Encrypted envelope ───

/**
 * On-disk AES-256-GCM envelope.
 *
 * Version semantics ({@link FridayEncryptedEnvelope.v}):
 *  - `undefined` (field absent) → **v1 legacy**: ciphertext produced WITHOUT
 *    additional-authenticated-data (AAD) context binding. Decryptable for
 *    backward compatibility ONLY; every v1 caller is unbound so a ciphertext is
 *    transplantable across owner/scope/field rows. New writes are never v1.
 *  - `2` → **v2 AAD-bound**: the GCM tag also authenticates a canonical binding
 *    context ({@link FridaySecretAadContext}). Decryption requires the SAME
 *    context or the GCM authentication fails closed (throws). This makes a
 *    ciphertext transplanted across owner/provider/field rows undecryptable.
 *
 * Stripping `v` from a v2 envelope does NOT downgrade it: a v2 tag was computed
 * over the AAD, so verifying it as v1 (no AAD) fails the GCM check. Likewise
 * forging `v: 2` onto a v1 envelope fails the check. Both directions fail closed.
 */
export interface FridayEncryptedEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  /** Envelope schema version. Absent = v1 legacy (no AAD); 2 = AAD-bound. */
  v?: number;
}

/**
 * Canonical binding context authenticated as GCM AAD for v2 envelopes.
 *
 * Every field must be derivable from the STABLE identity of the row/entry the
 * ciphertext belongs to (a primary key, a natural key, or a durable ref) so
 * that the writer and every reader reconstruct byte-identical AAD. Binding a
 * mutable column would brick the secret on rename; callers therefore bind
 * durable identifiers.
 */
export interface FridaySecretAadContext {
  /** Logical store namespace, e.g. `"friday-secrets"`, `"friday-oauth"`. Required, non-empty. */
  readonly store: string;
  /** Owner principal (e.g. owner user id) when the row is owner-scoped. */
  readonly owner?: string;
  /** Tenant / provider-profile discriminator when applicable. */
  readonly tenant?: string;
  /** Logical scope of the row (e.g. secret scope, provider-profile id). */
  readonly scope?: string;
  /** Durable per-row reference (primary key / natural key / vault ref). */
  readonly ref?: string;
  /** Sub-field discriminator when one row holds multiple secrets (e.g. access/refresh). */
  readonly field?: string;
}

/** Result of {@link decryptSecretWithMigration}. */
export interface FridaySecretMigrationResult {
  /** Recovered plaintext. */
  readonly plaintext: string;
  /**
   * A freshly AAD-bound (v2) envelope when the input was a legacy v1 envelope
   * and a binding context was supplied, else `null`. Callers persist this to
   * lazily migrate the row at rest (read-repair) so no v1 envelope survives.
   */
  readonly rewrapped: FridayEncryptedEnvelope | null;
}

// ─── Core encrypt / decrypt ───

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Envelope schema version for AAD-bound ciphertext. */
export const FRIDAY_SECRET_ENVELOPE_V2 = 2;
/**
 * Schema version of the canonical AAD encoding. Bumping this deliberately
 * invalidates every previously-written v2 tag (forces a re-wrap), so it is only
 * changed when the binding-context semantics change.
 */
export const FRIDAY_SECRET_AAD_SCHEMA_VERSION = 1;

function assertMasterKeyLength(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Master key must be ${KEY_BYTES} bytes, got ${String(masterKey.length)}`,
      { httpStatus: 400 },
    );
  }
}

/**
 * Deterministically encodes a binding context into AAD bytes.
 *
 * Uses a fixed field order and JSON encoding of `[key, value|null]` tuples so
 * the output is stable regardless of object key-insertion order and unambiguous
 * regardless of value contents (JSON escaping prevents separator injection).
 * A versioned magic prefix domain-separates this AAD from any other GCM usage.
 */
function canonicalizeAadContext(context: FridaySecretAadContext): Buffer {
  if (typeof context.store !== "string" || context.store.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Secret binding context requires a non-empty 'store'",
      { httpStatus: 400 },
    );
  }
  const pairs: Array<[string, string | null]> = [
    ["store", context.store],
    ["owner", context.owner ?? null],
    ["tenant", context.tenant ?? null],
    ["scope", context.scope ?? null],
    ["ref", context.ref ?? null],
    ["field", context.field ?? null],
  ];
  const canonical =
    `friday-secret-aad\u0000v${String(FRIDAY_SECRET_AAD_SCHEMA_VERSION)}\u0000` +
    JSON.stringify(pairs);
  return Buffer.from(canonical, "utf8");
}

/**
 * Encrypts `plaintext` under AES-256-GCM.
 *
 * When `context` is supplied the result is an AAD-bound v2 envelope: the GCM tag
 * authenticates the canonical binding context, so the ciphertext can only be
 * decrypted with the identical context (fail-closed on transplant). When
 * `context` is omitted a legacy v1 envelope is produced — retained ONLY for the
 * primitive's own tests and the (documented) not-yet-migrated stores; every
 * production secret writer supplies a context.
 */
export function encryptSecret(
  plaintext: string,
  masterKey: Buffer,
  context?: FridaySecretAadContext,
): FridayEncryptedEnvelope {
  assertMasterKeyLength(masterKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  if (context) {
    cipher.setAAD(canonicalizeAadContext(context));
  }
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const envelope: FridayEncryptedEnvelope = {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
  if (context) {
    envelope.v = FRIDAY_SECRET_ENVELOPE_V2;
  }
  return envelope;
}

/**
 * Decrypts a {@link FridayEncryptedEnvelope}.
 *
 * For a v2 envelope a binding `context` is REQUIRED and is authenticated as GCM
 * AAD: a missing or mismatched context fails closed (throws). For a v1 legacy
 * envelope no AAD is applied and `context` is ignored (this path exists only to
 * read secrets stored before AAD binding, during migration).
 */
export function decryptSecret(
  envelope: FridayEncryptedEnvelope,
  masterKey: Buffer,
  context?: FridaySecretAadContext,
): string {
  assertMasterKeyLength(masterKey);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);

  const version = envelope.v;
  if (version === FRIDAY_SECRET_ENVELOPE_V2) {
    if (!context) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "AAD-bound (v2) secret envelope requires a binding context to decrypt",
        { httpStatus: 400 },
      );
    }
    decipher.setAAD(canonicalizeAadContext(context));
  } else if (version !== undefined) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Unsupported secret envelope version ${String(version)}`,
      { httpStatus: 400 },
    );
  }
  // version === undefined → v1 legacy: no AAD (context, if any, is ignored).

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Decrypts and, when the input was a legacy v1 envelope, produces a v2 re-wrap
 * bound to `context` so the caller can migrate the row at rest (read-repair).
 *
 * A v2 input is decrypted (AAD-enforced) and returns `rewrapped: null`. A v1
 * input is decrypted via the legacy path and re-encrypted under `context`; the
 * caller persists `rewrapped` to guarantee no v1 envelope survives a read.
 * Because the recovered plaintext round-trips through {@link encryptSecret},
 * a re-wrap that could not itself be decrypted is impossible.
 */
export function decryptSecretWithMigration(
  envelope: FridayEncryptedEnvelope,
  masterKey: Buffer,
  context: FridaySecretAadContext,
): FridaySecretMigrationResult {
  const plaintext = decryptSecret(envelope, masterKey, context);
  if (envelope.v === undefined) {
    return { plaintext, rewrapped: encryptSecret(plaintext, masterKey, context) };
  }
  return { plaintext, rewrapped: null };
}

// ─── Master key resolution ───

// P2-SEC: Master key cache with TTL for rotation support (re-reads from env/file after 1 hour)
type MasterKeyCacheSource = "env" | "keychain" | "file" | "generated";
let cachedMasterKey: Buffer | null = null;
let cachedMasterKeyExpiresAt = 0;
let cachedMasterKeySource: MasterKeyCacheSource | null = null;
const MASTER_KEY_CACHE_TTL_MS = 3_600_000; // 1 hour

const MASTER_KEY_DIR = path.join(os.homedir(), ".friday");
const DEFAULT_MASTER_KEY_FILE = path.join(MASTER_KEY_DIR, "master.key");
const MASTER_KEY_KEYCHAIN_SERVICE = "Friday Master Key";
const MASTER_KEY_KEYCHAIN_ACCOUNT = "friday";
const TEST_ONLY_MASTER_KEY_GENERATION_ENV = "FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION";

function getMasterKeyFilePath(): string {
  return process.env.FRIDAY_MASTER_KEY_FILE ?? DEFAULT_MASTER_KEY_FILE;
}

function parseMasterKeyHex(hex: string, sourceLabel: string): Buffer {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== KEY_BYTES) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${sourceLabel} must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${String(buf.length)} bytes`,
      { httpStatus: 400 },
    );
  }
  return buf;
}

function cacheMasterKey(key: Buffer, source: MasterKeyCacheSource): Buffer {
  cachedMasterKey = key;
  cachedMasterKeySource = source;
  cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
  return cachedMasterKey;
}

function readPersistedMasterKeyFile(options: {
  readonly repairPermissions: boolean;
  readonly failClosed: boolean;
}): Buffer | null {
  let hex: string;
  const masterKeyFile = getMasterKeyFilePath();
  try {
    hex = fs.readFileSync(masterKeyFile, "utf8").trim();
  } catch (err) {
    if (options.failClosed) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        "FRIDAY_MASTER_KEY is not configured. Set FRIDAY_MASTER_KEY (hex), set FRIDAY_MASTER_KEY_SOURCE=keychain, or provision an existing ~/.friday/master.key. Friday will not auto-generate a key for this path.",
        { httpStatus: 503 },
      );
    }
    console.warn("[friday][secret-crypto] master key file unreadable:", err instanceof Error ? err.message : String(err));
    return null;
  }

  if (options.repairPermissions) {
    try {
      const stat = fs.statSync(masterKeyFile);
      if ((stat.mode & 0o077) !== 0) {
        // eslint-disable-next-line no-console
        console.warn(`[friday][SECURITY] Master key file permissions too open (0o${(stat.mode & 0o777).toString(8)}) — attempting chmod 0600`);
        try {
          fs.chmodSync(masterKeyFile, 0o600);
        } catch (chmodErr) {
          // eslint-disable-next-line no-console
          console.warn("[friday][SECURITY] Could not fix master key file permissions:", chmodErr instanceof Error ? chmodErr.message : String(chmodErr));
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[friday][secret-crypto] stat check failed:", err instanceof Error ? err.message : String(err));
    }
  }

  try {
    return parseMasterKeyHex(hex, "Persisted master key file");
  } catch (err) {
    if (options.failClosed) {
      throw err;
    }
    return null;
  }
}

function readKeychainMasterKey(): Buffer | null {
  if (process.platform !== "darwin") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY_SOURCE=keychain is only supported on macOS",
      { httpStatus: 400 },
    );
  }

  const service = process.env.FRIDAY_MASTER_KEY_KEYCHAIN_SERVICE ?? MASTER_KEY_KEYCHAIN_SERVICE;
  const account = process.env.FRIDAY_MASTER_KEY_KEYCHAIN_ACCOUNT ?? MASTER_KEY_KEYCHAIN_ACCOUNT;
  try {
    const hex = execFileSync("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const buf = Buffer.from(hex, "hex");
    if (buf.length !== KEY_BYTES) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Keychain master key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${String(buf.length)} bytes`,
        { httpStatus: 400 },
      );
    }
    return buf;
  } catch (error) {
    if (error instanceof FridayDomainError) throw error;
    return null;
  }
}

/**
 * Resolves the master key from `FRIDAY_MASTER_KEY` env var (hex-encoded),
 * optional macOS keychain, or an already-provisioned `~/.friday/master.key`.
 *
 * Default runtime behavior is fail-closed: Friday must not silently create new
 * encryption roots. Legacy/test generation exists only behind
 * `FRIDAY_ALLOW_TEST_ONLY_MASTER_KEY_GENERATION=1`.
 */
export function getMasterKey(): Buffer {
  // P2-SEC: Honor TTL — invalidate cache after expiry to support key rotation
  if (cachedMasterKey && Date.now() < cachedMasterKeyExpiresAt) {
    return cachedMasterKey;
  }
  cachedMasterKey = null;
  cachedMasterKeyExpiresAt = 0;
  cachedMasterKeySource = null;

  // 1. Prefer explicit env var
  const envKey = process.env.FRIDAY_MASTER_KEY;
  if (envKey) {
    return cacheMasterKey(parseMasterKeyHex(envKey, "FRIDAY_MASTER_KEY"), "env");
  }

  // 2. Optional OS keystore mode. This is opt-in to avoid unexpected keychain
  // prompts in CI and headless environments.
  if (process.env.FRIDAY_MASTER_KEY_SOURCE === "keychain") {
    const keychainKey = readKeychainMasterKey();
    if (keychainKey) {
      return cacheMasterKey(keychainKey, "keychain");
    }

    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY_SOURCE=keychain requires a pre-provisioned macOS keychain item; Friday will not pass generated master keys through process arguments",
      { httpStatus: 400 },
    );
  }

  // 3. Try to read persisted key file
  const persistedKey = readPersistedMasterKeyFile({
    repairPermissions: true,
    failClosed: process.env[TEST_ONLY_MASTER_KEY_GENERATION_ENV] !== "1",
  });
  if (persistedKey) {
    return cacheMasterKey(persistedKey, "file");
  }

  if (process.env[TEST_ONLY_MASTER_KEY_GENERATION_ENV] !== "1") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY is not configured. Set FRIDAY_MASTER_KEY (hex), set FRIDAY_MASTER_KEY_SOURCE=keychain, or provision an existing ~/.friday/master.key. Friday will not auto-generate a key for this path.",
      { httpStatus: 503 },
    );
  }

  // 4. Explicit test/legacy opt-in only: generate, persist, and warn
  const newKey = crypto.randomBytes(KEY_BYTES);

  try {
    const masterKeyFile = getMasterKeyFilePath();
    fs.mkdirSync(path.dirname(masterKeyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(masterKeyFile, newKey.toString("hex") + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    // Best-effort: if we can't write, the key lives only in memory this run
    console.warn(
      "[friday] WARNING: Could not persist master key to " + getMasterKeyFilePath(),
      err instanceof Error ? err.message : String(err),
    );
  }

  console.warn(
    "[friday] WARNING: No FRIDAY_MASTER_KEY env var set. " +
      "Generated a random master key and saved to " +
      getMasterKeyFilePath() +
      ". Set FRIDAY_MASTER_KEY for production use.",
  );

  return cacheMasterKey(newKey, "generated");
}

/**
 * Resets the cached master key (for testing).
 */
export function resetMasterKeyCache(): void {
  cachedMasterKey = null;
  cachedMasterKeyExpiresAt = 0;
  cachedMasterKeySource = null;
}

/**
 * Fail-closed master key resolver for multi-tenant security paths.
 *
 * Unlike {@link getMasterKey}, this resolver MUST NOT auto-generate or
 * persist a random key.  It requires `FRIDAY_MASTER_KEY` (hex) or
 * `FRIDAY_MASTER_KEY_SOURCE=keychain` on macOS.  When neither source is
 * configured it throws — the multi-tenant security runtime stays disabled
 * rather than silently generating a key and printing it.
 */
export function getStrictMasterKey(): Buffer {
  if (cachedMasterKey && cachedMasterKeySource === "env" && process.env.FRIDAY_MASTER_KEY && Date.now() < cachedMasterKeyExpiresAt) {
    return cachedMasterKey;
  }

  const envKey = process.env.FRIDAY_MASTER_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "hex");
    if (buf.length !== KEY_BYTES) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `FRIDAY_MASTER_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${String(buf.length)} bytes`,
        { httpStatus: 400 },
      );
    }
    cachedMasterKey = buf;
    cachedMasterKeySource = "env";
    cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
    return cachedMasterKey;
  }

  if (process.env.FRIDAY_MASTER_KEY_SOURCE === "keychain") {
    if (cachedMasterKey && cachedMasterKeySource === "keychain" && Date.now() < cachedMasterKeyExpiresAt) {
      return cachedMasterKey;
    }
    const keychainKey = readKeychainMasterKey();
    if (keychainKey) {
      cachedMasterKey = keychainKey;
      cachedMasterKeySource = "keychain";
      cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
      return cachedMasterKey;
    }
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY_SOURCE=keychain requires a pre-provisioned macOS keychain item",
      { httpStatus: 400 },
    );
  }

  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "FRIDAY_MASTER_KEY is not configured. Set FRIDAY_MASTER_KEY (hex) or FRIDAY_MASTER_KEY_SOURCE=keychain. Multi-tenant security will not auto-generate a key.",
    { httpStatus: 503 },
  );
}

/**
 * Fail-closed provisioned master-key resolver for legacy/file-backed paths.
 *
 * This is the no-generate counterpart to {@link getMasterKey}: it may read a
 * configured env key, a configured keychain key, or an already-provisioned
 * `~/.friday/master.key`, but it MUST NOT generate, create, or overwrite key
 * material. Use this for production/default code paths that need to preserve
 * an existing file-backed deployment without keeping the fail-open first-run
 * behavior.
 */
export function getProvisionedMasterKey(): Buffer {
  if (
    cachedMasterKey
    && Date.now() < cachedMasterKeyExpiresAt
  ) {
    if (cachedMasterKeySource === "env" && process.env.FRIDAY_MASTER_KEY) {
      return cachedMasterKey;
    }
    if (cachedMasterKeySource === "keychain" && process.env.FRIDAY_MASTER_KEY_SOURCE === "keychain") {
      return cachedMasterKey;
    }
    if (
      cachedMasterKeySource === "file"
      && !process.env.FRIDAY_MASTER_KEY
      && process.env.FRIDAY_MASTER_KEY_SOURCE !== "keychain"
    ) {
      return cachedMasterKey;
    }
  }

  const envKey = process.env.FRIDAY_MASTER_KEY;
  if (envKey) {
    return cacheMasterKey(parseMasterKeyHex(envKey, "FRIDAY_MASTER_KEY"), "env");
  }

  if (process.env.FRIDAY_MASTER_KEY_SOURCE === "keychain") {
    const keychainKey = readKeychainMasterKey();
    if (keychainKey) {
      return cacheMasterKey(keychainKey, "keychain");
    }
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY_SOURCE=keychain requires a pre-provisioned macOS keychain item",
      { httpStatus: 400 },
    );
  }

  const persistedKey = readPersistedMasterKeyFile({
    repairPermissions: false,
    failClosed: true,
  });
  if (persistedKey) {
    return cacheMasterKey(persistedKey, "file");
  }

  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "FRIDAY_MASTER_KEY is not configured. Set FRIDAY_MASTER_KEY (hex), set FRIDAY_MASTER_KEY_SOURCE=keychain, or provision an existing ~/.friday/master.key. Friday will not auto-generate a key for this path.",
    { httpStatus: 503 },
  );
}
