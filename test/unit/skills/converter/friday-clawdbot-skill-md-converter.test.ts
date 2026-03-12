import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClawdbotSkillMdConverter } from "#skills/converter";
import type { FridaySkillConverterContext } from "#skills/converter";

const NOW_ISO = "2026-02-17T12:00:00.000Z";

function makeCtx(overrides: Partial<FridaySkillConverterContext> = {}): FridaySkillConverterContext {
  return {
    workspaceDir: "/workspace",
    managedSkillsDir: "/managed",
    nowIso: () => NOW_ISO,
    ...overrides,
  };
}

describe("ClawdbotSkillMdConverter", () => {
  let testDir: string;
  const converter = createClawdbotSkillMdConverter();

  beforeEach(() => {
    testDir = join(tmpdir(), `friday-test-clawdbot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ─── detect ───

  describe("detect", () => {
    it("returns null for source without uri", async () => {
      const result = await converter.detect({});
      expect(result).toBeNull();
    });

    it("returns null when no SKILL.md exists", async () => {
      const result = await converter.detect({ uri: testDir });
      expect(result).toBeNull();
    });

    it("detects SKILL.md with frontmatter at high confidence", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: weather
---

# Weather
`);
      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
      expect(result!.format).toBe("clawdbot-skill-md");
      expect(result!.converterId).toBe("clawdbot-skill-md");
    });

    it("detects SKILL.md without frontmatter at lower confidence", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `# Weather

Just some plain markdown.
`);
      const result = await converter.detect({ uri: testDir });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.5);
    });

    it("detects when uri points directly to SKILL.md", async () => {
      const skillMdPath = join(testDir, "SKILL.md");
      writeFileSync(skillMdPath, `---
name: test
---
Body content.
`);
      const result = await converter.detect({ uri: skillMdPath });
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
    });
  });

  // ─── convert ───

  describe("convert", () => {
    it("throws when source has no uri", async () => {
      await expect(converter.convert({}, makeCtx())).rejects.toThrow(
        "ClawdbotSkillMdConverter requires a source URI",
      );
    });

    it("throws when SKILL.md is not found", async () => {
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      await expect(converter.convert({ uri: emptyDir }, makeCtx())).rejects.toThrow(
        "SKILL.md not found",
      );
    });

    it("converts a simple single-command SKILL.md", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: weather
skillKey: weather-skill
---

Get the current weather.

## Check weather

\`\`\`bash
curl -s "wttr.in/{{city}}?format=3"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());

      expect(result.converterId).toBe("clawdbot-skill-md");
      expect(result.detectedFormat).toBe("clawdbot-skill-md");
      expect(result.drafts).toHaveLength(1);

      const draft = result.drafts[0]!;

      // Manifest checks
      expect(draft.manifest.id).toBe("weather-skill");
      expect(draft.manifest.name).toBe("weather");
      expect(draft.manifest.runtime.kind).toBe("shell");
      expect(draft.manifest.runtime.entrypoint).toBe("run.sh");
      expect(draft.manifest.version).toBe("1.0.0");

      // Should have city input from placeholder
      const cityInput = draft.manifest.inputs.find((i) => i.key === "city");
      expect(cityInput).toBeDefined();
      expect(cityInput!.type).toBe("string");

      // Should NOT have command selector (single command)
      const commandInput = draft.manifest.inputs.find((i) => i.key === "command");
      expect(commandInput).toBeUndefined();

      // Outputs
      expect(draft.manifest.outputs).toHaveLength(3);
      expect(draft.manifest.outputs.map((o) => o.key)).toEqual(["stdout", "stderr", "exitCode"]);

      // Files
      expect(draft.files.find((f) => f.path === "run.sh")).toBeDefined();
      expect(draft.files.find((f) => f.path === "skill.manifest.json")).toBeDefined();
      expect(draft.files.find((f) => f.path === "skill.ui.json")).toBeDefined();
      expect(draft.files.find((f) => f.path === "SKILL.md")).toBeDefined();
      expect(draft.files.find((f) => f.path === "conversion.report.json")).toBeDefined();

      // run.sh should be executable
      const runSh = draft.files.find((f) => f.path === "run.sh")!;
      expect(runSh.executable).toBe(true);

      // run.sh should use env var refs
      expect(runSh.content).toContain("$FRIDAY_INPUT_CITY");
      expect(runSh.content).not.toContain("{{city}}");

      // Conversion report
      expect(draft.conversionReport.sourceFormat).toBe("clawdbot-skill-md");
      expect(draft.conversionReport.convertedAt).toBe(NOW_ISO);
      expect(draft.conversionReport.converterId).toBe("clawdbot-skill-md");
    });

    it("converts multi-command SKILL.md with command selector", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: github
---

GitHub helper commands.

## Check CI

\`\`\`bash
gh pr checks {{pr_number}} --repo {{repo}}
\`\`\`

## List runs

\`\`\`bash
gh run list --repo {{repo}} --limit 10
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const draft = result.drafts[0]!;

      // Should have command selector
      const commandInput = draft.manifest.inputs.find((i) => i.key === "command");
      expect(commandInput).toBeDefined();
      expect(commandInput!.required).toBe(true);
      expect(commandInput!.validation?.enum).toEqual(["Check CI", "List runs"]);

      // Should have placeholder inputs
      const prInput = draft.manifest.inputs.find((i) => i.key === "pr_number");
      expect(prInput).toBeDefined();
      const repoInput = draft.manifest.inputs.find((i) => i.key === "repo");
      expect(repoInput).toBeDefined();

      // run.sh should have case statement
      const runSh = draft.files.find((f) => f.path === "run.sh")!;
      expect(runSh.content).toContain("case");
      expect(runSh.content).toContain('"Check CI"');
      expect(runSh.content).toContain('"List runs"');
      expect(runSh.content).toContain("FRIDAY_INPUT_COMMAND");

      // UI schema should have select field for command
      const commandField = draft.uiSchema.fields.find((f) => f.inputKey === "command");
      expect(commandField).toBeDefined();
      expect(commandField!.kind).toBe("select");
    });

    it("substitutes placeholders in multi-command skills", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: multi-sub
---

Multi-command with placeholders.

## Greet

\`\`\`bash
echo "Hello {{name}} from {{city}}"
\`\`\`

## Farewell

\`\`\`bash
echo "Goodbye {{name}}, leaving {{city}}"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const runSh = result.drafts[0]!.files.find((f) => f.path === "run.sh")!;

      // Both commands should have substituted placeholders
      expect(runSh.content).toContain("$FRIDAY_INPUT_NAME");
      expect(runSh.content).toContain("$FRIDAY_INPUT_CITY");
      expect(runSh.content).not.toContain("{{name}}");
      expect(runSh.content).not.toContain("{{city}}");

      // Count occurrences — should appear in both branches
      const nameOccurrences = (runSh.content.match(/\$FRIDAY_INPUT_NAME/g) ?? []).length;
      expect(nameOccurrences).toBeGreaterThanOrEqual(2);
    });

    it("escapes special characters in shell case labels", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: escape-test
---

Test shell escaping.

## Run "quoted"

\`\`\`bash
echo "first"
\`\`\`

## Check $var

\`\`\`bash
echo "second"
\`\`\`

## Use \`backtick\`

\`\`\`bash
echo "third"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const runSh = result.drafts[0]!.files.find((f) => f.path === "run.sh")!;

      // Case labels should not contain dangerous characters
      expect(runSh.content).not.toMatch(/"Run "quoted""/);
      expect(runSh.content).not.toContain('$var');
      expect(runSh.content).not.toContain('`backtick`');

      // Labels should be sanitized but still usable
      expect(runSh.content).toContain("Run quoted");
      expect(runSh.content).toContain("Check var");
      expect(runSh.content).toContain("Use backtick");
    });

    it("handles SKILL.md with no commands gracefully", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: empty-skill
---

This skill has no commands.

Just documentation.
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const draft = result.drafts[0]!;

      expect(draft.manifest.inputs).toHaveLength(0);
      expect(draft.warnings).toContain("No executable command blocks found in SKILL.md body.");

      // run.sh should exit with error
      const runSh = draft.files.find((f) => f.path === "run.sh")!;
      expect(runSh.content).toContain("No commands available");
      expect(runSh.content).toContain("exit 1");
    });

    it("preserves frontmatter metadata in manifest", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: my-skill
homepage: https://example.com
license: MIT
tags: weather,api,cli
author: Test Author
userInvocable: false
disableModelInvocation: true
requires.bins: curl,jq
requires.env: API_KEY
requires.config: weather.city
primaryEnv: WEATHER_API
os: darwin,linux
---

Description text here.

\`\`\`bash
echo "hello"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const manifest = result.drafts[0]!.manifest;

      expect(manifest.name).toBe("my-skill");
      expect(manifest.homepage).toBe("https://example.com");
      expect(manifest.license).toBe("MIT");
      expect(manifest.tags).toEqual(["weather", "api", "cli"]);
      expect(manifest.author.name).toBe("Test Author");
      expect(manifest.invocation.userInvocable).toBe(false);
      expect(manifest.invocation.modelInvocable).toBe(false);
      expect(manifest.requirements.bins).toEqual(["curl", "jq"]);
      expect(manifest.requirements.env).toEqual(["WEATHER_API", "API_KEY"]);
      expect(manifest.requirements.config).toEqual(["weather.city"]);
      expect(manifest.requirements.os).toEqual(["darwin", "linux"]);
    });

    it("uses directory name as skill id when no skillKey", async () => {
      const skillDir = join(testDir, "my-cool-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `---
name: Cool Skill
---

A cool skill.

\`\`\`bash
echo "cool"
\`\`\`
`);

      const result = await converter.convert({ uri: skillDir }, makeCtx());
      expect(result.drafts[0]!.manifest.id).toBe("my-cool-skill");
    });

    it("deduplicates placeholders across multiple commands", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: test
---

Test skill.

## First

\`\`\`bash
echo "{{name}} in {{city}}"
\`\`\`

## Second

\`\`\`bash
echo "Hello {{name}} from {{country}}"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const inputs = result.drafts[0]!.manifest.inputs;

      // Should have command + 3 unique placeholders
      const placeholderInputs = inputs.filter((i) => i.key !== "command");
      expect(placeholderInputs).toHaveLength(3);
      expect(placeholderInputs.map((i) => i.key)).toEqual(["name", "city", "country"]);
    });

    it("generates valid UI schema with correct sections", async () => {
      writeFileSync(join(testDir, "SKILL.md"), `---
name: ui-test
---

Test skill with UI.

## Run

\`\`\`bash
echo "{{message}}"
\`\`\`
`);

      const result = await converter.convert({ uri: testDir }, makeCtx());
      const ui = result.drafts[0]!.uiSchema;

      expect(ui.schemaVersion).toBe("1.0");
      expect(ui.title).toBe("ui-test");
      expect(ui.sections).toHaveLength(1);
      expect(ui.sections[0]!.id).toBe("main");
      expect(ui.fields).toHaveLength(1);
      expect(ui.fields[0]!.inputKey).toBe("message");
      expect(ui.fields[0]!.kind).toBe("text");
      expect(ui.actions).toHaveLength(2);
      expect(ui.actions[0]!.id).toBe("run");
      expect(ui.actions[1]!.id).toBe("reset");
      expect(ui.outputs).toHaveLength(3);
    });
  });
});
