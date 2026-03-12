# Prompt Cache + Cost Routing Design

Design scope: two provider-layer subsystems only.

## 1) Type Definitions

### 1.1 Context, compaction, and prompt caching (`src/providers/model/friday-provider-context.types.ts`)

```ts
import type { FridayProviderApi, FridayProviderKind } from "#providers";

export type FridayProviderContextRole =
  | "system"
  | "user"
  | "assistant"
  | "tool-result";

export interface FridayProviderContextMessage {
  messageId: string;
  role: FridayProviderContextRole;
  content: string;
  createdAt: string;
  toolName?: string;
}

export interface FridayInferenceSessionContext {
  sessionId: string;
  specSummary: string;
  messages: FridayProviderContextMessage[];
}

export interface FridayContextCompactionSummary {
  summaryText: string;
  decisions: string[];
  todos: string[];
  openQuestions: string[];
  toolFailures: string[];
  fileOperations: string[];
}

export interface FridayContextCompactionResult {
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptMessages: FridayProviderContextMessage[];
  droppedMessages: FridayProviderContextMessage[];
  prunedMessageCount: number;
  summary?: FridayContextCompactionSummary;
}

export interface FridayPromptCacheHints {
  api: FridayProviderApi;
  providerKind: FridayProviderKind;
  anthropic: {
    enabled: boolean;
    systemCache: boolean;
    userStaticBlockIndexes: number[];
  };
  openaiSystemCache: {
    enabled: boolean;
  };
}

export interface FridayContextOptimizationResult {
  systemPrompt: string;
  userPrompt: string;
  estimatedInputTokens: number;
  compaction: FridayContextCompactionResult;
  cacheHints: FridayPromptCacheHints;
}
```

### 1.2 Cost, usage, budget, and routing (`src/providers/model/friday-provider-cost.types.ts`)

```ts
import type {
  FridayProviderApi,
  FridayProviderKind,
  FridayResolvedProviderRoute,
} from "#providers";

export type FridayTaskComplexity = "simple" | "medium" | "complex";

export type FridayProviderRouteStrategy =
  | "configured"
  | "cost_auto"
  | "budget_downgrade"
  | "budget_local_only";

export type FridayBudgetState = "ok" | "near_limit" | "over_limit";

export type FridayModelQualityTier = "cheap" | "balanced" | "best";

export interface FridayProviderNormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface FridayProviderModelPricing {
  providerKind: FridayProviderKind;
  modelPattern: string;
  qualityTier: FridayModelQualityTier;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cacheReadPer1MUsd: number;
  cacheWritePer1MUsd: number;
}

export interface FridayProviderPricingOverride {
  providerKind: FridayProviderKind;
  model: string;
  pricing: FridayProviderModelPricing;
}

export interface FridayLlmBudgetConfig {
  monthlyLimitUsd: number;
}

export interface FridayLlmBudgetStatus {
  month: string; // YYYY-MM
  config: FridayLlmBudgetConfig | null;
  spentUsd: number;
  remainingUsd: number | null;
  state: FridayBudgetState;
}

export interface FridayCostRoutingDecision {
  strategy: FridayProviderRouteStrategy;
  complexity: FridayTaskComplexity;
  budgetState: FridayBudgetState;
  estimatedInputTokens: number;
  orderedCandidates: FridayResolvedProviderRoute[];
  reason: string;
}

export interface FridayLlmUsageRecord {
  id: string;
  occurredAt: string;
  usageDay: string; // YYYY-MM-DD
  usageMonth: string; // YYYY-MM
  providerId: string;
  providerKind: FridayProviderKind;
  providerApi: FridayProviderApi;
  model: string;
  routeStrategy: FridayProviderRouteStrategy;
  taskComplexity: FridayTaskComplexity;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  currency: "USD";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FridayProviderUsageSummaryRow {
  day?: string;
  providerId?: string;
  model?: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface FridayProviderUsageSummary {
  from: string;
  to: string;
  groupBy: "day" | "provider" | "model";
  rows: FridayProviderUsageSummaryRow[];
  totals: {
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}
```

## 2) Service Interfaces

### 2.1 New provider-layer services

