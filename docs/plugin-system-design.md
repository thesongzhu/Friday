**Unified Plugin System Design**

Implements all 3 decisions in one system:

1. Core channels are internal bundled plugins (`discord`, `telegram`), all other channels come via plugin packages.
2. Plugin dependencies and marketplace are first-class together (install/load resolver uses semver + dependency graph).
3. Signature verification is enforced for marketplace plugins; local plugins use trust-on-install fingerprinting.

### 1. Core Constants + Types
```ts
// src/plugins/model/friday-plugin.types.ts

export const FRIDAY_PLUGIN_MANIFEST_FILENAME = "friday.plugin.json" as const;

export type FridayPluginKind =
  | "channel"
  | "provider"
  | "skill"
  | "storage"
  | "integration";

export type FridayPluginSource = "bundled" | "local" | "marketplace";

export type FridayPluginStatus =
  | "not_installed"
  | "installed"
  | "configured"
  | "enabled"
  | "running"
  | "disabled"
  | "error"
  | "uninstalled";

export type FridayPluginTrustMode = "signed" | "trust_on_install";

export const FRIDAY_CORE_CHANNEL_PLUGIN_IDS = [
  "friday.channel.discord",
  "friday.channel.telegram",
] as const;

// local > marketplace; bundled may not be overridden for reserved core IDs
export const FRIDAY_PLUGIN_SOURCE_PRECEDENCE: readonly FridayPluginSource[] = [
  "marketplace",
  "local",
  "bundled",
];

export interface FridayPluginSignature {
  algorithm: "ed25519";
  keyId: string;
  value: string; // base64 signature
}

export interface FridayPluginManifest {
  schemaVersion: "1.0";
  id: string;
  version: string;
  name: string;
  description: string;
  kinds: FridayPluginKind[];
  entrypoints: Partial<Record<FridayPluginKind, string>>;
  dependencies?: Record<string, string>; // { pluginId: semverRange }
  permissions: FridayPluginPermissionPolicy;
  compatibility: {
    minHubVersion: string;
    apiVersion: "1";
  };
  signature?: FridayPluginSignature; // required for marketplace installs
}

export type FridayPluginPermissionResource =
  | "filesystem"
  | "network"
  | "channel"
  | "tool"
  | "memory"
  | "device"
  | "shell"
  | "provider"
  | "storage"
  | "hook";

export type FridayPluginPermissionAction =
  | "read"
  | "write"
  | "connect"
  | "send"
  | "receive"
  | "execute"
  | "register";

export interface FridayPluginPermissionGrant {
  id: string;
  resource: FridayPluginPermissionResource;
  action: FridayPluginPermissionAction;
  required: boolean;
  reason: string;
  selectors?: {
    pathPrefixes?: string[];
    hostAllowlist?: string[];
    channelIds?: string[];
    toolAllowlist?: string[];
    memoryNamespaces?: string[];
    providerKinds?: string[];
    hookNames?: string[];
  };
}

export interface FridayPluginPermissionPolicy {
  grants: FridayPluginPermissionGrant[];
  promptOn: Array<
    | "filesystem.write"
    | "network.connect"
    | "shell.execute"
    | "channel.send"
    | "provider.execute"
  >;
}
```

Manifest rules:

- Required: `id`, `version`, `name`, `description`, `kinds`.
- For every value in `kinds`, `entrypoints[kind]` must exist.
- `dependencies` uses semver ranges (`^1.0.0`, `~2.3.1`, etc).
- `signature` required only when source is marketplace.

---

### 2. Migration DDL (V008)
```ts
// src/state/sqlite/migrations/v008-plugin-system-foundation.ts

export const V008_PLUGIN_SYSTEM_FOUNDATION_SQL = `
-- V008: Plugin system foundation

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('bundled','local','marketplace')),
  status TEXT NOT NULL CHECK (status IN (
    'not_installed','installed','configured','enabled','running','disabled','error','uninstalled'
  )),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  trust_mode TEXT NOT NULL CHECK (trust_mode IN ('signed','trust_on_install')),
  install_path TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  signature_algorithm TEXT,
  signature_key_id TEXT,
  signature_value TEXT,
  signature_verified INTEGER NOT NULL DEFAULT 0 CHECK (signature_verified IN (0,1)),
  trusted_fingerprint_sha256 TEXT,
  last_verified_at TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugins_status_enabled
  ON plugins(status, enabled);

CREATE INDEX IF NOT EXISTS idx_plugins_source_updated
  ON plugins(source, updated_at DESC);

