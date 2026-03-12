import type {
  FridayCodeRepoCapability,
  FridayCodeRepoMaterializedSource,
} from "./friday-code-repo.types.js";

const HTTP_ROUTE_REGEX = /\b(?:app|router)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const HTTP_DECORATOR_REGEX = /@app\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const EXPORT_FUNCTION_REGEX = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const PYTHON_FUNCTION_REGEX = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

export function extractFridayCodeRepoCapabilities(
  materialized: FridayCodeRepoMaterializedSource,
): FridayCodeRepoCapability[] {
  const capabilities: FridayCodeRepoCapability[] = [];
  const seenIds = new Set<string>();

  for (const file of materialized.files) {
    extractHttpCapabilities(file.relativePath, file.content, capabilities, seenIds);
    extractLibraryCapabilities(file.relativePath, file.content, capabilities, seenIds);
    extractScriptCapabilities(file.relativePath, capabilities, seenIds);
  }

  const packageJson = materialized.files.find((f) => f.relativePath.endsWith("package.json"));
  if (packageJson) {
    extractNpmScriptCapabilities(packageJson.content, capabilities, seenIds);
  }

  return capabilities
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20);
}

function extractHttpCapabilities(
  relativePath: string,
  content: string,
  capabilities: FridayCodeRepoCapability[],
  seenIds: Set<string>,
): void {
  for (const match of content.matchAll(HTTP_ROUTE_REGEX)) {
    const method = (match[1] ?? "").toUpperCase();
    const path = match[2] ?? "/";
    const id = `http_${method}_${path}_${relativePath}`;
    addCapability(
      {
        kind: "http-endpoint",
        id,
        name: `${method} ${path}`,
        description: `HTTP endpoint discovered in ${relativePath}`,
        confidence: 0.82,
        metadata: { method, path, file: relativePath, framework: "express-like" },
      },
      capabilities,
      seenIds,
    );
  }

  for (const match of content.matchAll(HTTP_DECORATOR_REGEX)) {
    const method = (match[1] ?? "").toUpperCase();
    const path = match[2] ?? "/";
    const id = `http_${method}_${path}_${relativePath}`;
    addCapability(
      {
        kind: "http-endpoint",
        id,
        name: `${method} ${path}`,
        description: `HTTP endpoint discovered in ${relativePath}`,
        confidence: 0.78,
        metadata: { method, path, file: relativePath, framework: "decorator-based" },
      },
      capabilities,
      seenIds,
    );
  }
}

function extractLibraryCapabilities(
  relativePath: string,
  content: string,
  capabilities: FridayCodeRepoCapability[],
  seenIds: Set<string>,
): void {
  for (const match of content.matchAll(EXPORT_FUNCTION_REGEX)) {
    const functionName = match[1];
    if (!functionName) continue;
    addCapability(
      {
        kind: "library-function",
        id: `lib_${functionName}_${relativePath}`,
        name: functionName,
        description: `Exported function discovered in ${relativePath}`,
        confidence: 0.62,
        metadata: { functionName, file: relativePath, languageHint: "js-ts" },
      },
      capabilities,
      seenIds,
    );
  }

  for (const match of content.matchAll(PYTHON_FUNCTION_REGEX)) {
    const functionName = match[1];
    if (!functionName || functionName.startsWith("_")) continue;
    addCapability(
      {
        kind: "library-function",
        id: `lib_${functionName}_${relativePath}`,
        name: functionName,
        description: `Function discovered in ${relativePath}`,
        confidence: 0.55,
        metadata: { functionName, file: relativePath, languageHint: "python" },
      },
      capabilities,
      seenIds,
    );
  }
}

function extractScriptCapabilities(
  relativePath: string,
  capabilities: FridayCodeRepoCapability[],
  seenIds: Set<string>,
): void {
  const lower = relativePath.toLowerCase();
  if (!lower.endsWith(".sh") && !lower.endsWith(".bash") && !lower.endsWith(".zsh")) {
    return;
  }

  const scriptName = lower.split("/").pop() ?? lower;
  addCapability(
    {
      kind: "script-task",
      id: `script_${scriptName}`,
      name: scriptName,
      description: `Shell script task from ${relativePath}`,
      confidence: 0.7,
      metadata: { scriptPath: relativePath },
    },
    capabilities,
    seenIds,
  );
}

function extractNpmScriptCapabilities(
  packageJsonContent: string,
  capabilities: FridayCodeRepoCapability[],
  seenIds: Set<string>,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonContent);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const scripts = (parsed as { scripts?: Record<string, string> }).scripts;
  if (!scripts || typeof scripts !== "object") return;

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string" || command.trim().length === 0) continue;
    addCapability(
      {
        kind: "cli-command",
        id: `cli_npm_${name}`,
        name: `npm run ${name}`,
        description: `NPM script "${name}"`,
        confidence: 0.88,
        metadata: { command, runner: "npm", script: name },
      },
      capabilities,
      seenIds,
    );
  }
}

function addCapability(
  capability: FridayCodeRepoCapability,
  capabilities: FridayCodeRepoCapability[],
  seenIds: Set<string>,
): void {
  const normalizedId = normalizeId(capability.id);
  if (seenIds.has(normalizedId)) return;
  seenIds.add(normalizedId);
  capabilities.push({
    ...capability,
    id: normalizedId,
  });
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

