/**
 * Manifest validation for friday.plugin.json files.
 */

import semver from "semver";

import { FridayDomainError } from "#errors";
import type {
  FridayPluginKind,
  FridayPluginManifest,
  FridayPluginPermissionGrant,
  FridayPluginPermissionPolicy,
} from "../model/friday-plugin.types.js";
import {
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_VALID_KINDS,
} from "../model/friday-plugin.types.js";

// ─── Validation Helpers ───

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidSemver(value: string): boolean {
  return semver.valid(value) !== null;
}

function isValidSemverRange(value: string): boolean {
  return value.length > 0 && semver.validRange(value) !== null;
}

function isValidPluginId(value: string): boolean {
  // Plugin IDs follow reverse-domain-ish pattern: lowercase alphanumeric with dots/hyphens
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(value);
}

function isPluginKind(value: unknown): value is FridayPluginKind {
  return typeof value === "string" && (FRIDAY_PLUGIN_VALID_KINDS as readonly string[]).includes(value);
}

// ─── Permission Validation ───

const VALID_PERMISSION_RESOURCES = new Set([
  "filesystem", "network", "channel", "tool", "memory",
  "device", "shell", "provider", "storage", "hook",
]);

const VALID_PERMISSION_ACTIONS = new Set([
  "read", "write", "connect", "send", "receive", "execute", "register",
]);

const VALID_PROMPT_ON_ACTIONS = new Set([
  "filesystem.write", "network.connect", "shell.execute",
  "channel.send", "provider.execute",
]);

function validatePermissionGrant(grant: unknown, index: number): FridayPluginPermissionGrant {
  if (grant == null || typeof grant !== "object") {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      `permissions.grants[${index}] must be an object`,
      { httpStatus: 400 },
    );
  }
  const g = grant as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyString(g.id)) errors.push("id is required");
  if (!isNonEmptyString(g.resource) || !VALID_PERMISSION_RESOURCES.has(g.resource as string)) {
    errors.push(`resource must be one of: ${[...VALID_PERMISSION_RESOURCES].join(", ")}`);
  }
  if (!isNonEmptyString(g.action) || !VALID_PERMISSION_ACTIONS.has(g.action as string)) {
    errors.push(`action must be one of: ${[...VALID_PERMISSION_ACTIONS].join(", ")}`);
  }
  if (typeof g.required !== "boolean") errors.push("required must be a boolean");
  if (!isNonEmptyString(g.reason)) errors.push("reason is required");

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      `permissions.grants[${index}]: ${errors.join("; ")}`,
      { httpStatus: 400 },
    );
  }

  return grant as FridayPluginPermissionGrant;
}

function validatePermissions(permissions: unknown): FridayPluginPermissionPolicy {
  if (permissions == null || typeof permissions !== "object") {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      "permissions is required and must be an object",
      { httpStatus: 400 },
    );
  }
  const p = permissions as Record<string, unknown>;

  if (!Array.isArray(p.grants)) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      "permissions.grants must be an array",
      { httpStatus: 400 },
    );
  }

  const grants = p.grants.map((g, i) => validatePermissionGrant(g, i));

  if (!Array.isArray(p.promptOn)) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      "permissions.promptOn must be an array",
      { httpStatus: 400 },
    );
  }

  for (const action of p.promptOn) {
    if (typeof action !== "string" || !VALID_PROMPT_ON_ACTIONS.has(action)) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
        `permissions.promptOn contains invalid action: ${String(action)}`,
        { httpStatus: 400 },
      );
    }
  }

  return { grants, promptOn: p.promptOn as FridayPluginPermissionPolicy["promptOn"] };
}

// ─── Main Validator ───

