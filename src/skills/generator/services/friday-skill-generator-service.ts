import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";

import { FridayDomainError } from "#errors";
import { resolveSafeInstallDir, resolveSafePath } from "#utilities";

import type { SkillManifestV2 } from "#skills";
import { applyFridaySkillManifestDefaults } from "#skills";

import type {
  CreateFridaySkillGeneratorServiceDeps,
  FridaySkillGeneratorService,
} from "./friday-skill-generator-service.types.js";

import type {
  FridayGeneratedSkillDraft,
  FridayGeneratedSkillFile,
  FridayGeneratedSkillValidationIssue,
  FridayGeneratedSkillValidationReport,
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
  FridaySkillGenerationTurnRequest,
  FridaySkillGenerationTurnResponse,
  FridayStartSkillGenerationRequest,
} from "../model/friday-skill-generator.types.js";

import type { FridaySkillUiSchemaV1 } from "../model/friday-skill-ui-schema.types.js";

import {
  createFridaySkillGenerationSessionRepository,
} from "../persistence/friday-skill-generation-session-repository.js";

import type {
  FridaySkillGenerationSessionRepository,
} from "../persistence/friday-skill-generation-session-repository.js";

import {
  buildCodePrompt,
  buildManifestPrompt,
  buildRequirementsPrompt,
  buildUiPrompt,
} from "../prompts/friday-skill-generator-prompts.js";

import { createFridayProviderInferenceClient } from "../llm/friday-provider-inference-client.js";

import type {
  FridayProviderInferenceClient,
} from "../llm/friday-provider-inference-client.types.js";

import { validateGeneratedCode } from "../validation/friday-generated-skill-safety-validator.js";
import { validateUiSchema } from "../validation/friday-generated-skill-ui-validator.js";
import { safeParseFridaySkillManifestV2 } from "../../manifest/friday-skill-manifest.schema.js";
import { loadFridaySkillPackage } from "../../manifest/friday-skill-package-loader.js";
import { validateFridaySkillPackage } from "../../validation/friday-skill-validation-pipeline.js";

// ─── Constants ───

const MAX_RECENT_TURNS = 12;
const MAX_REPAIR_ATTEMPTS = 2;
const DRAFT_NAMESPACE = "skill-generator-draft";
const FRIDAY_HUB_COMPAT_VERSION = "1.0.0";
const SUPPORTED_API_VERSIONS = ["1"];

type FridaySatelliteType = SkillManifestV2["executionTargets"]["allowedSatelliteTypes"][number];
type FridayOs = SkillManifestV2["requirements"]["os"][number];
type FridayRuntimeKind = SkillManifestV2["runtime"]["kind"];
type FridaySkillKind = SkillManifestV2["kind"];
type FridaySkillCategory = SkillManifestV2["category"];

const VALID_SATELLITE_TYPES: readonly FridaySatelliteType[] = [
  "phone",
  "desktop",
  "rpi",
  "cloud-vm",
];
const DEFAULT_SATELLITE_TYPES: readonly FridaySatelliteType[] = ["desktop", "cloud-vm"];
const SATELLITE_TYPE_ALIASES: Readonly<Record<string, FridaySatelliteType>> = {
  laptop: "desktop",
  mac: "desktop",
  macos: "desktop",
  windows: "desktop",
  linux: "desktop",
  pc: "desktop",
  mobile: "phone",
  ios: "phone",
  android: "phone",
  raspberrypi: "rpi",
  "raspberry-pi": "rpi",
  pi: "rpi",
  cloud: "cloud-vm",
  vm: "cloud-vm",
  server: "cloud-vm",
  cloudvm: "cloud-vm",
};
const VALID_OS_VALUES: readonly FridayOs[] = ["darwin", "linux", "win32"];
const DEFAULT_OS_VALUES: readonly FridayOs[] = ["darwin", "linux", "win32"];
const OS_ALIASES: Readonly<Record<string, FridayOs>> = {
  mac: "darwin",
  macos: "darwin",
  osx: "darwin",
  windows: "win32",
};
const VALID_RUNTIME_KINDS: readonly FridayRuntimeKind[] = [
  "builtin",
  "node",
  "python",
  "shell",
  "remote-http",
];
const VALID_SKILL_KINDS: readonly FridaySkillKind[] = [
  "conversation",
  "workflow",
  "system",
];
const VALID_SKILL_CATEGORIES: readonly FridaySkillCategory[] = [
  "automation",
  "communication",
  "filesystem",
  "browser",
  "media",
  "ai",
  "integration",
  "utility",
];
const RUNTIME_KIND_ALIASES: Readonly<Record<string, FridayRuntimeKind>> = {
  javascript: "node",
  js: "node",
  typescript: "node",
  ts: "node",
  nodejs: "node",
  bash: "shell",
  sh: "shell",
  py: "python",
  remote: "remote-http",
  http: "remote-http",
};
const SKILL_KIND_ALIASES: Readonly<Record<string, FridaySkillKind>> = {
  task: "workflow",
  tool: "conversation",
  agent: "conversation",
  skill: "conversation",
};
const SKILL_CATEGORY_ALIASES: Readonly<Record<string, FridaySkillCategory>> = {
  productivity: "automation",
  general: "utility",
  tools: "utility",
  coding: "ai",
  code: "ai",
  dev: "ai",
};

