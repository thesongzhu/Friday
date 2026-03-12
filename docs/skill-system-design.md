# Friday Skill System Design Specification

> **Version:** 2.1 — Unified Design (Cross-Document Audit Applied)  
> **Base:** Clawdbot source at `/opt/homebrew/lib/node_modules/clawdbot/`  
> **Scope:** Skill standard, three core skills, self-evolution architecture

---

## 0.1 Documentation Authority Matrix

This section defines which document is authoritative for each concept shared between `distributed-architecture.md` and `skill-system-design.md`. When the two documents cover the same topic, the authoritative document's definition takes precedence.

| Concept | Authoritative Doc | Reason |
| --- | --- | --- |
| Hub/satellite topology, transport, auth, deployment | `distributed-architecture.md` | System-level runtime architecture belongs in platform spec. |
| Runtime entity model and SQLite core schema | `distributed-architecture.md` | Single runtime DB/API contract must be centralized. |
| Skill package layout and legacy `SKILL.md` migration flow | `skill-system-design.md` | Authoring/discovery workflow is defined there with concrete migration steps. |
| Canonical skill manifest schema (post-merge) | `distributed-architecture.md` | Manifest is consumed by runtime, scheduler, marketplace, UI. |
| Manifest defaulting and legacy adapters | `skill-system-design.md` | This doc already defines loader/defaulting behavior in detail. |
| Manifest filename/versioning policy | `skill-system-design.md` | Loader, watcher, migration CLI behavior is already explicit there. |
| Skill invocation runtime (intent + workflow dual-mode) | `distributed-architecture.md` | Runtime dispatch semantics belong in execution architecture. |
| Permission canonical IR | `distributed-architecture.md` | Security enforcement must be owned by runtime/security model. |
| Workflow authoring DSL (`WorkflowSpecV1`) | `skill-system-design.md` | Builder skill and simulation contract are authoring-side. |
| Compiled workflow graph IR and scheduler contract | `distributed-architecture.md` | Executor/scheduler consumes compiled graph. |
| Workflow run statuses and lifecycle transitions | `distributed-architecture.md` | Status enums drive API/UI/runtime state machines. |
| Workflow version/run identity model | `distributed-architecture.md` | Immutable version pinning is storage/runtime concern. |
| Unified failure policy semantics | `distributed-architecture.md` | Execution behavior must be normalized where scheduling occurs. |
| DAG validation contract (including cycle detection) | `distributed-architecture.md` | Engine validation rules are runtime guarantees. |
| Learning data semantics (events/facts/incidents/autofix) | `skill-system-design.md` | Domain behavior and governance are specified there. |
| Learning/approval persistence DDL (post-merge) | `distributed-architecture.md` | Final DB schema authority must be singular. |
| Skill source taxonomy + precedence crosswalk | `skill-system-design.md` | Source precedence/discovery details already live there. |
| Trust tiers + sandbox execution modes | `distributed-architecture.md` | Enforcement and policy execution belong to runtime doc. |
| Unified implementation roadmap | `distributed-architecture.md` | Cross-team phase plan should be owned by platform roadmap. |
| Extension/plugin terminology glossary | `distributed-architecture.md` | Global naming standard should live in platform glossary. |
| Formatting standards for design docs | `distributed-architecture.md` | One style authority for all design specs. |

---

## 1. Clawdbot Architecture Analysis

### 1.1 Skills Subsystem

| Module | File | Role |
| --- | --- | --- |
| Skill loading + precedence | `src/agents/skills/workspace.ts` | Loads skills from multiple roots, merges by name with precedence: `extra < bundled < managed < personal .agents < project .agents < workspace`. |
| Frontmatter parsing | `src/agents/skills/frontmatter.ts` | Parses `SKILL.md` frontmatter including OpenClaw metadata (`requires`, `install`, `os`, `emoji`, `primaryEnv`, `skillKey`) and invocation flags. |
| Skill gating | `src/agents/skills/config.ts` | Filters skills based on config enable/disable, OS, binaries, env vars, and config-path requirements. |
| Extension skill injection | `src/agents/skills/plugin-skills.ts` | Adds skill directories advertised by extensions (`manifest.skills`) with extension enable/slot checks. |
| Runtime prompt injection | `src/agents/system-prompt.ts` | Injects an `<available_skills>` prompt block and a "read exactly one relevant SKILL.md" policy. |
| Hot refresh | `src/agents/skills/refresh.ts` | Watches `SKILL.md` files across all skill roots (including `extraDirs` and extension dirs) for snapshot refresh. Uses glob patterns (`<root>/SKILL.md` and `<root>/*/SKILL.md`) with conservative FD usage via chokidar. |
| Env overrides | `src/agents/skills/env-overrides.ts` | Mutates `process.env` with skill-specific env vars and `primaryEnv` API key injection from config. Returns a cleanup function to restore original values. **Security note:** global env mutation affects all concurrent operations; Friday should isolate env per-skill-run instead. |
| Bundled context | `src/agents/skills/bundled-context.ts` | Resolves and caches the set of bundled skill names from the bundled skills directory. Used for precedence resolution and availability checks. |
| Skill commands | `src/agents/skills/workspace.ts` | Generates user-invocable command specs from skill names with safe normalization/deduping and optional deterministic tool dispatch metadata. |
| Install flow | `src/agents/skills-install.ts` | Supports `brew/node/go/uv/download` installers with archive safety checks and code-scan warnings. |

### 1.2 Memory Subsystem

| Module | File | Role |
| --- | --- | --- |
| Manager selection | `src/memory/search-manager.ts`, `src/memory/backend-config.ts` | Chooses backend: builtin or QMD; wraps QMD with fallback to builtin on runtime failure. |
| Builtin index | `src/memory/manager.ts`, `src/memory/memory-schema.ts` | SQLite-based index with `files`, `chunks`, `meta`, `embedding_cache`; optional FTS5 + sqlite-vec vector table. |
| Sources | `src/memory/internal.ts`, `src/memory/sync-memory-files.ts`, `src/memory/sync-session-files.ts` | Indexes `MEMORY.md`, `memory/*.md`, optional extra paths, plus optional session transcript extraction. |
| Session extraction | `src/memory/session-files.ts` | Converts JSONL session transcripts into user/assistant text lines with source line mapping for citations. |
| Retrieval | `src/memory/manager-search.ts`, `src/memory/hybrid.ts` | Vector retrieval + keyword retrieval + weighted merge. |
| Embedding providers | `src/memory/embeddings*.ts` | OpenAI/Gemini/Voyage/local providers, configurable fallback provider. |
| Batch embeddings | `src/memory/manager-embedding-ops.ts`, `src/memory/batch-*.ts` | Batch mode with retry, timeout retry-once, failure counters, auto-disable to non-batch fallback. |
| QMD backend | `src/memory/qmd-manager.ts`, `src/memory/qmd-scope.ts` | CLI-backed retrieval/indexing with collection management, scoped access rules, and resilience paths. |

**Known issue:** `src/memory/manager-sync-ops.ts` references missing imports in `activateFallbackProvider()` (`createEmbeddingProvider`, default embedding model constants, `resolveAgentDir`) while the file is `@ts-nocheck`. This can cause runtime `ReferenceError` in fallback activation.

### 1.3 Extension Architecture

| Module | File | Role |
| --- | --- | --- |
| Discovery | `src/plugins/discovery.ts` | Discovers extension candidates from config paths, workspace `.openclaw/extensions`, global extensions dir, bundled dir. |
| Manifest | `src/plugins/manifest.ts`, `src/plugins/manifest-registry.ts` | Reads `openclaw.plugin.json` (`id`, `configSchema`, `kind`, `channels`, `providers`, `skills`) and enforces precedence. |
| Load + register | `src/plugins/loader.ts`, `src/plugins/registry.ts` | Loads extension module via `jiti`, validates config schema (AJV), registers tools/hooks/channels/providers/commands/http/services. |
| Runtime surface | `src/plugins/runtime/index.ts`, `src/plugins/runtime/types.ts` | Provides a large, typed runtime API to extension authors (messaging, channels, media, config IO, etc.). |
| Hook system | `src/plugins/hooks.ts`, `src/plugins/hook-runner-global.ts` | Typed lifecycle hooks with priority, safe execution, global singleton runner. |
| Install/update | `src/plugins/install.ts`, `src/plugins/update.ts` | Installs from npm/archive/dir/file with archive traversal safety + scanner warnings. |

