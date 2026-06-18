import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createFridayLegacySkillBridge,
  interpolateCommand,
  interpolateCommandToEnvRefs,
  selectCommand,
} from "../../../../src/skills/bridge/friday-legacy-skill-bridge.js";
import type {
  FridayShellExecutor,
  FridayShellRunOptions,
  FridayShellRunResult,
} from "#skills";
import type { AdaptedFridayLegacySkill } from "#skills";
import type { SkillManifestV2 } from "#skills";
import type { ExtractedCommand } from "../../../../src/skills/converter/utils/friday-markdown-command-extractor.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Output shape returned by the legacy bridge ───

interface LegacyBridgeOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  commandLabel: string;
  commandIndex: number;
}

// ─── Helpers ───

function makeManifest(overrides: Partial<SkillManifestV2> = {}): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    version: "0.0.0",
    description: "A test skill",
    kind: "conversation",
    category: "utility",
    author: { name: "test" },
    tags: [],
    runtime: {
      kind: "builtin",
      entrypoint: "",
      minHubVersion: "1.0.0",
      apiVersion: "1",
      timeoutMsDefault: 30_000,
    },
    triggers: { intents: [], phrases: [], channels: ["*"] },
    invocation: {
      userInvocable: true,
      modelInvocable: true,
      priority: 50,
      modes: ["intent"],
    },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux", "win32"] },
    inputs: [],
    outputs: [],
    permissions: { grants: [], promptOn: [] },
    schemas: { input: null, state: null, output: null },
    flow: null,
    executionTargets: {
      allowedSatelliteTypes: ["phone", "desktop", "rpi", "cloud-vm"],
      requiredCapabilities: [],
    },
    telemetry: { events: [] },
    ...overrides,
  };
}

function makeAdapted(
  skillMdPath: string,
  overrides: Partial<AdaptedFridayLegacySkill> = {},
): AdaptedFridayLegacySkill {
  return {
    skillMdPath,
    frontmatter: {},
    metadata: undefined,
    invocation: { userInvocable: true, disableModelInvocation: false },
    manifest: makeManifest(),
    warnings: [],
    ...overrides,
  };
}

function makeShellResult(overrides: Partial<FridayShellRunResult> = {}): FridayShellRunResult {
  return {
    exitCode: 0,
    stdout: "command output",
    stderr: "",
    timedOut: false,
    cancelled: false,
    durationMs: 42,
    ...overrides,
  };
}

// ─── Tests ───

describe("selectCommand", () => {
  const commands: ExtractedCommand[] = [
    { label: "Quick one-liner", command: 'curl -s "wttr.in/London?format=3"', lang: "bash" },
    { label: "Full forecast", command: 'curl -s "wttr.in/London?T"', lang: "bash" },
    { label: "Open-Meteo fallback", command: "curl -s https://api.open-meteo.com/...", lang: "bash" },
  ];

  it("returns 0 when no input or message", () => {
    expect(selectCommand(commands, {})).toBe(0);
  });

  it("selects by commandIndex", () => {
    expect(selectCommand(commands, { commandIndex: 2 })).toBe(2);
  });

  it("falls back to 0 for out-of-range commandIndex", () => {
    expect(selectCommand(commands, { commandIndex: 99 })).toBe(0);
  });

  it("selects by commandLabel match", () => {
    expect(selectCommand(commands, { commandLabel: "forecast" })).toBe(1);
  });

  it("selects by user message fuzzy match", () => {
    expect(selectCommand(commands, {}, "full forecast please")).toBe(1);
  });

  it("falls back to 0 when nothing matches", () => {
    expect(selectCommand(commands, {}, "something unrelated xyz")).toBe(0);
  });

  it("returns 0 for empty commands array", () => {
    expect(selectCommand([], {})).toBe(0);
  });
});

