import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  cmdRuns,
  finalizeCliCommand,
  isCliEntrypointPath,
  parseArgs,
  loadProcessEnvFromDotEnvFile,
  prepareStartupChannelsConfig,
  readSetupNetworkBinding,
  runCliSkillCommand,
  resolveStartupNetworkBinding,
  writeFridaySetupEnvFile,
  type FridayCliRunCommandDeps,
} from "#cli";
import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";
import Database from "better-sqlite3";

const TEST_MASTER_KEY_HEX = "66".repeat(32);

function withProvisionedMasterKey<T>(run: () => T): T {
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;
  const previousMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;
  process.env.FRIDAY_MASTER_KEY = TEST_MASTER_KEY_HEX;
  delete process.env.FRIDAY_MASTER_KEY_SOURCE;
  try {
    return run();
  } finally {
    if (previousMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    }
    if (previousMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = previousMasterKeySource;
    }
  }
}

describe("parseArgs", () => {
  // Helper: simulate argv with node + script prefix
  const argv = (...args: string[]) => ["node", "friday-cli.js", ...args];

  describe("command parsing", () => {
    it("defaults to help with no args", () => {
      expect(parseArgs(argv()).command).toBe("help");
    });

    it("parses --help", () => {
      expect(parseArgs(argv("--help")).command).toBe("help");
    });

    it("parses -h", () => {
      expect(parseArgs(argv("-h")).command).toBe("help");
    });

    it("parses help command", () => {
      expect(parseArgs(argv("help")).command).toBe("help");
    });

    it("parses start command", () => {
      expect(parseArgs(argv("start")).command).toBe("start");
    });

    it("parses list command", () => {
      expect(parseArgs(argv("list")).command).toBe("list");
    });

    it("marks subcommand help without downgrading the parsed command", () => {
      const result = parseArgs(argv("list", "--help"));
      expect(result.command).toBe("list");
      expect(result.showHelp).toBe(true);
    });

    it("parses run command", () => {
      expect(parseArgs(argv("run", "my-skill")).command).toBe("run");
    });

    it("parses status command", () => {
      expect(parseArgs(argv("status")).command).toBe("status");
    });

    it("parses skills command", () => {
      expect(parseArgs(argv("skills", "init", "demo-skill")).command).toBe("skills");
    });

    it("parses phases command", () => {
      expect(parseArgs(argv("phases", "doctor")).command).toBe("phases");
    });

    it("parses tui command", () => {
      expect(parseArgs(argv("tui")).command).toBe("tui");
    });

    it("preserves host/port overrides for tui", () => {
      const result = parseArgs(argv("tui", "--host", "0.0.0.0", "--port", "4145"));
      expect(result.command).toBe("tui");
      expect(result.host).toBe("0.0.0.0");
      expect(result.port).toBe(4145);
    });

    it("falls back to help for unknown command", () => {
      expect(parseArgs(argv("bogus")).command).toBe("help");
    });
  });

  describe("--skills-dir", () => {
    it("parses a single --skills-dir", () => {
      const result = parseArgs(argv("start", "--skills-dir", "/path/to/skills"));
      expect(result.skillDirs).toEqual(["/path/to/skills"]);
    });

    it("parses multiple --skills-dir flags", () => {
      const result = parseArgs(
        argv("list", "--skills-dir", "/a", "--skills-dir", "/b"),
      );
      expect(result.skillDirs).toEqual(["/a", "/b"]);
    });

    it("defaults to empty array when not specified", () => {
      const result = parseArgs(argv("start"));
      expect(result.skillDirs).toEqual([]);
    });
  });

  describe("--port", () => {
    it("parses --port", () => {
      const result = parseArgs(argv("start", "--port", "8080"));
      expect(result.port).toBe(8080);
    });

    it("ignores non-numeric --port", () => {
      const result = parseArgs(argv("start", "--port", "abc"));
      expect(result.port).toBeUndefined();
    });

    it("rejects numeric-prefix --port values instead of truncating them", () => {
      const result = parseArgs(argv("start", "--port", "123abc"));
      expect(result.port).toBeUndefined();
    });

    it("defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.port).toBeUndefined();
    });
  });

  describe("run command", () => {
    it("captures skill-id", () => {
      const result = parseArgs(argv("run", "my-skill-id"));
      expect(result.command).toBe("run");
      expect(result.skillId).toBe("my-skill-id");
    });

    it("captures --input key=value pairs", () => {
      const result = parseArgs(
        argv("run", "my-skill", "--input", "name=world", "--input", "count=3"),
      );
      expect(result.input).toEqual({ name: "world", count: "3" });
    });

    it("handles --input with = in value", () => {
      const result = parseArgs(
        argv("run", "my-skill", "--input", "query=a=b=c"),
      );
      expect(result.input).toEqual({ query: "a=b=c" });
    });

    it("skillId is undefined if not provided", () => {
      const result = parseArgs(argv("run", "--input", "x=1"));
      expect(result.skillId).toBeUndefined();
    });
  });

  describe("import command", () => {
    it("parses import command with source", () => {
      const result = parseArgs(argv("import", "/path/to/skill.md"));
      expect(result.command).toBe("import");
      expect(result.source).toBe("/path/to/skill.md");
    });

    it("parses import with --from flag", () => {
      const result = parseArgs(argv("import", "/path/to/skill.md", "--from", "clawdbot-skill-md"));
      expect(result.command).toBe("import");
      expect(result.source).toBe("/path/to/skill.md");
      expect(result.from).toBe("clawdbot-skill-md");
    });

    it("parses import with --target flag", () => {
      const result = parseArgs(argv("import", "/path/to/skill.md", "--target", "/custom/dir"));
      expect(result.target).toBe("/custom/dir");
    });

    it("parses import with --replace flag", () => {
      const result = parseArgs(argv("import", "/path/to/skill.md", "--replace"));
      expect(result.replace).toBe(true);
    });

    it("parses import with --dry-run flag", () => {
      const result = parseArgs(argv("import", "/path/to/skill.md", "--dry-run"));
      expect(result.dryRun).toBe(true);
    });

    it("parses import with all flags combined", () => {
      const result = parseArgs(
        argv("import", "/path/to/skill.md", "--from", "n8n-node", "--target", "managed", "--replace", "--dry-run"),
      );
      expect(result.command).toBe("import");
      expect(result.source).toBe("/path/to/skill.md");
      expect(result.from).toBe("n8n-node");
      expect(result.target).toBe("managed");
      expect(result.replace).toBe(true);
      expect(result.dryRun).toBe(true);
    });

    it("source is undefined if not provided", () => {
      const result = parseArgs(argv("import", "--from", "auto"));
      expect(result.source).toBeUndefined();
    });
  });

  describe("convert command", () => {
    it("parses convert command with source and --out", () => {
      const result = parseArgs(argv("convert", "/path/to/skill.md", "--out", "/tmp/output"));
      expect(result.command).toBe("convert");
      expect(result.source).toBe("/path/to/skill.md");
      expect(result.out).toBe("/tmp/output");
    });

    it("parses convert with --from flag", () => {
      const result = parseArgs(
        argv("convert", "/path/to/skill.md", "--out", "/out", "--from", "openai-gpt-action"),
      );
      expect(result.from).toBe("openai-gpt-action");
    });

    it("source is undefined if not provided", () => {
      const result = parseArgs(argv("convert", "--out", "/out"));
      expect(result.source).toBeUndefined();
    });
  });

  describe("converters command", () => {
    it("parses converters command", () => {
      expect(parseArgs(argv("converters")).command).toBe("converters");
    });

    it("marks converters --help as help without executing the command", () => {
      const result = parseArgs(argv("converters", "--help"));
      expect(result.command).toBe("converters");
      expect(result.showHelp).toBe(true);
    });
  });

  describe("pack command", () => {
    it("parses pack command with skill-dir and --out", () => {
      const result = parseArgs(argv("pack", "/path/to/skill", "--out", "/tmp/skill.friday.tgz"));
      expect(result.command).toBe("pack");
      expect(result.skillDir).toBe("/path/to/skill");
      expect(result.out).toBe("/tmp/skill.friday.tgz");
    });

    it("skillDir is undefined if not provided", () => {
      const result = parseArgs(argv("pack", "--out", "/tmp/out.tgz"));
      expect(result.skillDir).toBeUndefined();
    });
  });

  describe("skills init command", () => {
    it("parses skills init with template and output directory", () => {
      const result = parseArgs(argv("skills", "init", "demo-skill", "--template", "shell", "--out", "/tmp/demo-skill"));
      expect(result.command).toBe("skills");
      expect(result.skillsSubcommand).toBe("init");
      expect(result.initSkillId).toBe("demo-skill");
      expect(result.template).toBe("shell");
      expect(result.out).toBe("/tmp/demo-skill");
    });

    it("defaults template to undefined at parse time when not provided", () => {
      const result = parseArgs(argv("skills", "init", "demo-skill"));
      expect(result.skillsSubcommand).toBe("init");
      expect(result.initSkillId).toBe("demo-skill");
      expect(result.template).toBeUndefined();
    });

    it("preserves skills init parsing when help is requested", () => {
      const result = parseArgs(argv("skills", "init", "demo-skill", "--help"));
      expect(result.command).toBe("skills");
      expect(result.skillsSubcommand).toBe("init");
      expect(result.initSkillId).toBe("demo-skill");
      expect(result.showHelp).toBe(true);
    });
  });

  describe("phases command", () => {
    it("parses phases doctor", () => {
      const result = parseArgs(argv("phases", "doctor"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("doctor");
    });

    it("parses phases promote with manifest and dry-run", () => {
      const result = parseArgs(argv(
        "phases",
        "promote",
        "phase0",
        "--manifest",
        "docs/ops/openclaw-adoption-phase-manifest.json",
        "--dry-run",
        "--no-prepare-next",
      ));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("promote");
      expect(result.phaseIdArg).toBe("phase0");
      expect(result.manifestPath).toBe("docs/ops/openclaw-adoption-phase-manifest.json");
      expect(result.dryRun).toBe(true);
      expect(result.prepareNext).toBe(false);
    });

    it("parses phases resume with explicit phase id", () => {
      const result = parseArgs(argv("phases", "resume", "phase1"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("resume");
      expect(result.phaseIdArg).toBe("phase1");
    });

    it("parses phases stabilize with explicit phase id", () => {
      const result = parseArgs(argv("phases", "stabilize", "phase2", "--dry-run"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("stabilize");
      expect(result.phaseIdArg).toBe("phase2");
      expect(result.dryRun).toBe(true);
    });

    it("parses phases status with json output", () => {
      const result = parseArgs(argv("phases", "status", "--json"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("status");
      expect(result.json).toBe(true);
    });

    it("parses phases closeout", () => {
      const result = parseArgs(argv("phases", "closeout", "--dry-run"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("closeout");
      expect(result.dryRun).toBe(true);
    });

    it("preserves phases subcommand parsing when help is requested", () => {
      const result = parseArgs(argv("phases", "doctor", "--help"));
      expect(result.command).toBe("phases");
      expect(result.phasesSubcommand).toBe("doctor");
      expect(result.showHelp).toBe(true);
    });
  });

  describe("runs command", () => {
    it("parses runs backfill-pack-context", () => {
      const result = parseArgs(argv("runs", "backfill-pack-context"));
      expect(result.command).toBe("runs");
      expect(result.runsSubcommand).toBe("backfill-pack-context");
      expect(result.dryRun).toBe(false);
      expect(result.apply).toBe(false);
      expect(result.json).toBe(false);
    });

    it("parses runs backfill-pack-context with dry-run and json", () => {
      const result = parseArgs(argv("runs", "backfill-pack-context", "--dry-run", "--json"));
      expect(result.command).toBe("runs");
      expect(result.runsSubcommand).toBe("backfill-pack-context");
      expect(result.dryRun).toBe(true);
      expect(result.apply).toBe(false);
      expect(result.json).toBe(true);
    });

    it("parses runs backfill-pack-context with apply", () => {
      const result = parseArgs(argv("runs", "backfill-pack-context", "--apply"));
      expect(result.command).toBe("runs");
      expect(result.runsSubcommand).toBe("backfill-pack-context");
      expect(result.dryRun).toBe(false);
      expect(result.apply).toBe(true);
    });

    it("preserves runs subcommand parsing when help is requested", () => {
      const result = parseArgs(argv("runs", "backfill-pack-context", "--help"));
      expect(result.command).toBe("runs");
      expect(result.runsSubcommand).toBe("backfill-pack-context");
      expect(result.showHelp).toBe(true);
    });
  });

  describe("new flags default values", () => {
    it("replace defaults to false", () => {
      const result = parseArgs(argv("start"));
      expect(result.replace).toBe(false);
    });

    it("dryRun defaults to false", () => {
      const result = parseArgs(argv("start"));
      expect(result.dryRun).toBe(false);
    });

    it("from defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.from).toBeUndefined();
    });

    it("target defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.target).toBeUndefined();
    });

    it("out defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.out).toBeUndefined();
    });

    it("source defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.source).toBeUndefined();
    });

    it("skillDir defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.skillDir).toBeUndefined();
    });

    it("splitOperations defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.splitOperations).toBeUndefined();
    });

    it("skillIdPrefix defaults to undefined", () => {
      const result = parseArgs(argv("start"));
      expect(result.skillIdPrefix).toBeUndefined();
    });

    it("noRefresh defaults to false", () => {
      const result = parseArgs(argv("start"));
      expect(result.noRefresh).toBe(false);
    });

    it("json defaults to false", () => {
      const result = parseArgs(argv("start"));
      expect(result.json).toBe(false);
    });

    it("showHelp defaults to false", () => {
      const result = parseArgs(argv("start"));
      expect(result.showHelp).toBe(false);
    });
  });

  describe("converter option flags", () => {
    it("parses --split-operations", () => {
      const result = parseArgs(argv("convert", "spec.json", "--out", "/tmp", "--split-operations"));
      expect(result.splitOperations).toBe(true);
    });

    it("parses --no-split-operations", () => {
      const result = parseArgs(argv("convert", "spec.json", "--out", "/tmp", "--no-split-operations"));
      expect(result.splitOperations).toBe(false);
    });

    it("parses --skill-id-prefix", () => {
      const result = parseArgs(argv("convert", "spec.json", "--out", "/tmp", "--skill-id-prefix", "my-app"));
      expect(result.skillIdPrefix).toBe("my-app");
    });

    it("parses --no-refresh", () => {
      const result = parseArgs(argv("import", "/path/to/skill", "--no-refresh"));
      expect(result.noRefresh).toBe(true);
    });

    it("parses all converter flags combined", () => {
      const result = parseArgs(argv(
        "import", "/path/to/spec.json",
        "--from", "openai-gpt-action",
        "--target", "managed",
        "--split-operations",
        "--skill-id-prefix", "my-prefix",
        "--no-refresh",
        "--dry-run",
      ));
      expect(result.command).toBe("import");
      expect(result.source).toBe("/path/to/spec.json");
      expect(result.from).toBe("openai-gpt-action");
      expect(result.target).toBe("managed");
      expect(result.splitOperations).toBe(true);
      expect(result.skillIdPrefix).toBe("my-prefix");
      expect(result.noRefresh).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe("combined flags", () => {
    it("parses start with --skills-dir and --port", () => {
      const result = parseArgs(
        argv("start", "--skills-dir", "/skills", "--port", "3000"),
      );
      expect(result.command).toBe("start");
      expect(result.skillDirs).toEqual(["/skills"]);
      expect(result.port).toBe(3000);
    });

    it("parses run with skill-id, --input, and --skills-dir", () => {
      const result = parseArgs(
        argv(
          "run",
          "greeting-skill",
          "--input",
          "name=Friday",
          "--skills-dir",
          "/my-skills",
        ),
      );
      expect(result.command).toBe("run");
      expect(result.skillId).toBe("greeting-skill");
      expect(result.input).toEqual({ name: "Friday" });
      expect(result.skillDirs).toEqual(["/my-skills"]);
    });
  });
});

describe("finalizeCliCommand", () => {
  it("does not force-exit the long-running start command", async () => {
    let exitCode: number | undefined;
    await finalizeCliCommand("start", (code) => {
      exitCode = code;
    });
    expect(exitCode).toBeUndefined();
  });

  it("forces one-shot commands to exit after completion", async () => {
    let exitCode: number | undefined;
    await finalizeCliCommand("list", (code) => {
      exitCode = code;
    });
    expect(exitCode).toBe(0);
  });
});

describe("cmdRuns", () => {
  it("rejects simultaneous dry-run and apply flags", async () => {
    const originalExitCode = process.exitCode;
    const originalError = console.error;
    const errors: string[] = [];
    process.exitCode = undefined;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(" "));
    };

    try {
      await cmdRuns({
        runsSubcommand: "backfill-pack-context",
        dryRun: true,
        apply: true,
        json: false,
      });
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalError;
    }

    expect(errors.some((line) => line.includes("--dry-run and --apply cannot be used together"))).toBe(true);
  });

  it("dry-run backfill migrates a temp copy instead of mutating a v065 state database", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-runs-backfill-"));
    const dbPath = path.join(tempDir, "friday.db");
    const db = new Database(dbPath);
    const originalStdout = console.log;
    const originalExitCode = process.exitCode;
    const originalStateDir = process.env.FRIDAY_STATE_DIR;
    const stdout: string[] = [];

    try {
      const throughV065 = FRIDAY_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 65);
      runFridayMigrations({ db, migrations: throughV065 });
      db.close();

      process.env.FRIDAY_STATE_DIR = tempDir;
      process.exitCode = undefined;
      console.log = (...args: unknown[]) => {
        stdout.push(args.map((value) => String(value)).join(" "));
      };

      await cmdRuns({
        runsSubcommand: "backfill-pack-context",
        dryRun: true,
        apply: false,
        json: true,
      });
    } finally {
      console.log = originalStdout;
      process.exitCode = originalExitCode;
      if (originalStateDir === undefined) {
        delete process.env.FRIDAY_STATE_DIR;
      } else {
        process.env.FRIDAY_STATE_DIR = originalStateDir;
      }
      try {
        db.close();
      } catch {
        // no-op
      }
    }

    const payload = JSON.parse(stdout.join("\n")) as {
      dbPath: string;
      mode: string;
      report: { scannedRuns: number };
    };
    expect(payload.dbPath).toBe(dbPath);
    expect(payload.mode).toBe("dry_run");
    expect(payload.report.scannedRuns).toBe(0);

    const reopened = new Database(dbPath, { readonly: true });
    try {
      const columns = reopened.prepare("PRAGMA table_info(friday_agent_runs)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "metadata_json")).toBe(false);
    } finally {
      reopened.close();
    }
  });
});

describe("runCliSkillCommand", () => {
  const argv = (...args: string[]) => ["node", "friday-cli.js", ...args];

  it("uses the configured remote hub instead of self-hosting when FRIDAY_HUB_URL and FRIDAY_ACCESS_TOKEN are set", async () => {
    const parsed = parseArgs(argv("run", "demo-skill", "--input", "name=Friday"));
    const logs: string[] = [];

    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    let requestedBody = "";
    const fetchFn: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      requestedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({
        ok: true,
        data: {
          runId: "run-remote-1",
          status: "completed",
          durationMs: 42,
          output: { echoed: true },
          stdout: "remote ok",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const createHub: FridayCliRunCommandDeps["createHub"] = async () => {
      throw new Error("createHub should not be called for remote execution");
    };

    await runCliSkillCommand(parsed, {
      env: {
        FRIDAY_HUB_URL: "https://hub.example.test/",
        FRIDAY_ACCESS_TOKEN: "secret-token",
      },
      createHub,
      fetchFn,
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
    });

    expect(requestedUrl).toBe("https://hub.example.test/v1/skills/demo-skill/run");
    expect(requestedHeaders).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(requestedBody)).toEqual({
      input: { name: "Friday" },
      sessionId: "cli",
      channel: "cli",
    });
    expect(logs.some((line) => line.includes("Run run-remote-1 — completed (42ms)"))).toBe(true);
    expect(logs.some((line) => line.includes("remote ok"))).toBe(true);
  });

  it("sets a nonzero exit code when a remote skill run reports failed", async () => {
    const parsed = parseArgs(argv("run", "demo-skill"));
    const logs: string[] = [];
    let exitCode: number | undefined;

    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
      ok: true,
      data: {
        runId: "run-remote-failed",
        status: "failed",
        durationMs: 13,
        output: { code: "SKILL_FAILED" },
        stderr: "remote failed",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await runCliSkillCommand(parsed, {
      env: {
        FRIDAY_HUB_URL: "https://hub.example.test",
        FRIDAY_ACCESS_TOKEN: "secret-token",
      },
      createHub: async () => {
        throw new Error("createHub should not be called for remote execution");
      },
      fetchFn,
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(logs.some((line) => line.includes("Run run-remote-failed — failed (13ms)"))).toBe(true);
    expect(logs.some((line) => line.includes("remote failed"))).toBe(true);
    expect(logs.some((line) => line.includes("ended with status \"failed\""))).toBe(true);
  });

  it("falls back to an embedded hub when no remote hub env is configured", async () => {
    // Uses the exempt `ai-inference` skillId so the local-mode skill-run
    // retirement guard (which fail-closes arbitrary skillIds) does not block the
    // live BYOK provider path that must keep reaching the embedded executor.
    const parsed = parseArgs(argv("run", "ai-inference"));
    const logs: string[] = [];
    let startCount = 0;
    let stopCount = 0;
    let executeCount = 0;

    const localHub = {
      start: async () => {
        startCount += 1;
      },
      stop: async () => {
        stopCount += 1;
      },
      executor: {
        execute() {
          executeCount += 1;
          return {
            result: Promise.resolve({
              runId: "run-local-1",
              status: "completed",
              durationMs: 9,
              output: {},
              stdout: "local ok",
            }),
          };
        },
      },
    };
    const createHub = (async () => localHub) as FridayCliRunCommandDeps["createHub"];

    await runCliSkillCommand(parsed, {
      env: {},
      createHub,
      fetchFn: async () => {
        throw new Error("fetch should not be called for local execution");
      },
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
    });

    expect(startCount).toBe(1);
    expect(executeCount).toBe(1);
    expect(stopCount).toBe(1);
    expect(logs.some((line) => line.includes("Run run-local-1 — completed (9ms)"))).toBe(true);
  });

  it("sets a nonzero exit code when an embedded skill run reports failed", async () => {
    // Exempt `ai-inference` skillId — see note above; reaches the executor so the
    // failed-status exit-code behavior stays under test post-guard.
    const parsed = parseArgs(argv("run", "ai-inference"));
    const logs: string[] = [];
    let exitCode: number | undefined;
    let stopCount = 0;

    const localHub = {
      start: async () => {},
      stop: async () => {
        stopCount += 1;
      },
      executor: {
        execute() {
          return {
            result: Promise.resolve({
              runId: "run-local-failed",
              status: "failed",
              durationMs: 7,
              output: { code: "SKILL_FAILED" },
              stdout: "",
              stderr: "local failed",
            }),
          };
        },
      },
    };

    await runCliSkillCommand(parsed, {
      env: {},
      createHub: (async () => localHub) as FridayCliRunCommandDeps["createHub"],
      fetchFn: async () => {
        throw new Error("fetch should not be called for local execution");
      },
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(stopCount).toBe(1);
    expect(logs.some((line) => line.includes("Run run-local-failed — failed (7ms)"))).toBe(true);
    expect(logs.some((line) => line.includes("local failed"))).toBe(true);
    expect(logs.some((line) => line.includes("ended with status \"failed\""))).toBe(true);
  });

  it("fails closed with TS_RUNTIME_SKILL_RUNS_RETIRED for a NON-ai-inference local-hub run when the flag is UNSET (no hub booted, executor sink not reached)", async () => {
    // Local-mode skill-run retirement guard. With no remote-hub env, the prior
    // behavior booted an in-process hub and reached the arbitrary-code executor
    // sink (shell/python) directly with a caller-supplied skillId, bypassing the
    // HTTP route guard. The flag is UNSET (CLI buildConfig leaves
    // allowTestOnlySkillRunExecution undefined → fail-closed by default), so this
    // must throw before any hub is created.
    const parsed = parseArgs(argv("run", "demo-skill"));
    let createHubCalled = false;

    await expect(
      runCliSkillCommand(parsed, {
        env: {},
        createHub: (async () => {
          createHubCalled = true;
          throw new Error("createHub must not be called when the skill-run guard fails closed");
        }) as FridayCliRunCommandDeps["createHub"],
        fetchFn: async () => {
          throw new Error("fetch should not be called for local execution");
        },
        logger: { log: () => {}, error: () => {} },
      }),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_SKILL_RUNS_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_skill_run_entrypoint_required",
      },
    });

    // The guard fires BEFORE hub creation → the executor sink is never reached.
    expect(createHubCalled).toBe(false);
  });

  it("routes a governed local skill run through the Rust skill-run bin when the Rust route flag and operator materials are present", async () => {
    const parsed = parseArgs(argv("run", "output-current-date-time", "--skills-dir", "/tmp/friday-managed-skills"));
    let createHubCalled = false;
    const logs: string[] = [];
    const execFileFn = vi.fn(async () => ({
      stdout: JSON.stringify({
        truth_label: "d21_skill_run_local",
        ok: true,
        runs_skill: true,
        executes_skill: true,
        completes_work_item: false,
        run_ref: "proof://skill-run-local/run-1",
        proof_ref: "proof://skill-run-local/proof-1",
        skill_id: "output-current-date-time",
        status: "skill_executed_not_completed",
        exit_code: 0,
        output_sha256: "a".repeat(64),
        output_len: 32,
      }),
      stderr: "",
    }));

    await runCliSkillCommand(parsed, {
      env: {
        FRIDAY_ROUTE_SKILL_RUNS_VIA_RUST: "1",
        FRIDAY_D21_SKILL_RUN_LOCAL_BIN: "/tmp/hub_skill_run_local",
        FRIDAY_D21_SKILL_RUN_LOCAL_DB_PATH: "/tmp/friday-hub.sqlite",
        FRIDAY_D21_OPERATOR_VK_PATH: "/tmp/operator.vk",
        FRIDAY_D21_SKILL_RUN_APPROVAL_JSON: "/tmp/approval.json",
        FRIDAY_D21_SKILL_RUN_MISSION_ID: "mission-cli",
        FRIDAY_D21_SKILL_RUN_WORK_ITEM_ID: "work-cli",
        FRIDAY_D21_SKILL_RUN_OPERATOR_PRINCIPAL_ID: "operator",
      },
      createHub: (async () => {
        createHubCalled = true;
        throw new Error("createHub must not be called when the Rust skill-run route is active");
      }) as FridayCliRunCommandDeps["createHub"],
      fetchFn: async () => {
        throw new Error("fetch should not be called for local Rust execution");
      },
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
      execFileFn,
    } as FridayCliRunCommandDeps & { execFileFn: typeof execFileFn });

    expect(createHubCalled).toBe(false);
    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(execFileFn).toHaveBeenCalledWith(
      "/tmp/hub_skill_run_local",
      expect.arrayContaining([
        "run-local",
        "--db",
        "/tmp/friday-hub.sqlite",
        "--operator-vk-path",
        "/tmp/operator.vk",
        "--approval-json",
        "/tmp/approval.json",
        "--managed-skills-root",
        "/tmp/friday-managed-skills",
        "--skill-id",
        "output-current-date-time",
        "--mission-id",
        "mission-cli",
        "--work-item-id",
        "work-cli",
        "--operator-principal-id",
        "operator",
        "--approved-first-run-skill-id",
        "output-current-date-time",
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          FRIDAY_D21_SKILL_RUN_LOCAL: "1",
        }),
      }),
    );
    expect(logs.some((line) => line.includes("Run proof://skill-run-local/run-1 — skill_executed_not_completed"))).toBe(true);
  });

  it("fails fast when only one remote-hub env var is configured", async () => {
    const parsed = parseArgs(argv("run", "demo-skill"));
    const logs: string[] = [];
    let exitCode: number | undefined;

    await runCliSkillCommand(parsed, {
      env: {
        FRIDAY_HUB_URL: "https://hub.example.test",
      },
      createHub: async () => {
        throw new Error("createHub should not be called on invalid remote config");
      },
      fetchFn: async () => {
        throw new Error("fetch should not be called on invalid remote config");
      },
      logger: {
        log: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
        error: (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" ")),
      },
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(
      logs.some((line) => line.includes("requires both FRIDAY_HUB_URL and FRIDAY_ACCESS_TOKEN")),
    ).toBe(true);
  });
});

describe("resolveStartupNetworkBinding", () => {
  const argv = (...args: string[]) => ["node", "friday-cli.js", ...args];

  it("prefers CLI host/port over env and setup state", () => {
    const parsed = parseArgs(argv("start", "--host", "0.0.0.0", "--port", "7788"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {
        FRIDAY_HOST: "10.0.0.10",
        FRIDAY_PORT: "5566",
      },
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => ({ host: "192.168.1.10", port: 3344 }),
    });

    expect(binding).toEqual({ host: "0.0.0.0", port: 7788 });
  });

  it("uses env host/port when CLI flags are absent", () => {
    const parsed = parseArgs(argv("start"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {
        FRIDAY_HOST: "10.0.0.10",
        FRIDAY_PORT: "5566",
      },
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => ({ host: "192.168.1.10", port: 3344 }),
    });

    expect(binding).toEqual({ host: "10.0.0.10", port: 5566 });
  });

  it("rejects numeric-prefix env ports instead of truncating them", () => {
    const parsed = parseArgs(argv("start"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {
        FRIDAY_PORT: "123abc",
      },
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => ({ host: "127.0.0.1", port: 4455 }),
    });

    expect(binding).toEqual({ host: "127.0.0.1", port: 4455 });
  });

  it("uses setup state binding when CLI/env are absent", () => {
    const parsed = parseArgs(argv("start"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {},
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => ({ host: "0.0.0.0", port: 4321 }),
    });

    expect(binding).toEqual({ host: "0.0.0.0", port: 4321 });
  });

  it("falls back to localhost:3141 when no source provides binding", () => {
    const parsed = parseArgs(argv("start"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {},
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => undefined,
    });

    expect(binding).toEqual({ host: "127.0.0.1", port: 3141 });
  });

  it("can mix explicit host with setup-derived port", () => {
    const parsed = parseArgs(argv("start", "--host", "0.0.0.0"));

    const binding = resolveStartupNetworkBinding(parsed, {
      env: {},
      dbPath: "/tmp/friday-test.db",
      readSetupBinding: () => ({ host: "127.0.0.1", port: 8899 }),
    });

    expect(binding).toEqual({ host: "0.0.0.0", port: 8899 });
  });
});

describe("readSetupNetworkBinding", () => {
  it("returns undefined when DB file does not exist", () => {
    const missingPath = path.join(os.tmpdir(), `friday-missing-${Date.now()}.db`);
    expect(readSetupNetworkBinding(missingPath)).toBeUndefined();
  });

  it("reads host/port from friday_setup_state singleton row", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-network-test-"));
    const dbPath = path.join(tmpDir, "friday.db");
    const db = new Database(dbPath);

    try {
      db.exec(`
        CREATE TABLE friday_setup_state (
          id TEXT PRIMARY KEY,
          network_host TEXT NOT NULL,
          network_port INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO friday_setup_state (id, network_host, network_port)
         VALUES ('singleton', '0.0.0.0', 4455)`,
      ).run();

      expect(readSetupNetworkBinding(dbPath)).toEqual({
        host: "0.0.0.0",
        port: 4455,
      });
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("prepareStartupChannelsConfig", () => {
  it("migrates legacy channel config into setup_state managed secrets and scrubs friday.json", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-channels-test-"));
    const stateDir = path.join(tmpHome, "state");
    const dbPath = path.join(stateDir, "friday.db");
    const legacyDir = path.join(tmpHome, ".friday");
    const legacyPath = path.join(legacyDir, "friday.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });

    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE friday_setup_state (
          id TEXT PRIMARY KEY,
          channels_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE secrets (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          ref_key TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          key_id TEXT NOT NULL,
          expires_at TEXT,
          rotated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          channels: {
            discord: {
              token: "discord-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              allowedUsers: ["jarvis"],
            },
          },
        }, null, 2),
      );

      const resolution = withProvisionedMasterKey(() =>
        prepareStartupChannelsConfig({
          env: { HOME: tmpHome },
          dbPath,
          nowIso: () => "2026-03-12T12:00:00.000Z",
        }),
      );

      expect(resolution.source).toBe("migrated_legacy_to_setup_state");
      expect(resolution.migrated).toBe(true);
      expect(resolution.compatMode).toBe(false);
      expect(resolution.channels).toBeUndefined();

      const setupRow = db
        .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
        .get() as { channels_json: string };
      expect(setupRow.channels_json).toContain("secret://channel/");
      expect(setupRow.channels_json).not.toContain("discord-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      const secretCount = db
        .prepare("SELECT COUNT(*) AS count FROM secrets WHERE scope = 'channel'")
        .get() as { count: number };
      expect(secretCount.count).toBe(1);

      const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
      expect(legacy.channels).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("falls back to legacy runtime config when setup_state is unavailable", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-channels-fallback-"));
    const legacyDir = path.join(tmpHome, ".friday");
    const legacyPath = path.join(legacyDir, "friday.json");
    const testToken = "discord-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        channels: {
          discord: {
            token: testToken,
          },
        },
      }, null, 2),
    );

    const resolution = prepareStartupChannelsConfig({
      env: { HOME: tmpHome },
      dbPath: path.join(tmpHome, "missing.db"),
    });

    expect(resolution.source).toBe("legacy_runtime_fallback");
    expect(resolution.compatMode).toBe(true);
    expect(resolution.channels).toEqual({
      enabled: true,
      instances: [
        expect.objectContaining({
          kind: "discord",
          token: testToken,
        }),
      ],
    });

    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
    expect(legacy.channels).toBeDefined();

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rewrites existing setup_state plaintext secrets into managed secret refs", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-setup-state-secret-"));
    const stateDir = path.join(tmpHome, "state");
    const dbPath = path.join(stateDir, "friday.db");
    fs.mkdirSync(stateDir, { recursive: true });

    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE friday_setup_state (
          id TEXT PRIMARY KEY,
          channels_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE secrets (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          ref_key TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          key_id TEXT NOT NULL,
          expires_at TEXT,
          rotated_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO friday_setup_state (id, channels_json, created_at, updated_at)
         VALUES ('singleton', ?, '2026-03-12T12:00:00.000Z', '2026-03-12T12:00:00.000Z')`,
      ).run(JSON.stringify([
        {
          kind: "discord",
          enabled: true,
          config: {
            token: "fake-discord-token",
          },
        },
      ]));

      const resolution = withProvisionedMasterKey(() =>
        prepareStartupChannelsConfig({
          env: { HOME: tmpHome },
          dbPath,
          nowIso: () => "2026-03-12T12:30:00.000Z",
        }),
      );

      expect(resolution.source).toBe("setup_state");
      expect(resolution.migrated).toBe(true);
      expect(resolution.compatMode).toBe(false);
      expect(resolution.channels).toBeUndefined();

      const setupRow = db
        .prepare("SELECT channels_json FROM friday_setup_state WHERE id = 'singleton'")
        .get() as { channels_json: string };
      expect(setupRow.channels_json).toContain("secret://channel/");
      expect(setupRow.channels_json).not.toContain("fake-discord-token");

      const secretCount = db
        .prepare("SELECT COUNT(*) AS count FROM secrets WHERE scope = 'channel'")
        .get() as { count: number };
      expect(secretCount.count).toBe(1);
    } finally {
      db.close();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("isCliEntrypointPath", () => {
  it("matches the direct module path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-direct-"));
    try {
      const modulePath = path.join(tmpDir, "friday-cli.js");
      fs.writeFileSync(modulePath, "#!/usr/bin/env node\n", "utf8");
      const moduleUrl = pathToFileURL(modulePath);
      expect(isCliEntrypointPath(modulePath, moduleUrl.href)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("matches an npm bin symlink that resolves to the CLI module", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-entry-"));
    try {
      const realDir = path.join(tmpDir, "dist", "cli");
      const binDir = path.join(tmpDir, "node_modules", ".bin");
      fs.mkdirSync(realDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });

      const realCliPath = path.join(realDir, "friday-cli.js");
      const symlinkPath = path.join(binDir, "friday");
      fs.writeFileSync(realCliPath, "#!/usr/bin/env node\n", "utf8");
      fs.symlinkSync(realCliPath, symlinkPath);

      const moduleUrl = pathToFileURL(realCliPath);
      expect(isCliEntrypointPath(symlinkPath, moduleUrl.href)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns false for non-file module URLs", () => {
    expect(isCliEntrypointPath("/tmp/friday-cli.js", "https://example.test/friday-cli.js")).toBe(false);
  });

  it("returns false for malformed module URLs instead of throwing", () => {
    let result = false;
    expect(() => {
      result = isCliEntrypointPath("/tmp/friday-cli.js", "not a valid url");
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe("loadProcessEnvFromDotEnvFile", () => {
  it("loads values from .env without overriding pre-set env vars", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-env-test-"));
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "FRIDAY_DESKTOP_ENABLED=true",
        "FRIDAY_HOST=0.0.0.0",
        "export FRIDAY_PORT=7788",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      FRIDAY_DESKTOP_ENABLED: "false",
    };
    loadProcessEnvFromDotEnvFile({ cwd: tmpDir, env });

    expect(env.FRIDAY_DESKTOP_ENABLED).toBe("false");
    expect(env.FRIDAY_HOST).toBe("0.0.0.0");
    expect(env.FRIDAY_PORT).toBe("7788");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads dotenv from FRIDAY_ENV_FILE when provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-env-path-test-"));
    const envPath = path.join(tmpDir, "custom.env");
    fs.writeFileSync(envPath, "FRIDAY_DESKTOP_ENABLED=true\n", "utf8");

    const env: NodeJS.ProcessEnv = {
      FRIDAY_ENV_FILE: envPath,
    };
    loadProcessEnvFromDotEnvFile({ cwd: tmpDir, env });

    expect(env.FRIDAY_DESKTOP_ENABLED).toBe("true");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not mix setup state env values into an explicit FRIDAY_ENV_FILE", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-explicit-env-test-"));
    const stateDir = path.join(tmpDir, "state");
    const envPath = path.join(tmpDir, "custom.env");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(envPath, "FRIDAY_DESKTOP_ENABLED=true\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, ".env"),
      "FRIDAY_ANTHROPIC_API_KEY=setup-env-key\n", // pragma: allowlist secret
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      FRIDAY_ENV_FILE: envPath,
      FRIDAY_STATE_DIR: stateDir,
    };
    loadProcessEnvFromDotEnvFile({ cwd: tmpDir, env });

    expect(env.FRIDAY_DESKTOP_ENABLED).toBe("true");
    expect(env.FRIDAY_ANTHROPIC_API_KEY).toBeUndefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads setup wizard env values from the Friday state dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-state-env-test-"));
    const stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ".env"),
      "FRIDAY_ANTHROPIC_API_KEY=setup-env-key\n", // pragma: allowlist secret
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      FRIDAY_STATE_DIR: stateDir,
    };
    loadProcessEnvFromDotEnvFile({ cwd: tmpDir, env });

    expect(env.FRIDAY_ANTHROPIC_API_KEY).toBe("setup-env-key");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tightens an existing setup env file before and after writing provider keys", () => {
    if (process.platform === "win32") {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cli-setup-env-mode-test-"));
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "FRIDAY_TEST_PROVIDER_KEY=old\n", { mode: 0o644 });

    writeFridaySetupEnvFile(envPath, ["FRIDAY_TEST_PROVIDER_KEY=new"]);

    const mode = fs.statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(envPath, "utf8")).toBe("FRIDAY_TEST_PROVIDER_KEY=new\n");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