function normalizeSatelliteType(value: unknown): FridaySatelliteType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_SATELLITE_TYPES.includes(normalized as FridaySatelliteType)) {
    return normalized as FridaySatelliteType;
  }
  return SATELLITE_TYPE_ALIASES[normalized];
}

function normalizeOs(value: unknown): FridayOs | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (VALID_OS_VALUES.includes(normalized as FridayOs)) {
    return normalized as FridayOs;
  }
  return OS_ALIASES[normalized];
}

function normalizeRuntimeKind(value: unknown): FridayRuntimeKind {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (VALID_RUNTIME_KINDS.includes(normalized as FridayRuntimeKind)) {
      return normalized as FridayRuntimeKind;
    }
    if (normalized in RUNTIME_KIND_ALIASES) {
      return RUNTIME_KIND_ALIASES[normalized];
    }
  }
  return "node";
}

function normalizeSkillKind(value: unknown): FridaySkillKind {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (VALID_SKILL_KINDS.includes(normalized as FridaySkillKind)) {
      return normalized as FridaySkillKind;
    }
    if (normalized in SKILL_KIND_ALIASES) {
      return SKILL_KIND_ALIASES[normalized];
    }
  }
  return "conversation";
}

function normalizeSkillCategory(value: unknown): FridaySkillCategory {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (VALID_SKILL_CATEGORIES.includes(normalized as FridaySkillCategory)) {
      return normalized as FridaySkillCategory;
    }
    if (normalized in SKILL_CATEGORY_ALIASES) {
      return SKILL_CATEGORY_ALIASES[normalized];
    }
  }
  return "utility";
}

function normalizeManifestCandidate(manifest: SkillManifestV2): SkillManifestV2 {
  const normalizedTargets = manifest.executionTargets.allowedSatelliteTypes
    .map((value) => normalizeSatelliteType(value))
    .filter((value): value is FridaySatelliteType => value !== undefined);

  const normalizedOs = manifest.requirements.os
    .map((value) => normalizeOs(value))
    .filter((value): value is FridayOs => value !== undefined);

  const runtimeKind = normalizeRuntimeKind(manifest.runtime.kind);
  const normalizedEntrypoint =
    runtimeKind === "shell"
      ? "run.sh"
      : runtimeKind === "node"
        ? "index.mjs"
        : manifest.runtime.entrypoint;

  return {
    ...manifest,
    kind: normalizeSkillKind(manifest.kind),
    category: normalizeSkillCategory(manifest.category),
    runtime: {
      ...manifest.runtime,
      kind: runtimeKind,
      entrypoint: normalizedEntrypoint,
      minHubVersion:
        typeof manifest.runtime.minHubVersion === "string" &&
        manifest.runtime.minHubVersion.trim().length > 0
          ? manifest.runtime.minHubVersion
          : FRIDAY_HUB_COMPAT_VERSION,
    },
    requirements: {
      ...manifest.requirements,
      os:
        normalizedOs.length > 0
          ? [...new Set(normalizedOs)]
          : [...DEFAULT_OS_VALUES],
    },
    executionTargets: {
      ...manifest.executionTargets,
      allowedSatelliteTypes:
        normalizedTargets.length > 0
          ? [...new Set(normalizedTargets)]
          : [...DEFAULT_SATELLITE_TYPES],
      requiredCapabilities: manifest.executionTargets.requiredCapabilities.filter(
        (cap): cap is string => typeof cap === "string" && cap.trim().length > 0,
      ),
    },
  };
}

function normalizeGeneratedFileLanguage(
  value: unknown,
  filePath: string,
): FridayGeneratedSkillFile["language"] {
  if (value === "json" || value === "javascript" || value === "typescript" || value === "bash" || value === "markdown") {
    return value;
  }

  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case ".sh":
    case ".bash":
      return "bash";
    case ".json":
      return "json";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    default:
      return "javascript";
  }
}