```ts
import type {
  FridayCostRoutingDecision,
  FridayInferenceSessionContext,
  FridayLlmBudgetConfig,
  FridayLlmBudgetStatus,
  FridayLlmUsageRecord,
  FridayProviderNormalizedUsage,
  FridayProviderUsageSummary,
  FridayTaskComplexity,
  FridayContextOptimizationResult,
} from "#providers";
import type {
  FridayProviderApi,
  FridayProviderProfile,
  FridayResolvedProviderRoute,
} from "#providers";

export interface FridayProviderTokenEstimator {
  estimateTextTokens(text: string): number;
  estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number;
}

export interface FridayProviderContextOptimizer {
  optimize(params: {
    provider: FridayProviderProfile;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    sessionContext?: FridayInferenceSessionContext;
    summarize: (prompt: { system: string; user: string }) => Promise<string>;
  }): Promise<FridayContextOptimizationResult>;
}

export interface FridayProviderPromptCacheAdapter {
  applyAnthropicCacheHints(params: {
    systemPrompt: string;
    userPrompt: string;
    hints: FridayContextOptimizationResult["cacheHints"];
  }): {
    systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
    userBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
    extraHeaders: Record<string, string>;
  };
}

export interface FridayProviderComplexityClassifier {
  classify(params: {
    systemPrompt: string;
    userPrompt: string;
    estimatedInputTokens: number;
  }): FridayTaskComplexity;
}

export interface FridayProviderPricingCatalog {
  getPricing(providerKind: FridayProviderKind, model: string): {
    inputPer1MUsd: number;
    outputPer1MUsd: number;
    cacheReadPer1MUsd: number;
    cacheWritePer1MUsd: number;
    qualityTier: "cheap" | "balanced" | "best";
  };
}

export interface FridayProviderCostRouter {
  planRoutes(params: {
    candidates: FridayResolvedProviderRoute[];
    estimatedInputTokens: number;
    complexity: FridayTaskComplexity;
    budget: FridayLlmBudgetStatus;
  }): FridayCostRoutingDecision;
}

export interface FridayProviderUsageRepository {
  insert(db: import("better-sqlite3").Database, record: FridayLlmUsageRecord): void;
  sumCostForMonth(db: import("better-sqlite3").Database, usageMonth: string): number;
  querySummary(db: import("better-sqlite3").Database, params: {
    from: string;
    to: string;
    groupBy: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): FridayProviderUsageSummary;
}

export interface FridayProviderUsageService {
  normalizeUsage(api: FridayProviderApi, responseBody: Record<string, unknown>): FridayProviderNormalizedUsage;
  calculateCost(params: {
    providerKind: FridayProviderKind;
    model: string;
    usage: FridayProviderNormalizedUsage;
  }): number;
  recordUsage(input: {
    providerId: string;
    providerKind: FridayProviderKind;
    providerApi: FridayProviderApi;
    model: string;
    routeStrategy: "configured" | "cost_auto" | "budget_downgrade" | "budget_local_only";
    taskComplexity: FridayTaskComplexity;
    usage: FridayProviderNormalizedUsage;
    costUsd: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  getUsageSummary(input: {
    from: string;
    to: string;
    groupBy: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): Promise<FridayProviderUsageSummary>;
}

export interface FridayProviderBudgetService {
  getBudgetConfig(): Promise<FridayLlmBudgetConfig | null>;
  setBudgetConfig(input: FridayLlmBudgetConfig): Promise<FridayLlmBudgetConfig>;
  getBudgetStatus(nowIso?: string): Promise<FridayLlmBudgetStatus>;
}
```

### 2.2 `FridayProviderService` interface extension

```ts
export interface FridayProviderService {
  // existing methods unchanged...

  runWithFallback<T>(params: {
    requestedModel?: string;
    routingContext?: {
      estimatedInputTokens: number;
      complexity: "simple" | "medium" | "complex";
    };
    run: (
      route: FridayResolvedProviderRoute,
      credential: string | null,
    ) => Promise<T>;
  }): Promise<{
    result: T;
    route: FridayResolvedProviderRoute;
    attempts: FridayProviderAttempt[];
    routingDecision: FridayCostRoutingDecision;
  }>;

  recordUsage(input: {
    providerId: string;
    providerApi: FridayProviderApi;
    model: string;
    routeStrategy: FridayProviderRouteStrategy;
    taskComplexity: FridayTaskComplexity;
    usage: FridayProviderNormalizedUsage;
    costUsd: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  getUsageSummary(input: {
    from: string;
    to: string;
    groupBy: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): Promise<FridayProviderUsageSummary>;

  getBudgetStatus(): Promise<FridayLlmBudgetStatus>;
  setBudgetConfig(input: FridayLlmBudgetConfig): Promise<FridayLlmBudgetConfig>;
}
```

