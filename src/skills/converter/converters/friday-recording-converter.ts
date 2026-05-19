/**
 * Desktop Recording → Skill Converter.
 *
 * Detects desktop recording JSON (FridayDesktopRecording + steps) and converts
 * it into a FridayConvertedSkillDraft with a replay-based entrypoint,
 * parameterized manifest, and auto-generated UI schema.
 */

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

const CONVERTER_ID = "desktop-recording";
const CONVERTER_DISPLAY_NAME = "Desktop Recording";
const CONVERTER_PRIORITY = 60; // Below native (100) but above generic converters

// ─── Types for parsed input ───

interface RecordingParameterEntry {
  type: string;
  defaultValue?: string;
  description?: string;
  required: boolean;
}

interface RecordingStep {
  id: string;
  recordingId: string;
  stepIndex: number;
  action: Record<string, unknown> & { type: string };
  result?: Record<string, unknown>;
  element?: Record<string, unknown>;
  parameterBindings: Record<string, string>;
  timestamp: string;
  durationMs?: number;
}

interface RecordingPayload {
  id: string;
  name: string;
  description?: string;
  state: string;
  platform: string;
  parameters: Record<string, RecordingParameterEntry>;
  tags: string[];
  stepCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  steps: RecordingStep[];
}

// ─── Factory ───

export function createFridayRecordingConverter(): FridaySkillConverter {
  return {
    id: CONVERTER_ID,
    displayName: CONVERTER_DISPLAY_NAME,
    priority: CONVERTER_PRIORITY,

    async detect(
      source: FridaySkillConversionSource,
    ): Promise<FridaySkillConverterDetection | null> {
      const parsed = tryParseRecording(source);
      if (!parsed) return null;

      const reasons: string[] = [];
      let confidence = 0;

      // Check for recording schema markers
      if (parsed.id && parsed.name && parsed.platform && parsed.state) {
        confidence += 0.4;
        reasons.push("Has id, name, platform, and state fields");
      }

      if (parsed.steps && Array.isArray(parsed.steps)) {
        confidence += 0.3;
        reasons.push(`Contains ${parsed.steps.length} recording steps`);
      }

      if (parsed.parameters && typeof parsed.parameters === "object") {
        confidence += 0.1;
        reasons.push("Has parameter map");
      }

      if (
        parsed.steps?.some(
          (s) => s.action && typeof s.action === "object" && s.action.type,
        )
      ) {
        confidence += 0.2;
        reasons.push("Steps contain typed desktop actions");
      }

      if (confidence < 0.5) return null;

      return {
        converterId: CONVERTER_ID,
        format: "desktop-recording",
        confidence: Math.min(confidence, 1.0),
        reasons,
      };
    },

    async convert(
      source: FridaySkillConversionSource,
      ctx: FridaySkillConverterContext,
    ): Promise<FridaySkillConverterResult> {
      const parsed = tryParseRecording(source);
      if (!parsed) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "Source does not contain a valid desktop recording",
          { httpStatus: 400 },
        );
      }

      validateRecording(parsed);

      const manifest = buildManifest(parsed);
      const uiSchema = buildUiSchema(parsed, manifest);
      const files = buildFiles(parsed);
      const warnings = collectWarnings(parsed);

      const draft: FridayConvertedSkillDraft = {
        manifest,
        uiSchema,
        files,
        warnings,
        conversionReport: {
          sourceFormat: "desktop-recording",
          sourceRef: source.uri ?? `recording:${parsed.id}`,
          convertedAt: ctx.nowIso(),
          converterId: CONVERTER_ID,
        },
      };

      return {
        converterId: CONVERTER_ID,
        detectedFormat: "desktop-recording",
        drafts: [draft],
      };
    },
  };
}

// ─── Parsing ───

function tryParseRecording(
  source: FridaySkillConversionSource,
): RecordingPayload | null {
  let raw: string | undefined;

  if (source.contentBase64) {
    try {
      raw = Buffer.from(source.contentBase64, "base64").toString("utf-8");
    } catch (err) {
    console.warn("[friday][recording-converter] operation failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  if (!raw) return null;

  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.id === "string" &&
      typeof obj.name === "string" &&
      typeof obj.platform === "string" &&
      Array.isArray(obj.steps)
    ) {
      return obj as RecordingPayload;
    }
    return null;
  } catch (err) {
    console.warn("[friday][recording-converter] operation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Validation ───

function validateRecording(rec: RecordingPayload): void {
  if (!rec.id) {
    throw new FridayDomainError("VALIDATION_ERROR", "Recording is missing id", {
      httpStatus: 422,
    });
  }
  if (!rec.name) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Recording is missing name",
      { httpStatus: 422 },
    );
  }
  if (!rec.steps || rec.steps.length === 0) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "Recording has no steps — cannot convert an empty recording",
      { httpStatus: 422 },
    );
  }
  for (const step of rec.steps) {
    if (!step.action || !step.action.type) {
      throw new FridayDomainError(
        "VALIDATION_ERROR",
        `Step ${step.stepIndex ?? "?"} is missing a typed action`,
        { httpStatus: 422 },
      );
    }
  }
}