describe("interpolateCommand", () => {
  it("replaces {{variable}} placeholders", () => {
    const result = interpolateCommand('curl "wttr.in/{{city}}?format=3"', { city: "London" });
    expect(result).toBe('curl "wttr.in/London?format=3"');
  });

  it("leaves unknown placeholders intact", () => {
    const result = interpolateCommand("echo {{unknown}}", {});
    expect(result).toBe("echo {{unknown}}");
  });

  it("handles multiple replacements", () => {
    const result = interpolateCommand("{{a}} + {{b}} = {{c}}", {
      a: "1",
      b: "2",
      c: "3",
    });
    expect(result).toBe("1 + 2 = 3");
  });

  it("converts non-string values to strings", () => {
    const result = interpolateCommand("count={{n}}", { n: 42 });
    expect(result).toBe("count=42");
  });

  it("returns template unchanged when no placeholders", () => {
    const result = interpolateCommand("echo hello", {});
    expect(result).toBe("echo hello");
  });
});

describe("interpolateCommandToEnvRefs", () => {
  it("replaces {{variable}} with quoted env var reference", () => {
    const result = interpolateCommandToEnvRefs('curl "wttr.in/{{city}}?format=3"');
    expect(result).toBe('curl "wttr.in/"$FRIDAY_INPUT_CITY"?format=3"');
  });

  it("uppercases the variable name", () => {
    const result = interpolateCommandToEnvRefs("echo {{myVar}}");
    expect(result).toBe('echo "$FRIDAY_INPUT_MYVAR"');
  });

  it("returns template unchanged when no placeholders", () => {
    const result = interpolateCommandToEnvRefs("echo hello");
    expect(result).toBe("echo hello");
  });

  it("handles multiple placeholders", () => {
    const result = interpolateCommandToEnvRefs("{{a}} + {{b}}");
    expect(result).toBe('"$FRIDAY_INPUT_A" + "$FRIDAY_INPUT_B"');
  });
});

describe("selectCommand — non-integer rejection", () => {
  const commands: ExtractedCommand[] = [
    { label: "Cmd A", command: "echo A", lang: "bash" },
    { label: "Cmd B", command: "echo B", lang: "bash" },
  ];

  it("rejects non-integer commandIndex (1.5)", () => {
    expect(selectCommand(commands, { commandIndex: 1.5 })).toBe(0);
  });

  it("rejects NaN commandIndex", () => {
    expect(selectCommand(commands, { commandIndex: NaN })).toBe(0);
  });

  it("rejects Infinity commandIndex", () => {
    expect(selectCommand(commands, { commandIndex: Infinity })).toBe(0);
  });

  it("accepts valid integer commandIndex", () => {
    expect(selectCommand(commands, { commandIndex: 1 })).toBe(1);
  });
});