function normalizeGeneratedCodeBundle(
  parsed: unknown,
): FridayGeneratedSkillFile[] | null {
  let items: unknown[] | undefined;

  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (parsed != null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["files"])) {
      items = obj["files"] as unknown[];
    } else if (Array.isArray(obj["items"])) {
      items = obj["items"] as unknown[];
    } else if (obj["path"] != null && obj["content"] != null) {
      items = [obj];
    }
  }

  if (!items) return null;

  const normalized: FridayGeneratedSkillFile[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item == null || typeof item !== "object") {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record["path"] !== "string" || typeof record["content"] !== "string") {
      return null;
    }
    const path = record["path"];
    normalized.push({
      path,
      content: record["content"],
      language: normalizeGeneratedFileLanguage(record["language"], path),
      executable: record["executable"] === true,
    });
  }

  return normalized;
}

function buildFallbackUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = manifest.inputs.map((input) => ({
    id: `${input.key}-field`,
    inputKey: input.key,
    kind:
      input.type === "number"
        ? "number"
        : input.type === "boolean"
          ? "toggle"
          : input.type === "object" || input.type === "array"
            ? "json"
            : input.type === "file"
              ? "file"
              : "text",
    label: input.label,
    required: input.required,
    ...(input.help ? { help: input.help } : {}),
  }));

  const sections: FridaySkillUiSchemaV1["sections"] =
    fields.length > 0
      ? [
          {
            id: "main",
            label: "Inputs",
            fieldIds: fields.map((field) => field.id),
          },
        ]
      : [];

  const outputs: FridaySkillUiSchemaV1["outputs"] = manifest.outputs.map((output) => ({
    id: `${output.key}-output`,
    outputKey: output.key,
    label: output.key,
    widget:
      output.type === "object"
        ? "json"
        : output.type === "array"
          ? "table"
          : "text",
  }));

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description,
    sections,
    fields,
    outputs,
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

// ─── Requirements analyzer response shape ───

interface RequirementsAnalyzerResponse {
  state: "needs_clarification" | "ready_for_generation";
  questions: string[];
  spec: Record<string, unknown>;
}

// ─── Factory ───