CREATE TABLE IF NOT EXISTS plugin_dependencies (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  dependency_plugin_id TEXT NOT NULL,
  semver_range TEXT NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, dependency_plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_deps_dependency
  ON plugin_dependencies(dependency_plugin_id);

CREATE TABLE IF NOT EXISTS plugin_marketplace_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  trust_policy TEXT NOT NULL CHECK (trust_policy IN ('strict','warn','permissive')),
  pinned_key_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  package_url TEXT,
  manifest_json TEXT NOT NULL,
  signature_algorithm TEXT,
  signature_key_id TEXT,
  signature_value TEXT,
  released_at TEXT NOT NULL,
  yanked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin_released
  ON plugin_versions(plugin_id, released_at DESC);

CREATE TABLE IF NOT EXISTS plugin_marketplace_cache (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES plugin_marketplace_sources(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0,1)),
  indexed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, plugin_id, version)
);
`;
```

---

### 3. Repository + Service + Loader Interfaces
```ts
// src/plugins/persistence/friday-plugin-repository.ts
export interface FridayPluginRepository {
  upsertPlugin(db: Database.Database, input: UpsertFridayPluginInput): FridayPluginEntity;
  getById(db: Database.Database, pluginId: string): FridayPluginEntity | null;
  list(db: Database.Database, query?: FridayPluginListQuery): FridayPluginEntity[];
  setStatus(db: Database.Database, pluginId: string, status: FridayPluginStatus, nowIso: string): void;
  setEnabled(db: Database.Database, pluginId: string, enabled: boolean, nowIso: string): void;
  deletePlugin(db: Database.Database, pluginId: string): void;
}

// src/plugins/services/friday-plugin-discovery-service.types.ts
export interface FridayPluginDiscoveryService {
  discoverLocal(): FridayDiscoveredPluginCandidate[];
  discoverMarketplace(query: FridayPluginMarketplaceQuery): Promise<FridayDiscoveredPluginCandidate[]>;
  discoverAll(input?: FridayPluginDiscoveryInput): Promise<FridayDiscoveredPluginCandidate[]>;
}

// src/plugins/services/friday-plugin-registry-service.types.ts
export interface FridayPluginRegistryService {
  refresh(): Promise<void>;
  list(): FridayRegisteredPlugin[];
  get(pluginId: string): FridayRegisteredPlugin | null;
  resolveRuntimePlugins(): FridayRegisteredPlugin[]; // dedup + precedence
}

// src/plugins/services/friday-plugin-dependency-resolver.types.ts
export interface FridayPluginDependencyResolver {
  resolveInstallPlan(input: FridayPluginInstallPlanInput): Promise<FridayPluginInstallPlan>;
  resolveLoadOrder(pluginIds?: string[]): FridayPluginLoadPlan;
}

// src/plugins/services/friday-plugin-loader.types.ts
export interface FridayPluginLoader {
  load(plan: FridayPluginLoadPlan): Promise<FridayLoadedPlugin[]>;
  unload(pluginIds: string[]): Promise<void>;
}

// src/plugins/runtime/friday-plugin-runtime.types.ts
export interface FridayPluginApi {
  registerTool(input: FridayPluginToolRegistration): void;
  registerChannel(input: FridayChannelRegistration): void;
  registerProvider(input: FridayProviderRegistration): void;
  registerSkill(input: FridaySkillRegistration): void;
  registerStorage(input: FridayStorageRegistration): void;
  registerIntegration(input: FridayIntegrationRegistration): void;
  registerHook(input: FridayPluginHookRegistration): void;
}
```

Lifecycle state machine:

- `install -> configured -> enabled -> running -> disabled -> uninstalled`
- `error` is reachable from any state.
- `enable` and `run` are blocked if dependency resolution fails.

---

### 4. Dependency Resolver Algorithm
Use deterministic topological resolution with semver checks.

Algorithm:

1. Start from target plugin(s); recursively expand `dependencies`.
2. For each dependency edge `(A -> B@range)`:
   - If `B` missing: try auto-resolve from marketplace if enabled and `installDependencies=true`.
   - If still missing: emit `PLUGIN_DEPENDENCY_MISSING`.
   - If found but `!semver.satisfies(B.version, range)`: emit `PLUGIN_DEPENDENCY_VERSION_MISMATCH`.
3. Build DAG with edge `B -> A` (dependency loads before dependent).
4. Run Kahn topological sort with lexical tie-break on plugin id.
5. If unresolved nodes remain: run DFS to extract cycle and throw `PLUGIN_DEPENDENCY_CYCLE`.
6. Return ordered load/install plan.

Behavior:

