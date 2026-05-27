/**
 * Link evidence → Friday package converter.
 *
 * Converts a redacted, evidence-only link summary payload into a deterministic
 * shell skill candidate. The generated skill does not fetch the URL at run
 * time; it carries the extracted evidence forward for review and lifecycle
 * promotion.
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
import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";

const CONVERTER_ID = "link-evidence-skill";
const CONVERTER_DISPLAY_NAME = "Link Evidence Skill";
const CONVERTER_PRIORITY = 95;
export const FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA = "friday.link-to-skill.candidate-source.v1";

export interface FridayLinkEvidenceSkillPayload {
  readonly $schema: typeof FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA;
  readonly sourceDigest: string;
  readonly redactedUrl: string;
  readonly title: string | null;
  readonly summary: string;
  readonly contentType: string | null;
  readonly skillId: string;
  readonly skillName: string;
  readonly skillDescription: string;
  readonly skillVersion: string;
}

export function createFridayLinkEvidenceSkillConverter(): FridaySkillConverter {
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
        reasons: [`contentBase64 payload matches schema ${FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA}`],
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
          "Link evidence skill converter requires a valid contentBase64 payload",
          { httpStatus: 400 },
        );
      }

      const manifest = buildManifest(payload);
      const uiSchema = buildUiSchema(manifest);
      const entrypointFile = buildEntrypointFile(payload);
      const conversionReportFile: FridayConvertedSkillFile = {
        path: "conversion.report.json",
        content: JSON.stringify({
          sourceFormat: "friday-package",
          convertedAt: ctx.nowIso(),
          converterId: CONVERTER_ID,
          linkEvidencePayloadSchema: FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA,
          sourceDigest: payload.sourceDigest,
          redactedUrl: payload.redactedUrl,
          title: payload.title,
          contentType: payload.contentType,
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
      const evidenceFile: FridayConvertedSkillFile = {
        path: "LINK_EVIDENCE.md",
        content: [
          `# ${payload.skillName}`,
          "",
          `Source: ${payload.redactedUrl}`,
          payload.title ? `Title: ${payload.title}` : undefined,
          "",
          payload.summary,
          "",
        ].filter((line): line is string => line !== undefined).join("\n"),
      };

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files: [manifestFile, uiSchemaFile, entrypointFile, evidenceFile, conversionReportFile],
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

function tryDecodePayload(source: FridaySkillConversionSource): FridayLinkEvidenceSkillPayload | null {
  if (!source.contentBase64) return null;
  try {
    const decoded = Buffer.from(source.contentBase64, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (parsed.$schema !== FRIDAY_LINK_EVIDENCE_SKILL_PAYLOAD_SCHEMA) return null;
    if (!isSha256Hex(parsed.sourceDigest)) return null;
    if (!isRedactedHttpUrl(parsed.redactedUrl)) return null;
    if (parsed.title !== null && parsed.title !== undefined && !isNonEmptyString(parsed.title)) return null;
    if (!isNonEmptyString(parsed.summary)) return null;
    if (parsed.contentType !== null && parsed.contentType !== undefined && typeof parsed.contentType !== "string") return null;
    if (!isSafePayloadIdentifier(parsed.skillId)) return null;
    if (!isNonEmptyString(parsed.skillName)) return null;
    if (!isNonEmptyString(parsed.skillDescription)) return null;
    if (!isSafeVersion(parsed.skillVersion)) return null;
    return {
      ...parsed,
      title: parsed.title ?? null,
      contentType: parsed.contentType ?? null,
    } as unknown as FridayLinkEvidenceSkillPayload;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafePayloadIdentifier(value: unknown): value is string {
  return isNonEmptyString(value) && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSafeVersion(value: unknown): value is string {
  return isNonEmptyString(value) && /^[0-9A-Za-z._:-]+$/.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isRedactedHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function buildManifest(payload: FridayLinkEvidenceSkillPayload): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: payload.skillId,
    name: payload.skillName,
    description: payload.skillDescription,
    version: payload.skillVersion,
    kind: "conversation",
    category: "utility",
    author: { name: "friday-link-to-skill" },
    tags: ["link-to-skill", "evidence-derived"],
    runtime: {
      kind: "shell",
      entrypoint: "run.sh",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 5_000,
    },
    triggers: {
      intents: [`link_to_skill.${payload.skillId}`],
      phrases: [`use ${payload.skillName}`],
      channels: ["*"],
    },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [],
    outputs: [{ key: "result", type: "object", description: "Extracted link evidence result" }],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["desktop", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildUiSchema(manifest: SkillManifestV2): FridaySkillUiSchemaV1 {
  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [{ id: "main", label: "Evidence", fieldIds: [] }],
    fields: [],
    outputs: manifest.outputs.map((output) => ({
      id: `output-${output.key}`,
      outputKey: output.key,
      label: output.description ?? output.key,
      widget: "text",
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function buildEntrypointFile(payload: FridayLinkEvidenceSkillPayload): FridayConvertedSkillFile {
  const result = {
    status: "link_evidence_ready",
    sourceDigest: payload.sourceDigest,
    redactedUrl: payload.redactedUrl,
    title: payload.title,
    summary: payload.summary,
  };
  const content = [
    "#!/usr/bin/env sh",
    `# Link evidence skill generated from ${shellCommentText(payload.redactedUrl)}`,
    `printf '%s\\n' ${shellSingleQuote(JSON.stringify(result))}`,
    "",
  ].join("\n");
  return {
    path: "run.sh",
    content,
    executable: true,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellCommentText(value: string): string {
  return value.replace(/[\r\n\0]/g, " ");
}
