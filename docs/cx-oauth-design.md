**Target Design**
Anthropic OAuth fits Friday best as a new provider auth mode (`"oauth"`) backed by a new SQLite table (`oauth_credentials`) plus lazy refresh at credential resolution time in `runWithFallback`.

`./src/providers/persistence/friday-provider-repository.ts` does not exist in this repo; equivalent integration should be done via `src/providers/persistence/friday-provider-profile-repository.ts` (no major schema change there) and the new OAuth store file.

**1) Database Schema (`oauth_credentials`)**
Add migration `src/state/sqlite/migrations/v010-provider-oauth-credentials.ts`:

```sql
CREATE TABLE IF NOT EXISTS oauth_credentials (
  id TEXT PRIMARY KEY,
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  oauth_provider TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider_profile_id, oauth_provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_provider_profile
  ON oauth_credentials(provider_profile_id);

CREATE INDEX IF NOT EXISTS idx_oauth_credentials_expires_at
  ON oauth_credentials(expires_at);
```

Store `access_token` and `refresh_token` encrypted using existing envelope crypto (`encryptSecret`/`decryptSecret` from `src/providers/security/friday-secret-crypto.ts`).

**2) Type Definitions (full TS for this feature)**

`src/providers/model/friday-provider.types.ts` (additions/changes):
```ts
export type FridayProviderAuthMode = "api-key" | "bearer-token" | "oauth" | "none";

export type FridayOAuthProviderId = "anthropic";

export interface FridayOAuthAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  scopes: string[];
}

export interface FridayOAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: string;
  scope: string;
}

export interface FridayOAuthCredential {
  id: string;
  providerProfileId: string;
  oauthProvider: FridayOAuthProviderId;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridayOAuthCredentialRow {
  id: string;
  provider_profile_id: string;
  oauth_provider: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_type: string;
  scope: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface FridayOAuthLoginInitiation extends FridayOAuthAuthorizationRequest {
  providerId: string;
  oauthProvider: FridayOAuthProviderId;
}

export interface FridayOAuthLoginResult {
  providerId: string;
  oauthProvider: FridayOAuthProviderId;
  connected: true;
  expiresAt: string;
  tokenType: string;
  scope: string;
}

export interface FridayProviderConfigJson {
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  oauthProvider?: FridayOAuthProviderId;
  keySource: FridayProviderKeySource;
  supportedModels: string[];
  headers?: Record<string, string>;
  validation?: FridayProviderValidationState;
}
```

`src/providers/services/friday-provider-service.types.ts` (additions/changes):
```ts
export interface FridayProviderService {
  // existing methods...
  initiateOAuthLogin(input: {
    providerId: string;
  }): Promise<FridayOAuthLoginInitiation>;

  completeOAuthLogin(input: {
    providerId: string;
    authorizationCode: string; // supports `code#state`
    state?: string; // optional override
  }): Promise<FridayOAuthLoginResult>;
}

export interface CreateFridayProviderServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}
```

`src/api/model/friday-api-provider.types.ts` (additions):
```ts
export interface FridayInitiateAnthropicOAuthRequest {
  providerId: string;
}

export interface FridayInitiateAnthropicOAuthResponse {
  oauth: FridayOAuthLoginInitiation;
}

export interface FridayCompleteAnthropicOAuthCallbackRequest {
  providerId: string;
  authorizationCode: string;
  state?: string;
}

export interface FridayCompleteAnthropicOAuthCallbackResponse {
  oauth: FridayOAuthLoginResult;
}
```

**3) New Function Signatures with JSDoc**

`src/providers/oauth/friday-anthropic-oauth.ts`:
```ts
export const FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const FRIDAY_ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

export interface FridayPkcePair {
  verifier: string;
  challenge: string;
}

export interface FridayAnthropicAuthorizationCodeParts {
  code: string;
  state: string;
}

export interface FridayOAuthProviderAdapter {
  readonly id: FridayOAuthProviderId;
  readonly displayName: string;
  /** Builds the OAuth authorize URL (PKCE S256). */
  initiateAuthorization(): Promise<FridayOAuthAuthorizationRequest>;
  /** Exchanges an auth code for access/refresh tokens. */
  exchangeAuthorizationCode(input: {
    authorizationCode: string;
    state?: string;
    codeVerifier?: string;
  }): Promise<FridayOAuthTokenSet>;
  /** Refreshes an expired/expiring token set. */
  refreshAccessToken(refreshToken: string): Promise<FridayOAuthTokenSet>;
}

export interface CreateFridayAnthropicOAuthDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/** Parses Anthropic pasted code in `code#state` format. */
export function parseFridayAnthropicAuthorizationCode(
  rawAuthorizationCode: string,
): FridayAnthropicAuthorizationCodeParts;

/** Creates Anthropic OAuth adapter with initiate/exchange/refresh support. */
export function createFridayAnthropicOAuthProvider(
  deps?: CreateFridayAnthropicOAuthDeps,
): FridayOAuthProviderAdapter;
```

`src/providers/oauth/friday-oauth-credential-store.ts`:
```ts
export interface FridayOAuthCredentialStore {
  /** Reads and decrypts OAuth credentials for a provider profile. */
  getByProviderProfileId(providerProfileId: string): FridayOAuthCredential | null;
  /** Inserts or updates OAuth credentials for a provider profile. */
  upsert(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
    tokenSet: FridayOAuthTokenSet;
  }): FridayOAuthCredential;
  /** Deletes OAuth credentials bound to a provider profile. */
  deleteByProviderProfileId(providerProfileId: string): boolean;
}

export interface CreateFridayOAuthCredentialStoreDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

/** Creates SQLite-backed OAuth credential storage with envelope encryption. */
export function createFridayOAuthCredentialStore(
  deps: CreateFridayOAuthCredentialStoreDeps,
): FridayOAuthCredentialStore;
```

`src/providers/oauth/friday-oauth-token-manager.ts`:
```ts
export interface FridayOAuthProviderRegistry {
  /** Returns provider adapter by id or null when missing. */
  get(providerId: FridayOAuthProviderId): FridayOAuthProviderAdapter | null;
  /** Registers/overwrites an OAuth provider adapter. */
  register(provider: FridayOAuthProviderAdapter): void;
  /** Lists all registered OAuth adapters. */
  list(): FridayOAuthProviderAdapter[];
}

/** Creates in-memory OAuth provider registry for extensibility. */
export function createFridayOAuthProviderRegistry(
  providers?: readonly FridayOAuthProviderAdapter[],
): FridayOAuthProviderRegistry;

export interface FridayOAuthTokenManager {
  /** Stores token set after successful login callback exchange. */
  saveTokenSet(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
    tokenSet: FridayOAuthTokenSet;
  }): FridayOAuthCredential;
  /** Resolves valid access token; refreshes and persists if near expiry. */
  getValidAccessToken(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
  }): Promise<string | null>;
  /** Deletes stored OAuth credentials for provider profile. */
  clear(providerProfileId: string): boolean;
}

export interface CreateFridayOAuthTokenManagerDeps {
  credentialStore: FridayOAuthCredentialStore;
  providerRegistry: FridayOAuthProviderRegistry;
  nowMs?: () => number;
}

/** Creates lazy-refresh token manager with single-flight refresh per provider profile. */
export function createFridayOAuthTokenManager(
  deps: CreateFridayOAuthTokenManagerDeps,
): FridayOAuthTokenManager;
```

`src/cli/friday-cli-auth.ts`:
```ts
export interface FridayCliAuthCommandInput {
  providerId?: string;
  code?: string;
  noBrowser?: boolean;
}

