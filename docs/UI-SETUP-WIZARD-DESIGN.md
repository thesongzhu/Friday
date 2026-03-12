# Friday Web Setup Wizard: Implementation Blueprint

> Designed by CX (gpt-5.3-codex), 2026-02-19

## Assumptions
1. This blueprint is based on the architecture provided (router, API client, existing endpoints/components).
2. `RequireAuth` remains required for `/setup` because setup contains secrets.
3. Wizard completion must be persisted independently of provider count, otherwise "Skip provider" causes a redirect loop.

## 1) Product Flow

1. `Step 0: Welcome` (`required`)
2. `Step 1: Security Notice` (`required`, must acknowledge)
3. `Step 2: Provider Setup` (`optional`, skippable)
4. `Step 3: Network Access` (`required`)
5. `Step 4: Channel Setup` (`optional`, skippable)
6. `Step 5: Skills` (`optional`, skippable)
7. `Step 6: Done` (`required`, finalize + enter app)

## 2) Backend API Spec

### POST /v1/providers/detect

Purpose: provider inference + normalized config + model discovery + validation signal.

```ts
type ProviderKind = "openai" | "anthropic" | "google" | "ollama" | "openai-compatible";
type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";
type AuthMode = "api-key" | "bearer-token" | "oauth" | "none";

interface DetectProviderRequest {
  apiKey?: string;         // optional for ollama
  kind?: ProviderKind;     // optional; overrides pattern inference
  baseUrl?: string;        // required for openai-compatible custom host
  authMode?: AuthMode;     // optional override for custom providers
}

interface DetectProviderResponse {
  kind: ProviderKind;
  confidence: "high" | "medium" | "low";
  baseUrl: string;
  api: ProviderApi;
  authMode: AuthMode;
  availableModels: string[];
  defaultModel?: string;
  validated: boolean;
  latencyMs?: number;
  warnings: string[];
}
```

Response behavior:
- `200` with `validated=true/false` for non-fatal validation result.
- `400` malformed request (missing key for key-required provider).
- `401` invalid credentials.
- `422` unreachable endpoint / invalid base URL.
- `429` upstream rate limit.
- `500` internal error.

### GET /v1/setup/status

Purpose: one query that drives route redirect and step prefills.

```ts
interface SetupStatusResponse {
  needsSetup: boolean;                 // true on first-run until setup complete
  setupCompletedAt: string | null;     // ISO timestamp
  providerCount: number;
  channelCount: number;
  skillsCount: number;
  network: {
    host: string;                      // e.g. 127.0.0.1 or 0.0.0.0
    port: number;                      // e.g. 3141
    mode: "local" | "network" | "custom";
    previewUrls: string[];             // includes localhost + LAN candidates
  };
}
```

Redirect rule:
1. `needsSetup === true` and path != `/setup` => redirect to `/setup`.
2. `/setup` always accessible (for rerun), even when `needsSetup === false`.

### GET /v1/setup/network

Purpose: read persisted bind config + preview URLs.

### POST /v1/setup/network

Purpose: write host/port.

```ts
interface SetupNetworkRequest {
  mode: "local" | "network" | "custom";
  host?: string;      // required for custom mode
  port: number;       // 1-65535
}

interface SetupNetworkResponse {
  host: string;
  port: number;
  mode: "local" | "network" | "custom";
  previewUrls: string[];
  restartRequired: boolean; // true if bind settings applied on next process restart
}
```

### POST /v1/setup/channels

Purpose: minimal channel onboarding write in one call.

```ts
type ChannelKind = "discord" | "telegram" | "slack" | "whatsapp";

interface SetupChannelConfig {
  kind: ChannelKind;
  enabled: boolean;
  config: Record<string, string>; // encrypted at rest server-side
}

interface SetupChannelsRequest {
  channels: SetupChannelConfig[];
}

interface SetupChannelsResponse {
  savedKinds: ChannelKind[];
}
```

### POST /v1/setup/complete

Purpose: persist wizard completion even if provider/channel/skills skipped.

```ts
type SetupStepId = "welcome" | "security" | "provider" | "network" | "channels" | "skills" | "done";

interface SetupCompleteRequest {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
}

interface SetupCompleteResponse {
  setupCompletedAt: string;
}
```

## 3) Provider Auto-Detection Logic

Detection priority:
1. If `kind` provided by UI, trust it.
2. Else if no key and baseUrl is local Ollama (`localhost:11434` or `127.0.0.1:11434`), use `ollama`.
3. API key pattern:
   - `^sk-ant-` => `anthropic`
   - `^sk-` => `openai`
   - `^AI` or `^AIza` => `google`
4. Fallback => `openai-compatible` with explicit `baseUrl` required.