> **Terminology note:** "Extension" is the user-facing distribution term. Internal code paths (`src/plugins/*`) and config keys (`openclaw.plugin.json`) retain "plugin" for backward compatibility. See Terminology Glossary in `distributed-architecture.md`.

### 1.4 Config System

| Module | File | Role |
| --- | --- | --- |
| Read path | `src/config/io.ts` | JSON5 parse, include resolution, env substitution, schema validation (with extension schemas), defaults application. |
| Write path | `src/config/io.ts` | Merge-patch style update, env-var reference restoration, backup rotation, write audit logging. |
| Validation | `src/config/validation.ts` | Base schema validation + extension-aware validation (extension ids, extension config schema, channel ids, heartbeat targets). |
| Dynamic schema | `src/config/schema.ts` | Builds schema/UI hints, merges extension and channel config schemas into control-surface schema. |
| Auto-enable extensions | `src/config/plugin-auto-enable.ts` | Enables channel/provider extensions when related config/auth indicates they should be active. |

### 1.5 Session Management

| Module | File | Role |
| --- | --- | --- |
| Session store | `src/config/sessions/store.ts` | JSON store per agent, cached reads, lock-protected updates, maintenance (prune/cap/rotate). |
| Session transcripts | `src/config/sessions/paths.ts`, `src/config/sessions/transcript.ts` | Per-session JSONL transcript path resolution with path containment checks and append helpers. |
| Session key handling | `src/config/sessions/session-key.ts`, `src/sessions/session-key-utils.ts` | Canonicalization of main/global/agent session keys; safe handling of subagent/thread keys. |
| Transcript events | `src/sessions/transcript-events.ts` | Emits transcript updates for memory/session sync listeners. |

### 1.6 Agent System / Orchestration

| Module | File | Role |
| --- | --- | --- |
| Embedded run loop | `src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/run/attempt.ts` | Main orchestration: model/auth resolution, prompt assembly, tool wiring, run attempts, retries/fallbacks. |
| Stream/event handling | `src/agents/pi-embedded-subscribe*.ts` | Streams assistant/tool/lifecycle events, dedupes outputs, handles compaction wait conditions. |
| Run state + queue lanes | `src/agents/pi-embedded-runner/runs.ts`, `src/process/command-queue.ts` | Tracks active runs; serializes/parallelizes by command lanes; supports wait/abort. |
| Subagents | `src/agents/tools/sessions-spawn-tool.ts`, `src/agents/subagent-registry.ts` | Spawns isolated subagent sessions, persists run registry, waits completion, announces results. |
| Cross-session messaging | `src/agents/tools/sessions-send-tool.ts`, `src/agents/tools/sessions-history-tool.ts` | A2A/session tools with policy gates, visibility controls, and payload sanitization. |

### 1.7 Error Handling + Self-Repair

| Module | File | Role |
| --- | --- | --- |
| Error classification | `src/agents/pi-embedded-helpers/errors.ts`, `src/agents/failover-error.ts` | Classifies billing/auth/rate-limit/timeout/context errors and maps failover reasons. |
| Compaction fallback | `src/agents/compaction.ts` | Multi-stage summarization fallback and history pruning with tool-use/tool-result repair. |
| Transcript repair | `src/agents/session-transcript-repair.ts` | Repairs invalid toolCall/toolResult pairing, inserts synthetic missing results when needed. |
| Tool-result guard | `src/agents/session-tool-result-guard.ts` | Enforces tool-result integrity on append and truncates oversized tool results before persistence. |
| File repair + lock | `src/agents/session-file-repair.ts`, `src/agents/session-write-lock.ts` | Repairs malformed JSONL lines and provides robust lock semantics with stale lock cleanup. |

### 1.8 Reuse / Avoid / Improve for Friday

**Reuse:**
1. Deterministic discovery + precedence + validation patterns (workspace.ts).
2. Append-only transcript + repair + locking model.
3. Typed hook lifecycle with safe runner.
4. Hybrid memory retrieval and source-scoped indexing.

**Avoid:**
1. `@ts-nocheck` in core reliability paths (memory fallback).
2. Global `process.env` mutation for runtime skill config (env-overrides.ts) — use scoped env instead.
3. Relying only on prompt convention for structured multi-step workflows.

**Improve:**
1. First-class state-machine skills with strict step contracts.
2. Strongly typed event ledger for learning and auto-fix.
3. Explicit risk-tiered auto-correction policy with rollback.

---

## 2. Friday Skill Standard

### 2.1 Skill Package Layout

```text
skill-id/
  skill.manifest.json          # required: structured metadata (schemaVersion: "2.0")
  SKILL.md                     # recommended: human-readable instructions + frontmatter
  src/index.ts                 # optional: runtime entrypoint (TS/JS)
  schemas/
    input.schema.json          # optional
    output.schema.json         # optional
    state.schema.json          # optional
  prompts/
    step-*.md                  # optional: per-step prompt templates
  references/                  # optional
  scripts/                     # optional
  assets/                      # optional
```

> **Note:** Filename is always `skill.manifest.json`; versioning is only via the `schemaVersion` field inside the file.

### 2.2 Migration Path: SKILL.md → Manifest System

The existing Clawdbot skill system uses `SKILL.md` with YAML frontmatter as the sole skill definition format. Friday introduces `skill.manifest.json` as the primary structured metadata source but **must maintain full backward compatibility** with existing `SKILL.md`-only skills.

#### 2.2.1 Phase 1: Dual-Load (v1.0)
- The skill loader checks for `skill.manifest.json` first; if absent, falls back to `SKILL.md` frontmatter parsing via the existing `parseFrontmatter()` function.
- A `legacyCompat` adapter converts a Clawdbot `SkillEntry` into the internal `SkillManifestV2` type at load time. This uses the **actual Clawdbot API** where:
  - `ParsedSkillFrontmatter` is `Record<string, string>` (flat key-value pairs from YAML frontmatter)
  - `OpenClawSkillMetadata` is resolved separately via `resolveOpenClawMetadata(frontmatter)` (from `frontmatter.ts`)
  - `SkillInvocationPolicy` is resolved separately via `resolveSkillInvocationPolicy(frontmatter)`
  - These three are combined in the `SkillEntry` type: `{ skill, frontmatter, metadata?, invocation? }`

  ```ts
  import type { SkillEntry, OpenClawSkillMetadata, SkillInvocationPolicy } from "clawdbot/agents/skills/types";
  import { resolveOpenClawMetadata, resolveSkillInvocationPolicy, resolveSkillKey } from "clawdbot/agents/skills/frontmatter";

  function skillEntryToManifest(entry: SkillEntry): SkillManifestV2 {
    const { skill, frontmatter } = entry;
    const metadata: OpenClawSkillMetadata | undefined = entry.metadata ?? resolveOpenClawMetadata(frontmatter);
    const invocation: SkillInvocationPolicy = entry.invocation ?? resolveSkillInvocationPolicy(frontmatter);
    const skillKey = resolveSkillKey(skill, entry);

    return {
      schemaVersion: "2.0",
      id: skillKey,
      name: skill.name,
      version: "0.0.0",
      description: skill.description ?? "",
      kind: "conversation",
      category: "utility",
      author: { name: "unknown" },
      tags: [],
      runtime: {
        kind: "builtin",
        entrypoint: "",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30000,
      },
      triggers: {
        intents: [],
        phrases: [],
        channels: ["*"],
      },
      invocation: {
        userInvocable: invocation.userInvocable,
        modelInvocable: !invocation.disableModelInvocation,
        priority: 50,
        modes: ["intent"],
      },
      requirements: {
        bins: metadata?.requires?.bins ?? [],
        env: metadata?.primaryEnv ? [metadata.primaryEnv] : [],
        config: metadata?.requires?.config ?? [],
        os: (metadata?.os as Array<"darwin" | "linux" | "win32">) ?? ["darwin", "linux", "win32"],
      },
      inputs: [],
      outputs: [],
      permissions: {
        grants: [
          { id: "legacy-tools", resource: "tool", action: "execute", required: false, reason: "Legacy skill — all tools" },
          { id: "legacy-memory", resource: "memory", action: "read", required: false, reason: "Legacy skill — memory read" },
        ],
        promptOn: [],
      },
      schemas: { input: null, state: null, output: null },
      flow: null,
      executionTargets: {
        allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
        requiredCapabilities: [],
      },
      telemetry: { events: [] },
    };
  }
  ```
