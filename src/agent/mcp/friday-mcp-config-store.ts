import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import type { FridayMcpServerConfig } from "./friday-mcp-adapter.types.js";
import {
  decryptSecretWithMigration,
  encryptSecret,
  type FridayEncryptedEnvelope,
  type FridaySecretAadContext,
  getStrictMasterKey,
} from "../../security/friday-secret-crypto.js";
import {
  buildFridaySecretRef,
  parseFridaySecretInput,
} from "../../security/friday-secret-ref.js";

const CONFIG_FILENAME = "mcp-servers.json";
const VAULT_FILENAME = "mcp-secrets.json";
const VAULT_VERSION = 1;

/** Logical store namespace bound into every MCP vault-entry AAD context. */
const FRIDAY_MCP_VAULT_AAD_STORE = "friday-mcp-vault";

/**
 * Canonical AAD binding context for one MCP secret-vault entry.
 *
 * The vault map key (`refKey`) is the entry's stable identity, so binding it
 * prevents a ciphertext being transplanted to a different vault key. Writer
 * (save) and reader (load) both key off the same `refKey`.
 */
function mcpVaultAadContext(refKey: string): FridaySecretAadContext {
  return { store: FRIDAY_MCP_VAULT_AAD_STORE, ref: refKey };
}

const SECRET_FIELDS = ["env", "headers"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

/**
 * A secret value found at rest that could not be represented as an opaque,
 * resolvable `secret://` reference. Emitted by {@link FridayMcpConfigStore.load}
 * so callers/operators can observe (and audit) plaintext that predates
 * encryption or a broken vault, rather than silently leaking it forever. The
 * value is re-encrypted on the next `save()`.
 */
export interface FridayMcpSecretResidueEntry {
  serverId: string;
  field: SecretField;
  key: string;
  reason: "legacy-plaintext" | "unresolved-ref";
}

export interface CreateFridayMcpConfigStoreOptions {
  /**
   * Master key used to encrypt/decrypt env & header secret VALUES at rest.
   *
   * Defaults to the hub's fail-closed persistent master key resolver
   * ({@link getStrictMasterKey}) — the same source that guards provider and
   * multi-tenant secrets. It is resolved lazily (only when a plaintext value
   * actually needs encrypting on `save`, or a `secret://` ref needs decrypting
   * on `load`). When it is unavailable, `save` FAILS CLOSED (throws before any
   * write) so a secret is never silently persisted as plaintext. Tests inject a
   * fixed key here.
   */
  masterKey?: Buffer;
  /**
   * Invoked by {@link FridayMcpConfigStore.load} when it encounters legacy
   * plaintext or an unresolved secret ref at rest. Defaults to a console.warn
   * summary.
   */
  onSecretResidue?: (entries: readonly FridayMcpSecretResidueEntry[]) => void;
}

interface McpSecretVault {
  version: number;
  entries: Record<string, FridayEncryptedEnvelope>;
}

export interface FridayMcpConfigStore {
  load(): FridayMcpServerConfig[];
  save(configs: FridayMcpServerConfig[]): void;
  addServer(config: FridayMcpServerConfig): FridayMcpServerConfig[];
  removeServer(id: string): FridayMcpServerConfig[];
}

export function createFridayMcpConfigStore(
  stateDir: string,
  options: CreateFridayMcpConfigStoreOptions = {},
): FridayMcpConfigStore {
  const filePath = join(stateDir, CONFIG_FILENAME);
  const vaultPath = join(stateDir, VAULT_FILENAME);

  function resolveMasterKey(): Buffer {
    return options.masterKey ?? getStrictMasterKey();
  }

  function reportResidue(entries: FridayMcpSecretResidueEntry[]): void {
    if (entries.length === 0) return;
    if (options.onSecretResidue) {
      options.onSecretResidue(entries);
      return;
    }
     
    console.warn(
      `[friday][mcp-config-store][SECURITY] ${String(entries.length)} MCP secret value(s) present at rest ` +
        `without a resolvable encrypted ref (` +
        entries.map((e) => `${e.serverId}.${e.field}.${e.key}=${e.reason}`).join(", ") +
        `); they will be re-encrypted on the next save.`,
    );
  }

  function readVault(): McpSecretVault {
    try {
      const parsed = JSON.parse(readFileSync(vaultPath, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const entries = (parsed as { entries?: unknown }).entries;
        if (typeof entries === "object" && entries !== null && !Array.isArray(entries)) {
          return { version: VAULT_VERSION, entries: entries as Record<string, FridayEncryptedEnvelope> };
        }
      }
    } catch {
      // Missing/corrupt vault → behave as empty (secrets simply become residue).
    }
    return { version: VAULT_VERSION, entries: {} };
  }

  function isSecretRecord(value: unknown): value is Record<string, string> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function load(): FridayMcpServerConfig[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const configs = parsed.filter(isValidServerConfig);
    if (configs.length === 0) return configs;

    const vault = readVault();
    let vaultDirty = false;
    const residue: FridayMcpSecretResidueEntry[] = [];

    // Resolve the master key lazily: only if at least one secret ref needs
    // decrypting. Never throw out of `load` — an unresolvable key/vault means
    // the opaque ref is returned as-is (fail-safe: no plaintext is exposed).
    let cachedKey: Buffer | null | undefined;
    const getKey = (): Buffer | null => {
      if (cachedKey === undefined) {
        try {
          cachedKey = resolveMasterKey();
        } catch {
          cachedKey = null;
        }
      }
      return cachedKey;
    };

    for (const config of configs) {
      for (const field of SECRET_FIELDS) {
        const record = config[field];
        if (!isSecretRecord(record)) continue;
        for (const [key, rawValue] of Object.entries(record)) {
          if (typeof rawValue !== "string") continue;
          const input = parseFridaySecretInput(rawValue, { trimInline: false });
          if (input.kind === "secret-ref") {
            const envelope = vault.entries[input.refKey];
            if (envelope) {
              const activeKey = getKey();
              if (activeKey) {
                try {
                  const { plaintext, rewrapped } = decryptSecretWithMigration(
                    envelope,
                    activeKey,
                    mcpVaultAadContext(input.refKey),
                  );
                  record[key] = plaintext;
                  if (rewrapped) {
                    // Read-repair (SEC-SECRET-AAD-001): migrate the legacy v1
                    // vault entry to v2 in place; flushed below.
                    vault.entries[input.refKey] = rewrapped;
                    vaultDirty = true;
                  }
                  continue;
                } catch {
                  // fall through to residue below (leave opaque ref in place)
                }
              }
            }
            residue.push({ serverId: config.id, field, key, reason: "unresolved-ref" });
            continue;
          }
          // A non-ref literal at rest is legacy plaintext: return it as-is so the
          // server stays usable, but flag it so it does not silently persist.
          residue.push({ serverId: config.id, field, key, reason: "legacy-plaintext" });
        }
      }
    }

    if (vaultDirty) {
      // Best-effort persist of the AAD re-wrap so no legacy v1 entry survives.
      try {
        mkdirSync(dirname(vaultPath), { recursive: true });
        writeFileSync(vaultPath, JSON.stringify(vault, null, 2), { encoding: "utf8", mode: 0o600 });
      } catch (err) {
        console.warn(
          "[friday][mcp-config-store] AAD vault read-repair flush failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    reportResidue(residue);
    return configs;
  }

  function save(configs: FridayMcpServerConfig[]): void {
    const previousVault = readVault();
    const nextVault: McpSecretVault = { version: VAULT_VERSION, entries: {} };

    // Fail-closed: if any value needs encryption, resolve the key BEFORE writing
    // anything. When no key is available this throws and NO file (and therefore
    // no plaintext) is written.
    const needsKey = configs.some((config) =>
      SECRET_FIELDS.some((field) => {
        const record = config[field];
        if (!isSecretRecord(record)) return false;
        return Object.values(record).some(
          (value) =>
            typeof value === "string" &&
            parseFridaySecretInput(value, { trimInline: false }).kind !== "secret-ref",
        );
      }),
    );
    const masterKey = needsKey ? resolveMasterKey() : undefined;

    const redacted = configs.map((config) => {
      let next = config;
      for (const field of SECRET_FIELDS) {
        const record = config[field];
        if (!isSecretRecord(record)) continue;
        const rewritten: Record<string, string> = {};
        for (const [key, value] of Object.entries(record)) {
          if (typeof value !== "string") {
            rewritten[key] = value as string;
            continue;
          }
          const input = parseFridaySecretInput(value, { trimInline: false });
          if (input.kind === "secret-ref") {
            // Already opaque — preserve its envelope from the existing vault.
            rewritten[key] = value;
            const existing = previousVault.entries[input.refKey];
            if (existing) nextVault.entries[input.refKey] = existing;
            continue;
          }
          // Encrypt the exact literal (env-ref / file-ref / plaintext alike) so
          // no secret value is left at rest; load() restores it byte-for-byte.
          const refKey = randomBytes(16).toString("hex");
          // masterKey is guaranteed present here: `needsKey` is true whenever a
          // non-secret-ref value exists.
          nextVault.entries[refKey] = encryptSecret(
            value,
            masterKey as Buffer,
            mcpVaultAadContext(refKey),
          );
          rewritten[key] = buildFridaySecretRef(refKey);
        }
        next = { ...next, [field]: rewritten };
      }
      return next;
    });

    mkdirSync(dirname(filePath), { recursive: true });
    // Write the vault first so every ref in the config is resolvable the instant
    // the config file becomes visible.
    writeFileSync(vaultPath, JSON.stringify(nextVault, null, 2), { encoding: "utf8", mode: 0o600 });
    writeFileSync(filePath, JSON.stringify(redacted, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  function addServer(config: FridayMcpServerConfig): FridayMcpServerConfig[] {
    const existing = load();
    const filtered = existing.filter((s) => s.id !== config.id);
    const updated = [...filtered, config];
    save(updated);
    return updated;
  }

  function removeServer(id: string): FridayMcpServerConfig[] {
    const existing = load();
    const updated = existing.filter((s) => s.id !== id);
    save(updated);
    return updated;
  }

  return { load, save, addServer, removeServer };
}

function isValidServerConfig(value: unknown): value is FridayMcpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && obj.id.trim().length > 0;
}