## 3) Integration Points

1. `src/skills/generator/services/friday-skill-generator-service.ts`
- Pass `sessionContext` into `llm.infer(...)` for requirements turns.
- Keep session logic unchanged; no compaction logic is added here.

2. `src/skills/generator/llm/friday-provider-inference-client.types.ts`
- Extend `FridayInferenceRequest` with `sessionContext?: FridayInferenceSessionContext`.
- Extend `FridayInferenceResult` with `usage`, `costUsd`, and `routeStrategy`.

3. `src/skills/generator/llm/friday-provider-inference-client.ts`
- Before provider call:
  - Run `FridayProviderContextOptimizer.optimize(...)`.
  - Classify complexity using hardcoded heuristics.
  - Pass `routingContext` into `providerService.runWithFallback(...)`.
- Per API request assembly:
  - `openai-completions`: no explicit cache params; preserve stable system prompt.
  - `openai-responses`: no explicit cache params; preserve stable system prompt.
  - `anthropic-messages`: convert system/user text to content blocks and apply `cache_control` to system + detected static user blocks; set beta header.
  - `google-generative-ai`: no-op caching behavior.
  - `ollama`: no-op caching behavior.
- After provider response:
  - Normalize usage across response shapes.
  - Compute USD cost via pricing catalog.
  - Persist via `providerService.recordUsage(...)`.

4. `src/providers/services/friday-provider-service.ts`
- Keep provider CRUD/routing config behavior.
- Extend fallback path with cost-aware candidate ordering when `requestedModel` is absent.
- Apply budget policy before first attempt:
  - `near_limit`: auto-downgrade to cheaper candidates.
  - `over_limit`: allow only free/local candidates (`ollama`); else throw `FridayDomainError("LLM_BUDGET_EXCEEDED", ...)`.
- Keep existing fallback attempts array and key-redacted errors.

5. `src/providers/routing/friday-provider-fallback.ts`
- Keep resolve/dedupe logic.
- Add cooldown-aware candidate skip (hardcoded cooldown window) for transient failures/rate limits.

6. `src/api/http/routes/friday-provider-routes.ts`
- Add usage/budget endpoints under `/v1/providers/usage` and `/v1/providers/budget`.
- Validate bodies/queries with `FridayDomainError("VALIDATION_ERROR", ...)`.

7. `src/state/sqlite/migrations/*`
- Add v003 migration for `llm_usage_records`.
- Add migration export into ordered list.

## 4) SQLite Schema

### 4.1 New table: `llm_usage_records`

```sql
CREATE TABLE IF NOT EXISTS llm_usage_records (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  usage_day TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_api TEXT NOT NULL,
  model TEXT NOT NULL,
  route_strategy TEXT NOT NULL CHECK (
    route_strategy IN ('configured', 'cost_auto', 'budget_downgrade', 'budget_local_only')
  ),
  task_complexity TEXT NOT NULL CHECK (
    task_complexity IN ('simple', 'medium', 'complex')
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_day
  ON llm_usage_records(usage_day);

CREATE INDEX IF NOT EXISTS idx_llm_usage_month
  ON llm_usage_records(usage_month);

CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_day
  ON llm_usage_records(provider_id, usage_day);

CREATE INDEX IF NOT EXISTS idx_llm_usage_model_day
  ON llm_usage_records(model, usage_day);
```

### 4.2 `hub_settings` key

- Key: `llm.budget.v1`
- Value JSON:

```json
{
  "monthlyLimitUsd": 50
}
```

Rules:
- This is the only user-configurable value for cost routing.
- Missing key means no enforced monthly budget.

## 5) API Endpoints

### 5.1 Usage dashboard

- `GET /v1/providers/usage`
- Scope: `hub.admin`
- Query:
  - `from` (required, `YYYY-MM-DD`)
  - `to` (required, `YYYY-MM-DD`)
  - `groupBy` (optional, `day | provider | model`, default `day`)
  - `providerId` (optional)
  - `model` (optional)
- Response:

```json
{
  "summary": {
    "from": "2026-02-01",
    "to": "2026-02-29",
    "groupBy": "day",
    "rows": [
      {
        "day": "2026-02-17",
        "callCount": 28,
        "inputTokens": 182233,
        "outputTokens": 26901,
        "cacheReadTokens": 52000,
        "cacheWriteTokens": 10000,
        "totalTokens": 271134,
        "costUsd": 2.74
      }
    ],
    "totals": {
      "callCount": 28,
      "inputTokens": 182233,
      "outputTokens": 26901,
      "cacheReadTokens": 52000,
      "cacheWriteTokens": 10000,
      "totalTokens": 271134,
      "costUsd": 2.74
    }
  }
}
```

### 5.2 Budget status

- `GET /v1/providers/budget`
- Scope: `hub.admin`
- Response:

```json
{
  "budget": {
    "month": "2026-02",
    "config": { "monthlyLimitUsd": 50 },
    "spentUsd": 41.2,
    "remainingUsd": 8.8,
    "state": "near_limit"
  }
}
```

### 5.3 Budget update

- `PUT /v1/providers/budget`
- Scope: `hub.admin`
- Request:

```json
{
  "monthlyLimitUsd": 75
}
```

- Response:

```json
{
  "budget": {
    "monthlyLimitUsd": 75
  }
}
```

Validation failures use `FridayDomainError("VALIDATION_ERROR", ...)`.

## 6) File Plan

### 6.1 New files

- `src/providers/model/friday-provider-context.types.ts`
- `src/providers/model/friday-provider-cost.types.ts`
- `src/providers/context/friday-provider-token-estimator.ts`
- `src/providers/context/friday-provider-context-pruner.ts`
- `src/providers/context/friday-provider-context-compactor.ts`
- `src/providers/context/friday-provider-prompt-cache.ts`
- `src/providers/cost/friday-provider-complexity-classifier.ts`
- `src/providers/cost/friday-provider-pricing-catalog.ts`
- `src/providers/cost/friday-provider-cost-router.ts`
- `src/providers/cost/friday-provider-budget-service.ts`
- `src/providers/cost/friday-provider-usage-normalizer.ts`
- `src/providers/cost/friday-provider-cost-calculator.ts`
- `src/providers/persistence/friday-provider-usage-repository.ts`
- `src/state/sqlite/migrations/v003-provider-usage-cost-routing.ts`

### 6.2 Files to modify

- `src/providers/index.ts`
- `src/providers/model/friday-provider.types.ts`
- `src/providers/routing/friday-provider-fallback.ts`
- `src/providers/services/friday-provider-service.types.ts`
- `src/providers/services/friday-provider-service.ts`
- `src/skills/generator/llm/friday-provider-inference-client.types.ts`
- `src/skills/generator/llm/friday-provider-inference-client.ts`
- `src/skills/generator/services/friday-skill-generator-service.ts`
- `src/api/model/friday-api-provider.types.ts`
- `src/api/http/routes/friday-provider-routes.ts`
- `src/state/sqlite/migrations/index.ts`

## 7) Hardcoded Constants (Values)