- Missing dependency during enable: plugin stays `disabled` and stores structured error.
- Uninstall blocked when reverse dependencies exist unless `force=true`.

---

### 5. Signature Verification Policy
```ts
// src/plugins/services/friday-plugin-signature-verifier.ts
export interface FridayPluginSignatureVerifier {
  computeChecksum(packageBytes: Buffer): string;
  verifyMarketplacePackage(input: {
    pluginId: string;
    version: string;
    packageBytes: Buffer;
    expectedChecksum: string;
    signature: FridayPluginSignature;
    publicKeyPem: string;
    pinnedKeyIds?: string[];
  }): FridayPluginSignatureVerificationResult;
  evaluateLocalTrustOnInstall(input: {
    pluginId: string;
    version: string;
    packageBytes: Buffer;
    userApproved: boolean;
  }): FridayPluginSignatureVerificationResult;
}
```

Verification rules:

- Marketplace:
  - `signature` required.
  - Ed25519 verification required against known/pinned key.
  - Failure blocks install (`PLUGIN_SIGNATURE_REQUIRED` / `PLUGIN_SIGNATURE_INVALID`).
- Local:
  - Signature optional.
  - If missing, install only with explicit approval.
  - Store SHA-256 fingerprint in `trusted_fingerprint_sha256`.
  - On next load, fingerprint mismatch disables plugin (`PLUGIN_TRUST_FINGERPRINT_MISMATCH`).

Canonical signing payload:

`friday-plugin-signature-v1\n<pluginId>\n<version>\n<checksumSha256>`

---

### 6. Marketplace + Local API Routes

Add scopes in `FridayScope`:

- `plugin.read`
- `plugin.write`
- `plugin.install`

Marketplace routes (required):

- `GET /v1/marketplace/plugins` (`operationId: marketplace.plugins.list`)
- `GET /v1/marketplace/plugins/:id` (`operationId: marketplace.plugins.get`)
- `GET /v1/marketplace/plugins/:id/versions` (`operationId: marketplace.plugins.versions.list`)
- `POST /v1/marketplace/plugins/:id/install` (`operationId: marketplace.plugins.install`)

Local management mirrors:

- `GET /v1/plugins` (`operationId: plugins.list`)
- `GET /v1/plugins/:id` (`operationId: plugins.get`)
- `GET /v1/plugins/:id/versions` (`operationId: plugins.versions.list`)
- `POST /v1/plugins/:id/install` (`operationId: plugins.install`) with local path input
- `POST /v1/plugins/:id/enable` (`operationId: plugins.enable`)
- `POST /v1/plugins/:id/disable` (`operationId: plugins.disable`)
- `DELETE /v1/plugins/:id` (`operationId: plugins.uninstall`)

Dedup behavior for discovery responses:

- Runtime selected artifact by plugin id uses precedence `local > marketplace`.
- Reserved core channel IDs cannot be overridden by local/marketplace packages.

---

### 7. Channel Plugin Interface (Core + External)

```ts
// src/plugins/channels/friday-channel-plugin.types.ts
export interface FridayChannelPlugin {
  channelId: string; // "discord", "telegram", ...
  capabilities: {
    chatKinds: Array<"dm" | "group" | "channel" | "thread">;
    supportsTyping?: boolean;
    supportsThreads?: boolean;
  };
  start(ctx: FridayChannelRuntimeContext): Promise<void>;
  stop(ctx: FridayChannelRuntimeContext): Promise<void>;
  sendMessage(input: FridayChannelSendMessageInput): Promise<FridayChannelSendMessageResult>;
}

export interface FridayChannelRuntimeContext {
  onInboundMessage(message: FridayInboundChannelMessage): Promise<void>;
  onDeliveryEvent?(event: FridayChannelDeliveryEvent): Promise<void>;
}
```

Session integration:

- Inbound:
  - Channel plugin emits inbound message.
  - Session bridge normalizes key via existing session key rules.
  - Persist as `role="user"` via `FridaySessionService.addMessage`.
  - Emit workflow/agent trigger event.
- Outbound:
  - Runtime resolves target from session.
  - Calls `sendMessage` on channel plugin.
  - Persists assistant message + delivery metadata.

Core channels:

- `friday.channel.discord` and `friday.channel.telegram` are bundled plugins implementing this exact interface.
- They are always discoverable and non-uninstallable, but can be enabled/disabled.

---

### 8. File Plan (New + Updated)