- All existing skills continue to work without modification.

#### 2.2.2 Phase 2: Migration Tool (v1.1)
- `friday skills migrate <skill-dir>` generates `skill.manifest.json` from existing `SKILL.md` frontmatter.
- The tool produces a diff preview and requires confirmation before writing.
- Frontmatter metadata is preserved in `SKILL.md` for backward compatibility during the transition.

#### 2.2.3 Phase 3: Deprecation (v2.0)
- Frontmatter-only loading emits a deprecation warning at skill load time.
- `skill.manifest.json` becomes the required metadata source.
- `SKILL.md` remains recommended as the human-readable instruction document but is not required and no longer carries structured metadata. Skills without `SKILL.md` are fully valid; the file serves as optional documentation for human readers.

### 2.3 Manifest Format

The canonical `SkillManifestV2` TypeScript interface is defined in `distributed-architecture.md` §6.1 (the authoritative source for the manifest schema). Below is an example JSON instance:

```jsonc
{
  "schemaVersion": "2.0",
  "id": "onboarding",
  "name": "Onboarding Skill",
  "version": "1.0.0",
  "description": "Guided setup for new Friday users",
  "kind": "conversation",
  "category": "utility",
  "author": { "name": "Friday Team" },
  "tags": ["onboarding", "setup"],
  "runtime": {
    "kind": "node",
    "entrypoint": "./src/index.ts",
    "minHubVersion": "1.0.0",
    "apiVersion": "1",
    "timeoutMsDefault": 60000
  },
  "triggers": {
    "intents": ["onboard", "setup", "getting-started"],
    "phrases": ["set up friday", "help me start"],
    "channels": ["*"]
  },
  "invocation": {
    "userInvocable": true,
    "modelInvocable": true,
    "priority": 80,
    "modes": ["intent", "workflow"]
  },
  "requirements": {
    "bins": [],
    "env": [],
    "config": [],
    "os": ["darwin", "linux", "win32"]
  },
  "inputs": [
    {
      "key": "userId",
      "type": "string",
      "required": true,
      "label": "User ID"
    }
  ],
  "outputs": [
    {
      "key": "configPatch",
      "type": "object",
      "description": "Generated config patch"
    }
  ],
  "permissions": {
    "grants": [
      {
        "id": "mem-read",
        "resource": "memory",
        "action": "read",
        "required": true,
        "reason": "Read user preferences for personalization"
      },
      {
        "id": "mem-write",
        "resource": "memory",
        "action": "write",
        "required": true,
        "reason": "Store onboarding results"
      },
      {
        "id": "channel-send",
        "resource": "channel",
        "action": "send",
        "required": true,
        "reason": "Send messages to user"
      }
    ],
    "promptOn": ["channel.send"]
  },
  "schemas": {
    "input": "./schemas/input.schema.json",
    "state": "./schemas/state.schema.json",
    "output": "./schemas/output.schema.json"
  },
  "flow": {
    "startStep": "step_welcome",
    "steps": [
      {
        "id": "step_welcome",
        "type": "ask",
        "prompt": "./prompts/step-welcome.md",
        "collect": ["user_profile.name", "user_profile.experience_level"],
        "completion": {
          "requiredFields": ["user_profile.name", "user_profile.experience_level"],
          "minConfidence": 0.7
        },
        "transitions": {
          "onSuccess": "step_goals",
          "onFailure": null
        },
        "retry": { "maxAttempts": 3, "backoffMs": 1000 }
      }
    ]
  },
  "executionTargets": {
    "allowedSatelliteTypes": ["phone", "desktop", "rpi", "cloud-vm"],
    "requiredCapabilities": []
  },
  "telemetry": {
    "events": ["step_started", "step_completed", "validation_failed", "skill_completed"]
  }
}
```

#### 2.3.1 Filesystem Scope Validation

The `permissions.grants[].selectors.pathPrefixes` field accepts workspace-relative glob patterns. The runtime enforces:

1. All paths are resolved relative to the skill's parent directory or `${workspaceDir}`.
2. Path traversal (`../`) beyond the scope root is rejected.
3. Absolute paths are rejected unless they match an explicitly allowed prefix.
4. Validation occurs at manifest load time (static) and at runtime (dynamic, before each file operation).

```ts
import * as path from "path";
import * as fs from "fs";

/** Allowed root prefixes for filesystem scopes. Only paths under these roots are valid. */
const ALLOWED_SCOPE_ROOTS = (workspaceDir: string, skillDir: string): string[] => [
  fs.realpathSync(workspaceDir),
  fs.realpathSync(skillDir),
];

function validateFilesystemScope(scope: string, skillDir: string, workspaceDir: string): boolean {
  // 1. Reject absolute paths outright (must be relative or use ${workspaceDir})
  if (path.isAbsolute(scope) && !scope.startsWith("${workspaceDir}")) {
    return false;
  }

  // 2. Resolve variables and relative paths against skill directory (not CWD).
  const resolved = scope.startsWith("${workspaceDir}")
    ? scope.replace("${workspaceDir}", workspaceDir)
    : path.join(skillDir, scope);

  // 3. Canonicalize to real path (resolves symlinks and ../ traversals)
  const globStripped = resolved.replace(/[/*]+$/, "") || resolved;
  const resolvedPath = path.resolve(globStripped);

  let canonical: string;
  try {
    canonical = fs.realpathSync(resolvedPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      canonical = resolvedPath;
    } else {
      return false;
    }
  }

  // 4. Verify containment using path.relative
  const allowedRoots = ALLOWED_SCOPE_ROOTS(workspaceDir, skillDir);
  const isContained = allowedRoots.some((root) => {
    const rel = path.relative(root, canonical);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });

  return isContained;
}
```

**Security properties:**
- **Canonicalization** via `fs.realpathSync` on both scope roots AND target paths defeats path traversal (`../../etc/passwd`), symlink attacks, and double-encoding.
- **`path.relative` containment check** is safer than string `startsWith` because it handles edge cases like `/workspace-evil/` matching prefix `/workspace`.
- **Explicit allow-prefix list** limits scope roots to only the workspace and skill directories.

#### 2.3.2 Engine Compatibility

The `runtime` block enables version-gated loading:
- `minHubVersion`: Minimum Friday runtime version required (semver).
- `apiVersion`: Skill API contract version. Skills built against API v1 will not load in a v2 runtime without an explicit compatibility adapter.

At load time, the registry compares these fields against the running Friday version and rejects incompatible skills with a clear error message.

### 2.4 Minimal Authoring Mode

For first-time skill authors, the full manifest + schemas + flow graph is high friction. Friday provides a **minimal authoring mode**:

#### 2.4.1 Scaffold Generator

```bash
friday skills init <skill-name>
# Prompts: kind (conversation/workflow/system), description
# Generates:
#   <skill-name>/
#     skill.manifest.json   (minimal, with sensible defaults)
#     SKILL.md              (template with sections)
```

#### 2.4.2 Minimal Manifest (strong defaults)

A valid skill requires only:
```json
{
  "schemaVersion": "2.0",
  "id": "my-skill",
  "name": "My Skill",
  "version": "0.1.0",
  "description": "What this skill does",
  "kind": "conversation"
}
```

All other fields default to:
- `category`: `"utility"`
- `author`: `{ name: "unknown" }`
- `tags`: `[]`
- `runtime`: `{ kind: "builtin", entrypoint: "", minHubVersion: "1.0.0", apiVersion: "1", timeoutMsDefault: 30000 }`
- `triggers`: `{ intents: [], phrases: [], channels: ["*"] }`
- `invocation`: `{ userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] }`
- `requirements`: `{ bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] }`
- `inputs`: `[]`
- `outputs`: `[]`
- `permissions`: `{ grants: [], promptOn: [] }`
- `schemas`: `null` (no validation)
- `flow`: `null` (prompt-only, no state machine)
- `executionTargets`: `{ allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"], requiredCapabilities: [] }`
- `telemetry`: `{ events: [] }`