describe("FridayLegacySkillBridge", () => {
  let tmpDir: string;
  let skillMdPath: string;
  let mockShellExecutor: FridayShellExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "friday-bridge-test-"));
    skillMdPath = join(tmpDir, "SKILL.md");

    mockShellExecutor = {
      run: vi.fn<(options: FridayShellRunOptions) => Promise<FridayShellRunResult>>().mockResolvedValue(
        makeShellResult(),
      ),
    };
  });

  function writeSkillMd(content: string) {
    writeFileSync(skillMdPath, content, "utf-8");
  }

  it("wraps a legacy skill and returns a FridaySkill with manifest", () => {
    writeSkillMd(`# Test

\`\`\`bash
echo hello
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const adapted = makeAdapted(skillMdPath);
    const skill = bridge.wrap(adapted);

    expect(skill.manifest).toBe(adapted.manifest);
    expect(typeof skill.init).toBe("function");
    expect(typeof skill.execute).toBe("function");
    expect(typeof skill.teardown).toBe("function");
  });

  it("init() creates a valid run state with extracted commands", async () => {
    writeSkillMd(`# Test

## Greet

\`\`\`bash
echo "hello"
\`\`\`

## Farewell

\`\`\`bash
echo "goodbye"
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    expect(run.status).toBe("running");
    expect(run.skillId).toBe("test-skill");
    expect(run.state.commands).toHaveLength(2);
    expect(run.state.commands[0]!.label).toBe("Greet");
    expect(run.state.commands[1]!.label).toBe("Farewell");
    expect(run.state.lastCommandIndex).toBe(-1);
  });

  it("execute() runs the first command by default", async () => {
    writeSkillMd(`# Test

\`\`\`bash
echo "default command"
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({
      input: {},
      run,
    });

    expect(result.run.status).toBe("completed");
    expect(mockShellExecutor.run).toHaveBeenCalledTimes(1);

    const callArgs = (mockShellExecutor.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.command).toBe("sh");
    expect(callArgs.args).toEqual(["-c", 'echo "default command"']);
    // Verify cwd is set to skill directory (fix #3)
    expect(callArgs.cwd).toBe(tmpDir);
    expect(callArgs.osSandbox).toEqual({
      enabled: process.platform === "darwin",
      required: process.platform === "darwin",
      denyNetwork: true,
      writableRoots: [tmpDir],
    });
  });

  it("execute() selects command by commandIndex", async () => {
    writeSkillMd(`# Test

## Cmd A

\`\`\`bash
echo "A"
\`\`\`

## Cmd B

\`\`\`bash
echo "B"
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: { commandIndex: 1 },
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({
      input: { commandIndex: 1 },
      run,
    });

    const callArgs = (mockShellExecutor.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.args).toEqual(["-c", 'echo "B"']);
    expect((result.output as LegacyBridgeOutput).commandIndex).toBe(1);
  });

  it("execute() returns failure on non-zero exit code", async () => {
    writeSkillMd(`# Test

\`\`\`bash
exit 1
\`\`\`
`);
    (mockShellExecutor.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeShellResult({
        exitCode: 1,
        stdout: "",
        stderr: "something went wrong",
      }),
    );

    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({ input: {}, run });

    expect(result.run.status).toBe("failed");
    expect(result.messages.some((m) => m.text.includes("something went wrong"))).toBe(true);
    expect((result.output as LegacyBridgeOutput).exitCode).toBe(1);
  });

  it("execute() reports timeout", async () => {
    writeSkillMd(`# Test

\`\`\`bash
sleep 60
\`\`\`
`);
    (mockShellExecutor.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeShellResult({
        exitCode: 124,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    );

    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({ input: {}, run });

    expect(result.run.status).toBe("failed");
    expect(result.messages.some((m) => m.text.includes("timed out"))).toBe(true);
    expect((result.output as LegacyBridgeOutput).timedOut).toBe(true);
  });

  it("execute() fails gracefully when no commands found", async () => {
    writeSkillMd(`# Empty Skill

Just text, no code blocks.
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({ input: {}, run });

    expect(result.run.status).toBe("failed");
    expect(result.messages[0]!.text).toContain("No executable commands");
    expect(mockShellExecutor.run).not.toHaveBeenCalled();
  });

  it("execute() sets skill environment variables", async () => {
    writeSkillMd(`# Test

\`\`\`bash
echo $FRIDAY_SKILL_ID
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: { city: "London" },
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    await skill.execute({ input: { city: "London" }, run });

    const callArgs = (mockShellExecutor.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.env.FRIDAY_SKILL_ID).toBe("test-skill");
    expect(callArgs.env.FRIDAY_SKILL_NAME).toBe("Test Skill");
    expect(callArgs.env.FRIDAY_INPUT_CITY).toBe("London");
  });

  it("execute() handles SKILL.md with frontmatter", async () => {
    writeSkillMd(`---
name: test-skill
description: A test
---

# Test

\`\`\`bash
echo "after frontmatter"
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    const result = await skill.execute({ input: {}, run });

    expect(result.run.status).toBe("completed");
    const callArgs = (mockShellExecutor.run as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArgs.args).toEqual(["-c", 'echo "after frontmatter"']);
  });

  it("teardown() resolves without error", async () => {
    writeSkillMd(`# Test

\`\`\`bash
echo "hi"
\`\`\`
`);
    const bridge = createFridayLegacySkillBridge({ shellExecutor: mockShellExecutor });
    const skill = bridge.wrap(makeAdapted(skillMdPath));

    const run = await skill.init({
      input: {},
      sessionId: "sess-1",
      userId: "user-1",
      channel: "test",
      nowIso: "2025-01-01T00:00:00Z",
    });

    await expect(
      skill.teardown({ run, reason: "completed" }),
    ).resolves.toBeUndefined();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
});
