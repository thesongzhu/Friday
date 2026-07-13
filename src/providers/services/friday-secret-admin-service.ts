import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";

import type { FridaySecretEntity } from "../persistence/friday-secret-repository.js";
import { createFridaySecretRepository, fridaySecretAadContext } from "../persistence/friday-secret-repository.js";
import { encryptSecret, getStrictMasterKey } from "../security/friday-secret-crypto.js";

export interface FridaySecretSummary {
  id: string;
  scope: string;
  refKey: string;
  keyId: string;
  expiresAt?: string;
  rotatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayListSecretsQuery {
  scope?: string;
  refKey?: string;
  limit?: number;
}

export interface FridayCreateSecretInput {
  scope: string;
  refKey: string;
  value: string;
  expiresAt?: string;
}

export interface FridayUpdateSecretInput {
  refKey?: string;
  value?: string;
  expiresAt?: string | null;
}

export interface FridaySecretAdminService {
  listSecrets(query?: FridayListSecretsQuery): FridaySecretSummary[];
  getSecret(secretId: string): FridaySecretSummary | null;
  createSecret(input: FridayCreateSecretInput): FridaySecretSummary;
  updateSecret(secretId: string, input: FridayUpdateSecretInput): FridaySecretSummary;
  deleteSecret(secretId: string): boolean;
}

export interface CreateFridaySecretAdminServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

function assertNonEmptyString(value: string | undefined, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
}

function toSummary(secret: FridaySecretEntity): FridaySecretSummary {
  return {
    id: secret.id,
    scope: secret.scope,
    refKey: secret.refKey,
    keyId: secret.keyId,
    expiresAt: secret.expiresAt,
    rotatedAt: secret.rotatedAt,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

export function createFridaySecretAdminService(
  deps: CreateFridaySecretAdminServiceDeps,
): FridaySecretAdminService {
  const secretRepo = createFridaySecretRepository();

  return {
    listSecrets(query) {
      const secrets = deps.db.withReadConnection((db) =>
        secretRepo.list(db, query),
      );
      return secrets.map(toSummary);
    },

    getSecret(secretId) {
      const secret = deps.db.withReadConnection((db) =>
        secretRepo.getById(db, secretId),
      );
      return secret ? toSummary(secret) : null;
    },

    createSecret(input) {
      assertNonEmptyString(input.scope, "scope");
      assertNonEmptyString(input.refKey, "refKey");
      assertNonEmptyString(input.value, "value");

      const existing = deps.db.withReadConnection((db) =>
        secretRepo.getByRef(db, input.scope.trim(), input.refKey.trim()),
      );
      if (existing) {
        throw new FridayDomainError(
          "CONFLICT",
          `Secret already exists for ${input.scope.trim()}/${input.refKey.trim()}`,
          { httpStatus: 409 },
        );
      }

      const secretId = deps.idGenerator();
      const envelope = encryptSecret(
        input.value,
        getStrictMasterKey(),
        fridaySecretAadContext({ scope: input.scope.trim(), id: secretId }),
      );
      deps.db.withWriteTransaction((db) => {
        secretRepo.upsert(db, {
          id: secretId,
          scope: input.scope.trim(),
          refKey: input.refKey.trim(),
          encryptedValue: JSON.stringify(envelope),
          keyId: "master-v1",
          expiresAt: input.expiresAt,
          nowIso: deps.nowIso(),
        });
      });

      const created = deps.db.withReadConnection((db) =>
        secretRepo.getByRef(db, input.scope.trim(), input.refKey.trim()),
      );
      if (!created) {
        throw new FridayDomainError("INTERNAL_ERROR", "Secret was not persisted", { httpStatus: 500 });
      }
      return toSummary(created);
    },

    updateSecret(secretId, input) {
      const existing = deps.db.withReadConnection((db) =>
        secretRepo.getById(db, secretId),
      );
      if (!existing) {
        throw new FridayDomainError("NOT_FOUND", "Secret not found", { httpStatus: 404 });
      }

      const nextRefKey = input.refKey?.trim();
      if (nextRefKey !== undefined && nextRefKey === "") {
        throw new FridayDomainError("VALIDATION_ERROR", "refKey must be non-empty when provided", {
          httpStatus: 400,
        });
      }

      if (nextRefKey && nextRefKey !== existing.refKey) {
        const conflict = deps.db.withReadConnection((db) =>
          secretRepo.getByRef(db, existing.scope, nextRefKey),
        );
        if (conflict && conflict.id !== secretId) {
          throw new FridayDomainError(
            "CONFLICT",
            `Secret already exists for ${existing.scope}/${nextRefKey}`,
            { httpStatus: 409 },
          );
        }
      }

      let encryptedValue: string | undefined;
      if (input.value !== undefined) {
        assertNonEmptyString(input.value, "value");
        // Bind the STABLE row id (not the possibly-renamed refKey) so a value
        // update or a refKey rename never mismatches the reader's AAD.
        encryptedValue = JSON.stringify(
          encryptSecret(
            input.value,
            getStrictMasterKey(),
            fridaySecretAadContext({ scope: existing.scope, id: secretId }),
          ),
        );
      }

      const updated = deps.db.withWriteTransaction((db) =>
        secretRepo.updateById(db, {
          secretId,
          refKey: nextRefKey,
          encryptedValue,
          keyId: encryptedValue ? "master-v1" : undefined,
          expiresAt: input.expiresAt,
          nowIso: deps.nowIso(),
        }),
      );
      if (!updated) {
        throw new FridayDomainError("NOT_FOUND", "Secret not found", { httpStatus: 404 });
      }
      return toSummary(updated);
    },

    deleteSecret(secretId) {
      return deps.db.withWriteTransaction((db) =>
        secretRepo.deleteById(db, secretId),
      );
    },
  };
}
