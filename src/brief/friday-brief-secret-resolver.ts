import type Database from "better-sqlite3";

import { createFridaySecretRepository } from "../providers/persistence/friday-secret-repository.js";
import {
  decryptSecret,
  type FridayEncryptedEnvelope,
  getMasterKey,
} from "../providers/security/friday-secret-crypto.js";

const BRIEF_SECRET_SCOPE = "brief";

/**
 * Resolve a secret reference.
 *
 * - `$ENV_NAME` → read from `process.env.ENV_NAME`
 * - Anything else → look up `(scope="brief", refKey=<value>)` in the secret store
 *   and decrypt with the master key.
 *
 * Returns `undefined` when the ref is missing or unresolvable so callers can
 * treat a missing secret as "not configured".
 */
export function resolveBriefSecret(
  db: Database.Database,
  ref: string | undefined,
): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("$")) {
    return process.env[ref.slice(1)] ?? undefined;
  }
  const repo = createFridaySecretRepository();
  const entity = repo.getByRef(db, BRIEF_SECRET_SCOPE, ref);
  if (!entity) return undefined;
  try {
    const envelope = JSON.parse(entity.encryptedValue) as FridayEncryptedEnvelope;
    return decryptSecret(envelope, getMasterKey());
  } catch {
    return undefined;
  }
}

export const FRIDAY_BRIEF_SECRET_SCOPE = BRIEF_SECRET_SCOPE;
