/**
 * REST routes for the skill converter subsystem.
 *
 * GET  /v1/skills/converters — list available converters
 * POST /v1/skills/convert    — convert source to drafts (no install)
 * POST /v1/skills/import     — convert + install + refresh registry
 * POST /v1/skills/pack       — pack skill dir into .friday.tgz
 */

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import {
  FRIDAY_SKILL_SOURCE_FORMAT_HINTS,
  summarizeFridaySkillConversionQuality,
} from "#skills/converter";
import type {
  FridaySkillConversionSource,
  FridaySkillConverterService,
  FridaySkillSourceFormat,
} from "#skills/converter";
import type {
  FridayApiConvertResponse,
  FridayApiImportResponse,
  FridayApiListConvertersResponse,
  FridayApiPackResponse,
} from "../../model/friday-api-skill-converter.types.js";

// ─── Source format constants ───

const VALID_SOURCE_FORMATS = new Set<string>(FRIDAY_SKILL_SOURCE_FORMAT_HINTS);

// ─── Validation helpers ───

function validateConvertBody(
  body: unknown,
): asserts body is {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  dryRun?: boolean;
  options?: { splitOperations?: boolean; skillIdPrefix?: string };
} {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.source == null || typeof b.source !== "object") {
    errors.push("source is required and must be an object");
  } else {
    const src = b.source as Record<string, unknown>;
    if (src.uri === undefined && src.contentBase64 === undefined) {
      errors.push("source must include uri or contentBase64");
    }
    if (src.uri !== undefined && typeof src.uri !== "string") {
      errors.push("source.uri must be a string");
    }
    if (src.contentBase64 !== undefined && typeof src.contentBase64 !== "string") {
      errors.push("source.contentBase64 must be a string");
    }
    if (src.formatHint !== undefined) {
      if (typeof src.formatHint !== "string" || !VALID_SOURCE_FORMATS.has(src.formatHint)) {
        errors.push(`source.formatHint must be one of: ${[...VALID_SOURCE_FORMATS].join(", ")}`);
      }
    }
  }

  if (b.formatHint !== undefined) {
    if (typeof b.formatHint !== "string" || !VALID_SOURCE_FORMATS.has(b.formatHint)) {
      errors.push(`formatHint must be one of: ${[...VALID_SOURCE_FORMATS].join(", ")}`);
    }
  }

  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") {
    errors.push("dryRun must be a boolean");
  }

  if (b.options !== undefined) {
    if (typeof b.options !== "object" || b.options === null) {
      errors.push("options must be an object");
    } else {
      const opts = b.options as Record<string, unknown>;
      if (opts.splitOperations !== undefined && typeof opts.splitOperations !== "boolean") {
        errors.push("options.splitOperations must be a boolean");
      }
      if (opts.skillIdPrefix !== undefined && typeof opts.skillIdPrefix !== "string") {
        errors.push("options.skillIdPrefix must be a string");
      }
    }
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validateImportBody(
  body: unknown,
): asserts body is {
  source: FridaySkillConversionSource;
  formatHint?: FridaySkillSourceFormat | "auto";
  target?: "managed" | "workspace" | { path: string };
  replace?: boolean;
  refreshRegistry?: boolean;
} {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (b.source == null || typeof b.source !== "object") {
    errors.push("source is required and must be an object");
  } else {
    const src = b.source as Record<string, unknown>;
    if (src.uri === undefined && src.contentBase64 === undefined) {
      errors.push("source must include uri or contentBase64");
    }
    if (src.uri !== undefined && typeof src.uri !== "string") {
      errors.push("source.uri must be a string");
    }
    if (src.contentBase64 !== undefined && typeof src.contentBase64 !== "string") {
      errors.push("source.contentBase64 must be a string");
    }
  }

  if (b.formatHint !== undefined) {
    if (typeof b.formatHint !== "string" || !VALID_SOURCE_FORMATS.has(b.formatHint)) {
      errors.push(`formatHint must be one of: ${[...VALID_SOURCE_FORMATS].join(", ")}`);
    }
  }

  if (b.target !== undefined) {
    if (typeof b.target === "string") {
      if (b.target !== "managed" && b.target !== "workspace") {
        errors.push("target must be 'managed', 'workspace', or an object with a path property");
      }
    } else if (typeof b.target === "object" && b.target !== null) {
      const t = b.target as Record<string, unknown>;
      if (typeof t.path !== "string" || t.path.trim() === "") {
        errors.push("target.path must be a non-empty string");
      }
    } else {
      errors.push("target must be 'managed', 'workspace', or an object with a path property");
    }
  }

  if (b.replace !== undefined && typeof b.replace !== "boolean") {
    errors.push("replace must be a boolean");
  }

  if (b.refreshRegistry !== undefined && typeof b.refreshRegistry !== "boolean") {
    errors.push("refreshRegistry must be a boolean");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

function validatePackBody(
  body: unknown,
): asserts body is { skillDir: string; outputFile: string } {
  if (body == null || typeof body !== "object") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Request body is required",
      { httpStatus: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof b.skillDir !== "string" || b.skillDir.trim() === "") {
    errors.push("skillDir is required and must be a non-empty string");
  }

  if (typeof b.outputFile !== "string" || b.outputFile.trim() === "") {
    errors.push("outputFile is required and must be a non-empty string");
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `Invalid request body: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }
}

// ─── Dependencies ───

export interface FridaySkillConverterRoutesDeps {
  converterService: FridaySkillConverterService;
}

// ─── Factory ───

export function createFridaySkillConverterRoutes(
  deps: FridaySkillConverterRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    // ─── List converters ───
    {
      operationId: "skills.converters.list",
      method: "GET",
      path: "/v1/skills/converters",
      auth: { public: false, anyOfScopes: ["skill.read"] },
      async handler(): Promise<FridayApiListConvertersResponse> {
        const converters = deps.converterService.listConverters();
        return { converters };
      },
    },

    // ─── Convert source (no install) ───
    {
      operationId: "skills.convert",
      method: "POST",
      path: "/v1/skills/convert",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_converter.write",
      async handler(ctx): Promise<FridayApiConvertResponse> {
        validateConvertBody(ctx.body);
        const body = ctx.body;
        const result = await deps.converterService.convert({
          source: body.source,
          formatHint: body.formatHint,
          dryRun: body.dryRun,
          options: body.options,
        });
        const quality = result.quality
          ?? summarizeFridaySkillConversionQuality(result.validation);
        return {
          converterId: result.converterId,
          detectedFormat: result.detectedFormat,
          drafts: result.drafts,
          validation: result.validation,
          quality,
        };
      },
    },

    // ─── Import (convert + install + refresh) ───
    {
      operationId: "skills.import",
      method: "POST",
      path: "/v1/skills/import",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_converter.write",
      async handler(ctx): Promise<FridayApiImportResponse> {
        validateImportBody(ctx.body);
        const body = ctx.body;

        // Resolve target — the body may contain a string or an object with path
        let target: "managed" | "workspace" | { path: string } | undefined;
        if (body.target !== undefined) {
          if (typeof body.target === "string") {
            target = body.target;
          } else {
            target = body.target;
          }
        }

        const result = await deps.converterService.import({
          source: body.source,
          formatHint: body.formatHint,
          target,
          replace: body.replace,
          refreshRegistry: body.refreshRegistry,
        });

        return {
          converterId: result.converterId,
          detectedFormat: result.detectedFormat,
          imports: result.imports,
          registryRefreshed: result.registryRefreshed,
        };
      },
    },

    // ─── Pack skill ───
    {
      operationId: "skills.pack",
      method: "POST",
      path: "/v1/skills/pack",
      auth: { public: false, anyOfScopes: ["skill.write"] },
      rateLimitPolicyId: "skill_converter.write",
      async handler(ctx): Promise<FridayApiPackResponse> {
        validatePackBody(ctx.body);
        const body = ctx.body;
        const result = await deps.converterService.pack({
          skillDir: body.skillDir,
          outputFile: body.outputFile,
        });
        return {
          packageFile: result.packageFile,
          checksumSha256: result.checksumSha256,
        };
      },
    },
  ];
}
