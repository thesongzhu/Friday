import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import type { SkillManifestV2 } from "../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillValidationIssue } from "./friday-skill-validation.types.js";

export interface FridayCompiledSkillSchemas {
  input?: ValidateFunction<unknown>;
  state?: ValidateFunction<unknown>;
  output?: ValidateFunction<unknown>;
}

export interface CompileFridaySkillSchemasOptions {
  manifest: SkillManifestV2;
  skillDir: string;
  ajv?: Ajv.default;
}

/** Compiles input/state/output schemas declared by manifest into AJV validators. */
export function compileFridaySkillSchemas(
  options: CompileFridaySkillSchemasOptions,
): { compiled: FridayCompiledSkillSchemas; issues: FridaySkillValidationIssue[] } {
  const { manifest, skillDir } = options;
  // SAFETY: ESM/CJS interop — Ajv may export as { default: Ajv } or as Ajv directly
  const AjvConstructor = (Ajv as unknown as { default: typeof Ajv.default }).default ?? Ajv;
  const ajv = options.ajv ?? new AjvConstructor({ allErrors: true });
  const compiled: FridayCompiledSkillSchemas = {};
  const issues: FridaySkillValidationIssue[] = [];

  if (!manifest.schemas) {
    return { compiled, issues };
  }

  const schemaSlots: Array<{ key: keyof FridayCompiledSkillSchemas; path: string | null }> = [
    { key: "input", path: manifest.schemas.input },
    { key: "state", path: manifest.schemas.state },
    { key: "output", path: manifest.schemas.output },
  ];

  for (const { key, path } of schemaSlots) {
    if (!path) continue;

    const fullPath = join(skillDir, path);

    if (!existsSync(fullPath)) {
      issues.push({
        stage: "schema-compile",
        severity: "error",
        code: "SCHEMA_FILE_NOT_FOUND",
        message: `Schema file not found: ${fullPath}`,
        path: `schemas.${key}`,
      });
      continue;
    }

    let schemaText: string;
    try {
      schemaText = readFileSync(fullPath, "utf-8");
    } catch (cause) {
      issues.push({
        stage: "schema-compile",
        severity: "error",
        code: "SCHEMA_READ_FAILED",
        message: `Failed to read schema file: ${fullPath}`,
        path: `schemas.${key}`,
      });
      continue;
    }

    let schemaObj: unknown;
    try {
      schemaObj = JSON.parse(schemaText);
    } catch {
      issues.push({
        stage: "schema-compile",
        severity: "error",
        code: "SCHEMA_PARSE_FAILED",
        message: `Invalid JSON in schema file: ${fullPath}`,
        path: `schemas.${key}`,
      });
      continue;
    }

    try {
      compiled[key] = ajv.compile(schemaObj as Record<string, unknown>);
    } catch (cause) {
      issues.push({
        stage: "schema-compile",
        severity: "error",
        code: "SCHEMA_COMPILE_FAILED",
        message: `Failed to compile schema: ${fullPath} — ${cause instanceof Error ? cause.message : String(cause)}`,
        path: `schemas.${key}`,
      });
    }
  }

  return { compiled, issues };
}
