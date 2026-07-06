import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type LockDependency = {
  specifier?: string;
};

type PnpmLock = {
  importers?: {
    "."?: {
      dependencies?: Record<string, LockDependency>;
      devDependencies?: Record<string, LockDependency>;
    };
  };
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

function readPnpmLock(): PnpmLock {
  return parse(readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")) as PnpmLock;
}

describe("pnpm lockfile", () => {
  it("keeps root dependency specifiers in sync with package.json", () => {
    const packageJson = readPackageJson();
    const rootImporter = readPnpmLock().importers?.["."];

    expect(rootImporter).toBeTruthy();

    for (const [name, specifier] of Object.entries(packageJson.dependencies ?? {})) {
      expect(rootImporter?.dependencies?.[name]?.specifier, `dependency ${name}`).toBe(specifier);
    }

    for (const [name, specifier] of Object.entries(packageJson.devDependencies ?? {})) {
      expect(rootImporter?.devDependencies?.[name]?.specifier, `devDependency ${name}`).toBe(specifier);
    }
  });
});
