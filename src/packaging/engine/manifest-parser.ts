/**
 * Manifest Parser — Parse and validate package manifest files.
 *
 * Supports both JSON and simplified YAML-like formats. Validates all
 * required fields, types, and constraints against the FridayPackageManifest
 * schema defined in the domain model.
 *
 * @module packaging/engine/manifest-parser
 */

import type {
  FridayPackageAssets,
  FridayPackageAuthor,
  FridayPackageHooks,
  FridayPackageManifest,
  FridayPackageMetadata,
} from "../model/friday-packaging.types.js";
import { isValidSemver, isValidSemverRange, satisfiesRange } from "./semver.js";

// ─── Validation Error ───

/** A single manifest validation error with a field path. */
export interface ManifestValidationError {
  readonly path: string;
  readonly message: string;
}

/** Result of parsing a manifest. */
export interface ManifestParseResult {
  readonly success: boolean;
  readonly manifest: FridayPackageManifest | null;
  readonly errors: readonly ManifestValidationError[];
}

// ─── Name Pattern ───

/** Scoped package name pattern: @scope/name or plain name. */
const PACKAGE_NAME_RE = /^(@[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*$/;

/** Capability format: type:name. */
const CAPABILITY_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

// ─── Internal Helpers ───

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (isObject(value)) {
    const normalized: Record<string, unknown> = {};
    const sortedKeys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    for (const key of sortedKeys) {
      normalized[key] = canonicalizeJson(value[key]);
    }
    return normalized;
  }
  return value;
}

// ─── Field Validators ───

function validateName(value: unknown, errors: ManifestValidationError[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path: "name", message: "Must be a non-empty string" });
    return null;
  }
  if (!PACKAGE_NAME_RE.test(value)) {
    errors.push({
      path: "name",
      message: "Must be a valid scoped package name (e.g. @friday/my-package or my-package)",
    });
    return null;
  }
  return value;
}

function validateVersion(value: unknown, errors: ManifestValidationError[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path: "version", message: "Must be a non-empty string" });
    return null;
  }
  if (!isValidSemver(value)) {
    errors.push({ path: "version", message: "Must be a valid semantic version (e.g. 1.2.3)" });
    return null;
  }
  return value;
}

function validateDescription(value: unknown, errors: ManifestValidationError[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path: "description", message: "Must be a non-empty string" });
    return null;
  }
  return value;
}

function validateAuthor(value: unknown, errors: ManifestValidationError[]): FridayPackageAuthor | null {
  if (!isObject(value)) {
    errors.push({ path: "author", message: "Must be an object" });
    return null;
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    errors.push({ path: "author.name", message: "Must be a non-empty string" });
    return null;
  }
  if (value.email !== undefined && typeof value.email !== "string") {
    errors.push({ path: "author.email", message: "Must be a string" });
  }
  if (value.url !== undefined && typeof value.url !== "string") {
    errors.push({ path: "author.url", message: "Must be a string" });
  }
  return {
    name: value.name as string,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

function validateCapabilities(value: unknown, errors: ManifestValidationError[]): readonly string[] {
  if (!Array.isArray(value)) {
    errors.push({ path: "capabilities", message: "Must be an array" });
    return [];
  }
  const valid: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || !CAPABILITY_RE.test(value[i])) {
      errors.push({
        path: `capabilities[${i}]`,
        message: "Must match format type:name (e.g. skill:web-search)",
      });
    } else {
      valid.push(value[i]);
    }
  }
  return valid;
}

function validateDependencyMap(
  value: unknown,
  fieldPath: string,
  errors: ManifestValidationError[],
): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) {
    errors.push({ path: fieldPath, message: "Must be an object" });
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      errors.push({ path: `${fieldPath}.${key}`, message: "Must be a semver range string" });
    } else if (!isValidSemverRange(val)) {
      errors.push({ path: `${fieldPath}.${key}`, message: "Must be a valid semver range" });
    } else {
      result[key] = val;
    }
  }
  return result;
}

function validateFridayVersionRange(value: unknown, errors: ManifestValidationError[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path: "fridayVersionRange", message: "Must be a non-empty string" });
    return null;
  }
  if (!isValidSemverRange(value)) {
    errors.push({ path: "fridayVersionRange", message: "Must be a valid semver range" });
    return null;
  }
  return value;
}