// ─── Manifest Generation ───

function buildManifest(rec: RecordingPayload): SkillManifestV2 {
  const skillId = `desktop-recording-${rec.id}`;
  const paramEntries = Object.entries(rec.parameters ?? {});

  const inputs: SkillManifestV2["inputs"] = paramEntries.map(
    ([key, entry]) => ({
      key,
      type: mapParameterType(entry.type),
      required: entry.required,
      label: entry.description ?? key,
      help: entry.description,
      defaultValue: entry.defaultValue,
    }),
  );

  const osTargets = mapPlatformToOs(rec.platform);

  return {
    schemaVersion: "2.0",
    id: skillId,
    name: rec.name,
    description:
      rec.description ?? `Replays desktop recording "${rec.name}"`,
    version: "1.0.0",
    kind: "workflow",
    category: "automation",
    author: { name: rec.createdBy || "Friday Desktop Recorder" },
    tags: [...(rec.tags ?? []), "desktop-recording", "automation"],

    runtime: {
      kind: "node",
      entrypoint: "entrypoint.js",
      minHubVersion: "0.1.0",
      apiVersion: "1",
      timeoutMsDefault: Math.max(30_000, rec.steps.length * 5_000),
    },

    triggers: {
      intents: [`replay.${slugify(rec.name)}`],
      phrases: [`replay ${rec.name}`, `run ${rec.name} recording`],
      channels: [],
    },

    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["workflow"],
    },

    requirements: {
      bins: [],
      env: [],
      config: [],
      os: osTargets,
    },

    inputs,

    outputs: [
      { key: "result", type: "object", description: "Replay execution result" },
      {
        key: "stepResults",
        type: "array",
        description: "Per-step execution results",
      },
    ],

    permissions: {
      grants: [
        {
          id: "desktop-execute",
          resource: "device",
          action: "execute",
          required: true,
          reason: "Replays desktop actions (clicks, keystrokes, etc.)",
        },
        {
          id: "desktop-capture",
          resource: "device",
          action: "capture",
          required: false,
          reason: "Takes screenshots for verification",
        },
      ],
      promptOn: ["device.capture"],
    },

    executionTargets: {
      allowedSatelliteTypes: ["desktop"],
      requiredCapabilities: ["desktop-control"],
    },

    ui: {
      icon: "monitor",
      color: "#6366f1",
    },
  };
}

// ─── UI Schema Generation ───

