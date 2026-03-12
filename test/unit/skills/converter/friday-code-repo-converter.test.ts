import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createFridayCodeRepoConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";
import { materializeFridayCodeRepoSource } from "../../../../src/skills/converter/code-repo/friday-source-materializer.js";
import { extractFridayCodeRepoCapabilities } from "../../../../src/skills/converter/code-repo/friday-capability-extractor.js";

const NOW_ISO = "2026-02-23T12:00:00.000Z";

function makeCtx(overrides: Partial<FridaySkillConverterContext> = {}): FridaySkillConverterContext {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe("FridayCodeRepoConverter", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(tmpdir(), `friday-test-code-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, "src"), { recursive: true });

    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          scripts: {
            start: "node src/server.js",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(repoDir, "src", "server.js"),
      `
      import express from "express";
      const app = express();
      app.get("/health", (_req, res) => res.json({ ok: true }));
      app.post("/users", (_req, res) => res.status(201).json({ id: "u1" }));
      export function utilThing(a) { return a; }
      `,
    );

    mkdirSync(join(repoDir, "scripts"), { recursive: true });
    writeFileSync(join(repoDir, "scripts", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n");

    mkdirSync(join(repoDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "x", "ignored.js"), "app.get('/ignored', () => {})");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("detects code-repo from explicit hint", async () => {
    const converter = createFridayCodeRepoConverter();
    const detection = await converter.detect({
      uri: repoDir,
      formatHint: "code-repo",
    });

    expect(detection).not.toBeNull();
    expect(detection?.converterId).toBe("code-repo");
    expect(detection?.format).toBe("code-repo");
  });

  it("detects repository capabilities from directory scan", async () => {
    const converter = createFridayCodeRepoConverter();
    const detection = await converter.detect({
      uri: repoDir,
    });

    expect(detection).not.toBeNull();
    expect(detection?.reasons.join(" ")).toContain("Detected capabilities");
  });

  it("converts repository to generated drafts", async () => {
    const converter = createFridayCodeRepoConverter();
    const result = await converter.convert(
      {
        uri: repoDir,
        formatHint: "code-repo",
      },
      makeCtx(),
    );

    expect(result.converterId).toBe("code-repo");
    expect(result.detectedFormat).toBe("code-repo");
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(result.drafts[0]?.conversionReport.sourceFormat).toBe("code-repo");
  });

  it("materializer ignores node_modules for safety and signal quality", () => {
    const materialized = materializeFridayCodeRepoSource(repoDir);
    const paths = materialized.files.map((f) => f.relativePath);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("extractor finds HTTP and CLI capabilities", () => {
    const materialized = materializeFridayCodeRepoSource(repoDir);
    const capabilities = extractFridayCodeRepoCapabilities(materialized);
    expect(capabilities.some((c) => c.kind === "http-endpoint")).toBe(true);
    expect(capabilities.some((c) => c.kind === "cli-command")).toBe(true);
  });

  it("generates shell entrypoint with escaped command execution wrapper", async () => {
    const converter = createFridayCodeRepoConverter();
    const result = await converter.convert(
      {
        uri: repoDir,
        formatHint: "code-repo",
      },
      makeCtx(),
    );

    const shellDraft = result.drafts.find((draft) => draft.manifest.runtime.kind === "shell");
    expect(shellDraft).toBeTruthy();
    const runSh = shellDraft?.files.find((file) => file.path === "run.sh");
    expect(runSh).toBeTruthy();
    expect(runSh?.content).toContain("bash -lc --");
  });
});
