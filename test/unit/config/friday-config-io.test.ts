import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import JSON5 from "json5";
import {
  loadFridayConfig,
  parseFridayJson5,
  writeFridayConfig,
} from "#config";
import { buildDefaultFridayConfig, parseFridayConfig } from "#config";

describe("friday-config-io", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-config-io-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parseFridayJson5", () => {
    it("parses valid JSON5 with comments and trailing commas", () => {
      const raw = `{
        // A comment
        "database": {
          "readPoolSize": 2,
        },
      }`;
      const result = parseFridayJson5(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.value as Record<string, unknown>).database).toEqual({
          readPoolSize: 2,
        });
      }
    });

    it("returns error for invalid JSON5", () => {
      const result = parseFridayJson5("{invalid:::");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeTruthy();
      }
    });
  });

  describe("loadFridayConfig", () => {
    it("loads defaults when config file is absent", () => {
      const configPath = path.join(tmpDir, "nonexistent.json5");
      const result = loadFridayConfig({ configPath });
      expect(result.exists).toBe(false);
      expect(result.config).toEqual(buildDefaultFridayConfig());
    });

    it("parses JSON5 config file with comments and trailing commas", () => {
      const configPath = path.join(tmpDir, "config.json5");
      fs.writeFileSync(
        configPath,
        `{
          // Custom config
          "database": {
            "readPoolSize": 8,
            "busyTimeoutMs": 3000,
            "synchronous": "FULL",
          },
        }`,
      );
      const result = loadFridayConfig({ configPath });
      expect(result.exists).toBe(true);
      expect(result.config.database.readPoolSize).toBe(8);
      expect(result.config.database.busyTimeoutMs).toBe(3000);
      expect(result.config.database.synchronous).toBe("FULL");
      expect(result.rawText).toBeTruthy();
    });

    it("rejects invalid config with Zod path details", () => {
      const configPath = path.join(tmpDir, "bad-config.json5");
      fs.writeFileSync(
        configPath,
        `{ "database": { "readPoolSize": -5 } }`,
      );
      expect(() => loadFridayConfig({ configPath })).toThrow(/readPoolSize/);
    });
  });

  describe("writeFridayConfig", () => {
    it("writes atomically and produces valid JSON5 output", async () => {
      const configPath = path.join(tmpDir, "output.json5");
      const config = buildDefaultFridayConfig();
      config.database.readPoolSize = 6;

      await writeFridayConfig(config, { configPath, backupCount: 0 });

      expect(fs.existsSync(configPath)).toBe(true);
      const written = fs.readFileSync(configPath, "utf-8");
      // Verify the written file is parseable JSON5
      const parsed = JSON5.parse(written);
      expect(parsed.database.readPoolSize).toBe(6);
      // Verify it validates against our schema
      const validated = parseFridayConfig(parsed);
      expect(validated.database.readPoolSize).toBe(6);
    });

    it("creates backups before overwriting", async () => {
      const configPath = path.join(tmpDir, "config.json5");
      const config = buildDefaultFridayConfig();

      // Write original
      await writeFridayConfig(config, { configPath, backupCount: 2 });

      // Overwrite
      config.database.readPoolSize = 10;
      await writeFridayConfig(config, { configPath, backupCount: 2 });

      expect(fs.existsSync(`${configPath}.bak`)).toBe(true);
    });
  });
});