export interface FridayCliAuthCommandDeps {
  providerService: FridayProviderService;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

/** Runs `friday auth login anthropic` CLI flow end-to-end. */
export async function runFridayCliAuthLoginAnthropic(
  input: FridayCliAuthCommandInput,
  deps: FridayCliAuthCommandDeps,
): Promise<void>;
```

`src/providers/services/friday-provider-service.ts` (new public methods):
```ts
/** Starts OAuth login by generating Anthropic authorization URL for a provider profile. */
async function initiateOAuthLogin(input: { providerId: string }): Promise<FridayOAuthLoginInitiation>;

/** Completes OAuth login by exchanging code and persisting tokens, then validating provider auth. */
async function completeOAuthLogin(input: {
  providerId: string;
  authorizationCode: string;
  state?: string;
}): Promise<FridayOAuthLoginResult>;
```

**4) CLI Command Flow**

`friday auth login anthropic [--provider-id <id>] [--code "<code#state>"] [--no-browser]`

1. Start hub and resolve provider service.
2. Resolve target provider profile.
3. Call `providerService.initiateOAuthLogin`.
4. Open browser unless `--no-browser`; always print URL.
5. Prompt user for pasted auth code if `--code` missing.
6. Call `providerService.completeOAuthLogin`.
7. Print success (`providerId`, expiry).
8. Stop hub.

Provider resolution rule:
1. If `--provider-id` supplied, use it.
2. Else find enabled providers where `kind === "anthropic"` and `config.authMode === "oauth"`.
3. If exactly one, use it.
4. Otherwise fail with explicit IDs to avoid accidental token binding.

**5) API Endpoint Specs**

Add to `src/api/http/routes/friday-provider-routes.ts`:

1. `POST /v1/auth/oauth/anthropic/initiate`
Body:
```json
{ "providerId": "prov_123" }
```
Response:
```json
{
  "oauth": {
    "providerId": "prov_123",
    "oauthProvider": "anthropic",
    "authorizationUrl": "https://claude.ai/oauth/authorize?...",
    "state": "<pkce_verifier>",
    "codeVerifier": "<pkce_verifier>",
    "scopes": ["org:create_api_key", "user:profile", "user:inference"]
  }
}
```

2. `POST /v1/auth/oauth/anthropic/callback`
Body:
```json
{
  "providerId": "prov_123",
  "authorizationCode": "<code>#<state>"
}
```
Response:
```json
{
  "oauth": {
    "providerId": "prov_123",
    "oauthProvider": "anthropic",
    "connected": true,
    "expiresAt": "2026-02-19T20:10:00.000Z",
    "tokenType": "Bearer",
    "scope": "org:create_api_key user:profile user:inference"
  }
}
```

Auth/scope:
`{ public: false, anyOfScopes: ["hub.admin"] }` for both routes.

**6) Provider Service Integration**

1. `src/providers/services/friday-provider-service.ts` now creates:
`createFridayAnthropicOAuthProvider`, `createFridayOAuthCredentialStore`, `createFridayOAuthProviderRegistry`, `createFridayOAuthTokenManager`.
2. `resolveCredential` becomes async and branches on `authMode`.
3. For `authMode: "oauth"`, get token via token manager.
4. `runWithFallback` uses awaited credential resolution, so refresh happens lazily at execution time.
5. `deleteProvider` clears OAuth credentials for that provider profile.
6. `createProvider`/`updateProvider` with `authMode: "oauth"` force `keySource: { kind: "none" }`.
7. `VALID_AUTH_MODES` in route validation includes `"oauth"`.

No changes needed in `src/skills/generator/llm/friday-provider-inference-client.ts` because it already consumes `providerService.runWithFallback`.

**7) File-by-File Breakdown**

New files:
1. `src/providers/oauth/friday-anthropic-oauth.ts`
2. `src/providers/oauth/friday-oauth-credential-store.ts`
3. `src/providers/oauth/friday-oauth-token-manager.ts`
4. `src/providers/oauth/index.ts`
5. `src/cli/friday-cli-auth.ts`
6. `src/state/sqlite/migrations/v010-provider-oauth-credentials.ts` (required for table)

Modified files:
1. `src/providers/model/friday-provider.types.ts`
2. `src/providers/services/friday-provider-service.types.ts`
3. `src/providers/services/friday-provider-service.ts`
4. `src/providers/index.ts` (export oauth module)
5. `src/api/model/friday-api-provider.types.ts`
6. `src/api/http/routes/friday-provider-routes.ts`
7. `src/cli/friday-cli.ts`
8. `src/cli/index.ts`
9. `src/state/sqlite/migrations/index.ts`
10. `test/unit/cli/friday-cli.test.ts`
11. `test/unit/providers/services/friday-provider-service.test.ts`
12. `test/unit/providers/api/friday-provider-routes.test.ts`
13. `test/integration/state/sqlite/friday-migration-chain.test.ts`

**8) Test Plan**

1. Unit OAuth adapter tests in `test/unit/providers/oauth/friday-anthropic-oauth.test.ts`.
2. Unit credential store tests in `test/unit/providers/oauth/friday-oauth-credential-store.test.ts`.
3. Unit token manager tests in `test/unit/providers/oauth/friday-oauth-token-manager.test.ts`.
4. Provider service tests for oauth resolution/refresh/fallback in `test/unit/providers/services/friday-provider-service.test.ts`.
5. Provider route tests for new endpoints and authMode validation in `test/unit/providers/api/friday-provider-routes.test.ts`.
6. CLI parse/flow tests for `auth login anthropic` in `test/unit/cli/friday-cli.test.ts`.
7. Migration chain test updated for v010 in `test/integration/state/sqlite/friday-migration-chain.test.ts`.

If you want, I can turn this directly into a patch-ready implementation plan ordered by commit (migration first, oauth core, service integration, routes, CLI, tests).