This means a beginner can create a skill with just `skill.manifest.json` (6 lines) and iterate from there. Adding a `SKILL.md` for human-readable documentation is recommended but not required.

#### 2.4.3 Manifest Defaulting / Normalization Stage

The minimal manifest above is valid because the skill loader applies a **defaulting/normalization stage before schema validation**. The load pipeline is:

1. **Read** — Parse `skill.manifest.json` from disk (raw JSON).
2. **Normalize + Apply Defaults** — Fill all omitted fields with their documented defaults (see table above). This transforms the minimal 6-field manifest into a fully-populated `SkillManifestV2` object.
3. **Schema Validate** — Validate the now-complete object against the `SkillManifestV2` type contract. Because defaults were applied in step 2, all required fields are present.
4. **Continue** — Proceed with filesystem scope validation, engine compatibility checks, etc.

```ts
function applyManifestDefaults(raw: Record<string, unknown>): SkillManifestV2 {
  return {
    schemaVersion: (raw.schemaVersion as string) ?? "2.0",
    id: raw.id as string,
    name: raw.name as string,
    version: raw.version as string,
    description: raw.description as string,
    kind: (raw.kind as SkillKind) ?? "conversation",
    category: (raw.category as SkillCategory) ?? "utility",
    author: (raw.author as SkillManifestV2["author"]) ?? { name: "unknown" },
    tags: (raw.tags as string[]) ?? [],
    runtime: (raw.runtime as SkillManifestV2["runtime"]) ?? {
      kind: "builtin", entrypoint: "", minHubVersion: "1.0.0", apiVersion: "1", timeoutMsDefault: 30000,
    },
    triggers: (raw.triggers as SkillManifestV2["triggers"]) ?? { intents: [], phrases: [], channels: ["*"] },
    invocation: (raw.invocation as SkillManifestV2["invocation"]) ?? {
      userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"],
    },
    requirements: (raw.requirements as SkillManifestV2["requirements"]) ?? {
      bins: [], env: [], config: [], os: ["darwin", "linux", "win32"],
    },
    inputs: (raw.inputs as SkillManifestV2["inputs"]) ?? [],
    outputs: (raw.outputs as SkillManifestV2["outputs"]) ?? [],
    permissions: (raw.permissions as PermissionPolicyV2) ?? { grants: [], promptOn: [] },
    schemas: (raw.schemas as SkillManifestV2["schemas"]) ?? null,
    flow: (raw.flow as SkillManifestV2["flow"]) ?? null,
    executionTargets: (raw.executionTargets as SkillManifestV2["executionTargets"]) ?? {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"], requiredCapabilities: [],
    },
    telemetry: (raw.telemetry as SkillManifestV2["telemetry"]) ?? { events: [] },
  };
}
```

This ensures there is no conflict between the minimal authoring surface (6 fields) and the full `SkillManifestV2` type contract — defaults bridge the gap.

### 2.5 Trust Tiers and Sandbox Model

Skills execute code via their `runtime.entrypoint`. Loading arbitrary code without trust boundaries is a supply-chain risk. Friday defines a two-axis trust model (see `distributed-architecture.md` §6.4 for the authoritative type definitions):

| Trust Tier | Default Execution Mode | Description |
| --- | --- | --- |
| **`bundled`** | `trusted` | Ships with Friday; runs in-process |
| **`managed`** | `restricted` (or `isolated` by policy) | Installed via `friday skills install` from registry; process-isolated with scoped access |
| **`workspace`** | `isolated` | User-created in workspace/`.agents`; process-isolated with code-scan warning on first load |
| **`extra`** | `isolated` | External/third-party; strictest isolation by default |

#### 2.5.1 Enforcement

1. **Entrypoint isolation:** Managed, workspace, and extra skill entrypoints are loaded in a child process (or worker thread with restricted `require`). They communicate with the skill engine via a typed message protocol (JSON-RPC over stdio/IPC).
2. **Filesystem enforcement:** The runtime intercepts file operations and validates against `permissions.grants[].selectors.pathPrefixes` before forwarding.
3. **Network enforcement:** If no `network/connect` grant exists in `permissions.grants`, outbound network calls from the entrypoint are blocked via the sandbox.
4. **First-load warning:** Workspace and extra skills with entrypoints trigger a one-time confirmation: "Skill `X` wants to run code. Allow?"

### 2.6 TypeScript Interfaces (Lifecycle + Engine)

The canonical `SkillManifestV2`, `PermissionPolicyV2`, and `SkillStepDefinition` types are defined in `distributed-architecture.md` §6.1 and §6.1.1. This section defines the runtime state and lifecycle contracts that are authoritative here.

```ts
// --- Runtime state ---

export type SkillRunStatus =
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type SkillRunState<TState> = {
  runId: string;
  skillId: string;
  version: string;
  status: SkillRunStatus;
  currentStepId: string;
  attemptsByStep: Record<string, number>;
  state: TState;
  startedAt: string;
  updatedAt: string;
};

// --- Lifecycle contexts ---

export type SkillInitContext<TInput> = {
  input: TInput;
  sessionId: string;
  userId: string;
  channel: string;
  nowIso: string;
};

export type ToolRequestItem = {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
};

export type ToolResultItem = {
  requestId: string;
  tool: string;
  ok: boolean;
  payload: unknown;
};

export type SkillExecuteContext<TInput, TState> = {
  input: TInput;
  run: SkillRunState<TState>;
  userMessage?: string;
  toolResults?: ToolResultItem[];
};

export type SkillExecutionResult<TState, TOutput> = {
  run: SkillRunState<TState>;
  messages: Array<{ role: "assistant" | "system"; text: string }>;
  requestedTools?: ToolRequestItem[];
  output?: TOutput;
};

export type SkillTeardownContext<TState> = {
  run: SkillRunState<TState>;
  reason: "completed" | "failed" | "cancelled";
};

export interface FridaySkill<TInput, TState, TOutput> {
  manifest: SkillManifestV2;
  init(ctx: SkillInitContext<TInput>): Promise<SkillRunState<TState>>;
  execute(ctx: SkillExecuteContext<TInput, TState>): Promise<SkillExecutionResult<TState, TOutput>>;
  teardown(ctx: SkillTeardownContext<TState>): Promise<void>;
}
```

### 2.7 Skill Registry Design

#### 2.7.1 Discovery Sources and Precedence

Preserving the existing Clawdbot precedence order (see `workspace.ts:171`):

```text
extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
```

Where:
- **extra**: `config.skills.load.extraDirs` + extension-advertised skill directories
- **bundled**: Ships with Friday
- **managed**: `~/.config/friday/skills/` (installed via `friday skills install`)
- **agents-skills-personal**: `~/.agents/skills/`
- **agents-skills-project**: `<workspaceDir>/.agents/skills/`
- **workspace**: `<workspaceDir>/skills/`

Higher precedence wins on name collision (same behavior as Clawdbot). This is preserved to avoid breaking user overrides. If precedence semantics change in the future, a migration guide must accompany the release.

**Source/origin crosswalk (see `distributed-architecture.md` §6.6 for authoritative types):**

| `SkillSource` | Default `SkillOrigin` | Notes |
| --- | --- | --- |
| `bundled` | `bundled` | Ships with Friday |
| `marketplace` | `managed` | Installed via registry |
| `git` | Depends on install location | Maps to personal/project/workspace/extra |
| `local` | Depends on install location | Maps to personal/project/workspace/extra |

**Rules:**
1. Collision winner is highest precedence `origin` (workspace > agents-skills-project > ... > extra).
2. `marketplace` installs default to `origin = "managed"`.
3. `local`/`git` sources may map to personal/project/workspace/extra origins depending on install location.

#### 2.7.2 Validation Pipeline

1. **Manifest defaulting + schema validation** — Apply defaults to fill omitted fields (see §2.4 "Manifest Defaulting / Normalization Stage"), then JSON Schema check against the fully-populated `SkillManifestV2` type.
2. **Required files check** — `skill.manifest.json` (or `SKILL.md` in legacy mode), plus all declared schema/prompt files. `SKILL.md` is checked only in legacy mode; in manifest mode it is recommended but not required.
3. **Step graph validation** (if `flow` is present):
   - `startStep` references an existing step ID.
   - All `transitions.onSuccess`/`onFailure` targets reference existing step IDs or are null.
   - No orphan steps (every non-start step is reachable from `startStep`).
   - At least one terminal path exists (a step whose `onSuccess` is `null` or `undefined`/omitted — both are terminal).