Preset mapping:
1. `openai` => `baseUrl=https://api.openai.com`, `api=openai-responses`, `authMode=bearer-token`
2. `anthropic` => `baseUrl=https://api.anthropic.com`, `api=anthropic-messages`, `authMode=api-key`
3. `google` => `baseUrl=https://generativelanguage.googleapis.com`, `api=google-generative-ai`, `authMode=api-key`
4. `ollama` => `baseUrl=http://localhost:11434`, `api=ollama`, `authMode=none`
5. `openai-compatible` => `baseUrl` user-provided, `api=openai-responses` default, `authMode=bearer-token` default

## 4) Model Fetching Logic

### OpenAI
1. `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`.
2. Keep chat-capable IDs (`gpt-*`, `o1*`, `o3*`, `o4*`), drop obvious non-chat families.
3. Sort with preferred order list, then alpha.
4. Choose first preferred present as `defaultModel`.

### Anthropic
1. Use maintained server constant list:
   - `claude-opus-4`
   - `claude-sonnet-4`
   - `claude-haiku-3.5`
2. Validate key using a minimal cheap request to Anthropic API (backend controlled).
3. Default `claude-sonnet-4` when available.

### Google
1. `GET https://generativelanguage.googleapis.com/v1beta/models?key=<key>`.
2. Keep models supporting `generateContent`.
3. Normalize `models/gemini-...` => `gemini-...`.
4. Default newest stable Gemini model present.

### Ollama
1. `GET <baseUrl>/api/tags`.
2. Map `models[].name`.
3. Default first installed model.

### OpenAI-compatible
1. `GET <baseUrl>/v1/models`.
2. No strict filtering; return all IDs.
3. Default first model.

## 5) Frontend File Plan

### New files (17)
1. `ui/src/routes/setup-page.tsx`
2. `ui/src/hooks/use-setup.ts`
3. `ui/src/lib/api/setup.ts`
4. `ui/src/components/setup/setup-shell.tsx`
5. `ui/src/components/setup/setup-progress.tsx`
6. `ui/src/components/setup/setup-footer-nav.tsx`
7. `ui/src/components/setup/step-welcome.tsx`
8. `ui/src/components/setup/step-security.tsx`
9. `ui/src/components/setup/step-provider.tsx`
10. `ui/src/components/setup/provider-kind-cards.tsx`
11. `ui/src/components/setup/provider-detect-panel.tsx`
12. `ui/src/components/setup/step-network.tsx`
13. `ui/src/components/setup/step-channels.tsx`
14. `ui/src/components/setup/channel-card.tsx`
15. `ui/src/components/setup/step-skills.tsx`
16. `ui/src/components/setup/step-done.tsx`
17. `ui/src/components/setup/types.ts`

### Modified files (2)
1. `ui/src/router.tsx` (add `/setup`, add setup redirect guard)
2. `ui/src/routes/settings-page.tsx` (add "Re-run Setup" entry/button)

### Component hierarchy
```
SetupPage
  └─ SetupShell
       ├─ SetupProgress (step dots / progress bar)
       ├─ CurrentStepComponent (one of step-*.tsx)
       └─ SetupFooterNav (Back / Next / Skip buttons)
```

## 6) TypeScript Interfaces (Frontend)

```ts
// ui/src/components/setup/types.ts
export type SetupStepId = "welcome" | "security" | "provider" | "network" | "channels" | "skills" | "done";
export type ProviderKind = "openai" | "anthropic" | "google" | "ollama" | "openai-compatible";
export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";
export type AuthMode = "api-key" | "bearer-token" | "oauth" | "none";
export type ChannelKind = "discord" | "telegram" | "slack" | "whatsapp";

export interface ProviderDraft {
  kind: ProviderKind | null;
  name: string;
  apiKey: string;
  baseUrl: string;
  api: ProviderApi | null;
  authMode: AuthMode | null;
  availableModels: string[];
  defaultModel: string;
  validated: boolean;
  detecting: boolean;
  error?: string;
}

export interface NetworkDraft {
  mode: "local" | "network" | "custom";
  host: string;
  port: number;
  previewUrls: string[];
  restartRequired?: boolean;
}

export interface ChannelDraft {
  kind: ChannelKind;
  enabled: boolean;
  expanded: boolean;
  config: Record<string, string>;
}

export interface SkillsDraft {
  aiSkillGeneratorEnabled: boolean;
  importOpenClaw: boolean;
  importN8n: boolean;
  importGptActions: boolean;
}

export interface SetupWizardState {
  currentStep: SetupStepId;
  acknowledgedSecurity: boolean;
  provider: ProviderDraft;
  network: NetworkDraft;
  channels: ChannelDraft[];
  skills: SkillsDraft;
  skippedSteps: SetupStepId[];
}
```

### Component Signatures

