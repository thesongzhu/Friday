/**
 * Policy Bundle Signature — deterministic HMAC-SHA256 signing and verification.
 *
 * Canonicalization recursively sorts object keys so signatures are stable
 * regardless of input key order.
 *
 * @module rules/engine
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  FridayPolicyBundle,
  FridayPolicyBundleSignature,
  FridayPolicyBundleYaml,
  FridayRule,
} from "../model/friday-rules-engine.types.js";

export type PolicyBundleSignatureErrorCode =
  | "MISSING_SIGNATURE"
  | "MISSING_SECRET"
  | "INVALID_SIGNATURE"
  | "UNSUPPORTED_ALGORITHM"
  | "UNSUPPORTED_PAYLOAD";

export class PolicyBundleSignatureError extends Error {
  constructor(
    message: string,
    public readonly code: PolicyBundleSignatureErrorCode,
  ) {
    super(message);
    this.name = "PolicyBundleSignatureError";
  }
}

export interface PolicyBundleSignatureVerificationOptions {
  signatureSecrets?: Readonly<Record<string, string>>;
  enforceBundleSignature?: boolean;
}

/** Build canonical signing payload for a parsed YAML/JSON bundle document. */
export function createParsedBundleSigningPayload(parsed: FridayPolicyBundleYaml): unknown {
  const { signature: _signature, ...metadataWithoutSignature } = parsed.metadata;
  return {
    apiVersion: parsed.apiVersion,
    kind: parsed.kind,
    metadata: metadataWithoutSignature,
    rules: parsed.rules,
  };
}

/** Build canonical signing payload for a pre-constructed domain bundle + rules. */
export function createDomainBundleSigningPayload(bundle: FridayPolicyBundle, rules: FridayRule[]): unknown {
  return {
    apiVersion: "friday/rules/v1",
    kind: "PolicyBundle",
    metadata: {
      id: bundle.id,
      name: bundle.name,
      description: bundle.description,
      version: bundle.version,
      priority: bundle.priority,
      enabled: bundle.enabled,
      tags: bundle.tags,
    },
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      resource: rule.resource,
      action: rule.action,
      conditions: rule.conditions,
      decision: rule.decision,
      message: rule.message,
      priority: rule.priority,
    })),
  };
}

/** Canonicalize an object payload (stable recursive key ordering) for signing. */
export function canonicalizePolicyBundlePayload(payload: unknown): string {
  return JSON.stringify(toCanonicalJson(payload));
}

/** Compute HMAC-SHA256 signature (hex) for a canonicalized payload. */
export function createPolicyBundleSignature(payload: unknown, secret: string): string {
  const canonical = canonicalizePolicyBundlePayload(payload);
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

/** Verify HMAC-SHA256 signature (hex or `sha256=<hex>` format) in constant time. */
export function verifyPolicyBundleSignature(
  payload: unknown,
  signatureValue: string,
  secret: string,
): boolean {
  const normalizedActual = normalizeSignatureHex(signatureValue);
  if (!normalizedActual) return false;

  const expected = createPolicyBundleSignature(payload, secret);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(normalizedActual, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Enforce signature requirements and verification for one policy bundle payload. */
export function assertPolicyBundleSignatureValid(
  payload: unknown,
  signature: FridayPolicyBundleSignature | undefined,
  options: PolicyBundleSignatureVerificationOptions = {},
): void {
  const enforceBundleSignature = options.enforceBundleSignature ?? false;
  if (!signature) {
    if (enforceBundleSignature) {
      throw new PolicyBundleSignatureError(
        "policy bundle signature is required",
        "MISSING_SIGNATURE",
      );
    }
    return;
  }

  if (signature.algorithm !== "hmac-sha256") {
    throw new PolicyBundleSignatureError(
      `unsupported policy bundle signature algorithm "${signature.algorithm}"`,
      "UNSUPPORTED_ALGORITHM",
    );
  }

  const secret = options.signatureSecrets?.[signature.keyId];
  if (!secret) {
    throw new PolicyBundleSignatureError(
      `no policy bundle signature secret configured for keyId "${signature.keyId}"`,
      "MISSING_SECRET",
    );
  }

  if (!verifyPolicyBundleSignature(payload, signature.value, secret)) {
    throw new PolicyBundleSignatureError(
      "policy bundle signature verification failed",
      "INVALID_SIGNATURE",
    );
  }
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function toCanonicalJson(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalJson(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const canonical: { [key: string]: CanonicalJson } = {};
    for (const key of sortedKeys) {
      const nested = record[key];
      if (nested === undefined) continue;
      canonical[key] = toCanonicalJson(nested);
    }
    return canonical;
  }

  throw new PolicyBundleSignatureError(
    `unsupported payload value type "${typeof value}" during canonicalization`,
    "UNSUPPORTED_PAYLOAD",
  );
}

function normalizeSignatureHex(value: string): string | null {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
  if (!/^[a-fA-F0-9]{64}$/.test(withoutPrefix)) {
    return null;
  }
  return withoutPrefix.toLowerCase();
}
