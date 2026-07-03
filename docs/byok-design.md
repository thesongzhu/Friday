````markdown
# Friday BYOK (Bring Your Own Key) v1 Design

Design-only document. No code changes were made.

Assumption for v1: single local user context (no multi-tenant), with globally configured providers.

## 1. Data model

### TypeScript types

```ts
export type FridayProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "openai-compatible";

export type FridayProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";

export type FridayProviderAuthMode = "api-key" | "bearer-token" | "none";

export type FridayProviderKeySource =
  | { kind: "secret-ref"; refKey: string }   // encrypted in secrets table
  | { kind: "env-ref"; envVar: string }      // e.g. OPENAI_API_KEY
  | { kind: "none" };                        // ollama/local no key

export interface FridayProviderValidationState {
  status: "never" | "ok" | "failed";
  checkedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  httpStatus?: number;
}

export interface FridayProviderConfigJson {
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  keySource: FridayProviderKeySource;
  supportedModels: string[];
  headers?: Record<string, string>;
  validation?: FridayProviderValidationState;
}

export interface FridayProviderProfile {
  id: string;
  kind: FridayProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  defaultModel?: string;
  config: FridayProviderConfigJson;
  createdAt: string;
  updatedAt: string;
}

export interface FridayModelRoutingConfig {
  defaultProviderId: string;
  defaultModel?: string;
  fallbackProviderIds: string[]; // ordered
}

export interface FridayProviderAttempt {
  providerId: string;
  providerKind: FridayProviderKind;
  model: string;
  error?: string;
}

export interface FridayResolvedProviderRoute {
  provider: FridayProviderProfile;
  model: string;
}
```

### SQLite schema (DB-authority)

New SQLite tables required for v1: **none**.

Reuse existing tables from `./src/state/sqlite/migrations/v001-initial.ts:16`, `./src/state/sqlite/migrations/v001-initial.ts:421`, and `./src/state/sqlite/migrations/v001-initial.ts:433`.

| Table | Usage in BYOK v1 |
|---|---|
| `provider_profiles` | Registry metadata: `kind`, `display_name`, `endpoint_url`, `enabled`, `default_model`, and `config_json` (typed by `FridayProviderConfigJson`). |
| `secrets` | Encrypted key material only for `keySource.kind="secret-ref"`, with `scope='provider'`, `ref_key='provider:<providerId>:apiKey'`. |
| `hub_settings` | Routing config stored as key-value JSON: key `llm.routing.v1`, value typed by `FridayModelRoutingConfig`. |

## 2. Service interface — `FridayProviderService`

```ts
export interface FridayProviderService {
  listProviders(): Promise<FridayProviderProfile[]>;
  getProvider(providerId: string): Promise<FridayProviderProfile | null>;

  createProvider(input: {
    kind: FridayProviderKind;
    name: string;
    baseUrl: string;
    authMode: FridayProviderAuthMode;
    api: FridayProviderApi;
    apiKey?: string; // raw key or "$ENV_VAR"
    supportedModels: string[];
    defaultModel?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    validateOnSave?: boolean; // default true
  }): Promise<FridayProviderProfile>;

  updateProvider(
    providerId: string,
    patch: {
      name?: string;
      baseUrl?: string;
      authMode?: FridayProviderAuthMode;
      api?: FridayProviderApi;
      apiKey?: string; // raw key or "$ENV_VAR"
      supportedModels?: string[];
      defaultModel?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      validateOnSave?: boolean; // default true when auth/baseUrl/model changed
    },
  ): Promise<FridayProviderProfile>;

  deleteProvider(providerId: string): Promise<void>;

  validateProvider(providerId: string): Promise<FridayProviderValidationState>;

  getRoutingConfig(): Promise<FridayModelRoutingConfig>;
  setRoutingConfig(input: FridayModelRoutingConfig): Promise<FridayModelRoutingConfig>;

  resolveRoute(requestedModel?: string): Promise<FridayResolvedProviderRoute>;

  runWithFallback<T>(params: {
    requestedModel?: string;
    run: (route: FridayResolvedProviderRoute, credential: string | null) => Promise<T>;
  }): Promise<{ result: T; route: FridayResolvedProviderRoute; attempts: FridayProviderAttempt[] }>;
}
```

Behavior rules:
1. `apiKey="$OPENAI_API_KEY"` is stored as env-ref only, not as secret value.
2. Raw key values are encrypted before persistence.
3. Save/update performs live validation call unless `validateOnSave=false`.
4. Validation errors are structured (`PROVIDER_ENV_VAR_MISSING`, `PROVIDER_AUTH_INVALID`, `PROVIDER_UNREACHABLE`, `PROVIDER_MODEL_UNAVAILABLE`).
5. Fallback is ordered by `defaultProviderId` + `fallbackProviderIds`, deduped, and stops on first success.

## 3. API endpoints

All BYOK routes follow existing route pattern in `./src/api/http/routes/friday-*.ts` and are registered from `./src/api/runtime/friday-api-runtime.ts:149`.

| Method | Route | Scope | Request | Response |
|---|---|---|---|---|
| `GET` | `/v1/providers` | `hub.admin` | none | `{ items: FridayProviderProfile[] }` (no decrypted keys) |
| `GET` | `/v1/providers/:providerId` | `hub.admin` | none | `{ provider: FridayProviderProfile }` |
| `POST` | `/v1/providers` | `hub.admin` | create payload (supports `apiKey` raw or `$ENV_VAR`) | `{ provider, validation }` |
| `PATCH` | `/v1/providers/:providerId` | `hub.admin` | partial patch | `{ provider, validation? }` |
| `DELETE` | `/v1/providers/:providerId` | `hub.admin` | none | `{ deleted: true }` |
| `POST` | `/v1/providers/:providerId/validate` | `hub.admin` | none | `{ validation }` |
| `GET` | `/v1/model-routing` | `hub.admin` | none | `{ routing: FridayModelRoutingConfig }` |
| `PUT` | `/v1/model-routing` | `hub.admin` | `{ defaultProviderId, defaultModel?, fallbackProviderIds[] }` | `{ routing }` |

