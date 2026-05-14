/**
 * Discovery Integration Bridge.
 *
 * Converts a real program recommendation into a structured contentBase64
 * source suitable for the discovery integration converter. Redacts raw
 * executable paths and path-like program identifiers to avoid leakage in API
 * responses and staged candidate provenance.
 */

import { createHash } from "node:crypto";

import type {
  FridayDiscoveredProgram,
  FridayIntegrationRecommendation,
} from "./friday-program-discovery.types.js";
import type { FridaySkillConversionSource } from "../model/friday-skill-converter.types.js";
import type { FridayDiscoveryIntegrationPayload } from "../converters/friday-discovery-integration-converter.js";

const PAYLOAD_SCHEMA = "friday.discovery.integration.candidate-source.v1";

export interface FridayDiscoveryIntegrationBridgeInput {
  readonly program: FridayDiscoveredProgram;
  readonly recommendation: FridayIntegrationRecommendation;
}

export interface FridayDiscoveryIntegrationBridgeResult {
  readonly source: FridaySkillConversionSource;
  readonly payload: FridayDiscoveryIntegrationPayload;
  readonly redactedProgramId: string;
  readonly redactedProgramName: string;
}

export function buildDiscoveryIntegrationSource(
  input: FridayDiscoveryIntegrationBridgeInput,
): FridayDiscoveryIntegrationBridgeResult {
  const { program, recommendation } = input;
  const programRef = redactProgramIdentifier(program.id);
  const skillId = `discovery-${programRef}`;
  const skillName = `${program.name} Integration`;

  const payload: FridayDiscoveryIntegrationPayload = {
    $schema: PAYLOAD_SCHEMA,
    programId: programRef,
    programName: program.name,
    programCategory: program.category,
    integrationPath: recommendation.integrationPath,
    skillId,
    skillName,
    skillDescription: `Discovered integration for ${program.name} via ${recommendation.integrationPath} path.`,
    skillVersion: "1.0.0",
    skillKind: "conversation",
    runtimeKind: "shell",
    runtimeEntrypoint: "run.sh",
    tags: [
      "discovery",
      `integration-path:${recommendation.integrationPath}`,
      `category:${program.category}`,
    ],
    recommendationConfidence: recommendation.confidence,
    recommendationRationale: recommendation.rationale,
  };

  const contentBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");

  return {
    source: { contentBase64, formatHint: "friday-package" },
    payload,
    redactedProgramId: programRef,
    redactedProgramName: program.name,
  };
}

function sanitizeId(raw: string): string {
  const normalized = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "program").slice(0, 64);
}

function redactProgramIdentifier(raw: string): string {
  if (isPathLike(raw)) {
    return `local-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  }
  return sanitizeId(raw);
}

function isPathLike(raw: string): boolean {
  return raw.includes("/") || raw.includes("\\");
}
