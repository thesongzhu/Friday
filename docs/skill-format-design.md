# Friday Skill Format Standard + Converter System (v1)

> Current boundary: this document covers the **skill package format** and converter pipeline used by Friday runtimes, local installs, and legacy executable assets. It is **not** the same thing as the public marketplace contract. The public marketplace is moving to a declarative-first asset model with explicit permission manifests and framework-owned execution; executable `node` / `shell` packages remain legacy/bounded for local, operator, or migration scenarios.

## Scope
This design defines a universal Friday skill package format and a pluggable converter/import pipeline so users can:
1. Install from a marketplace.
2. Import from external platforms (Clawdbot, n8n, OpenAI GPT Actions).
3. Reuse generated skills.
4. Share skills as portable artifacts.

v1 focus: native package format + import/convert flow. Marketplace publishing/discovery remains minimal.

---

## 1. Package Standard

### 1.1 Canonical Directory Structure
```text
<skill-id>/
  skill.manifest.json          # required, SkillManifestV2 (schemaVersion "2.0")
  skill.ui.json                # required, FridaySkillUiSchemaV1 (schemaVersion "1.0")
  index.mjs                    # required when runtime.kind = "node"
  run.sh                       # required when runtime.kind = "shell"
  README.md                    # recommended
  CHANGELOG.md                 # optional
  SKILL.md                     # optional (legacy docs only)
  assets/                      # optional static assets
  test/                        # optional tests/smoke scripts
  schemas/                     # optional input/state/output schemas
  prompts/                     # optional flow prompt files
  conversion.report.json       # optional provenance (required for converted imports)
```

### 1.2 Required/Optional Rules
| File | Requirement | Rule |
|---|---|---|
| `skill.manifest.json` | Required | Must parse as `SkillManifestV2` and pass existing validation pipeline. |
| `skill.ui.json` | Required | Must parse as `FridaySkillUiSchemaV1` and align with manifest inputs/outputs. |
| `index.mjs` | Conditional required | Required if `manifest.runtime.kind = "node"` and must match `runtime.entrypoint`. |
| `run.sh` | Conditional required | Required if `manifest.runtime.kind = "shell"` and must match `runtime.entrypoint`, executable bit set. |
| `README.md` | Recommended | Human docs; required for marketplace listing quality gate (future). |
| `conversion.report.json` | Conditional required | Required when package produced by converter; records source format, warnings, mapping decisions. |

### 1.3 Metadata Schema (Distribution-facing)
Distribution metadata is canonicalized from `skill.manifest.json`:
- `version` -> `manifest.version`
- `author` -> `manifest.author`
- `license` -> `manifest.license`
- `repository` -> `manifest.repository` (new optional field; fallback: `manifest.homepage`)
- `tags` -> `manifest.tags`
- `category` -> `manifest.category`

Proposed manifest extension (backward-compatible):
```ts
interface SkillManifestV2 {
  repository?: string; // git URL or HTTPS repo URL
}
```

### 1.4 Runtime Profiles
| Profile | Manifest runtime | Entrypoint |
|---|---|---|
| Node skill | `runtime.kind = "node"` | `index.mjs` |
| Shell skill | `runtime.kind = "shell"` | `run.sh` |

### 1.5 Validation Contract (same as generated skills)
All converted packages must pass:
1. `safeParseFridaySkillManifestV2`.
2. `validateUiSchema` (UI/model cross-check).
3. `loadFridaySkillPackage` against staged directory.
4. `validateFridaySkillPackage` (full 6-stage pipeline).

---

## 2. Converter Interface (Pluggable)

```ts
export type FridaySkillSourceFormat =
  | "friday-package"
  | "clawdbot-skill-md"
  | "n8n-node"
  | "openai-gpt-action"
  | "unknown";

export interface FridaySkillConversionSource {
  uri?: string;                 // local path, URL, marketplace URI, git URL
  contentBase64?: string;       // API upload mode
  formatHint?: FridaySkillSourceFormat | "auto";
}

export interface FridaySkillConverterDetection {
  converterId: string;
  format: FridaySkillSourceFormat;
  confidence: number;           // 0..1
  reasons: string[];
}

export interface FridayConvertedSkillFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface FridayConvertedSkillDraft {
  manifest: SkillManifestV2;
  uiSchema: FridaySkillUiSchemaV1;
  files: FridayConvertedSkillFile[];
  warnings: string[];
  conversionReport: {
    sourceFormat: FridaySkillSourceFormat;
    sourceRef?: string;
    convertedAt: string;
    converterId: string;
  };
}

export interface FridaySkillConverterResult {
  converterId: string;
  detectedFormat: FridaySkillSourceFormat;
  drafts: FridayConvertedSkillDraft[]; // supports 1->N conversion
}

export interface FridaySkillConverterContext {
  workspaceDir: string;
  managedSkillsDir: string;
  nowIso: () => string;
}

export interface FridaySkillConverter {
  id: string;
  displayName: string;
  priority: number;
  detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null>;
  convert(source: FridaySkillConversionSource, ctx: FridaySkillConverterContext): Promise<FridaySkillConverterResult>;
}
```

