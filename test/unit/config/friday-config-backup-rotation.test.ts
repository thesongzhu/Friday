import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { rotateFridayConfigBackups } from "#config";

describe("friday-config-backup-rotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-backup-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rotates backups correctly at N depth", async () => {
    const configPath = path.join(tmpDir, "config.json5");

    // Create original and existing backups
    fs.writeFileSync(configPath, "v3");
    fs.writeFileSync(`${configPath}.bak`, "v2");
    fs.writeFileSync(`${configPath}.bak.1`, "v1");

    await rotateFridayConfigBackups(configPath, 3);

    // .bak.1 -> .bak.2, .bak -> .bak.1, config -> .bak
    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe("v3");
    expect(fs.readFileSync(`${configPath}.bak.1`, "utf-8")).toBe("v2");
    expect(fs.readFileSync(`${configPath}.bak.2`, "utf-8")).toBe("v1");
  });

  it("drops oldest backup when at full depth", async () => {
    const configPath = path.join(tmpDir, "config.json5");

    // maxBackups=3 means keep .bak, .bak.1, .bak.2 (3 total)
    fs.writeFileSync(configPath, "current");
    fs.writeFileSync(`${configPath}.bak`, "backup0");
    fs.writeFileSync(`${configPath}.bak.1`, "backup1");
    fs.writeFileSync(`${configPath}.bak.2`, "backup2"); // oldest — should be dropped

    await rotateFridayConfigBackups(configPath, 3);

    // backup2 was dropped, backup1 -> .bak.2, backup0 -> .bak.1, current -> .bak
    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe("current");
    expect(fs.readFileSync(`${configPath}.bak.1`, "utf-8")).toBe("backup0");
    expect(fs.readFileSync(`${configPath}.bak.2`, "utf-8")).toBe("backup1");
    // .bak.3 should NOT exist (would exceed maxBackups)
    expect(fs.existsSync(`${configPath}.bak.3`)).toBe(false);
  });

  it("is a no-op when maxBackups <= 1", async () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(configPath, "content");

    await rotateFridayConfigBackups(configPath, 1);

    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it("is a no-op when maxBackups <= 0", async () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(configPath, "content");

    await rotateFridayConfigBackups(configPath, 0);

    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });

  it("handles missing backup files gracefully", async () => {
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(configPath, "content");

    // No existing backups - should not throw
    await rotateFridayConfigBackups(configPath, 3);

    expect(fs.readFileSync(`${configPath}.bak`, "utf-8")).toBe("content");
  });

  it("is a no-op when config file does not exist", async () => {
    const configPath = path.join(tmpDir, "nonexistent.json5");

    await rotateFridayConfigBackups(configPath, 3);

    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
  });
});
