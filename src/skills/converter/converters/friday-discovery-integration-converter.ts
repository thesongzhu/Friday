/**
 * Discovery Integration Converter.
 *
 * Handles structured contentBase64 payloads carrying the namespaced
 * schema `friday.discovery.integration.candidate-source.v1`. Detects
 * as format `"friday-package"` and builds a valid SkillManifestV2
 * draft without widening the source format union.
 */

import { Buffer } from "node:buffer";

import { FridayDomainError } from "#errors";

import type {
  FridayConvertedSkillDraft,
  FridayConvertedSkillFile,
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";
import type {
  SkillKind,
  SkillManifestV2,
  SkillRuntimeKind,
} from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";
import type { FridayIntegrationPath } from "../discovery/friday-program-discovery.types.js";

const CONVERTER_ID = "discovery-integration";
const CONVERTER_DISPLAY_NAME = "Discovery Integration";
const CONVERTER_PRIORITY = 90;
const PAYLOAD_SCHEMA = "friday.discovery.integration.candidate-source.v1";
const INTEGRATION_PATHS = new Set<FridayIntegrationPath>([
  "code-repo",
  "rest-api",
  "web-flow",
  "desktop-recording",
  "desktop-control",
]);
const SKILL_KINDS = new Set<SkillKind>(["conversation", "workflow", "system"]);
const RUNTIME_KINDS = new Set<SkillRuntimeKind>(["builtin", "node", "python", "shell", "remote-http"]);

export interface FridayDiscoveryIntegrationPayload {
  readonly $schema: typeof PAYLOAD_SCHEMA;
  readonly programId: string;
  readonly programName: string;
  readonly programCategory: string;
  readonly integrationPath: FridayIntegrationPath;
  readonly skillId: string;
  readonly skillName: string;
  readonly skillDescription: string;
  readonly skillVersion: string;
  readonly skillKind: "conversation" | "workflow" | "system";
  readonly runtimeKind: "builtin" | "node" | "python" | "shell" | "remote-http";
  readonly runtimeEntrypoint: string;
  readonly tags: readonly string[];
  readonly recommendationConfidence: number;
  readonly recommendationRationale: string;
}

export function createFridayDiscoveryIntegrationConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      const payload = tryDecodePayload(source);
      if (!payload) return null;
      return {
        converterId: CONVERTER_ID,
        format: "friday-package",
        confidence: 1.0,
        reasons: [`contentBase64 payload matches schema ${PAYLOAD_SCHEMA}`],
      };
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      const payload = tryDecodePayload(source);
      if (!payload) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Discovery integration converter requires a valid contentBase64 payload",
          { httpStatus: 400 },
        );
      }

      const manifest = buildManifest(payload);
      const uiSchema = buildMinimalUiSchema(manifest);
      const entrypointFile = buildEntrypointFile(payload);
      const conversionReportFile: FridayConvertedSkillFile = {
        path: "conversion.report.json",
        content: JSON.stringify({
          sourceFormat: "friday-package",
          convertedAt: ctx.nowIso(),
          converterId: CONVERTER_ID,
          discoveryPayloadSchema: PAYLOAD_SCHEMA,
          programId: payload.programId,
          integrationPath: payload.integrationPath,
        }, null, 2),
      };
      const manifestFile: FridayConvertedSkillFile = {
        path: "skill.manifest.json",
        content: JSON.stringify(manifest, null, 2),
      };
      const uiSchemaFile: FridayConvertedSkillFile = {
        path: "skill.ui.json",
        content: JSON.stringify(uiSchema, null, 2),
      };

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files: [manifestFile, uiSchemaFile, entrypointFile, conversionReportFile],
        warnings: [],
        conversionReport: {
          sourceFormat: "friday-package",
          convertedAt: ctx.nowIso(),
          converterId: CONVERTER_ID,
        },
      };

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "friday-package",
        drafts: [draft],
      };
    },
  };
}

