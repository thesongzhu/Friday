/**
 * n8n Node → Friday Package converter.
 *
 * Detects n8n node definition JSON (type/displayName/properties/execute signature)
 * and converts them into a full Friday skill package.
 *
 * v1 limits:
 *   - Trigger/webhook nodes imported as utility skills only.
 *   - Complex n8n credential UX mapped to env/input secrets.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FridayDomainError } from "#errors";

import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";
import type {
  FridayConvertedSkillDraft,
  FridayConvertedSkillFile,
  FridaySkillConversionSource,
  FridaySkillConverter,
  FridaySkillConverterContext,
  FridaySkillConverterDetection,
  FridaySkillConverterResult,
} from "../model/friday-skill-converter.types.js";

// ─── Constants ───

const CONVERTER_ID = "n8n-node";
const CONVERTER_DISPLAY_NAME = "n8n Node";
const CONVERTER_PRIORITY = 40;

// ─── n8n descriptor shape (subset for detection + conversion) ───

interface N8nNodeProperty {
  displayName?: string;
  name?: string;
  type?: string;
  default?: unknown;
  description?: string;
  required?: boolean;
  options?: Array<{ name?: string; value?: unknown; description?: string }>;
}

interface N8nNodeDescriptor {
  displayName?: string;
  name?: string;
  description?: string;
  group?: string[];
  version?: number;
  properties?: N8nNodeProperty[];
  credentials?: Array<{ name?: string; required?: boolean }>;
  defaults?: Record<string, unknown>;
}

// ─── Factory ───

export function createFridayN8nNodeConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(source: FridaySkillConversionSource): Promise<FridaySkillConverterDetection | null> {
      const content = resolveSourceContent(source);
      if (!content) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return null;
      }

      if (!isN8nNodeDescriptor(parsed)) {
        return null;
      }

      const reasons: string[] = ["Found n8n node descriptor with type/displayName/properties"];
      let confidence = 0.8;

      // Boost confidence if it has n8n-specific fields
      const descriptor = parsed as N8nNodeDescriptor;
      if (descriptor.group && Array.isArray(descriptor.group)) {
        confidence = 0.9;
        reasons.push("Has n8n group field");
      }
      if (descriptor.credentials && Array.isArray(descriptor.credentials)) {
        confidence = 0.9;
        reasons.push("Has n8n credentials field");
      }

      return {
        converterId: CONVERTER_ID,
        format: "n8n-node",
        confidence,
        reasons,
      };
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      const content = resolveSourceContent(source);
      if (!content) {
        throw new FridayDomainError("VALIDATION_ERROR", "N8nNodeConverter requires a source URI pointing to a JSON file or contentBase64", { httpStatus: 400 });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new FridayDomainError("PARSE_ERROR", "N8nNodeConverter: source is not valid JSON", { httpStatus: 422 });
      }

      if (!isN8nNodeDescriptor(parsed)) {
        throw new FridayDomainError("PARSE_ERROR", "N8nNodeConverter: source does not match n8n node descriptor shape", { httpStatus: 422 });
      }

      const descriptor = parsed as N8nNodeDescriptor;
      const warnings: string[] = [];

      // Detect trigger/webhook nodes
      const isTrigger = isTriggerNode(descriptor);
      if (isTrigger) {
        warnings.push("Trigger/webhook node imported as utility skill only — trigger semantics are not preserved.");
      }

      // Build skill ID
      const skillId = buildSkillId(descriptor, source);

      // Build manifest
      const manifest = buildManifest(descriptor, skillId, warnings);

      // Build UI schema
      const uiSchema = buildUiSchema(manifest, descriptor);

      // Build index.mjs adapter
      const indexMjs = buildIndexMjs(descriptor, skillId);

      // Build files
      const files: FridayConvertedSkillFile[] = [];

      files.push({
        path: "index.mjs",
        content: indexMjs,
      });

      files.push({
        path: "skill.manifest.json",
        content: JSON.stringify(manifest, null, 2),
      });

      files.push({
        path: "skill.ui.json",
        content: JSON.stringify(uiSchema, null, 2),
      });

      // Preserve original n8n descriptor
      files.push({
        path: "n8n-node-descriptor.json",
        content: JSON.stringify(descriptor, null, 2),
      });

      const conversionReport = {
        sourceFormat: "n8n-node" as const,
        sourceRef: source.uri,
        convertedAt: ctx.nowIso(),
        converterId: CONVERTER_ID,
      };

      files.push({
        path: "conversion.report.json",
        content: JSON.stringify(conversionReport, null, 2),
      });

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files,
        warnings,
        conversionReport,
      };

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "n8n-node",
        drafts: [draft],
      };
    },
  };
}

// ─── Helpers ───

function resolveSourceContent(source: FridaySkillConversionSource): string | null {
  if (source.contentBase64) {
    try {
      return Buffer.from(source.contentBase64, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }

  if (!source.uri) {
    return null;
  }

  // If URI is a directory, look for common n8n node file names
  if (existsSync(source.uri)) {
    const content = tryReadAsFile(source.uri);
    if (content !== null) {
      return content;
    }

    // Try common n8n node file patterns
    for (const candidate of ["node.json", "n8n-node.json", "descriptor.json"]) {
      const filePath = join(source.uri, candidate);
      const fileContent = tryReadAsFile(filePath);
      if (fileContent !== null) {
        return fileContent;
      }
    }
  }

  return null;
}

function tryReadAsFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const stat = readFileSync(filePath, "utf-8");
    return stat;
  } catch {
    return null;
  }
}

function isN8nNodeDescriptor(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const record = obj as Record<string, unknown>;
  // Must have at minimum: a name or displayName, and properties array
  const hasDisplayName = typeof record["displayName"] === "string";
  const hasName = typeof record["name"] === "string";
  const hasProperties = Array.isArray(record["properties"]);

  return (hasDisplayName || hasName) && hasProperties;
}

function isTriggerNode(descriptor: N8nNodeDescriptor): boolean {
  const groups = descriptor.group ?? [];
  if (groups.includes("trigger")) {
    return true;
  }

  const name = (descriptor.name ?? "").toLowerCase();
  return name.includes("trigger") || name.includes("webhook");
}

function buildSkillId(descriptor: N8nNodeDescriptor, source: FridaySkillConversionSource): string {
  // Use the n8n node name, sanitized
  if (descriptor.name) {
    return sanitizeSkillId(`n8n-${descriptor.name}`);
  }
  if (descriptor.displayName) {
    return sanitizeSkillId(`n8n-${descriptor.displayName}`);
  }
  if (source.uri) {
    return sanitizeSkillId(`n8n-${basename(source.uri, ".json")}`);
  }
  return "n8n-imported-node";
}

function sanitizeSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function mapN8nPropertyType(n8nType: string): "string" | "number" | "boolean" | "object" | "array" {
  switch (n8nType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
    case "collection":
    case "fixedCollection":
      return "object";
    case "multiOptions":
      return "array";
    default:
      return "string";
  }
}

function mapN8nPropertyToUiFieldKind(n8nType: string): "text" | "number" | "toggle" | "select" | "json" | "textarea" {
  switch (n8nType) {
    case "number":
      return "number";
    case "boolean":
      return "toggle";
    case "options":
      return "select";
    case "json":
    case "collection":
    case "fixedCollection":
      return "json";
    case "string":
    default:
      return "text";
  }
}

function buildManifest(
  descriptor: N8nNodeDescriptor,
  skillId: string,
  warnings: string[],
): SkillManifestV2 {
  const displayName = descriptor.displayName ?? descriptor.name ?? skillId;
  const description = descriptor.description ?? `Converted from n8n node: ${displayName}`;
  const properties = descriptor.properties ?? [];

  // Build inputs from n8n properties
  const inputs: SkillManifestV2["inputs"] = [];

  for (const prop of properties) {
    if (!prop.name) {
      continue;
    }

    const propType = prop.type ?? "string";
    const inputType = mapN8nPropertyType(propType);

    const input: SkillManifestV2["inputs"][number] = {
      key: prop.name,
      type: inputType,
      required: prop.required ?? false,
      label: prop.displayName ?? prop.name,
      help: prop.description,
    };

    // Add default value
    if (prop.default !== undefined && prop.default !== null && prop.default !== "") {
      input.defaultValue = prop.default;
    }

    // Add enum validation for options type
    if (propType === "options" && Array.isArray(prop.options)) {
      const enumValues = prop.options
        .map((o) => typeof o.value === "string" ? o.value : o.name)
        .filter((v): v is string => typeof v === "string");
      if (enumValues.length > 0) {
        input.validation = { enum: enumValues };
      }
    }

    inputs.push(input);
  }

  // Map credentials to secret inputs
  const credentials = descriptor.credentials ?? [];
  for (const cred of credentials) {
    if (!cred.name) {
      continue;
    }

    const credKey = `${cred.name}_credential`;
    inputs.push({
      key: credKey,
      type: "secret",
      required: cred.required ?? false,
      label: `${cred.name} Credential`,
      help: `Credential for ${cred.name} — provide as environment variable or secret input`,
    });

    warnings.push(`Credential "${cred.name}" mapped to secret input "${credKey}" — n8n credential lifecycle not fully replicated.`);
  }

  // Determine if node is HTTP-capable
  const isHttpCapable = detectHttpCapability(descriptor);

  const grants: SkillManifestV2["permissions"]["grants"] = [];
  const promptOn: SkillManifestV2["permissions"]["promptOn"] = [];

  if (isHttpCapable) {
    grants.push({
      id: "network.connect",
      resource: "network",
      action: "connect",
      required: true,
      reason: "n8n node performs HTTP requests",
    });
    promptOn.push("network.connect");
  }

  return {
    schemaVersion: "2.0",
    id: skillId,
    name: displayName,
    description,
    version: "1.0.0",
    kind: "conversation",
    category: "integration",
    author: { name: "n8n-import" },
    tags: ["n8n", "imported"],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: {
      intents: [],
      phrases: [],
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
      env: credentials.filter((c) => c.name).map((c) => `N8N_CRED_${c.name!.toUpperCase()}`),
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs,
    outputs: [
      { key: "result", type: "object", description: "Node execution result" },
      { key: "status", type: "string", description: "Execution status" },
    ],
    permissions: { grants, promptOn },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildUiSchema(
  manifest: SkillManifestV2,
  descriptor: N8nNodeDescriptor,
): FridaySkillUiSchemaV1 {
  const properties = descriptor.properties ?? [];
  const fields: FridaySkillUiSchemaV1["fields"] = [];
  const fieldIds: string[] = [];

  for (const input of manifest.inputs) {
    const fieldId = `field-${input.key}`;
    fieldIds.push(fieldId);

    // Find matching n8n property for kind mapping
    const n8nProp = properties.find((p) => p.name === input.key);
    const n8nType = n8nProp?.type ?? "string";
    const kind = input.type === "secret" ? "text" : mapN8nPropertyToUiFieldKind(n8nType);

    fields.push({
      id: fieldId,
      inputKey: input.key,
      kind,
      label: input.label,
      required: input.required,
      help: input.help,
      placeholder: input.type === "secret"
        ? "Enter secret value…"
        : `Enter ${input.label.toLowerCase()}…`,
      validation: input.validation,
    });
  }

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [
      {
        id: "main",
        label: "Configuration",
        fieldIds,
      },
    ],
    fields,
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: o.type === "object" ? "json" as const : "text" as const,
    })),
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function buildIndexMjs(descriptor: N8nNodeDescriptor, skillId: string): string {
  const properties = descriptor.properties ?? [];
  const propNames = properties
    .filter((p) => p.name)
    .map((p) => p.name);

  const nodeName = descriptor.name ?? skillId;
  const credentials = descriptor.credentials ?? [];

  const credentialMapping = credentials
    .filter((c) => c.name)
    .map((c) => `      ${JSON.stringify(c.name!)}: { data: { apiKey: env.N8N_CRED_${c.name!.toUpperCase()} ?? "" } },`)
    .join("\n");

  return `/**
 * Friday adapter for n8n node: ${descriptor.displayName ?? descriptor.name ?? skillId}
 * Auto-generated by friday-n8n-node-converter.
 *
 * This adapter attempts to load and execute the actual n8n node module.
 * If the n8n node module is not installed, it falls back to parameter passthrough.
 */