```ts
export interface SetupShellProps {
  currentStep: SetupStepId;
  canGoBack: boolean;
  canGoNext: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
  children: React.ReactNode;
}

export interface StepSecurityProps {
  acknowledged: boolean;
  onAcknowledgeChange: (value: boolean) => void;
}

export interface StepProviderProps {
  value: ProviderDraft;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onDetect: () => Promise<void>;
  onValidate: () => Promise<void>;
}

export interface StepNetworkProps {
  value: NetworkDraft;
  onChange: (patch: Partial<NetworkDraft>) => void;
  onSave: () => Promise<void>;
}

export interface StepChannelsProps {
  value: ChannelDraft[];
  onToggle: (kind: ChannelKind, enabled: boolean) => void;
  onExpand: (kind: ChannelKind, expanded: boolean) => void;
  onConfigChange: (kind: ChannelKind, key: string, value: string) => void;
}

export interface StepDoneProps {
  summary: {
    provider?: { kind: ProviderKind; model: string };
    network: { host: string; port: number; mode: string };
    channelsConnected: ChannelKind[];
    skillsSelections: string[];
  };
  onEnterFriday: () => Promise<void>;
}
```

## 7) Hook + API Client Pattern

### ui/src/lib/api/setup.ts
1. `getSetupStatus()`
2. `detectProvider(req)`
3. `getSetupNetwork()`
4. `saveSetupNetwork(req)`
5. `saveSetupChannels(req)`
6. `completeSetup(req)`

Use existing `apiClient.get/post/put` and JWT handling.

### ui/src/hooks/use-setup.ts
1. `useSetupStatusQuery` (`queryKey: ["setup","status"]`)
2. `useDetectProviderMutation`
3. `useSaveNetworkMutation`
4. `useSaveChannelsMutation`
5. `useCompleteSetupMutation`
6. `useSetupWizardReducer` for local step state

## 8) Router + First-Visit Redirect

Add `/setup` route under `RequireAuth`.

Add `SetupGate` logic (inside auth-protected tree):
1. Fetch `/v1/setup/status`.
2. If loading, show full-page loader.
3. If `needsSetup` and current path is not `/setup`, `Navigate("/setup", { replace: true })`.
4. If path is `/setup` and user clicks "Enter Friday", call `completeSetup`, invalidate setup status query, then navigate `/`.

Settings rerun:
1. Add button/link to `/setup?mode=rerun`.
2. Rerun mode does not force completion reset; it just reopens wizard and allows updating values.

## 9) Step Behavior Details

### Step 2 Provider
1. Choose provider card.
2. Enter API key (except Ollama).
3. Click `Detect & Load Models`.
4. Show auto-filled read-only `baseUrl`, `api`, `authMode` (editable only for custom).
5. Choose default model from real fetched list.
6. `Validate` reruns detect call and requires `validated=true`.
7. On step continue, call existing `POST /v1/providers`, then `PUT /v1/model-routing`.

### Step 3 Network
1. Radio cards: `Local only` (`127.0.0.1`) and `Network access` (`0.0.0.0`) plus `Custom`.
2. Editable port input (default `3141`).
3. Live URL preview from backend.
4. Save via `/v1/setup/network`.

### Step 4 Channels
1. Icon cards for Discord/Telegram/Slack/WhatsApp.
2. Expand card for minimal secrets.
3. Prominent `Skip for now`.
4. Save only enabled cards.

### Step 5 Skills
1. Three option cards (AI generator, import tools, marketplace soon).
2. Mostly preference capture for now.
3. Prominent `Skip for now`.

### Step 6 Done
1. Summary card.
2. `Enter Friday` calls `/v1/setup/complete`.
3. Navigate into app.

## 10) Mobile and Visual Rules

1. Layout container `max-w-3xl mx-auto px-4 sm:px-6`.
2. Use `min-h-dvh` and sticky footer nav for thumb reach.
3. Progress indicator uses compact dots on mobile, labels on `sm+`.
4. Card-first UI, no dense forms.
5. Colors follow WOM tokens: navy structure, coral action accents, warm background.
6. Keep optional-step skip action visible on every optional step.

## 11) Implementation Order

1. Backend: setup persistence + `GET /v1/setup/status`
2. Backend: `POST /v1/providers/detect` with provider inference + model fetch adapters
3. Backend: `GET/POST /v1/setup/network`
4. Backend: `POST /v1/setup/channels` + `POST /v1/setup/complete`
5. Frontend: API module `ui/src/lib/api/setup.ts`
6. Frontend: `use-setup.ts` hook + query keys/mutations
7. Frontend: `/setup` route + `SetupGate` redirect in `ui/src/router.tsx`
8. Frontend: `SetupShell`, progress, footer nav
9. Frontend: Build steps in order: Welcome, Security, Provider, Network, Channels, Skills, Done
10. Frontend: Wire provider creation + model-routing on provider step continue
11. Frontend: Add Settings "Re-run Setup"
12. QA: Desktop/mobile, skip paths, reload mid-flow behavior