Converter registry behavior:
1. Register converters at bootstrap.
2. Run `detect()` across converters and pick highest confidence, then highest priority.
3. Allow explicit `formatHint` override.
4. Reject ambiguous detection unless explicitly overridden.

---

## 3. Built-in Converters (v1)

### 3.1 Clawdbot `SKILL.md` -> Friday Package
Input:
- `SKILL.md` (frontmatter + markdown command blocks).

Conversion:
1. Reuse `loadFridaySkillFrontmatter`, legacy metadata mapping, and markdown command extraction.
2. Build manifest from legacy fields (same compatibility defaults as legacy adapter).
3. Generate static `run.sh` dispatcher for extracted commands.
4. Generate `skill.ui.json` with command selector + extracted placeholder inputs.
5. Write `conversion.report.json` with frontmatter mapping and warnings.

Runtime target:
- `runtime.kind = "shell"`
- `runtime.entrypoint = "run.sh"`

Note:
- This does not use the runtime legacy bridge; it creates a static package.

### 3.2 n8n Node -> Friday Package
Input:
- n8n node definition JSON + execute JS module (local package/path/URL).

Conversion:
1. Detect n8n node package (`n8n` metadata or node descriptor signature).
2. Convert one n8n node -> one Friday skill draft.
3. Map node properties -> manifest inputs + UI fields.
4. Generate `index.mjs` adapter that calls node execute with Friday input context.
5. Default outputs to structured object/array result.
6. Infer permissions:
   - HTTP-capable nodes -> `network.connect` grant.
   - Host allowlist from known base URLs when resolvable; otherwise wildcard + warning.

Known v1 limits:
- Trigger/webhook nodes are imported as workflow-invocable utility skills only.
- Complex n8n credential UX is mapped to env/input secrets, not full n8n credential lifecycle.

### 3.3 OpenAI GPT Action (OpenAPI) -> Friday Package
Input:
- OpenAPI JSON/YAML + optional auth mapping config.

Conversion:
1. Parse OpenAPI and enumerate operations.
2. Default behavior: one Friday skill per operation (`<baseId>-<operationId>`).
3. Generate `index.mjs` HTTP executor for the operation.
4. Map parameters/body schema -> manifest inputs + UI fields.
5. Map output -> `status`, `headers`, `data`.
6. Add `network.connect` permission with host allowlist from OpenAPI `servers`.
7. Map auth schemes:
   - API key -> secret input/env requirement.
   - Bearer token -> secret input/env requirement.
   - OAuth2 -> warning + manual post-import setup required.

---

## 4. Distribution Format

### 4.1 Canonical Share Artifact
- Format: `.tgz` (gzip tarball).
- Filename: `<skillId>-<version>.friday.tgz`.
- Archive root: skill directory contents (manifest/UI/entrypoint/etc).

### 4.2 Marketplace Serving Model
Marketplace serves:
1. `index.json` with skill/version metadata (existing model).
2. `manifestUrl` for each version.
3. `packageUrl` pointing to `.friday.tgz`.
4. `signatureUrl` optional for signed packages.

### 4.3 Installation Sources
`friday import` accepts:
1. Local directory.
2. Local `.tgz` or `.zip` archive.
3. HTTP(S) URL to directory archive/spec.
4. Marketplace identifier: `marketplace:<sourceId>/<skillId>@<version>`.
5. Git URL (cloned then converted/imported).

Install target behavior:
- Default target: `<managedSkillsDir>/<skillId>/` (single-level directory to match current registry discovery model).
- Optional target: workspace skills dir.
- Collision policy: fail by default, `--replace` to overwrite.

---

## 5. CLI Integration

### 5.1 New Commands
| Command | Purpose |
|---|---|
| `friday import <source>` | Detect -> convert (if needed) -> validate -> install -> registry refresh. |
| `friday convert <source> --out <dir>` | Detect -> convert -> validate -> write package(s) to output dir, no install. |
| `friday converters` | List installed converters and supported source formats. |
| `friday pack <skill-dir> --out <file.tgz>` | Package native Friday skill for sharing. |

### 5.2 Key Flags
- `--from auto|clawdbot-skill-md|n8n-node|openai-gpt-action|friday-package`
- `--target managed|workspace|<path>`
- `--replace`
- `--dry-run`
- `--no-refresh`
- `--split-operations` (OpenAPI)
- `--skill-id-prefix <prefix>`

---

## 6. API Endpoints (REST)

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/v1/skills/converters` | `skill.read` | List available converters and formats. |
| `POST` | `/v1/skills/convert` | `skill.write` | Convert source to one or more validated drafts (no install). |
| `POST` | `/v1/skills/import` | `skill.write` | Convert (if needed), install package(s), refresh registry. |
| `POST` | `/v1/skills/pack` | `skill.write` | Pack native skill dir into `.friday.tgz`. |

`POST /v1/skills/import` response includes:
- `imports[]` with `skillId`, `skillDir`, `status`, `issues`.
- `registryRefreshed`.
- `converterId`, `detectedFormat`.

---

## 7. Service Interface (`FridaySkillConverterService`)

```ts
export interface FridaySkillConverterService {
  listConverters(): Array<{
    id: string;
    displayName: string;
    sourceFormats: FridaySkillSourceFormat[];
  }>;

  detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection>;

  convert(input: {
    source: FridaySkillConversionSource;
    formatHint?: FridaySkillSourceFormat | "auto";
    dryRun?: boolean;
    options?: {
      splitOperations?: boolean;
      skillIdPrefix?: string;
    };
  }): Promise<FridaySkillConverterResult & {
    validation: Array<{
      skillId: string;
      ok: boolean;
      issues: FridaySkillValidationIssue[];
    }>;
  }>;

  import(input: {
    source: FridaySkillConversionSource;
    formatHint?: FridaySkillSourceFormat | "auto";
    target?: "managed" | "workspace" | { path: string };
    replace?: boolean;
    refreshRegistry?: boolean;
  }): Promise<{
    converterId: string;
    detectedFormat: FridaySkillSourceFormat;
    imports: Array<{
      skillId: string;
      skillDir: string;
      installed: boolean;
      issues: FridaySkillValidationIssue[];
    }>;
    registryRefreshed: boolean;
  }>;

  pack(input: {
    skillDir: string;
    outputFile: string;
  }): Promise<{
    packageFile: string;
    checksumSha256: string;
  }>;
}
```

---

## 8. File Plan

### 8.1 New Files
1. `src/skills/converter/index.ts`
2. `src/skills/converter/model/friday-skill-converter.types.ts`
3. `src/skills/converter/services/friday-skill-converter-registry.ts`
4. `src/skills/converter/services/friday-skill-converter-service.types.ts`
5. `src/skills/converter/services/friday-skill-converter-service.ts`
6. `src/skills/converter/services/friday-skill-import-installer.ts`
7. `src/skills/converter/services/friday-skill-package-archive.ts`
8. `src/skills/converter/converters/index.ts`
9. `src/skills/converter/converters/friday-native-skill-package-converter.ts`
10. `src/skills/converter/converters/friday-clawdbot-skill-md-converter.ts`
11. `src/skills/converter/converters/friday-n8n-node-converter.ts`
12. `src/skills/converter/converters/friday-openai-gpt-action-converter.ts`
13. `src/api/model/friday-api-skill-converter.types.ts`
14. `src/api/http/routes/friday-skill-converter-routes.ts`
15. `test/unit/skills/converter/friday-clawdbot-skill-md-converter.test.ts`
16. `test/unit/skills/converter/friday-n8n-node-converter.test.ts`
17. `test/unit/skills/converter/friday-openai-gpt-action-converter.test.ts`
18. `test/unit/skills/converter/friday-skill-converter-service.test.ts`
19. `test/unit/api/http/routes/friday-skill-converter-routes.test.ts`

### 8.2 Existing Files to Modify
1. `src/skills/index.ts` (export converter module)
2. `src/hub/friday-hub-bootstrap.ts` (instantiate and expose converter service)
3. `src/hub/index.ts` (export updated hub surface)
4. `src/cli/friday-cli.ts` (new commands/arg parsing)
5. `src/cli/index.ts` (updated exports/types)
6. `test/unit/cli/friday-cli.test.ts` (new parser cases)
7. `src/api/index.ts` (export converter API types)
8. `src/api/runtime/friday-api-runtime.types.ts` (inject converter service)
9. `src/api/runtime/friday-api-runtime.ts` (register converter routes)
10. `src/skills/model/friday-skill-manifest-v2.types.ts` (optional `repository` field)
11. `src/skills/manifest/friday-skill-manifest.schema.ts` (validate `repository`)
12. `src/skills/manifest/friday-skill-manifest-defaults.ts` (normalize new metadata field)

---

## 9. Integration with Existing Modules

| Existing module | Integration point |
|---|---|
| `src/skills/manifest/` | Converter outputs are staged and validated using existing loader + schema + pipeline. |
| `src/skills/model/` | Add converter types; optionally extend manifest metadata (`repository`). |
| `src/skills/registry/` | Import service writes packages into discoverable dirs and calls `registry.refresh()`. |
| `src/skills/lifecycle/` | Import marks status `installed` via memory state update after successful install. |
| `src/skills/generator/` | Reuse UI schema type/validator and package validation behavior for parity. |
| `src/skills/bridge/` | Clawdbot converter reuses frontmatter and markdown extraction; bridge remains fallback runtime for unconverted legacy skills. |

### End-to-end Import Flow
1. Resolve source (`path`, URL, marketplace ID, git).
2. Detect converter (`detect` scoring or explicit `--from`).
3. Convert to draft package(s).
4. Stage to temp dir and run native validation stack.
5. Install into managed/workspace dir.
6. Update lifecycle state and append audit log.
7. Refresh registry and return import report.

### v1 Non-goals
1. Full marketplace publishing workflow.
2. Full n8n credential manager parity.
3. OAuth handshake automation for GPT Actions.
4. Multi-version install directories under managed root (deferred until registry discovery supports nested version layout).