/** Validates a parsed JSON object as a FridayPluginManifest. */
export function validateFridayPluginManifest(raw: unknown): FridayPluginManifest {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      "Plugin manifest must be a JSON object",
      { httpStatus: 400 },
    );
  }

  const m = raw as Record<string, unknown>;
  const errors: string[] = [];

  // schemaVersion
  if (m.schemaVersion !== "1.0") {
    errors.push('schemaVersion must be "1.0"');
  }

  // id
  if (!isNonEmptyString(m.id) || !isValidPluginId(m.id)) {
    errors.push("id must be a valid plugin identifier (e.g. friday.channel.discord)");
  }

  // version
  if (!isNonEmptyString(m.version) || !isValidSemver(m.version)) {
    errors.push("version must be a valid semver string (e.g. 1.0.0)");
  }

  // name
  if (!isNonEmptyString(m.name)) {
    errors.push("name is required and must be a non-empty string");
  }

  // description
  if (!isNonEmptyString(m.description)) {
    errors.push("description is required and must be a non-empty string");
  }

  // kinds
  if (!Array.isArray(m.kinds) || m.kinds.length === 0) {
    errors.push("kinds must be a non-empty array");
  } else {
    for (const kind of m.kinds) {
      if (!isPluginKind(kind)) {
        errors.push(`kinds contains invalid value: ${String(kind)}`);
      }
    }
  }

  // entrypoints
  if (m.entrypoints == null || typeof m.entrypoints !== "object" || Array.isArray(m.entrypoints)) {
    errors.push("entrypoints must be an object");
  } else if (Array.isArray(m.kinds)) {
    const ep = m.entrypoints as Record<string, unknown>;
    for (const kind of m.kinds) {
      if (isPluginKind(kind)) {
        if (!isNonEmptyString(ep[kind])) {
          errors.push(`entrypoints.${kind} is required for kind "${kind}"`);
        }
      }
    }
  }

  // dependencies (optional)
  if (m.dependencies !== undefined) {
    if (m.dependencies == null || typeof m.dependencies !== "object" || Array.isArray(m.dependencies)) {
      errors.push("dependencies must be an object mapping plugin IDs to semver ranges");
    } else {
      const deps = m.dependencies as Record<string, unknown>;
      for (const [depId, range] of Object.entries(deps)) {
        if (!isValidPluginId(depId)) {
          errors.push(`dependencies key "${depId}" is not a valid plugin ID`);
        }
        if (typeof range !== "string" || !isValidSemverRange(range)) {
          errors.push(`dependencies["${depId}"] must be a valid semver range`);
        }
      }
    }
  }

  // compatibility
  if (m.compatibility == null || typeof m.compatibility !== "object") {
    errors.push("compatibility is required and must be an object");
  } else {
    const c = m.compatibility as Record<string, unknown>;
    if (!isNonEmptyString(c.minHubVersion) || !isValidSemver(c.minHubVersion)) {
      errors.push("compatibility.minHubVersion must be a valid semver string");
    }
    if (c.apiVersion !== "1") {
      errors.push('compatibility.apiVersion must be "1"');
    }
  }

  if (errors.length > 0) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
      `Invalid plugin manifest: ${errors.join("; ")}`,
      { httpStatus: 400, details: { errors } },
    );
  }

  // Validate permissions separately (throws on error)
  const permissions = validatePermissions(m.permissions);

  // Validate signature shape if present
  if (m.signature !== undefined) {
    if (m.signature == null || typeof m.signature !== "object") {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
        "signature must be an object",
        { httpStatus: 400 },
      );
    }
    const sig = m.signature as Record<string, unknown>;
    if (sig.algorithm !== "ed25519") {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
        'signature.algorithm must be "ed25519"',
        { httpStatus: 400 },
      );
    }
    if (!isNonEmptyString(sig.keyId)) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
        "signature.keyId is required",
        { httpStatus: 400 },
      );
    }
    if (!isNonEmptyString(sig.value)) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_INVALID,
        "signature.value is required",
        { httpStatus: 400 },
      );
    }
  }

  return {
    schemaVersion: "1.0",
    id: m.id as string,
    version: m.version as string,
    name: m.name as string,
    description: m.description as string,
    kinds: m.kinds as FridayPluginKind[],
    entrypoints: m.entrypoints as FridayPluginManifest["entrypoints"],
    dependencies: m.dependencies as Record<string, string> | undefined,
    permissions,
    compatibility: m.compatibility as FridayPluginManifest["compatibility"],
    signature: m.signature as FridayPluginManifest["signature"],
  };
}