```ts
// ─── Context + caching ───
export const FRIDAY_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const FRIDAY_TOKEN_ESTIMATE_MESSAGE_OVERHEAD = 8;

export const FRIDAY_CONTEXT_COMPACTION_TRIGGER_RATIO = 0.70;
export const FRIDAY_CONTEXT_KEEP_RECENT_TURNS = 8;
export const FRIDAY_CONTEXT_SUMMARY_MAX_TOKENS = 1_200;

export const FRIDAY_CONTEXT_PRUNE_STALE_TURN_DISTANCE = 6;
export const FRIDAY_CONTEXT_PRUNE_LARGE_CONTENT_CHARS = 12_000;
export const FRIDAY_CONTEXT_PRUNE_RETAIN_HEAD_CHARS = 2_000;
export const FRIDAY_CONTEXT_PRUNE_RETAIN_TAIL_CHARS = 1_000;

export const FRIDAY_ANTHROPIC_CACHE_MIN_STATIC_CHARS = 800;
export const FRIDAY_ANTHROPIC_CACHE_RETENTION: "short" = "short";
export const FRIDAY_ANTHROPIC_CACHE_BETA_HEADER = "prompt-caching-2024-07-31";

export const FRIDAY_DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
export const FRIDAY_CONTEXT_WINDOW_BY_PROVIDER: Record<FridayProviderKind, number> = {
  openai: 128_000,
  anthropic: 200_000,
  google: 131_072,
  ollama: 16_384,
  "openai-compatible": 32_768,
};

// ─── Cost routing + budget ───
export const FRIDAY_LLM_BUDGET_SETTINGS_KEY = "llm.budget.v1";
export const FRIDAY_LLM_USAGE_TABLE = "llm_usage_records";
export const FRIDAY_USAGE_CURRENCY = "USD";

export const FRIDAY_BUDGET_NEAR_LIMIT_RATIO = 0.80;
export const FRIDAY_BUDGET_HARD_LIMIT_RATIO = 1.00;

export const FRIDAY_PROVIDER_COOLDOWN_MS = 120_000;

export const FRIDAY_COMPLEXITY_SIMPLE_MAX_TOKENS = 900;
export const FRIDAY_COMPLEXITY_COMPLEX_MIN_TOKENS = 4_000;
export const FRIDAY_COMPLEXITY_COMPLEX_KEYWORDS = [
  "multi-file",
  "refactor",
  "architecture",
  "migration",
  "security",
  "validator",
  "schema",
  "workflow",
  "async",
  "error handling",
];

export const FRIDAY_ROUTE_SCORE_WEIGHTS = {
  simple: { cost: 1.0, quality: 0.0 },
  medium: { cost: 0.60, quality: 0.40 },
  complex: { cost: 0.20, quality: 0.80 },
} as const;

// ─── Default pricing table (USD per 1M tokens) ───
export const FRIDAY_DEFAULT_MODEL_PRICING: FridayProviderModelPricing[] = [
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1",
    qualityTier: "best",
    inputPer1MUsd: 2.00,
    outputPer1MUsd: 8.00,
    cacheReadPer1MUsd: 0.50,
    cacheWritePer1MUsd: 2.00,
  },
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1-mini",
    qualityTier: "balanced",
    inputPer1MUsd: 0.40,
    outputPer1MUsd: 1.60,
    cacheReadPer1MUsd: 0.10,
    cacheWritePer1MUsd: 0.40,
  },
  {
    providerKind: "openai",
    modelPattern: "gpt-4.1-nano",
    qualityTier: "cheap",
    inputPer1MUsd: 0.10,
    outputPer1MUsd: 0.40,
    cacheReadPer1MUsd: 0.03,
    cacheWritePer1MUsd: 0.10,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-opus",
    qualityTier: "best",
    inputPer1MUsd: 15.00,
    outputPer1MUsd: 75.00,
    cacheReadPer1MUsd: 1.50,
    cacheWritePer1MUsd: 15.00,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-sonnet",
    qualityTier: "balanced",
    inputPer1MUsd: 3.00,
    outputPer1MUsd: 15.00,
    cacheReadPer1MUsd: 0.30,
    cacheWritePer1MUsd: 3.00,
  },
  {
    providerKind: "anthropic",
    modelPattern: "claude-haiku",
    qualityTier: "cheap",
    inputPer1MUsd: 0.80,
    outputPer1MUsd: 4.00,
    cacheReadPer1MUsd: 0.08,
    cacheWritePer1MUsd: 0.80,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.5-pro",
    qualityTier: "best",
    inputPer1MUsd: 1.25,
    outputPer1MUsd: 5.00,
    cacheReadPer1MUsd: 0.13,
    cacheWritePer1MUsd: 1.25,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.5-flash",
    qualityTier: "balanced",
    inputPer1MUsd: 0.30,
    outputPer1MUsd: 1.20,
    cacheReadPer1MUsd: 0.03,
    cacheWritePer1MUsd: 0.30,
  },
  {
    providerKind: "google",
    modelPattern: "gemini-2.0-flash-lite",
    qualityTier: "cheap",
    inputPer1MUsd: 0.08,
    outputPer1MUsd: 0.30,
    cacheReadPer1MUsd: 0.01,
    cacheWritePer1MUsd: 0.08,
  },
  {
    providerKind: "ollama",
    modelPattern: "*",
    qualityTier: "cheap",
    inputPer1MUsd: 0,
    outputPer1MUsd: 0,
    cacheReadPer1MUsd: 0,
    cacheWritePer1MUsd: 0,
  },
];
```

## Error Discipline

All new failures use `FridayDomainError` with stable codes. No raw `throw new Error`.

