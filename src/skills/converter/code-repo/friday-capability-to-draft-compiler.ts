import type { SkillManifestV2 } from "../../model/friday-skill-manifest-v2.types.js";
import type { FridaySkillUiSchemaV1 } from "../../generator/model/friday-skill-ui-schema.types.js";
import type { FridayConvertedSkillDraft, FridayConvertedSkillFile } from "../model/friday-skill-converter.types.js";
import type { FridayCodeRepoCapability, FridayCodeRepoDraftPlan } from "./friday-code-repo.types.js";

export interface CompileFridayCodeRepoDraftPlanInput {
  repoName: string;
  sourceRef: string;
  capabilities: FridayCodeRepoCapability[];
  convertedAt: string;
  maxDrafts?: number;
}

export function compileFridayCodeRepoDraftPlan(
  input: CompileFridayCodeRepoDraftPlanInput,
): FridayCodeRepoDraftPlan {
  const maxDrafts = Math.max(1, Math.min(20, input.maxDrafts ?? 10));
  const selected = input.capabilities.slice(0, maxDrafts);
  const warnings: string[] = [];

  if (selected.length === 0) {
    warnings.push("No executable capabilities detected from repository scan.");
  }

  const drafts: FridayConvertedSkillDraft[] = selected.map((capability) =>
    compileCapabilityDraft(input, capability),
  );

  return { drafts, warnings };
}

function compileCapabilityDraft(
  input: CompileFridayCodeRepoDraftPlanInput,
  capability: FridayCodeRepoCapability,
): FridayConvertedSkillDraft {
  const skillId = toSkillId(`${input.repoName}-${capability.id}`);
  const runtimeKind = isShellCapability(capability) ? "shell" : "node";
  const runtimeEntrypoint = runtimeKind === "shell" ? "run.sh" : "index.mjs";

  const manifest = buildManifest(skillId, runtimeKind, runtimeEntrypoint, capability);
  const uiSchema = buildUiSchema(manifest, capability);

  const files: FridayConvertedSkillFile[] = [
    {
      path: "skill.manifest.json",
      content: JSON.stringify(manifest, null, 2),
    },
    {
      path: "skill.ui.json",
      content: JSON.stringify(uiSchema, null, 2),
    },
    {
      path: "conversion.report.json",
      content: JSON.stringify(
        {
          sourceFormat: "code-repo",
          sourceRef: input.sourceRef,
          convertedAt: input.convertedAt,
          converterId: "code-repo",
          capability,
        },
        null,
        2,
      ),
    },
  ];

  if (runtimeKind === "shell") {
    files.push({
      path: "run.sh",
      content: buildShellEntrypoint(capability),
      executable: true,
    });
  } else {
    files.push({
      path: "index.mjs",
      content: buildNodeEntrypoint(capability),
    });
  }

  const draftWarnings = [
    "Auto-generated from repository heuristics. Review before production use.",
  ];
  if (isShellCapability(capability)) {
    draftWarnings.push("Shell capabilities default to preview mode and require allowExec=true to execute.");
  }

  return {
    manifest,
    uiSchema,
    files,
    warnings: draftWarnings,
    conversionReport: {
      sourceFormat: "code-repo",
      sourceRef: input.sourceRef,
      convertedAt: input.convertedAt,
      converterId: "code-repo",
    },
  };
}

function buildManifest(
  skillId: string,
  runtimeKind: "shell" | "node",
  entrypoint: string,
  capability: FridayCodeRepoCapability,
): SkillManifestV2 {
  const inputs: SkillManifestV2["inputs"] = [
    {
      key: "notes",
      type: "string",
      required: false,
      label: "Notes",
      help: "Optional notes for this generated capability run.",
    },
  ];

  if (runtimeKind === "shell") {
    inputs.push({
      key: "allowExec",
      type: "boolean",
      required: false,
      label: "Allow Command Execution",
      help: "Set true to execute the discovered command.",
      defaultValue: false,
    });
  }

  return {
    schemaVersion: "2.0",
    id: skillId,
    name: capability.name,
    description: capability.description,
    version: "1.0.0",
    kind: "workflow",
    category: "integration",
    author: { name: "friday-code-repo-converter" },
    tags: ["generated", "code-repo", capability.kind],
    runtime: {
      kind: runtimeKind,
      entrypoint,
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
      modes: ["intent", "workflow"],
    },
    requirements: {
      bins: runtimeKind === "shell" ? ["bash"] : [],
      env: [],
      config: [],
      os: ["darwin", "linux", "win32"],
    },
    inputs,
    outputs: [
      { key: "result", type: "object", description: "Capability execution result payload." },
    ],
    permissions: {
      grants: runtimeKind === "shell"
        ? [
            {
              id: "shell.execute",
              resource: "shell",
              action: "execute",
              required: true,
              reason: "Generated repository CLI/script capability",
            },
          ]
        : [],
      promptOn: runtimeKind === "shell" ? ["shell.execute"] : [],
    },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
  };
}

