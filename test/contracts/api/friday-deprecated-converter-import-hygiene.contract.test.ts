import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DEPRECATED_CONVERTER_DIR = path.join(ROOT, "src", "converter");
const SEARCH_ROOTS = [
  path.join(ROOT, "src"),
  path.join(ROOT, "test"),
];

const IMPORT_SPECIFIER_PATTERNS = [
  /from\s+["']([^"']+)["']/g,
  /import\s+["']([^"']+)["']/g,
];

function importsDeprecatedConverter(importerPath: string, content: string): boolean {
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1]!;
      if (specifier === "#converter") {
        return true;
      }
      if (specifier.startsWith("#")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(importerPath), specifier);
      if (resolved.startsWith(DEPRECATED_CONVERTER_DIR)) {
        return true;
      }
    }
  }
  return false;
}

describe("Deprecated converter import hygiene", () => {
  it("disallows direct src/converter imports everywhere", () => {
    const violations: string[] = [];

    function scanDir(dir: string) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (fullPath.startsWith(DEPRECATED_CONVERTER_DIR)) {
          continue;
        }

        if (entry.isDirectory()) {
          scanDir(fullPath);
          continue;
        }

        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
          continue;
        }

        const content = readFileSync(fullPath, "utf8");
        if (!importsDeprecatedConverter(fullPath, content)) {
          continue;
        }

        violations.push(path.relative(ROOT, fullPath));
      }
    }

    for (const searchRoot of SEARCH_ROOTS) {
      scanDir(searchRoot);
    }

    expect(violations).toEqual([]);
  });
});