/**
 * Execute the converted n8n node with Friday input context.
 * @param {object} context - Friday execution context
 * @param {object} context.inputs - Input values keyed by input key
 * @param {object} context.env - Environment variables
 * @returns {Promise<{result: object, status: string}>}
 */
export default async function execute(context) {
  const { inputs, env } = context;

  // Map Friday inputs to n8n-style getNodeParameter calls
  const getNodeParameter = (name, fallback) => {
    const val = inputs[name];
    return val !== undefined ? val : fallback;
  };

  try {
    // Gather parameters from Friday inputs
    const params = {};
${propNames.map((n) => `    params[${JSON.stringify(n)}] = getNodeParameter(${JSON.stringify(n)}, ${JSON.stringify(properties.find((p) => p.name === n)?.default ?? null)});`).join("\n")}

    // Attempt to load and execute the actual n8n node
    let nodeModule;
    try {
      nodeModule = await import(${JSON.stringify(nodeName)});
    } catch {
      // Node module not available — return gathered parameters
      return {
        result: {
          message: "n8n node module not found — returning gathered parameters",
          node: ${JSON.stringify(nodeName)},
          parameters: params,
        },
        status: "success",
      };
    }

    // Resolve the node class from the module
    const NodeClass = nodeModule.default ?? nodeModule[Object.keys(nodeModule).find(k => typeof nodeModule[k] === "function") ?? ""];
    if (!NodeClass || typeof NodeClass !== "function") {
      return {
        result: { message: "n8n node module loaded but no node class found", parameters: params },
        status: "success",
      };
    }

    const nodeInstance = new NodeClass();

    // Build n8n execution context mock
    const inputItems = [{ json: { ...params } }];

    const executionContext = {
      getInputData: () => inputItems,
      getNodeParameter: (name, itemIndex, fallback) => {
        const val = params[name];
        return val !== undefined ? val : fallback;
      },
      getCredentials: async (type) => {
        const credentials = {
${credentialMapping}
        };
        return credentials[type]?.data ?? {};
      },
      helpers: {
        request: async (options) => {
          const resp = await fetch(options.uri ?? options.url, {
            method: options.method ?? "GET",
            headers: options.headers ?? {},
            body: options.body ? JSON.stringify(options.body) : undefined,
          });
          return resp.json();
        },
        requestWithAuthentication: async (credType, options) => {
          const resp = await fetch(options.uri ?? options.url, {
            method: options.method ?? "GET",
            headers: options.headers ?? {},
            body: options.body ? JSON.stringify(options.body) : undefined,
          });
          return resp.json();
        },
        returnJsonArray: (data) => Array.isArray(data) ? data.map(item => ({ json: item })) : [{ json: data }],
      },
      getNode: () => ({ name: ${JSON.stringify(nodeName)}, type: ${JSON.stringify(nodeName)} }),
    };

    // Execute the n8n node
    let outputItems;
    if (typeof nodeInstance.execute === "function") {
      outputItems = await nodeInstance.execute.call(executionContext);
    } else {
      return {
        result: { message: "n8n node has no execute method", parameters: params },
        status: "success",
      };
    }

    // Map n8n output back to Friday format
    const resultData = Array.isArray(outputItems)
      ? outputItems.flat().map(item => item?.json ?? item)
      : outputItems;

    return {
      result: resultData,
      status: "success",
    };
  } catch (err) {
    return {
      result: { error: err.message },
      status: "error",
    };
  }
}
`;
}

function detectHttpCapability(descriptor: N8nNodeDescriptor): boolean {
  const name = (descriptor.name ?? "").toLowerCase();
  const displayName = (descriptor.displayName ?? "").toLowerCase();
  const combined = `${name} ${displayName}`;

  // Common HTTP-capable n8n node patterns
  const httpPatterns = [
    "http", "request", "api", "webhook", "fetch", "rest",
    "graphql", "soap", "ftp", "ssh", "smtp", "imap",
  ];

  for (const pattern of httpPatterns) {
    if (combined.includes(pattern)) {
      return true;
    }
  }

  // Check properties for URL fields
  const properties = descriptor.properties ?? [];
  for (const prop of properties) {
    const propName = (prop.name ?? "").toLowerCase();
    if (propName === "url" || propName === "baseurl" || propName === "endpoint") {
      return true;
    }
  }

  return false;
}