4. **Schema compilation** — Input/state/output JSON schemas are parsed and compiled (AJV).
5. **Engine compatibility** — `runtime.minHubVersion` checked against Friday runtime version; `runtime.apiVersion` checked against supported API versions.

#### 2.7.3 Activation

1. Requirement checks (`bins/env/config/os`) via existing `shouldIncludeSkill` logic.
2. Permission policy check (grants valid, filesystem scopes valid, network policy).
3. Trust tier verification (bundled/managed/workspace/extra).

#### 2.7.4 Runtime Load

1. Lazy-load entrypoint on first invocation (not at discovery time).
2. Cache by `skillId@version`.
3. Hot-reload via watcher on **all manifest-declared files**: `skill.manifest.json`, `SKILL.md`, all files referenced in `schemas.*`, `flow.steps[*].prompt`, and `runtime.entrypoint`.
4. On change: reload manifest → re-validate → atomically swap the cached skill snapshot.

#### 2.7.5 Registry API

```ts
interface SkillRegistry {
  list(): SkillManifestV2[];
  get(skillId: string): SkillManifestV2 | null;
  resolveByIntent(intent: string, context: SkillResolutionContext): SkillManifestV2 | null;
  validateAll(): ValidationResult[];
  reload(skillId: string): void;
  isCompatible(manifest: SkillManifestV2): CompatResult;
}
```

### 2.8 Data Flow: Friday Core ↔ Skills

1. `UserEvent` enters `Intent Router` OR `WorkflowAction` enters `Workflow Scheduler`.
2. **Intent mode:** `Skill Selector` chooses skill from registry using triggers + priority → `invokeByIntent`.
3. **Workflow mode:** Workflow scheduler dispatches to skill node → `invokeFromWorkflow` with run/node context.
4. `Skill Engine` loads/creates `SkillRunState`.
5. Engine executes one step turn:
   - Step may emit assistant messages to user.
   - Step may emit tool requests (with `requestId`).
   - Step may transition to next step.
   - Step may produce final `SkillOutput`.
6. If tool requests were emitted, engine dispatches them, collects `ToolResultItem[]` (matched by `requestId`), and re-enters `execute()`.
7. Engine persists state and emits telemetry event.
8. On completion, output is handed to the appropriate consumer:
   - Config output → Config Apply Pipeline
   - Workflow output → Workflow Engine
   - Learning output → Event Ledger
   - Display output → UI renderer

> **Note:** The dual-mode invocation contract (`SkillExecutor`) is defined in `distributed-architecture.md` §5.2.2.

---

## 3. Three Core Skills

### 3.1 Skill 1: Onboarding

#### 3.1.1 Goal
Produce a personalized, validated Friday configuration by understanding explicit goals and inferred intent.

#### 3.1.2 Input/Output Contracts

```ts
export type OnboardingInput = {
  userId: string;
  channel: string;
  isFirstRun: boolean;
};

export type OnboardingState = {
  profile: {
    name?: string;
    experienceLevel?: "beginner" | "intermediate" | "advanced";
    role?: string;
  };
  goals: Array<{ id: string; text: string; priority: 1 | 2 | 3 }>;
  workflowsToday: Array<{ name: string; steps: string[]; painPoints: string[] }>;
  constraints: {
    toolsAllowed: string[];
    budgetLevel?: "low" | "medium" | "high";
    privacyLevel?: "strict" | "balanced" | "flexible";
    timePerDayMinutes?: number;
  };
  inferredIntent?: {
    summary: string;
    successSignals: string[];
    confidence: number;
  };
};

export type OnboardingOutput = {
  configPatch: {
    agents?: {
      defaults?: {
        model?: { primary?: string; fallbacks?: string[] };
        userTimezone?: string;
        memorySearch?: { enabled?: boolean };
        contextPruning?: { mode?: "off" | "cache-ttl" };
        compaction?: { mode?: "default" | "safeguard" };
        thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      };
    };
    memory?: {
      backend?: "builtin" | "qmd";
      citations?: "auto" | "on" | "off";
    };
    session?: {
      scope?: "per-sender" | "global";
    };
    skills?: {
      entries?: Record<string, { enabled?: boolean }>;
    };
    tools?: {
      deny?: string[];
    };
    logging?: {
      level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    };
    ui?: {
      assistant?: {
        name?: string;
      };
    };
  };
  summaryForUser: string;
};
```

**Why this mapping matters:** Every key in `configPatch` corresponds to an actual path in `FridaySchema` (defined in `src/config/zod-schema.ts`). The patch is validated against the schema before application — no invented fields, no runtime surprises.

#### 3.1.3 Config Apply/Rollback Pipeline

When the user approves the onboarding output:

```ts
type ConfigApplyPipeline = {
  steps: [
    { action: "draft_patch"; input: OnboardingOutput["configPatch"]; output: "json_patch" },
    { action: "validate"; input: "json_patch"; validator: "FridaySchema.safeParse" },
    { action: "backup"; target: "config.json5"; backup: "config.json5.bak.<timestamp>" },
    { action: "apply"; method: "merge_patch"; target: "config.json5" },
    { action: "verify"; method: "reload_config_and_validate" },
    { action: "rollback_on_fail"; restore: "config.json5.bak.<timestamp>" },
  ];
};
```

Error handling:
- If validation fails → report errors to user, do not apply.
- If apply succeeds but verify fails → automatic rollback from backup.
- Backup rotation: keep last 5 backups (matches `CONFIG_BACKUP_COUNT = 5` in `backup-rotation.ts`).

#### 3.1.4 Step Flow

| Step | Entry | Exit | Output | Thresholds |
| --- | --- | --- | --- | --- |
| `welcome_profile` | Skill started | `name` + `experienceLevel` captured | `profile` | Required: `name`. `experienceLevel` defaults to `beginner` if not captured after 2 attempts. |
| `goal_capture` | Profile complete | Goals captured | `goals[]` | Minimum 1 goal required. Adaptive: if user provides 1 clear goal after 2 prompts, proceed. Max 3 prompt attempts before skip with default goals inferred from role. |
| `workflow_inventory` | Goals captured | Workflows mapped | `workflowsToday[]` | Minimum 1 workflow. If user says "I don't know" or gives no answer after 2 attempts → skip with empty list and note in `inferredIntent`. |
| `constraints_capture` | Workflows done | Constraints captured | `constraints` | All fields optional. Skip after 1 prompt if user declines. Defaults: `privacyLevel: "balanced"`, `budgetLevel: "medium"`. |
| `intent_inference` | Constraints done | AI produces intent summary | `inferredIntent` | Target confidence ≥ 0.7. If < 0.7 after inference → proceed anyway with explicit note that confidence is low. |
| `intent_confirmation` | Inference done | User confirms/edits | Updated `inferredIntent` | User can approve, edit, or skip. Skip → use as-is. |
| `config_draft` | Intent confirmed | Draft config generated | `configPatch` draft | Must pass `FridaySchema.safeParse()` validation. |
| `config_confirm_apply` | Draft ready | User approves | Final `OnboardingOutput` | User can approve, edit, or reject. Reject → restart from `config_draft`. |

**Fallback/skip logic:** Every step has a maximum attempt count (default: 3). If the user cannot or will not provide required information after max attempts, the step either:
- Falls back to sensible defaults (documented per step above), or
- Skips with an explicit note in the summary for the user.

This prevents infinite loops while still gathering useful information.

---

### 3.2 Skill 2: Self-Learning

#### 3.2.1 Goal
Continuously improve Friday by learning preferences/corrections, detecting failures, and safely applying fixes.

#### 3.2.2 Input/Output/State Contracts