1. `src/plugins/index.ts`
2. `src/plugins/model/friday-plugin.types.ts`
3. `src/plugins/model/friday-plugin-marketplace.types.ts`
4. `src/plugins/manifest/friday-plugin-manifest.schema.ts`
5. `src/plugins/manifest/friday-plugin-manifest-loader.ts`
6. `src/plugins/persistence/friday-plugin-repository.ts`
7. `src/plugins/persistence/friday-plugin-dependency-repository.ts`
8. `src/plugins/persistence/friday-plugin-version-repository.ts`
9. `src/plugins/persistence/friday-plugin-marketplace-source-repository.ts`
10. `src/plugins/persistence/friday-plugin-marketplace-cache-repository.ts`
11. `src/plugins/services/friday-plugin-discovery-service.ts`
12. `src/plugins/services/friday-plugin-registry-service.ts`
13. `src/plugins/services/friday-plugin-dependency-resolver.ts`
14. `src/plugins/services/friday-plugin-signature-verifier.ts`
15. `src/plugins/services/friday-plugin-installation-service.ts`
16. `src/plugins/services/friday-plugin-loader.ts`
17. `src/plugins/services/friday-plugin-lifecycle-service.ts`
18. `src/plugins/services/friday-plugin-sandbox-service.ts`
19. `src/plugins/runtime/friday-plugin-runtime.types.ts`
20. `src/plugins/runtime/friday-plugin-runtime.ts`
21. `src/plugins/channels/friday-channel-plugin.types.ts`
22. `src/plugins/channels/friday-channel-session-bridge.ts`
23. `src/plugins/channels/builtin/friday-discord-channel-plugin.ts`
24. `src/plugins/channels/builtin/friday-telegram-channel-plugin.ts`
25. `src/api/model/friday-api-plugin.types.ts`
26. `src/api/http/routes/friday-plugin-routes.ts`
27. `src/api/http/routes/friday-marketplace-plugin-routes.ts`
28. `src/state/sqlite/migrations/v008-plugin-system-foundation.ts`
29. `src/state/sqlite/migrations/index.ts` (append V008)
30. `src/api/model/friday-api-auth.types.ts` (new plugin scopes)
31. `src/api/runtime/friday-api-runtime.types.ts` (plugin runtime dep)
32. `src/api/runtime/friday-api-runtime.ts` (register plugin routes)
33. `src/config/friday-config.types.ts` (plugin settings)
34. `src/config/friday-config.schema.ts` (plugin defaults/validation)
35. `package.json` (`#plugins` import alias)

---

### 9. Test Plan

Unit:

- `friday-plugin-manifest.schema.test.ts`: required fields, kind/entrypoint matching, semver dependency format.
- `friday-plugin-discovery-service.test.ts`: local scan, marketplace merge, dedup precedence.
- `friday-plugin-dependency-resolver.test.ts`: valid DAG, missing dep, semver mismatch, cycle detection.
- `friday-plugin-signature-verifier.test.ts`: Ed25519 pass/fail, key pinning, local trust-on-install.
- `friday-plugin-loader.test.ts`: dynamic import load/unload, lifecycle callback ordering.
- `friday-channel-session-bridge.test.ts`: inbound/outbound session persistence behavior.

Persistence/migration:

- `friday-v008-plugin-system-schema.test.ts`: table/index creation.
- repository tests for plugin/dependency/version/source/cache repos.

API:

- `friday-plugin-routes.test.ts` and `friday-marketplace-plugin-routes.test.ts` for validation, scope checks, error mapping.

Integration:

- Marketplace install with transitive dependencies.
- Local unsigned plugin install (approved), restart fingerprint check.
- Core channel plugins loaded as bundled and non-uninstallable.
- Skill/provider plugin registration interoperability with existing `#skills` and `#providers`.

---

### 10. Adapted From Clawdbot

Patterns adapted:

- Manifest/discovery/registry split from Clawdbot plugin SDK (`plugins/manifest.d.ts`, `plugins/discovery.d.ts`, `plugins/manifest-registry.d.ts`, `plugins/registry.d.ts`).
- Central runtime registration API pattern from `plugins/types.d.ts`.
- Channel plugin typed interface approach from `channels/plugins/types.plugin.d.ts` and `types.adapters.d.ts`.
- Hook registration model from `plugins/hooks.d.ts`.

Friday-specific changes:

- `friday.plugin.json` replaces `openclaw.plugin.json`.
- Required `kinds[]`, `dependencies`, and manifest-level `signature`.
- SQLite-backed plugin metadata and dependency graph.
- Enforced marketplace signature verification with Ed25519.
- Local trust-on-install fingerprint model.
- Core channel reservation (`discord`, `telegram`) with bundled implementation.