function validateAssets(value: unknown, errors: ManifestValidationError[]): FridayPackageAssets {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) {
    errors.push({ path: "assets", message: "Must be an object" });
    return {};
  }
  const result: Record<string, readonly string[]> = {};
  const allowed = ["skills", "rules", "playbooks", "providers"] as const;
  for (const key of allowed) {
    if (value[key] !== undefined) {
      if (!isStringArray(value[key])) {
        errors.push({ path: `assets.${key}`, message: "Must be an array of strings" });
      } else {
        result[key] = value[key] as string[];
      }
    }
  }
  return result as FridayPackageAssets;
}

function validateHooks(value: unknown, errors: ManifestValidationError[]): FridayPackageHooks | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) {
    errors.push({ path: "hooks", message: "Must be an object" });
    return undefined;
  }
  const result: Record<string, string | null | undefined> = {};
  const allowed = ["preInstall", "postInstall", "preUninstall", "postUninstall"] as const;
  for (const key of allowed) {
    if (value[key] !== undefined) {
      if (value[key] !== null && typeof value[key] !== "string") {
        errors.push({ path: `hooks.${key}`, message: "Must be a string or null" });
      } else {
        result[key] = value[key] as string | null;
      }
    }
  }
  return result as FridayPackageHooks;
}

function validateMetadata(value: unknown, errors: ManifestValidationError[]): FridayPackageMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) {
    errors.push({ path: "metadata", message: "Must be an object" });
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (value.repository !== undefined) {
    if (typeof value.repository !== "string") {
      errors.push({ path: "metadata.repository", message: "Must be a string" });
    } else {
      result.repository = value.repository;
    }
  }
  if (value.keywords !== undefined) {
    if (!isStringArray(value.keywords)) {
      errors.push({ path: "metadata.keywords", message: "Must be an array of strings" });
    } else {
      result.keywords = value.keywords;
    }
  }
  if (value.tenantScopes !== undefined) {
    if (!isStringArray(value.tenantScopes)) {
      errors.push({ path: "metadata.tenantScopes", message: "Must be an array of strings" });
    } else {
      result.tenantScopes = value.tenantScopes;
    }
  }
  return result as FridayPackageMetadata;
}

// ─── Public API ───

/**
 * Parse and validate a manifest from a JSON string.
 *
 * Returns a structured result with the parsed manifest (if valid)
 * and any validation errors encountered.
 */
export function parseManifestJson(json: string): ManifestParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return {
      success: false,
      manifest: null,
      errors: [{ path: "", message: `Invalid JSON: ${(e as Error).message}` }],
    };
  }
  return validateManifestObject(raw);
}

/**
 * Validate a manifest from a plain object (already parsed from JSON or YAML).
 *
 * Returns a structured result with the parsed manifest (if valid)
 * and any validation errors encountered.
 */
export function validateManifestObject(raw: unknown): ManifestParseResult {
  if (!isObject(raw)) {
    return {
      success: false,
      manifest: null,
      errors: [{ path: "", message: "Manifest must be a JSON object" }],
    };
  }

  const errors: ManifestValidationError[] = [];

  const name = validateName(raw.name, errors);
  const version = validateVersion(raw.version, errors);
  const description = validateDescription(raw.description, errors);
  const author = validateAuthor(raw.author, errors);
  const capabilities = validateCapabilities(raw.capabilities, errors);
  const dependencies = validateDependencyMap(raw.dependencies, "dependencies", errors);
  const peerDependencies = validateDependencyMap(raw.peerDependencies, "peerDependencies", errors);
  const fridayVersionRange = validateFridayVersionRange(raw.fridayVersionRange, errors);
  const assets = validateAssets(raw.assets, errors);
  const hooks = validateHooks(raw.hooks, errors);
  const metadata = validateMetadata(raw.metadata, errors);
  const license = raw.license !== undefined && typeof raw.license === "string" ? raw.license : undefined;

  if (raw.license !== undefined && typeof raw.license !== "string") {
    errors.push({ path: "license", message: "Must be a string" });
  }

  if (errors.length > 0) {
    return { success: false, manifest: null, errors };
  }

  const manifest: FridayPackageManifest = {
    name: name!,
    version: version!,
    description: description!,
    author: author!,
    ...(license !== undefined ? { license } : {}),
    capabilities,
    dependencies,
    ...(Object.keys(peerDependencies).length > 0 ? { peerDependencies } : {}),
    fridayVersionRange: fridayVersionRange!,
    assets,
    ...(hooks !== undefined ? { hooks } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };

  return { success: true, manifest, errors: [] };
}

/**
 * Serialize a manifest to a canonical JSON string (sorted keys, 2-space indent).
 */
export function serializeManifest(manifest: FridayPackageManifest): string {
  return JSON.stringify(canonicalizeJson(manifest), null, 2);
}