```ts
export type SelfLearningInput = {
  event: LearningEvent;
};

export type LearningEvent = {
  eventId: string;
  ts: string;
  sessionId: string;
  userId: string;
  kind:
    | "user_message"
    | "assistant_message"
    | "tool_result"
    | "user_correction"
    | "error_incident"
    | "workflow_outcome";
  payload: Record<string, unknown>;
};

export type SelfLearningState = {
  currentPhase:
    | "ingest"
    | "extract"
    | "fact_update"
    | "incident_classify"
    | "autofix_plan"
    | "autofix_execute"
    | "persist"
    | "score_update"
    | "done";
  extractedSignals: ExtractedSignal[];
  pendingFactUpdates: PreferenceFact[];
  pendingIncident: ErrorIncident | null;
  pendingAction: AutoFixAction | null;
  persistedIds: string[];
};

export type ExtractedSignal = {
  signalId: string;
  kind: "preference" | "correction" | "error" | "positive_feedback";
  key: string;
  value: unknown;
  confidence: number;
  sourceEventId: string;
};

export type SelfLearningOutput = {
  factsUpdated: string[];
  incidentsCreated: string[];
  actionsExecuted: string[];
  scoreDeltas: {
    successRate: number;
    autoFixSuccessRate: number;
  };
};
```

#### 3.2.3 Supporting Type Definitions

```ts
export type CorrectionPayload = {
  correctedField: string;
  oldValue: unknown;
  newValue: unknown;
  context?: string;
};

export type ErrorPayload = {
  errorCode: string | null;
  toolName: string | null;
  message: string;
  stackTrace?: string;
};

export type MessagePayload = {
  text: string;
  channel: string;
  metadata?: Record<string, unknown>;
};

export type PreferenceFact = {
  factId: string;
  userId: string;
  key: string;
  value: unknown;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
  sourceEventIds: string[];
};

export type ErrorIncident = {
  incidentId: string;
  userId: string;
  ts: string;
  category: "tool" | "model" | "routing" | "config" | "workflow";
  severity: "low" | "medium" | "high";
  signature: string;
  context: Record<string, unknown>;
  autoFixEligible: boolean;
};

export type AutoFixAction = {
  actionId: string;
  incidentId: string;
  userId: string;
  riskTier: 0 | 1 | 2;
  plan: {
    description: string;
    steps: Array<{
      action: string;
      target: string;
      payload: unknown;
    }>;
    rollbackPlan?: {
      description: string;
      steps: Array<{
        action: string;
        target: string;
        payload: unknown;
      }>;
    };
  };
  status: "planned" | "applied" | "rolled_back" | "rejected";
  outcome: "success" | "failed" | null;
};

export type ValidationResult = {
  valid: boolean;
  errors: Array<{
    path: string;
    code: string;
    message: string;
  }>;
};

export type StepResult = {
  stepId: string;
  status: "completed" | "failed" | "skipped";
  output: Record<string, unknown>;
  error?: string;
};

export type SimulationResult = {
  runId: string;
  status: "completed" | "failed";
  stepResults: Record<string, StepResult>;
  outputs: Record<string, unknown>;
  testResults?: Array<{
    testName: string;
    passed: boolean;
    assertions: Array<{
      path: string;
      operator: string;
      expected: unknown;
      actual: unknown;
      passed: boolean;
    }>;
  }>;
  error?: { stepId: string; message: string; code: string };
};
```

#### 3.2.4 Signal Extraction Algorithm

Signal extraction must be deterministic and reproducible:

```ts
function extractSignals(event: LearningEvent): ExtractedSignal[] {
  const signals: ExtractedSignal[] = [];

  switch (event.kind) {
    case "user_correction": {
      const { correctedField, oldValue, newValue } = event.payload as CorrectionPayload;
      signals.push({
        signalId: `sig-${event.eventId}-correction`,
        kind: "correction",
        key: `correction:${correctedField}`,
        value: newValue,
        confidence: 1.0,
        sourceEventId: event.eventId,
      });
      break;
    }
    case "error_incident": {
      const { errorCode, toolName, message } = event.payload as ErrorPayload;
      signals.push({
        signalId: `sig-${event.eventId}-error`,
        kind: "error",
        key: `tool_failure:${toolName ?? "unknown"}:${errorCode ?? "unknown"}`,
        value: { errorCode, message },
        confidence: 1.0,
        sourceEventId: event.eventId,
      });
      break;
    }
    case "user_message": {
      const preferences = inferPreferencesFromMessage(event.payload as MessagePayload);
      for (const pref of preferences) {
        signals.push({
          signalId: `sig-${event.eventId}-pref-${pref.key}`,
          kind: "preference",
          key: pref.key,
          value: pref.value,
          confidence: pref.confidence,
          sourceEventId: event.eventId,
        });
      }
      break;
    }
    // ... other event kinds
  }

  return signals;
}
```

#### 3.2.5 Deduplication and Signature

Events are deduped by `eventId` (primary key). Incident signatures are computed deterministically:

```ts
function computeIncidentSignature(signal: ExtractedSignal): string {
  const components = [signal.kind, signal.key];
  return createHash("sha256").update(components.join(":")).digest("hex").slice(0, 16);
}
```

This allows:
- Counting recurrences of the same incident type.
- Avoiding duplicate auto-fix plans for the same root cause.
- Tracking whether a fix actually resolved the issue.

#### 3.2.6 Persistent Storage Schema

The authoritative DDL for all learning, diagnosis, and approval tables is in `distributed-architecture.md` §10.2 (unified learning + diagnosis + approval schema). The tables are:

- `learning_events` — append-only event ledger
- `preference_facts` — materialized preference facts (upserted on user+key)
- `error_incidents` — classified error incidents with signature dedup
- `diagnosis_records` — AI-generated diagnosis records linked to incidents
- `learned_lessons` — consolidated lessons from recurring incidents
- `auto_fix_actions` — planned/applied fix actions with rollback support
- `approval_requests` — Tier-2 approval workflow
- `learning_metrics` — daily aggregated metrics

**Transactional rules:**
1. Event ingestion: single INSERT into `learning_events` (idempotent via PK).
2. Fact update: UPSERT on `(user_id, key)` within a transaction that also increments `evidence_count` and appends to `source_event_ids_json`.
3. Incident + action creation: wrapped in a single transaction — if action planning fails, the incident is still recorded but `auto_fix_eligible` is set to false.
4. Metrics: computed via daily aggregation job, not in the hot path.

#### 3.2.8 Data Governance

| Control | Implementation |
| --- | --- |
| **Retention** | Events older than `retentionDays` (default: 90) are hard-deleted via daily cleanup job. Incidents and actions follow the same policy. |
| **PII classification** | `user_id`, `payload_json` containing names/emails are tagged as PII at schema level. |
| **Redaction** | Before any event export or log output, PII fields are redacted via the existing `logging.redactPatterns` pipeline. |
| **User data lifecycle** | `friday learning export --user <id>` exports all user data as JSON. `friday learning delete --user <id>` hard-deletes all records for that user across all tables. |
| **Right to erasure** | Delete cascades: `auto_fix_actions` cascade from `error_incidents` (via `ON DELETE CASCADE`), `approval_requests` cascade from `auto_fix_actions` (via `ON DELETE CASCADE`). All user-scoped tables have a direct `user_id` column. Full user delete order (in a single transaction): `DELETE FROM auto_fix_actions WHERE user_id = ?` → `DELETE FROM error_incidents WHERE user_id = ?` → `DELETE FROM preference_facts WHERE user_id = ?` → `DELETE FROM learning_events WHERE user_id = ?`. |

#### 3.2.7 Step Flow

| Step | Entry | Exit | Output |
| --- | --- | --- | --- |
| `ingest_event` | New `LearningEvent` received | Event normalized + deduped (PK check) | Stored event |
| `signal_extract` | Event stored | Signals extracted via deterministic rules | `ExtractedSignal[]` |
| `fact_update` | Signals include preference/correction | Fact UPSERT with confidence recalculation | Updated `PreferenceFact[]` |
| `incident_classify` | Signals include error | Incident created with signature | `ErrorIncident` |
| `autofix_plan` | Incident is auto-fix eligible | Risk tier assigned + fix plan generated | `AutoFixAction` plan |
| `autofix_execute` | `riskTier` ≤ policy threshold | Action applied with rollback guard | Action result |
| `memory_persist` | Facts/incidents/actions ready | Durable write complete | Persisted IDs |
| `quality_score_update` | Action result available | Metrics updated | Score deltas |

#### 3.2.9 Risk Policy

