import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  finalizeCliCommand,
  isCliEntrypointPath,
  parseArgs,
  loadProcessEnvFromDotEnvFile,
  prepareStartupChannelsConfig,
  readSetupNetworkBinding,
  resolveStartupNetworkBinding,
} from "#cli";
import Database from "better-sqlite3";

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

    it("parses run command", () => {
      expect(parseArgs(argv("run", "my-skill")).command).toBe("run");
    });

    it("parses status command", () => {
      expect(parseArgs(argv("status")).command).toBe("status");
    });

    it("falls back to help for unknown command", () => {
      expect(parseArgs(argv("bogus")).command).toBe("help");
    });

    it("keeps experimental tui entrypoint out of the public parser", () => {
      expect(parseArgs(argv("tui")).command).toBe("help");
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
              token: "fake-discord-token",
              allowedUsers: ["jarvis"],
            },
          },
        }, null, 2),
      );

      const resolution = prepareStartupChannelsConfig({
        env: { HOME: tmpHome },
        dbPath,
        nowIso: () => "2026-03-12T12:00:00.000Z",
      });

      expect(resolution.source).toBe("migrated_legacy_to_setup_state");
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
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        channels: {
          discord: {
            token: "fake-discord-token",
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
          token: "fake-discord-token",
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

      const resolution = prepareStartupChannelsConfig({
        env: { HOME: tmpHome },
        dbPath,
        nowIso: () => "2026-03-12T12:30:00.000Z",
      });

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
    const modulePath = path.join("/tmp", "friday-cli.js");
    const moduleUrl = new URL(`file://${modulePath}`);
    expect(isCliEntrypointPath(modulePath, moduleUrl.href)).toBe(true);
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

      const moduleUrl = new URL(`file://${realCliPath}`);
      expect(isCliEntrypointPath(symlinkPath, moduleUrl.href)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
});