Validation-on-save behavior:
- `POST/PATCH` validates before commit by default.
- If validation fails, return 4xx with clear machine code + message.

## 4. Clawdbot reuse map

Attribution for retained reference files lives in `docs/clawdbot-reference/NOTICE.md`.

| Clawdbot source | Reuse | Friday adaptation |
|---|---|---|
| `<openclaw-repo>/src/config/zod-schema.core.ts:35-70` and `<openclaw-repo>/src/config/zod-schema.core.ts:84-91` | `ModelDefinitionSchema`, `ModelProviderSchema`, `ModelsConfigSchema` structure. | Keep field shapes (`baseUrl`, `auth`, `models`, `api`) but persist in SQLite row + `config_json` instead of file config tree. |
| `<openclaw-repo>/src/config/zod-schema.agent-runtime.ts:173-199` | BYOK pattern from `ToolsWebSearchSchema`: optional top-level provider fields plus provider-specific credentials. | Use same contract style for provider DTOs (`apiKey` raw/env-ref and per-provider options), but enforce at service/API layer, not config files. |
| `<openclaw-repo>/src/config/defaults.ts:14-26` and `<openclaw-repo>/src/config/defaults.ts:96-106` | Alias map + alias resolution (`gpt`, `sonnet`, etc.). | Add lightweight alias resolver in provider routing service for model hints. No global config mutation pass. |
| `<openclaw-repo>/src/config/defaults.ts:172-292` | Model normalization defaults (context, max tokens, alias attachment). | Reuse normalization idea only for provider-supported model metadata if needed; keep v1 minimal (id list + default model). |
| `<openclaw-repo>/src/agents/model-fallback.ts:37-54`, `<openclaw-repo>/src/agents/model-fallback.ts:130-207`, `<openclaw-repo>/src/agents/model-fallback.ts:209-321` | Candidate-chain resolution, dedupe, attempts array, summary error. | Keep chain + attempts logic. Remove auth-profile cooldown and allowlist complexity for v1. |

Write fresh in Friday:
- SQLite repositories for `provider_profiles` and `secrets`.
- Key encryption/decryption service.
- Provider-specific live validators.
- API route + runtime wiring.

## 5. Integration points

1. SQLite authority stays in state runtime initialized by `./src/state/index.ts:50`; provider service uses `stateRuntime.sqlite`.
2. BYOK registry persists in existing `provider_profiles` and `secrets` defined in `./src/state/sqlite/migrations/v001-initial.ts:421` and `./src/state/sqlite/migrations/v001-initial.ts:433`.
3. Routing config is stored in `hub_settings` from `./src/state/sqlite/migrations/v001-initial.ts:16` under key `llm.routing.v1`.
4. Hub bootstrap in `./src/hub/friday-hub-bootstrap.ts:106` creates `FridayProviderService` after state init and injects it into execution paths.
5. Workflow AI nodes already funnel through `invokeSkill("ai-inference", ...)` at `./src/workflows/engine/friday-workflow-node-executor.ts:183`; that handler should call provider routing + fallback.
6. API runtime route wiring follows existing registration style in `./src/api/runtime/friday-api-runtime.ts:152`; add provider routes there.
7. Skill executor gets model config by calling `providerService.resolveRoute(modelHint)` when handling `ai-inference` requests, then executing via `runWithFallback`.

## 6. Security (key encryption approach)

1. Encrypt raw API keys before DB write using AES-256-GCM envelope encryption.
2. Store only ciphertext envelope in `secrets.encrypted_value`; store active key id in `secrets.key_id`.
3. Decrypt only in-memory at call time; never return decrypted keys from API.
4. Support env-ref keys (`$OPENAI_API_KEY`) by storing only env var name; no secret row needed for that provider.
5. Redact key-like strings from logs and error messages.
6. Validate key material with short timeout and no prompt/content persistence.
7. Keep encryption master key outside SQLite (env var such as `FRIDAY_MASTER_KEY`, with file fallback only if explicitly enabled).

## 7. File plan

### New files to create

- `src/providers/index.ts`
- `src/providers/model/friday-provider.types.ts`
- `src/providers/persistence/friday-provider-profile-repository.ts`
- `src/providers/persistence/friday-secret-repository.ts`
- `src/providers/security/friday-secret-crypto.ts`
- `src/providers/validation/friday-provider-validator.ts`
- `src/providers/routing/friday-provider-fallback.ts`
- `src/providers/services/friday-provider-service.types.ts`
- `src/providers/services/friday-provider-service.ts`
- `src/api/model/friday-api-provider.types.ts`
- `src/api/http/routes/friday-provider-routes.ts`

### Existing files to modify

- `package.json` (add `#providers` import alias)
- `src/api/index.ts` (export provider API types/surfaces)
- `src/api/runtime/friday-api-runtime.types.ts` (add provider-service dependency/runtime surface)
- `src/api/runtime/friday-api-runtime.ts` (register BYOK routes and wire service)
- `src/hub/friday-hub-bootstrap.ts` (construct and inject provider service)
- `src/skills/executor/friday-skill-executor.types.ts` (inject provider routing dependency for AI path)
- `src/skills/executor/friday-skill-executor.ts` (handle `ai-inference` via provider service + fallback)

Migration note:
- v1 BYOK can ship with **no new migration file** because required tables already exist in v001.
````
