import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function workflowFilesContainingInteropProof(): string[] {
  const workflowDir = join(repoRoot, ".github", "workflows");
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(workflowDir, name))
    .filter((file) => readFileSync(file, "utf8").includes("interop_ts_"));
}

function triggerPaths(workflow: unknown, triggerName: "push" | "pull_request"): string[] | undefined {
  const root = workflow as Record<string, unknown>;
  const on = root.on as Record<string, unknown> | undefined;
  const trigger = on?.[triggerName];
  if (trigger === undefined || trigger === null) return undefined;
  if (typeof trigger !== "object") return undefined;
  const paths = (trigger as Record<string, unknown>).paths;
  if (paths === undefined) return undefined;
  expect(Array.isArray(paths), `${triggerName}.paths must be a string array when present`).toBe(true);
  return (paths as unknown[]).map((item) => String(item));
}

function pathMatchesGitHubFilter(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(file));
}

describe("rust-core interop proof workflow coverage", () => {
  it("does not leave the interop proof behind a hand-maintained paths gate", () => {
    const workflowFiles = workflowFilesContainingInteropProof();
    expect(workflowFiles, "expected at least one workflow to run interop_ts_ proofs").not.toHaveLength(0);

    for (const workflowFile of workflowFiles) {
      const workflow = parse(readFileSync(workflowFile, "utf8"));
      for (const triggerName of ["push", "pull_request"] as const) {
        expect(
          triggerPaths(workflow, triggerName),
          `${relative(repoRoot, workflowFile)} ${triggerName}.paths must be absent so the interop proof is eligible on every ${triggerName}`
        ).toBeUndefined();
      }
    }
  });

  it("keeps every bundled source input eligible to trigger the interop proof", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "friday-interop-metafile-"));
    const metafilePath = join(tempDir, "sealed-client-runner-metafile.json");

    try {
      execFileSync(process.execPath, ["test/interop/build-sealed-client-runner.mjs"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          FRIDAY_SEALED_CLIENT_RUNNER_METAFILE: metafilePath,
        },
        stdio: "pipe",
      });

      expect(
        existsSync(metafilePath),
        "build-sealed-client-runner.mjs must honor FRIDAY_SEALED_CLIENT_RUNNER_METAFILE so this guard audits the real esbuild bundle"
      ).toBe(true);

      const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as {
        inputs?: Record<string, unknown>;
      };
      const bundledSourceInputs = Object.keys(metafile.inputs ?? {})
        .map((input) => relative(repoRoot, resolve(repoRoot, input)).replaceAll("\\", "/"))
        .filter((input) => input.startsWith("src/"))
        .sort();

      expect(bundledSourceInputs, "expected the sealed-client bundle to include src/** inputs").not.toHaveLength(0);

      const workflowFiles = workflowFilesContainingInteropProof();
      expect(workflowFiles, "expected at least one workflow to run interop_ts_ proofs").not.toHaveLength(0);

      for (const workflowFile of workflowFiles) {
        const workflow = parse(readFileSync(workflowFile, "utf8"));
        for (const triggerName of ["push", "pull_request"] as const) {
          const paths = triggerPaths(workflow, triggerName);
          const uncovered =
            paths === undefined
              ? []
              : bundledSourceInputs.filter((input) => !pathMatchesGitHubFilter(input, paths));

          expect(
            uncovered,
            `${relative(repoRoot, workflowFile)} ${triggerName}.paths omits bundled interop source inputs`
          ).toEqual([]);
        }
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
