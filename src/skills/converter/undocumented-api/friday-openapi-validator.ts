import type { FridayOpenApiValidationResult } from "./friday-undocumented-api.types.js";

export function validateFridayOpenApi(spec: unknown): FridayOpenApiValidationResult {
  const issues: string[] = [];
  if (!spec || typeof spec !== "object") {
    return { ok: false, issues: ["Synthesized OpenAPI spec is not an object."] };
  }

  const record = spec as Record<string, unknown>;
  if (typeof record.openapi !== "string" || !record.openapi.startsWith("3.")) {
    issues.push("OpenAPI version must start with 3.x.");
  }

  if (!record.info || typeof record.info !== "object") {
    issues.push("info object is required.");
  } else {
    const info = record.info as Record<string, unknown>;
    if (typeof info.title !== "string" || info.title.trim() === "") {
      issues.push("info.title is required.");
    }
    if (typeof info.version !== "string" || info.version.trim() === "") {
      issues.push("info.version is required.");
    }
  }

  if (!record.paths || typeof record.paths !== "object") {
    issues.push("paths object is required.");
  } else if (Object.keys(record.paths as Record<string, unknown>).length === 0) {
    issues.push("paths must contain at least one endpoint.");
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

