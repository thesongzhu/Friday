import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
let cachedMasterKey: Buffer | null = null;
let cachedMasterKeyExpiresAt = 0;
const MASTER_KEY_CACHE_TTL_MS = 3_600_000; // 1 hour

const MASTER_KEY_DIR = path.join(os.homedir(), ".friday");
const MASTER_KEY_FILE = path.join(MASTER_KEY_DIR, "master.key");

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
    cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
    return cachedMasterKey;
  }

  // 2. Try to read persisted key file
  try {
    const hex = fs.readFileSync(MASTER_KEY_FILE, "utf8").trim();
    // P2-SEC: Verify master key file permissions are not too open
    try {
      const stat = fs.statSync(MASTER_KEY_FILE);
      if ((stat.mode & 0o077) !== 0) {
        console.warn(`[friday][SECURITY] Master key file permissions too open — expected 0600, got 0o${(stat.mode & 0o777).toString(8)}`);
      }
    } catch (err) { console.warn("[friday][secret-crypto] stat check failed:", err instanceof Error ? err.message : String(err)); }
    const buf = Buffer.from(hex, "hex");
    if (buf.length === KEY_BYTES) {
      cachedMasterKey = buf;
      return cachedMasterKey;
    }
    // Invalid length — fall through to regenerate
  } catch (err) {
    // File unreadable — fall through to regenerate
    console.warn("[friday][secret-crypto] master key file unreadable:", err instanceof Error ? err.message : String(err));
  }

  // 3. Generate, persist, and warn
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
  cachedMasterKeyExpiresAt = Date.now() + MASTER_KEY_CACHE_TTL_MS;
  return cachedMasterKey;
}

/**
 * Resets the cached master key (for testing).
 */
export function resetMasterKeyCache(): void {
  cachedMasterKey = null;
}