function buildUiSchema(manifest: SkillManifestV2, capability: FridayCodeRepoCapability): FridaySkillUiSchemaV1 {
  const fields: FridaySkillUiSchemaV1["fields"] = manifest.inputs.map((input) => ({
    id: `field-${input.key}`,
    inputKey: input.key,
    kind: input.type === "boolean" ? "toggle" : "text",
    label: input.label ?? input.key,
    required: input.required,
    help: input.help,
    defaultValue: input.defaultValue,
  }));

  return {
    schemaVersion: "1.0",
    title: manifest.name,
    description: `${manifest.description}\n\nKind: ${capability.kind}`,
    sections: [
      {
        id: "main",
        label: "Inputs",
        fieldIds: fields.map((f) => f.id),
      },
    ],
    fields,
    outputs: [
      {
        id: "result",
        outputKey: "result",
        label: "Result",
        widget: "json",
      },
    ],
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function buildShellEntrypoint(capability: FridayCodeRepoCapability): string {
  const command = toShellCommand(capability);
  const escapedCommand = quoteShellArg(command);
  return `#!/usr/bin/env bash
set -euo pipefail
INPUT_JSON="$(cat || true)"

if echo "$INPUT_JSON" | grep -Eq '"allowExec"[[:space:]]*:[[:space:]]*true'; then
  set +e
  bash -lc -- ${escapedCommand} >/dev/null 2>&1
  EXIT_CODE=$?
  set -e
  printf '{"result":{"kind":"%s","mode":"executed","command":"%s","exitCode":%s}}\\n' \
    "${escapeForPrintf(capability.kind)}" \
    "${escapeForPrintf(command)}" \
    "$EXIT_CODE"
else
  printf '{"result":{"kind":"%s","mode":"preview","command":"%s","message":"Set allowExec=true to execute."}}\\n' \
    "${escapeForPrintf(capability.kind)}" \
    "${escapeForPrintf(command)}"
fi
`;
}

function buildNodeEntrypoint(capability: FridayCodeRepoCapability): string {
  const metadata = JSON.stringify(capability.metadata ?? {}, null, 2);
  return `export async function execute(input) {
  return {
    result: {
      kind: ${JSON.stringify(capability.kind)},
      name: ${JSON.stringify(capability.name)},
      confidence: ${JSON.stringify(capability.confidence)},
      metadata: ${metadata},
      receivedInput: input ?? {},
      mode: "analysis"
    }
  };
}
`;
}

function toShellCommand(capability: FridayCodeRepoCapability): string {
  if (capability.kind === "cli-command") {
    const command = capability.metadata["command"];
    if (typeof command === "string" && command.trim().length > 0) {
      return command;
    }
  }
  if (capability.kind === "script-task") {
    const scriptPath = capability.metadata["scriptPath"];
    if (typeof scriptPath === "string" && scriptPath.trim().length > 0) {
      return `bash ${quoteShellArg(scriptPath)}`;
    }
  }
  return `echo ${quoteShellArg(`No executable command for ${capability.name}`)}`;
}

function isShellCapability(capability: FridayCodeRepoCapability): boolean {
  return capability.kind === "cli-command" || capability.kind === "script-task";
}

function toSkillId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "generated-skill";
}

function quoteShellArg(input: string): string {
  return `'${input.replace(/'/g, `'\"'\"'`)}'`;
}

function escapeForPrintf(input: string): string {
  return input.replace(/[%\\"]/g, (m) => {
    if (m === "%") return "%%";
    if (m === "\\") return "\\\\";
    return "\\\"";
  });
}