function tryDecodePayload(source: FridaySkillConversionSource): FridayDiscoveryIntegrationPayload | null {
  if (!source.contentBase64) return null;
  try {
    const decoded = Buffer.from(source.contentBase64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (parsed.$schema !== PAYLOAD_SCHEMA) return null;
    if (!isSafePayloadIdentifier(parsed.programId)) return null;
    if (!isNonEmptyString(parsed.programName)) return null;
    if (!isNonEmptyString(parsed.programCategory)) return null;
    if (!isIntegrationPath(parsed.integrationPath)) return null;
    if (!isSafePayloadIdentifier(parsed.skillId)) return null;
    if (!isNonEmptyString(parsed.skillName)) return null;
    if (!isNonEmptyString(parsed.skillDescription)) return null;
    if (!isNonEmptyString(parsed.skillVersion)) return null;
    if (!isNonEmptyString(parsed.skillKind) || !SKILL_KINDS.has(parsed.skillKind as SkillKind)) return null;
    if (!isNonEmptyString(parsed.runtimeKind) || !RUNTIME_KINDS.has(parsed.runtimeKind as SkillRuntimeKind)) return null;
    if (!isNonEmptyString(parsed.runtimeEntrypoint)) return null;
    if (!Array.isArray(parsed.tags) || !parsed.tags.every(isNonEmptyString)) return null;
    if (typeof parsed.recommendationConfidence !== "number" || !Number.isFinite(parsed.recommendationConfidence)) return null;
    if (!isNonEmptyString(parsed.recommendationRationale)) return null;
    return parsed as unknown as FridayDiscoveryIntegrationPayload;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafePayloadIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && !value.includes("/") && !value.includes("\\");
}

function isIntegrationPath(value: unknown): value is FridayIntegrationPath {
  return isNonEmptyString(value) && INTEGRATION_PATHS.has(value as FridayIntegrationPath);
}

function buildManifest(payload: FridayDiscoveryIntegrationPayload): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: payload.skillId,
    name: payload.skillName,
    description: payload.skillDescription,
    version: payload.skillVersion,
    kind: payload.skillKind,
    category: mapToSkillCategory(payload.programCategory),
    author: { name: "friday-discovery" },
    tags: [...payload.tags],
    runtime: {
      kind: payload.runtimeKind,
      entrypoint: payload.runtimeEntrypoint,
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [`discovery.${payload.programId}`],
      phrases: [`use ${payload.programName}`],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs: [],
    outputs: [
      { key: "result", type: "object", description: "Integration result" },
    ],
    permissions: {
      grants: [],
      promptOn: [],
    },
    executionTargets: {
      allowedSatelliteTypes: ["desktop"],
      requiredCapabilities: [],
    },
  };
}

function mapToSkillCategory(programCategory: string): SkillManifestV2["category"] {
  const mapping: Record<string, SkillManifestV2["category"]> = {
    browser: "browser",
    editor: "utility",
    terminal: "utility",
    communication: "communication",
    media: "media",
    productivity: "utility",
    development: "utility",
    database: "integration",
    cloud: "integration",
    security: "utility",
    automation: "automation",
    design: "media",
    finance: "utility",
    system: "utility",
  };
  return mapping[programCategory] ?? "integration";
}

function buildMinimalUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [{ id: "main", label: "Configuration", fieldIds: [] }],
    fields: [],
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: "text" as const,
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function buildEntrypointFile(payload: FridayDiscoveryIntegrationPayload): FridayConvertedSkillFile {
  const content = [
    "#!/usr/bin/env sh",
    `# Discovery integration stub for ${payload.programName}`,
    `# Integration path: ${payload.integrationPath}`,
    `echo '{"status":"staged","programId":"${payload.programId}","integrationPath":"${payload.integrationPath}"}'`,
    "",
  ].join("\n");
  return {
    path: payload.runtimeEntrypoint,
    content,
    executable: true,
  };
}