| Tier | Actions | Approval | Rollback |
| --- | --- | --- | --- |
| **0** | Retry, fallback switch, payload trim | Automatic | N/A (stateless) |
| **1** | Non-destructive config patch | Automatic with rollback | Auto-rollback if verification fails within 60s |
| **2** | Destructive changes, skill disable, workflow modification | Requires user confirmation | Manual or auto-rollback on failure |

---

### 3.3 Skill 3: Workflow Builder

#### 3.3.1 Goal
Turn user-described needs into executable workflow definitions compatible with Friday's Workflow Engine.

#### 3.3.2 Workflow Engine Contract

Before defining the Workflow Builder skill, we must define the engine that executes its output.

##### 3.3.2.1 Executor API

```ts
interface WorkflowEngine {
  // Validate a workflow spec without executing
  validate(spec: WorkflowSpecV1): ValidationResult;

  // Compile spec into immutable version and start a new workflow run
  start(workflowVersionId: string, inputs: Record<string, unknown>): Promise<WorkflowRun>;

  // Resume a paused run (e.g., after human approval)
  resume(runId: string, stepResult?: StepResult): Promise<WorkflowRun>;

  // Cancel a running workflow
  cancel(runId: string, reason: string): Promise<void>;

  // Get current run state
  getState(runId: string): WorkflowRun | null;

  // Dry-run simulation (no side effects)
  simulate(spec: WorkflowSpecV1, inputs: Record<string, unknown>): Promise<SimulationResult>;
}
```

> **Note:** `start()` takes a `workflowVersionId` (the immutable compiled version identifier), not a raw spec. The spec must be compiled and published first. See `distributed-architecture.md` §5.2.1 for the compiler contract.

##### 3.3.2.2 State Model

The authoritative `WorkflowRunStatus` enum is defined in `distributed-architecture.md` §5.2:

```ts
type WorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"       // transitional: pause requested but nodes still draining
  | "paused"        // terminal-pause: all nodes quiesced
  | "compensating"  // compensation workflow in progress
  | "completed"
  | "failed"
  | "cancelled";

type StepRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

// The canonical WorkflowRun type is defined in distributed-architecture.md §5.2.
// It uses nodeId/currentNodeId because compiled steps become graph nodes at runtime.
// In the authoring context (this document), we use stepId as an alias for nodeId —
// after compilation, each step maps 1:1 to a node in the CompiledWorkflowGraphV2.
// This type re-exports the canonical shape with step-oriented field names for
// authoring clarity. At runtime, the engine uses the canonical WorkflowRun as-is.
type WorkflowRun = {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  status: WorkflowRunStatus;
  inputs: Record<string, unknown>;
  stepStates: Record<string, StepState>;    // keyed by stepId (= nodeId after compilation)
  currentStepId: string | null;             // alias for currentNodeId in canonical WorkflowRun
  outputs: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;                      // aligned with canonical WorkflowRun
  error?: { stepId: string; message: string; code: string }; // stepId = nodeId after compilation
};

type StepState = {
  stepId: string;
  status: StepRunStatus;
  attempts: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};
```

> **Note:** `specId` is accepted as a deprecated alias for `workflowVersionId` in API inputs for backward compatibility.
>
> **Mapping to canonical type:** The `WorkflowRun` type here uses `stepId`/`currentStepId`/`stepStates` for authoring readability. At runtime, the workflow compiler maps each `stepId` to a `nodeId` in the compiled graph. The canonical `WorkflowRun` in `distributed-architecture.md` §5.2 uses `currentNodeId`, `error.nodeId`, and does not include `stepStates` (node states are tracked in `WorkflowRunNodeAttemptEntity` rows). Both representations describe the same underlying run state; this document uses the authoring-oriented projection.

##### 3.3.2.3 Step Execution Contract

Each step type has a defined contract:

| Step Type | Behavior | Input | Output |
| --- | --- | --- | --- |
| `skill_call` | Invokes a registered skill by `ref` (skill ID). `args` are passed as skill input. | Resolved `args` from context | Skill output |
| `tool_call` | Invokes a registered tool by `ref` (tool name). `args` are passed as tool input. | Resolved `args` from context | Tool result |
| `condition` | Evaluates `condition` expression. Routes to `true` or `false` edge. No side effects. | Context variables | `{ result: boolean }` |
| `transform` | Evaluates a pure mapping expression. `args` defines the mapping. | Context variables | Transformed data |
| `human_approval` | Pauses execution, sends approval request to user. Resumes on approve/reject. | Approval prompt from `args.message` | `{ approved: boolean, comment?: string }` |

##### 3.3.2.4 Expression DSL

Workflow `condition` and `args` values support a simple, safe expression language:

```ebnf
Grammar (precedence-climbing, suitable for recursive descent):
  expr        = logical_or
  logical_or  = logical_and ( "||" logical_and )*
  logical_and = not_expr ( "&&" not_expr )*
  not_expr    = "!" not_expr | compare
  compare     = primary ( OP primary )?
  primary     = ref | literal | "(" expr ")"
  ref         = "$" path             // e.g., $steps.fetch_data.output.count
  path        = IDENT ( "." IDENT )*
  literal     = STRING | NUMBER | BOOLEAN | NULL
  OP          = "==" | "!=" | ">" | "<" | ">=" | "<="
```

**Precedence (highest to lowest):** `!` (not) → comparison (`==`, `!=`, `>`, `<`, `>=`, `<=`) → `&&` (logical AND) → `||` (logical OR). Parentheses override precedence.

Key properties:
- **No function calls** — prevents arbitrary code execution.
- **No assignment** — expressions are pure and read-only.
- **Context access only** — `$inputs.*`, `$steps.<stepId>.output.*`, `$env.*`.
- **Type coercion** — string/number/boolean only; objects are accessed via dot-path.
- **Logical operators** — `&&` (AND) and `||` (OR) combine sub-expressions; `!` negates.

Example conditions:
- `$steps.fetch_data.output.count > 0`
- `$inputs.environment == "production" && $steps.check_health.output.healthy == true`
- `!$steps.dry_run.output.hasErrors`
- `$inputs.priority == "high" || $steps.check_urgency.output.urgent == true`

##### 3.3.2.5 Failure Semantics

The authoritative failure policy type is `WorkflowFailurePolicyV2` (defined in `distributed-architecture.md` §5.2). The canonical strategies are:

| Strategy | Behavior |
| --- | --- |
| `fail_fast` | Mark run as failed, record error. |
| `continue_on_error` | Skip step, proceed on `failure` edge if one exists. |
| `fallback_step` | Jump to designated `fallbackStepId`. |
| `compensate` | Execute compensation workflow/nodes. |
| `pause_for_approval` | Pause run and wait for user approval. |

**Legacy mapping:** `"stop"` → `"fail_fast"`, `"continue"` → `"continue_on_error"`, `"fallback"` → `"fallback_step"`.

Additional failure rules:
1. **Step failure:** If a step fails and has `retry` configured, retry with backoff up to `maxAttempts`. If all retries fail, apply the `errorPolicy.onFailure` strategy.
2. **Timeout:** If `timeoutSec` expires, treat as step failure.
3. **Human approval timeout:** Approval requests expire after 24 hours (configurable). Expired = rejected.
4. **Unhandled failure:** If no `failure` edge exists and policy is `"continue_on_error"`, the run fails.

##### 3.3.2.6 Edge/Transition Semantics

Edges connect steps. The `when` field determines which edge is followed:

| `when` value | Applies to | Meaning |
| --- | --- | --- |
| `"success"` | All step types | Step completed without error |
| `"failure"` | All step types | Step failed (after retries exhausted) |
| `"true"` | `condition` steps only | Condition evaluated to true |
| `"false"` | `condition` steps only | Condition evaluated to false |
| *(absent)* | All step types | Unconditional (always followed on completion) |

**Validation rule:** A `condition` step must have at least one `true` or `false` edge. Non-condition steps must not use `true`/`false` edges.

##### 3.3.2.7 DAG Validation

All workflow graphs must be strictly acyclic in V1. Cycle detection is required and cycles fail validation with `WORKFLOW_CYCLE_DETECTED`. See `distributed-architecture.md` §5.2 for the cycle-check algorithm.

#### 3.3.3 Output Schema (Authoring DSL)

The `WorkflowSpecV1` is the authoring DSL. It must be compiled into `CompiledWorkflowGraphV2` (see `distributed-architecture.md` §5.2.1) before execution by the workflow engine.