function buildUiSchema(
  rec: RecordingPayload,
  manifest: SkillManifestV2,
): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = manifest.inputs.map(
    (input) => ({
      id: `field-${input.key}`,
      inputKey: input.key,
      kind: mapParameterTypeToFieldKind(
        rec.parameters?.[input.key]?.type ?? "string",
      ),
      label: input.label,
      required: input.required,
      help: input.help,
      defaultValue: input.defaultValue,
    }),
  );

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: manifest.description || undefined,
    sections: [
      {
        id: "parameters",
        label: "Recording Parameters",
        fieldIds: fields.map((f) => f.id),
      },
    ],
    fields,
    outputs: manifest.outputs.map((o) => ({
      id: `output-${o.key}`,
      outputKey: o.key,
      label: o.description ?? o.key,
      widget: o.type === "array" ? ("table" as const) : ("json" as const),
    })),
    actions: [
      { id: "run", label: "Replay", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

// ─── File Generation ───

function buildFiles(rec: RecordingPayload): FridayConvertedSkillFile[] {
  const entrypoint = buildEntrypoint(rec);
  const stepsJson = JSON.stringify(rec.steps, null, 2);

  return [
    { path: "entrypoint.js", content: entrypoint },
    { path: "recording-steps.json", content: stepsJson },
    {
      path: "recording-metadata.json",
      content: JSON.stringify(
        {
          id: rec.id,
          name: rec.name,
          description: rec.description,
          platform: rec.platform,
          parameters: rec.parameters,
          tags: rec.tags,
          stepCount: rec.steps.length,
          createdBy: rec.createdBy,
          createdAt: rec.createdAt,
          stoppedAt: rec.stoppedAt,
        },
        null,
        2,
      ),
    },
  ];
}

function buildEntrypoint(rec: RecordingPayload): string {
  const paramKeys = Object.keys(rec.parameters ?? {});
  const hasParams = paramKeys.length > 0;

  return `/**
 * Auto-generated entrypoint for desktop recording: ${rec.name}
 * Recording ID: ${rec.id}
 * Platform: ${rec.platform}
 * Steps: ${rec.steps.length}
 *
 * This file replays the captured desktop actions with parameter substitution.
 * Generated by the Friday Desktop Recording Converter.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export default async function execute(input, ctx) {
  const stepsRaw = readFileSync(join(__dirname, "recording-steps.json"), "utf-8");
  const steps = JSON.parse(stepsRaw);

  const desktop = ctx.desktop;
  if (!desktop) {
    throw new FridayDomainError("NOT_INITIALIZED", "Desktop helper is not available — this skill requires desktop control.", { httpStatus: 503 });
  }

  if (!desktop.isConnected()) {
    throw new FridayDomainError("NOT_INITIALIZED", "Desktop session is not connected.", { httpStatus: 503 });
  }

  const stepResults = [];
  let lastError = null;

  for (const step of steps) {
    const action = ${hasParams ? "substituteParameters(step.action, input)" : "step.action"};

    try {
      const result = await desktop.executeAction(action);
      stepResults.push({
        stepIndex: step.stepIndex,
        actionType: step.action.type,
        status: result.status,
        durationMs: result.durationMs,
      });

      if (result.status === "failed") {
        lastError = result.errorMessage || "Action failed";
        break;
      }
    } catch (err) {
      stepResults.push({
        stepIndex: step.stepIndex,
        actionType: step.action.type,
        status: "failed",
        error: err.message,
      });
      lastError = err.message;
      break;
    }
  }

  return {
    result: {
      success: lastError === null,
      stepsExecuted: stepResults.length,
      totalSteps: steps.length,
      error: lastError,
      recordingId: "${rec.id}",
      platform: "${rec.platform}",
    },
    stepResults,
  };
}
${hasParams ? buildParameterSubstitution() : ""}`;
}

function buildParameterSubstitution(): string {
  return `
/**
 * Substitutes {{paramName}} placeholders in action fields with input values.
 */
function substituteParameters(action, input) {
  return substituteValue(action, input);
}

function substituteValue(value, input) {
  if (typeof value === "string") {
    return value.replace(/\\{\\{(\\w+)\\}\\}/g, (match, key) => {
      if (
        input &&
        Object.prototype.hasOwnProperty.call(input, key) &&
        input[key] !== undefined
      ) {
        return String(input[key]);
      }
      return match;
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => substituteValue(entry, input));
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = substituteValue(nested, input);
    }
    return result;
  }

  return value;
}
`;
}

// ─── Warnings ───

function collectWarnings(rec: RecordingPayload): string[] {
  const warnings: string[] = [];

  if (rec.state !== "stopped") {
    warnings.push(
      `Recording state is "${rec.state}" — only stopped recordings should be converted`,
    );
  }

  if (rec.steps.length === 0) {
    warnings.push("Recording has no steps");
  }

  const failedSteps = rec.steps.filter(
    (s) => s.result && (s.result as Record<string, unknown>).status === "failed",
  );
  if (failedSteps.length > 0) {
    warnings.push(
      `${failedSteps.length} step(s) had failures during original recording`,
    );
  }

  const actionTypes = new Set(rec.steps.map((s) => s.action.type));
  if (actionTypes.has("file_operation")) {
    warnings.push(
      "Recording contains file operations — ensure target paths are correct for the replay environment",
    );
  }

  const unparameterized = rec.steps.filter(
    (s) => Object.keys(s.parameterBindings ?? {}).length === 0,
  );
  if (
    unparameterized.length === rec.steps.length &&
    Object.keys(rec.parameters ?? {}).length > 0
  ) {
    warnings.push(
      "Parameters are defined but no steps have parameter bindings — substitution may not work as expected",
    );
  }

  return warnings;
}

// ─── Helpers ───

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function mapParameterType(
  pType: string,
): SkillManifestV2["inputs"][number]["type"] {
  switch (pType) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "path":
      return "string";
    case "selector":
      return "object";
    default:
      return "string";
  }
}

function mapParameterTypeToFieldKind(
  pType: string,
): "text" | "number" | "toggle" | "json" {
  switch (pType) {
    case "number":
      return "number";
    case "boolean":
      return "toggle";
    case "selector":
      return "json";
    default:
      return "text";
  }
}

function mapPlatformToOs(
  platform: string,
): Array<"darwin" | "linux" | "win32"> {
  switch (platform) {
    case "darwin":
      return ["darwin"];
    case "win32":
      return ["win32"];
    case "linux":
      return ["linux"];
    default:
      return ["darwin", "linux", "win32"];
  }
}
