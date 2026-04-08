#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;

const RULES = [
  {
    scope: "src/state",
    label: "State layer stays below config/errors only",
    allowedAliases: ["#config", "#errors"],
    allowedRelativeRoots: [],
  },
  {
    scope: "src/security",
    label: "Security layer avoids app-surface aliases",
    allowedAliases: ["#errors"],
    allowedRelativeRoots: ["src/api", "src/observability", "src/providers", "src/security"],
  },
  {
    scope: "src/channels",
    label: "Channel layer only depends on agent/error aliases",
    allowedAliases: ["#agent", "#errors"],
    allowedRelativeRoots: ["src/channels", "src/security"],
  },
  {
    scope: "src/providers",
    label: "Provider layer remains infrastructure-only",
    allowedAliases: ["#state", "#errors", "#utilities"],
    allowedRelativeRoots: ["src/agent", "src/learning", "src/providers", "src/security"],
  },
];

function parseArgs(argv) {
  const explicit = argv.find((entry) => !entry.startsWith("--"))?.trim();
  return {
    repoRoot: explicit ? path.resolve(explicit) : process.cwd(),
  };
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const pending = [rootDir];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (SOURCE_FILE_PATTERN.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function extractSpecifiers(content) {
  const specifiers = [];
  const staticImportRegex = /(?:import|export)\s[\s\S]*?\sfrom\s+["']([^"']+)["']/gu;
  const bareImportRegex = /import\s+["']([^"']+)["']/gu;
  const dynamicImportRegex = /import\(\s*["']([^"']+)["']\s*\)/gu;
  for (const regex of [staticImportRegex, bareImportRegex, dynamicImportRegex]) {
    for (const match of content.matchAll(regex)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function normalizeAlias(specifier) {
  const root = specifier.slice(1).split("/")[0];
  return `#${root}`;
}

function resolveRelativeImport(filePath, specifier) {
  return path.resolve(path.dirname(filePath), specifier);
}

function checkRule(repoRoot, rule) {
  const scopeRoot = path.join(repoRoot, rule.scope);
  const allowedRelativeRoots = (rule.allowedRelativeRoots ?? []).map((entry) => path.join(repoRoot, entry));
  const scopeFiles = walkFiles(scopeRoot);
  const violations = [];

  for (const filePath of scopeFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const specifier of extractSpecifiers(content)) {
      if (specifier.startsWith("#")) {
        const normalized = normalizeAlias(specifier);
        if (!rule.allowedAliases.includes(normalized)) {
          violations.push({
            type: "alias",
            file: path.relative(repoRoot, filePath),
            specifier,
            message: `${path.relative(repoRoot, filePath)} imports ${specifier}, but ${rule.scope} only allows ${rule.allowedAliases.join(", ")}.`,
          });
        }
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeImport(filePath, specifier);
      const withinAllowedRoots = allowedRelativeRoots.some(
        (allowedRoot) => resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`),
      );
      if (!(resolved === scopeRoot || resolved.startsWith(`${scopeRoot}${path.sep}`) || withinAllowedRoots)) {
        violations.push({
          type: "relative-escape",
          file: path.relative(repoRoot, filePath),
          specifier,
          message: `${path.relative(repoRoot, filePath)} escapes ${rule.scope} through relative import ${specifier}.`,
        });
      }
    }
  }

  return {
    kind: "architecture-boundary",
    label: rule.label,
    target: rule.scope,
    status: violations.length === 0 ? "passed" : "failed",
    fileCount: scopeFiles.length,
    allowedAliases: rule.allowedAliases,
    violations,
  };
}

function main() {
  const { repoRoot } = parseArgs(process.argv.slice(2));
  const checks = RULES.map((rule) => checkRule(repoRoot, rule));
  const failed = checks.filter((check) => check.status === "failed");
  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    status: failed.length === 0 ? "passed" : "failed",
    summary: {
      passed: checks.filter((check) => check.status === "passed").length,
      failed: failed.length,
    },
    checks,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