export function createFridaySkillGeneratorService(
  deps: CreateFridaySkillGeneratorServiceDeps,
): FridaySkillGeneratorService {
  const repo: FridaySkillGenerationSessionRepository =
    createFridaySkillGenerationSessionRepository({
      db: deps.db,
      idGenerator: deps.idGenerator,
      nowIso: deps.nowIso,
    });

  const llm: FridayProviderInferenceClient =
    createFridayProviderInferenceClient({
      providerService: deps.providerService,
    });

  // ─── Draft persistence via memory_items ───

  function saveDraft(sessionId: string, draft: FridayGeneratedSkillDraft): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          deps.idGenerator(),
          DRAFT_NAMESPACE,
          sessionId,
          JSON.stringify(draft),
          JSON.stringify(["draft"]),
          deps.nowIso(),
          deps.nowIso(),
        );
    });
  }

  function loadDraft(sessionId: string): FridayGeneratedSkillDraft | undefined {
    return deps.db.withReadConnection((reader) => {
      const row = reader
        .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
        .get(DRAFT_NAMESPACE, sessionId) as { value_json: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.value_json) as FridayGeneratedSkillDraft;
    });
  }

  function deleteDraft(sessionId: string): void {
    deps.db.withWriteTransaction((writer) => {
      writer
        .prepare("DELETE FROM memory_items WHERE namespace = ? AND key = ?")
        .run(DRAFT_NAMESPACE, sessionId);
    });
  }

  // ─── Helpers ───

  function getRecentTurns(turns: FridaySkillGenerationTurn[]): FridaySkillGenerationTurn[] {
    if (turns.length <= MAX_RECENT_TURNS) return turns;
    return turns.slice(turns.length - MAX_RECENT_TURNS);
  }

  function persistSession(session: FridaySkillGenerationSession): void {
    const existing = repo.getSession(session.sessionId);
    if (existing) {
      repo.updateSession(session);
      return;
    }
    repo.createSession(session);
  }

  function normalizeLifecycleTags(tags: readonly string[]): string[] {
    return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  }

  function withDraftLifecycleTags(manifest: SkillManifestV2): SkillManifestV2 {
    const baseTags = normalizeLifecycleTags(
      manifest.tags.filter((tag) => !["stable", "stabilized", "skill.stabilized"].includes(tag)),
    );
    const nextTags = new Set<string>(baseTags);
    nextTags.add("generated");
    nextTags.add("generated.draft");
    if (manifest.runtime.kind === "shell" || manifest.runtime.kind === "python") {
      nextTags.add("cli-backed");
    }
    return {
      ...manifest,
      tags: [...nextTags],
    };
  }

  function withStabilizedLifecycleTags(manifest: SkillManifestV2): SkillManifestV2 {
    const nextTags = new Set<string>(
      normalizeLifecycleTags(
        manifest.tags.filter((tag) => tag !== "generated.draft"),
      ),
    );
    nextTags.add("generated");
    nextTags.add("skill.stabilized");
    if (manifest.runtime.kind === "shell" || manifest.runtime.kind === "python") {
      nextTags.add("cli-backed");
    }
    return {
      ...manifest,
      tags: [...nextTags],
    };
  }

  async function runRequirementsAnalyzer(
    session: FridaySkillGenerationSession,
    turns: FridaySkillGenerationTurn[],
    requestedModel?: string,
  ): Promise<RequirementsAnalyzerResponse> {
    const recentTurns = getRecentTurns(turns);
    const prompt = buildRequirementsPrompt(
      session.goal,
      session.specSummary,
      session.openQuestions,
      recentTurns,
    );
    const result = await llm.infer<RequirementsAnalyzerResponse>({
      prompt,
      requestedModel,
      taskProfile: "planning",
    });
    return result.parsed;
  }

  function buildTurnResponse(
    session: FridaySkillGenerationSession,
    analyzerResult: RequirementsAnalyzerResponse,
    draft?: FridayGeneratedSkillDraft,
    errors?: FridayGeneratedSkillValidationIssue[],
  ): FridaySkillGenerationTurnResponse {
    if (draft) {
      return {
        session,
        mode: draft.validation.ok ? "preview_ready" : "generation_failed",
        draft,
        errors: draft.validation.ok ? undefined : draft.validation.issues,
      };
    }

    if (errors && errors.length > 0) {
      return {
        session,
        mode: "generation_failed",
        errors,
      };
    }

    if (analyzerResult.state === "needs_clarification") {
      return {
        session,
        mode: "clarification_required",
        questions: analyzerResult.questions,
      };
    }

    // Shouldn't reach here normally, but handle defensively
    return {
      session,
      mode: "clarification_required",
      questions: [],
    };
  }

  async function generateManifest(
    spec: Record<string, unknown>,
    requestedModel?: string,
  ): Promise<SkillManifestV2> {
    const prompt = buildManifestPrompt(spec);
    let parsed: unknown;
    try {
      const result = await llm.infer<unknown>({
        prompt,
        requestedModel,
        taskProfile: "deterministic",
      });
      parsed = result.parsed;
    } catch (err) {
      throw new FridayDomainError(
        "PARSE_ERROR",
        `Manifest generation failed (parse error): ${err instanceof Error ? err.message : String(err)}`,
        { httpStatus: 422, cause: err instanceof Error ? err : undefined },
      );
    }

    // Guard against non-object LLM output before schema validation
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new FridayDomainError(
        "PARSE_ERROR",
        "Manifest generation returned non-object result",
        { httpStatus: 422 },
      );
    }

    // Apply defaults before schema validation so the LLM only needs to
    // provide core fields (id, name, description, version, runtime.kind, etc.)
    const withDefaults = applyFridaySkillManifestDefaults(parsed as Record<string, unknown>);
    const normalizedCandidate = normalizeManifestCandidate(withDefaults);

    // Schema-validate the manifest shape
    const validation = safeParseFridaySkillManifestV2(normalizedCandidate);
    if (!validation.success) {
      const errorSummary = validation.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new FridayDomainError("VALIDATION_ERROR", `Manifest schema invalid: ${errorSummary}`, { httpStatus: 422 });
    }
    return validation.data;
  }

  async function generateCode(
    manifest: SkillManifestV2,
    runtimeKind: "shell" | "node",
    requestedModel?: string,
  ): Promise<FridayGeneratedSkillFile[]> {
    const prompt = buildCodePrompt(manifest, runtimeKind);
    let parsed: unknown;
    try {
      const result = await llm.infer<unknown>({
        prompt,
        requestedModel,
        taskProfile: "review",
      });
      parsed = result.parsed;
    } catch (err) {
      throw new FridayDomainError(
        "PARSE_ERROR",
        `Code generation failed (parse error): ${err instanceof Error ? err.message : String(err)}`,
        { httpStatus: 422, cause: err instanceof Error ? err : undefined },
      );
    }

    // Accept both direct arrays and object-wrapped arrays from some providers.
    const files = normalizeGeneratedCodeBundle(parsed);
    if (!files) {
      throw new FridayDomainError(
        "PARSE_ERROR",
        `Code bundle is not a supported shape — got ${typeof parsed}`,
        { httpStatus: 422 },
      );
    }
    return files;
  }

  async function generateUi(
    manifest: SkillManifestV2,
    requestedModel?: string,
  ): Promise<FridaySkillUiSchemaV1> {
    const prompt = buildUiPrompt(manifest);
    let parsed: unknown;
    try {
      const result = await llm.infer<unknown>({
        prompt,
        requestedModel,
        taskProfile: "deterministic",
      });
      parsed = result.parsed;
    } catch (err) {
      throw new FridayDomainError(
        "PARSE_ERROR",
        `UI schema generation failed (parse error): ${err instanceof Error ? err.message : String(err)}`,
        { httpStatus: 422, cause: err instanceof Error ? err : undefined },
      );
    }

    // Accept wrapper responses ({ ui: ... }) and fall back to deterministic UI
    // when provider output is not strict JSON schema.
    const schema =
      parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)["ui"] === "object"
        ? (parsed as Record<string, unknown>)["ui"]
        : parsed;

    const uiObject = schema as Record<string, unknown>;
    if (
      typeof uiObject !== "object" ||
      uiObject === null ||
      typeof uiObject["schemaVersion"] !== "string" ||
      !Array.isArray(uiObject["fields"]) ||
      !Array.isArray(uiObject["outputs"]) ||
      !Array.isArray(uiObject["actions"])
    ) {
      return buildFallbackUiSchema(manifest);
    }
    return uiObject as unknown as FridaySkillUiSchemaV1;
  }

  function validateManifest(manifest: unknown): FridayGeneratedSkillValidationIssue[] {
    const parseResult = safeParseFridaySkillManifestV2(manifest);
    if (parseResult.success) return [];
    return parseResult.error.issues.map((zodIssue) => ({
      code: "MANIFEST_SCHEMA_INVALID",
      severity: "error" as const,
      message: `${zodIssue.path.join(".")}: ${zodIssue.message}`,
      path: zodIssue.path.join("."),
    }));
  }

  function collectAllIssues(
    manifest: SkillManifestV2,
    files: FridayGeneratedSkillFile[],
    uiSchema: FridaySkillUiSchemaV1,
  ): FridayGeneratedSkillValidationIssue[] {
    const issues: FridayGeneratedSkillValidationIssue[] = [];
    issues.push(...validateManifest(manifest));
    issues.push(...validateGeneratedCode(files, manifest));
    issues.push(...validateUiSchema(uiSchema, manifest));
    return issues;
  }

  async function runGenerationPipeline(
    session: FridaySkillGenerationSession,
    spec: Record<string, unknown>,
    requestedModel?: string,
  ): Promise<FridayGeneratedSkillDraft> {
    let repairedManifest: SkillManifestV2 | undefined;
    let repairedFiles: FridayGeneratedSkillFile[] | undefined;
    let repairedUiSchema: FridaySkillUiSchemaV1 | undefined;
    let allIssues: FridayGeneratedSkillValidationIssue[] = [];
    let repairAttempts = 0;

    // The entire generation pipeline (manifest + code + UI + validation)
    // is wrapped in the repair loop so that parse/schema errors thrown by
    // generateManifest/generateCode/generateUi also trigger auto-repair.
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      const currentSpec =
        attempt === 0
          ? spec
          : {
              ...spec,
              _repairContext: {
                errors: allIssues
                  .filter((i) => i.severity === "error")
                  .map((i) => `[${i.code}] ${i.message}`)
                  .join("\n"),
                attempt,
              },
            };

      try {
        // Step 1: Generate manifest
        repairedManifest = await generateManifest(currentSpec, requestedModel);

        // Determine runtime kind
        const runtimeKind: "shell" | "node" =
          repairedManifest.runtime.kind === "shell" ? "shell" : "node";

        // Step 2: Generate code files
        repairedFiles = await generateCode(repairedManifest, runtimeKind, requestedModel);

        // Step 3: Generate UI schema
        repairedUiSchema = await generateUi(repairedManifest, requestedModel);

        // Step 4: Validate all artifacts
        allIssues = collectAllIssues(repairedManifest, repairedFiles, repairedUiSchema);
      } catch (err) {
        // Convert generation/parse/schema errors into validation issues
        // so the repair loop can retry.
        allIssues = [
          {
            code: "GENERATION_ERROR",
            severity: "error" as const,
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }

      const hasErrors = allIssues.some((i) => i.severity === "error");
      if (!hasErrors) break;

      // Count each repair attempt (attempts > 0 are repairs)
      if (attempt < MAX_REPAIR_ATTEMPTS) {
        repairAttempts++;
      }
    }

    const finalHasErrors = allIssues.some((i) => i.severity === "error");
    const validation: FridayGeneratedSkillValidationReport = {
      ok: !finalHasErrors,
      issues: allIssues,
      repaired: repairAttempts > 0 && !finalHasErrors,
      repairAttempts,
    };

    // If no valid artifacts were produced after retries, throw instead of persisting malformed data
    if (!repairedManifest || !repairedFiles || !repairedUiSchema) {
      throw new FridayDomainError(
        "GENERATION_FAILED",
        `Skill generation failed after ${repairAttempts} repair attempt(s): ${allIssues.map((i) => i.message).join("; ")}`,
        { httpStatus: 422 },
      );
    }

    const draft: FridayGeneratedSkillDraft = {
      manifest: withDraftLifecycleTags(repairedManifest),
      files: repairedFiles,
      uiSchema: repairedUiSchema,
      runtimeKind:
        repairedManifest.runtime.kind === "shell" ? "shell" : "node",
      validation,
    };

    // Persist the draft to memory_items
    saveDraft(session.sessionId, draft);

    return draft;
  }

  function requireSession(sessionId: string): FridaySkillGenerationSession {
    const session = repo.getSession(sessionId);
    if (!session) {
      throw new FridayDomainError("GENERATOR_SESSION_NOT_FOUND", `Generation session not found: ${sessionId}`, { httpStatus: 404 });
    }
    return session;
  }

  // ─── Service methods ───

  return {
    async startSession(
      input: FridayStartSkillGenerationRequest,
    ): Promise<FridaySkillGenerationTurnResponse> {
      const now = deps.nowIso();
      const sessionId = deps.idGenerator();

      const session: FridaySkillGenerationSession = {
        sessionId,
        userId: input.userId,
        channel: input.channel,
        status: "collecting_requirements",
        goal: input.goal,
        specSummary: "",
        openQuestions: [],
        decisions: [],
        createdAt: now,
        updatedAt: now,
      };

      persistSession(session);

      // Add the initial user turn
      const userTurn: FridaySkillGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "user",
        content: input.goal,
        createdAt: now,
      };
      repo.addTurn(userTurn);

      // Run requirements analyzer
      const analyzerResult = await runRequirementsAnalyzer(
        session,
        [userTurn],
        input.requestedModel,
      );

      // Update session based on analyzer result
      const updatedSession: FridaySkillGenerationSession = {
        ...session,
        status:
          analyzerResult.state === "needs_clarification"
            ? "needs_clarification"
            : "generating",
        specSummary: analyzerResult.spec
          ? JSON.stringify(analyzerResult.spec)
          : session.specSummary,
        openQuestions: analyzerResult.questions ?? [],
        updatedAt: deps.nowIso(),
      };

      persistSession(updatedSession);

      // Add assistant turn with questions or spec
      const assistantContent =
        analyzerResult.state === "needs_clarification"
          ? analyzerResult.questions.join("\n")
          : "Requirements complete. Generating skill...";

      const assistantTurn: FridaySkillGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "assistant",
        content: assistantContent,
        createdAt: deps.nowIso(),
      };
      repo.addTurn(assistantTurn);

      // If ready for generation, run the pipeline
      if (analyzerResult.state === "ready_for_generation") {
        try {
          const draft = await runGenerationPipeline(
            updatedSession,
            analyzerResult.spec,
            input.requestedModel,
          );

          const finalSession: FridaySkillGenerationSession = {
            ...updatedSession,
            status: draft.validation.ok ? "ready_for_review" : "failed",
            draftSkillId: draft.manifest.id,
            updatedAt: deps.nowIso(),
          };
          persistSession(finalSession);

          return buildTurnResponse(finalSession, analyzerResult, draft);
        } catch (err) {
          const failedSession: FridaySkillGenerationSession = {
            ...updatedSession,
            status: "failed",
            updatedAt: deps.nowIso(),
          };
          persistSession(failedSession);

          return {
            session: failedSession,
            mode: "generation_failed",
            errors: [
              {
                code: "GENERATION_ERROR",
                severity: "error",
                message:
                  err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      }

      return buildTurnResponse(updatedSession, analyzerResult);
    },

    async submitTurn(
      sessionId: string,
      input: FridaySkillGenerationTurnRequest,
    ): Promise<FridaySkillGenerationTurnResponse> {
      const session = requireSession(sessionId);

      if (
        session.status === "approved" ||
        session.status === "saved" ||
        session.status === "cancelled"
      ) {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot submit turn to session in '${session.status}' status`,
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();

      // Add user turn
      const userTurn: FridaySkillGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "user",
        content: input.message,
        createdAt: now,
      };
      repo.addTurn(userTurn);

      // Get all turns for context
      const allTurns = repo.getTurns(sessionId);

      // Run requirements analyzer with updated conversation
      const analyzerResult = await runRequirementsAnalyzer(
        session,
        allTurns,
        input.requestedModel,
      );

      // Update session
      const updatedSession: FridaySkillGenerationSession = {
        ...session,
        status:
          analyzerResult.state === "needs_clarification"
            ? "needs_clarification"
            : "generating",
        specSummary: analyzerResult.spec
          ? JSON.stringify(analyzerResult.spec)
          : session.specSummary,
        openQuestions: analyzerResult.questions ?? [],
        decisions: [
          ...session.decisions,
          ...(analyzerResult.spec
            ? [`User provided: ${input.message}`]
            : []),
        ],
        updatedAt: deps.nowIso(),
      };

      persistSession(updatedSession);

      // Add assistant turn
      const assistantContent =
        analyzerResult.state === "needs_clarification"
          ? analyzerResult.questions.join("\n")
          : "Requirements complete. Generating skill...";

      const assistantTurn: FridaySkillGenerationTurn = {
        turnId: deps.idGenerator(),
        sessionId,
        role: "assistant",
        content: assistantContent,
        createdAt: deps.nowIso(),
      };
      repo.addTurn(assistantTurn);

      // If ready, generate
      if (analyzerResult.state === "ready_for_generation") {
        try {
          const draft = await runGenerationPipeline(
            updatedSession,
            analyzerResult.spec,
            input.requestedModel,
          );

          const finalSession: FridaySkillGenerationSession = {
            ...updatedSession,
            status: draft.validation.ok ? "ready_for_review" : "failed",
            draftSkillId: draft.manifest.id,
            updatedAt: deps.nowIso(),
          };
          persistSession(finalSession);

          return buildTurnResponse(finalSession, analyzerResult, draft);
        } catch (err) {
          const failedSession: FridaySkillGenerationSession = {
            ...updatedSession,
            status: "failed",
            updatedAt: deps.nowIso(),
          };
          persistSession(failedSession);

          return {
            session: failedSession,
            mode: "generation_failed",
            errors: [
              {
                code: "GENERATION_ERROR",
                severity: "error",
                message:
                  err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      }

      return buildTurnResponse(updatedSession, analyzerResult);
    },

    async getSession(sessionId: string) {
      const session = repo.getSession(sessionId);
      if (!session) return null;

      const turns = repo.getTurns(sessionId);
      const draft = loadDraft(sessionId);

      return { session, turns, draft };
    },

    async generateDraft(
      sessionId: string,
      requestedModel?: string,
    ): Promise<FridayGeneratedSkillDraft> {
      const session = requireSession(sessionId);

      if (
        session.status === "approved" ||
        session.status === "saved" ||
        session.status === "cancelled"
      ) {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot generate draft for session in '${session.status}' status`,
          { httpStatus: 409 },
        );
      }

      // Parse the current spec from specSummary
      let spec: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(session.specSummary);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error("Spec must be a plain object");
        }
        spec = parsed as Record<string, unknown>;
      } catch {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "No valid specification available. Continue the conversation to provide requirements.",
          { httpStatus: 400 },
        );
      }

      // Update status to generating
      const generatingSession: FridaySkillGenerationSession = {
        ...session,
        status: "generating",
        updatedAt: deps.nowIso(),
      };
      persistSession(generatingSession);

      try {
        const draft = await runGenerationPipeline(
          generatingSession,
          spec,
          requestedModel,
        );

        const finalSession: FridaySkillGenerationSession = {
          ...generatingSession,
          status: draft.validation.ok ? "ready_for_review" : "failed",
          draftSkillId: draft.manifest.id,
          updatedAt: deps.nowIso(),
        };
        persistSession(finalSession);

        return draft;
      } catch (err) {
        const failedSession: FridaySkillGenerationSession = {
          ...generatingSession,
          status: "failed",
          updatedAt: deps.nowIso(),
        };
        persistSession(failedSession);
        throw err;
      }
    },

    async approveAndSave(sessionId: string) {
      const session = requireSession(sessionId);

      if (session.status !== "ready_for_review") {
        throw new FridayDomainError(
          "STATE_CONFLICT",
          `Cannot approve session in '${session.status}' status. Must be 'ready_for_review'.`,
          { httpStatus: 409 },
        );
      }

      // Load draft from persistence (not in-memory)
      const draft = loadDraft(sessionId);
      if (!draft) {
        throw new FridayDomainError(
          "GENERATOR_DRAFT_NOT_FOUND",
          "No draft found for session. Generate a draft first.",
          { httpStatus: 404 },
        );
      }

      if (!draft.validation.ok) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Cannot approve a draft with validation errors.",
          { httpStatus: 422 },
        );
      }

      // Resolve skills directory
      const settings = await deps.configManager.getSkillRegistrySettings(
        ".",
      );
      const skillsDir = settings.managedSkillsDir;
      const skillId = draft.manifest.id;
      const finalSkillDir = resolveSafeInstallDir(skillsDir, skillId);
      const promotedManifest = withStabilizedLifecycleTags(draft.manifest);

      // ── Stage: Write to temp directory first ──
      const tempDir = join(tmpdir(), `friday-skill-${sessionId}`);
      mkdirSync(tempDir, { recursive: true });

      const savedFiles: string[] = [];

      try {
        // Write manifest
        const manifestPath = resolveSafePath(tempDir, "skill.manifest.json");
        mkdirSync(dirname(manifestPath), { recursive: true });
        writeFileSync(
          manifestPath,
          JSON.stringify(promotedManifest, null, 2),
          "utf-8",
        );
        savedFiles.push("skill.manifest.json");

        // Write UI schema
        const uiPath = resolveSafePath(tempDir, "skill.ui.json");
        mkdirSync(dirname(uiPath), { recursive: true });
        writeFileSync(
          uiPath,
          JSON.stringify(draft.uiSchema, null, 2),
          "utf-8",
        );
        savedFiles.push("skill.ui.json");

        // Write generated files
        for (const file of draft.files) {
          const filePath = resolveSafePath(tempDir, file.path);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, file.content, "utf-8");
          savedFiles.push(file.path);

          // chmod +x shell files (.sh extension or executable metadata)
          const ext = extname(file.path).toLowerCase();
          if (ext === ".sh" || ext === ".bash" || file.executable) {
            chmodSync(filePath, 0o755);
          }
        }

        // ── Stage: Validate package in temp dir ──
        const loadResult = loadFridaySkillPackage({
          skillDir: tempDir,
          workspaceDir: skillsDir,
        });

        if (!loadResult.ok) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `Package load failed in staging directory: ${loadResult.error.message}`,
            { httpStatus: 422 },
          );
        }

        const packageValidation = validateFridaySkillPackage({
          loaded: loadResult.value,
          workspaceDir: skillsDir,
          hubVersion: FRIDAY_HUB_COMPAT_VERSION,
          supportedApiVersions: SUPPORTED_API_VERSIONS,
        });

        if (!packageValidation.ok) {
          const errors = packageValidation.issues
            .filter((i) => i.severity === "error")
            .map((i) => i.message)
            .join("; ");
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `Package validation failed: ${errors}`,
            { httpStatus: 422 },
          );
        }

        // ── Stage: Move from temp to final directory ──
        mkdirSync(finalSkillDir, { recursive: true });

        // Build a set of paths that have the executable metadata flag
        const executablePaths = new Set(
          draft.files
            .filter((f) => f.executable)
            .map((f) => f.path),
        );

        // Copy files from temp to final (renameSync can fail across mounts)
        for (const relPath of savedFiles) {
          const src = join(tempDir, relPath);
          const dest = resolveSafePath(finalSkillDir, relPath);
          mkdirSync(dirname(dest), { recursive: true });
          const content = readFileSync(src);
          writeFileSync(dest, content);

          // Preserve executable permissions — check both extension and metadata
          const ext = extname(relPath).toLowerCase();
          if (ext === ".sh" || ext === ".bash" || executablePaths.has(relPath)) {
            chmodSync(dest, 0o755);
          }
        }
      } finally {
        // ── Stage: Clean up temp dir ──
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }

      // Update session status
      const approvedSession: FridaySkillGenerationSession = {
        ...session,
        status: "approved",
        updatedAt: deps.nowIso(),
      };
      persistSession(approvedSession);

      // Update lifecycle status to "installed"
      await deps.memoryStateService.updateSkillStatus(
        skillId,
        "installed",
      );

      // Save final status
      const savedSession: FridaySkillGenerationSession = {
        ...approvedSession,
        status: "saved",
        updatedAt: deps.nowIso(),
      };
      persistSession(savedSession);

      // Refresh the skill registry
      let registryRefreshed = false;
      try {
        await deps.registry.refresh();
        registryRefreshed = true;
      } catch {
        // Non-fatal — skill is saved but registry didn't refresh
      }

      // Clean up persisted draft
      deleteDraft(sessionId);

      return {
        sessionId,
        skillId,
        skillDir: finalSkillDir,
        savedFiles,
        registryRefreshed,
        promotionStage: "stabilized",
        promotedManifestTags: promotedManifest.tags,
        evidence: {
          packageLoaded: true,
          packageValidated: true,
          registryRefreshed,
        },
      };
    },

    async cancelSession(sessionId: string): Promise<void> {
      const session = requireSession(sessionId);

      if (session.status === "saved") {
        throw new FridayDomainError("STATE_CONFLICT", "Cannot cancel a session that is already saved.", { httpStatus: 409 });
      }

      const cancelledSession: FridaySkillGenerationSession = {
        ...session,
        status: "cancelled",
        updatedAt: deps.nowIso(),
      };
      persistSession(cancelledSession);

      // Clean up persisted draft
      deleteDraft(sessionId);
    },
  };
}
