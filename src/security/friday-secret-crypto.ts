import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { FridayDomainError } from "#errors";

// ─── Encrypted envelope ───

export interface FridayEncryptedEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
}

// ─── Core encrypt / decrypt ───

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function encryptSecret(
  plaintext: string,
  masterKey: Buffer,
): FridayEncryptedEnvelope {
  if (masterKey.length !== KEY_BYTES) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Master key must be ${KEY_BYTES} bytes, got ${String(masterKey.length)}`,
      { httpStatus: 400 },
    );
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptSecret(
  envelope: FridayEncryptedEnvelope,
  masterKey: Buffer,
): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Master key must be ${KEY_BYTES} bytes, got ${String(masterKey.length)}`,
      { httpStatus: 400 },
    );
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// ─── Master key resolution ───

// P2-SEC: Master key cache with TTL for rotation support (re-reads from env/file after 1 hour)
type MasterKeyCacheSource = "env" | "keychain" | "file" | "generated";
let cachedMasterKey: Buffer | null = null;
let cachedMasterKeyExpiresAt = 0;
let cachedMasterKeySource: MasterKeyCacheSource | null = null;
const MASTER_KEY_CACHE_TTL_MS = 3_600_000; // 1 hour

const MASTER_KEY_DIR = path.join(os.homedir(), ".friday");
const MASTER_KEY_FILE = path.join(MASTER_KEY_DIR, "master.key");
const MASTER_KEY_KEYCHAIN_SERVICE = "Friday Master Key";
const MASTER_KEY_KEYCHAIN_ACCOUNT = "friday";

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
 * or persists/reads a random one from `~/.friday/master.key`.
 *
 * When no explicit key is set:
 * - On first run, generates a random key, writes to `~/.friday/master.key`
 *   (mode 0600), and logs a warning.
 * - On subsequent runs, reads from that file so secrets survive restarts.
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

  // 2. Optional OS keystore mode. This is opt-in to avoid unexpected keychain
  // prompts in CI and headless environments.
  if (process.env.FRIDAY_MASTER_KEY_SOURCE === "keychain") {
    const keychainKey = readKeychainMasterKey();
    if (keychainKey) {
      cachedMasterKey = keychainKey;
      cachedMasterKeySource = "keychain";
      cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
      return cachedMasterKey;
    }

    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "FRIDAY_MASTER_KEY_SOURCE=keychain requires a pre-provisioned macOS keychain item; Friday will not pass generated master keys through process arguments",
      { httpStatus: 400 },
    );
  }

  // 3. Try to read persisted key file
  try {
    const hex = fs.readFileSync(MASTER_KEY_FILE, "utf8").trim();
    // P2-SEC: Verify and fix master key file permissions
    try {
      const stat = fs.statSync(MASTER_KEY_FILE);
      if ((stat.mode & 0o077) !== 0) {
        // eslint-disable-next-line no-console
        console.warn(`[friday][SECURITY] Master key file permissions too open (0o${(stat.mode & 0o777).toString(8)}) — attempting chmod 0600`);
        try {
          fs.chmodSync(MASTER_KEY_FILE, 0o600);
        } catch (chmodErr) {
          // eslint-disable-next-line no-console
          console.warn("[friday][SECURITY] Could not fix master key file permissions:", chmodErr instanceof Error ? chmodErr.message : String(chmodErr));
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[friday][secret-crypto] stat check failed:", err instanceof Error ? err.message : String(err));
    }
    const buf = Buffer.from(hex, "hex");
    if (buf.length === KEY_BYTES) {
      cachedMasterKey = buf;
      cachedMasterKeySource = "file";
      cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
      return cachedMasterKey;
    }
    // Invalid length — fall through to regenerate
  } catch (err) {
    // File unreadable — fall through to regenerate
    console.warn("[friday][secret-crypto] master key file unreadable:", err instanceof Error ? err.message : String(err));
  }

  // 4. Generate, persist, and warn
  const newKey = crypto.randomBytes(KEY_BYTES);

  try {
    fs.mkdirSync(MASTER_KEY_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(MASTER_KEY_FILE, newKey.toString("hex") + "\n", {
      mode: 0o600,
    });
  } catch (err) {
    // Best-effort: if we can't write, the key lives only in memory this run
    console.warn(
      "[friday] WARNING: Could not persist master key to " + MASTER_KEY_FILE,
      err instanceof Error ? err.message : String(err),
    );
  }

  console.warn(
    "[friday] WARNING: No FRIDAY_MASTER_KEY env var set. " +
      "Generated a random master key and saved to " +
      MASTER_KEY_FILE +
      ". Set FRIDAY_MASTER_KEY for production use.",
  );

  cachedMasterKey = newKey;
  cachedMasterKeySource = "generated";
  cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
  return cachedMasterKey;
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