```ts
export type WorkflowSpecV1 = {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger:
    | { type: "manual" }
    | { type: "schedule"; cron: string; timezone: string }
    | { type: "event"; source: string; event: string };
  inputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    required: boolean;
    defaultValue?: unknown;
  }>;
  steps: Array<{
    id: string;
    type: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval";
    ref?: string;
    args?: Record<string, unknown>;
    condition?: string;
    timeoutSec?: number;
    retry?: { maxAttempts: number; backoffMs: number };
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: "success" | "failure" | "true" | "false";
  }>;
  outputs: Array<{
    key: string;
    fromStep: string;
    path: string;
  }>;
  errorPolicy: WorkflowFailurePolicyV2;
  tests: Array<{
    name: string;
    description?: string;
    inputs: Record<string, unknown>;
    mocks?: Record<string, MockStepResult>;
    assertions: Array<{
      path: string;
      operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
      expected: unknown;
    }>;
  }>;
};

type MockStepResult = {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
};
```

**Validation rules for `WorkflowSpecV1`:**
1. `startStepId` must reference an existing step.
2. Every step referenced in `edges.from` and `edges.to` must exist in `steps`.
3. `condition` steps must have `condition` field set and at least one `true`/`false` edge.
4. `skill_call` and `tool_call` steps must have `ref` set.
5. `outputs[*].fromStep` must reference an existing step.
6. If `errorPolicy.onFailure === "fallback_step"`, then `errorPolicy.fallbackStepId` must reference an existing step.
7. The graph must be connected from `startStepId` (no unreachable steps).
8. At least one path from `startStepId` reaches a terminal node (no outbound edges or all outbound edges lead to terminals).
9. The graph must be acyclic (cycle detection required — see `distributed-architecture.md` §5.2).

##### 3.3.3.1 Test Semantics

Tests are executable by the `simulate()` engine method:
1. **Inputs** are injected as `$inputs.*` context.
2. **Mocks** replace actual step execution — when a step has a mock, the mock output is used instead of invoking the real skill/tool.
3. **Assertions** are evaluated after simulation completes:
   - `path` is resolved against the simulation context (`$outputs.*`, `$steps.*`).
   - `operator` performs the comparison against `expected`.
   - All assertions must pass for the test to pass.
4. **No side effects** — mocked steps don't invoke real tools/skills; unmocked steps in simulation mode run with a no-op adapter that returns empty output.

#### 3.3.4 Step Flow

| Step | Entry | Exit | Output |
| --- | --- | --- | --- |
| `need_capture` | Skill started | User problem statement + concrete example | `problemStatement` |
| `trigger_define` | Problem captured | Trigger type and details defined | `trigger` |
| `io_define` | Trigger defined | Required inputs/outputs enumerated | `inputs`/`outputs` |
| `logic_decompose` | IO defined | Process decomposed into steps + decisions | Step draft |
| `exception_design` | Logic draft ready | Failure paths, retries, fallback, approvals defined | `errorPolicy` |
| `spec_generate` | Exception design done | `WorkflowSpecV1` generated + schema-valid | Workflow JSON |
| `test_generate` | Spec valid | ≥ 3 test cases with mocks and assertions | `tests[]` |
| `simulation_review` | Tests generated | Dry-run via `engine.simulate()`, summary shown | Simulation result |
| `publish` | User approval | Workflow compiled, stored + executable ID returned | Published `workflowVersionId` |

---

## 4. Self-Evolution Architecture

### 4.1 Core Loop

```text
Observe → Understand → Decide → Act → Verify → Consolidate
```

1. **Observe:** Capture structured events from conversations, tool calls, workflow runs, failures.
2. **Understand:** Extract preference/correction/incident signals via deterministic rules.
3. **Decide:** Rank possible adaptations by confidence and risk tier.
4. **Act:** Apply safe fixes automatically (Tier 0-1); gate risky changes (Tier 2).
5. **Verify:** Measure outcome; rollback if degraded.
6. **Consolidate:** Nightly compaction — merge duplicate facts, decay stale preferences, keep provenance.

### 4.2 Required Services

| Service | Responsibility |
| --- | --- |
| **Event Ledger** | Append-only, immutable, queryable by user/session/kind/time. |
| **Learning Engine** | Computes preference facts and incident signatures from raw events. |
| **AutoFix Engine** | Executes Tier 0/1 fixes with rollback transactions; queues Tier 2 for approval. |
| **Policy Store** | Materialized "current learned state" per user — queryable as key-value. |
| **Evaluation Service** | Compares before/after metrics, flags regressions, triggers hard-stops. |

### 4.3 Tier-2 Approval Workflow

Tier-2 actions require explicit user confirmation before execution. The `ApprovalRequestEntity` type and DDL are defined in `distributed-architecture.md` §10.1 and §10.2. The approval API endpoints are in `distributed-architecture.md` §11.1 (Approvals section).

**Lifecycle:**
1. **Request:** AutoFix Engine creates an `ApprovalRequest` and sends a notification to the user (via configured channel).
2. **Pending:** Request is stored in the approval queue. User can view pending approvals via `friday approvals list`.
3. **Response:** User approves or rejects:
   - `friday approvals approve <requestId>` → Execute the action.
   - `friday approvals reject <requestId>` → Mark as rejected, log reason.
4. **Expiry:** If no response within `expiresAt`, status becomes `"expired"`. Expired requests are not executed.
5. **Audit:** All approval lifecycle events are logged to the Event Ledger.

### 4.4 Guardrails

1. **Evidence requirements:** Every learned fact requires minimum evidence count (default: 2), minimum confidence (default: 0.5), and source traceability (linked event IDs).
2. **Fix requirements:** Every auto-fix requires explicit risk tier, rollback plan (for Tier 1+), and outcome logging.
3. **Additive by default:** Learning never silently overwrites hard user settings. User-explicit config values always take precedence over learned preferences.
4. **Hard-stop conditions:**
   - Rollback rate > 30% in a 24h window → pause all Tier 1 auto-fixes.
   - Error spike > 3× baseline in 1h → pause all auto-fixes, alert user.
   - Unresolved high-severity incident older than 48h → escalate to user notification.
5. **Evaluation gates:** Before any Tier 1 auto-fix is permanently committed, the Evaluation Service compares pre/post metrics. If any metric degrades beyond threshold → auto-rollback.

---

## 5. Implementation Priority

### 5.1 Unified Roadmap

The authoritative unified roadmap is in `distributed-architecture.md` §14.2. Summary of phases relevant to this document:

| Phase | Deliverable | Relevance to Skill System |
| --- | --- | --- |
| **Phase 1** | Skill runtime/registry + manifest V2 loader + legacy adapter | Core skill lifecycle, manifest loader, legacy compat, validation pipeline, trust tier enforcement. |
| **Phase 2** | Satellite runtime + durable run/event ledger | Durable skill run state, event ledger (SQLite schema, transactional writes, retention jobs). |
| **Phase 3** | Workflow compiler/executor/validator/simulator + Evaluation Service | Expression DSL, step adapters, state machine, simulate mode. Evaluation Service must exist before any auto-fix. |
| **Phase 4** | Skill store/marketplace + trust/sandbox + permission enforcement + Onboarding Skill | Install/update lifecycle, marketplace, full permission enforcement. Onboarding Skill exercises full lifecycle. |
| **Phase 5** | Workflow Builder Skill + AI routing/diagnosis | Produces `WorkflowSpecV1` definitions. Depends on working engine. |
| **Phase 6** | Learning pipeline (events/facts/incidents) | Self-Learning Skill Phase A: passive learning + reporting only. |
| **Phase 7** | Auto-fix rollout with approvals + Scaffold Generator | Self-Learning Skill Phase B: risk-tiered auto-fix. Scaffold generator for community authors. |
| **Phase 8** | Visual UX completion + legacy decommission | Full builder UI, fleet dashboard, legacy removal. |

**Key ordering rationale:** The Workflow Engine (Phase 3) comes before the Workflow Builder skill (Phase 5), and Evaluation Gates (Phase 3) come before any auto-fix rollout (Phase 7). This ensures no workflow output is produced without an engine to validate it, and no automatic mutations happen without regression detection.

---

*End of specification.*
