import { describe, it, expect } from "vitest";
import { createFridayEnvironmentScanner } from "../../../src/setup/friday-setup-environment-scanner.js";

describe("FridayEnvironmentScanner", () => {
  const scanner = createFridayEnvironmentScanner();

  describe("isInstalled", () => {
    it("should detect node as installed", async () => {
      const result = await scanner.isInstalled("node");
      expect(result).toBe(true);
    });

    it("should return false for non-existent command", async () => {
      const result = await scanner.isInstalled("this-command-surely-does-not-exist-xyz-123");
      expect(result).toBe(false);
    });
  });

  describe("getVersion", () => {
    it("should get node version", async () => {
      const version = await scanner.getVersion("node");
      expect(version).not.toBeNull();
      expect(version).toMatch(/^\d+\.\d+/);
    });

    it("should return null for non-existent command", async () => {
      const version = await scanner.getVersion("this-command-surely-does-not-exist-xyz-123");
      expect(version).toBeNull();
    });
  });

  describe("fileExists", () => {
    it("should detect existing file", async () => {
      const result = await scanner.fileExists(process.cwd() + "/package.json");
      expect(result).toBe(true);
    });

    it("should return false for non-existent file", async () => {
      const result = await scanner.fileExists("/this/path/does/not/exist/at/all.txt");
      expect(result).toBe(false);
    });
  });

  describe("getEnvVar", () => {
    it("should return PATH env var", () => {
      const path = scanner.getEnvVar("PATH");
      expect(path).toBeDefined();
      expect(path!.length).toBeGreaterThan(0);
    });

    it("should return undefined for non-existent env var", () => {
      expect(scanner.getEnvVar("THIS_ENV_VAR_DOES_NOT_EXIST_XYZ")).toBeUndefined();
    });
  });

  describe("getOs", () => {
    it("should return a valid OS string", () => {
      const os = scanner.getOs();
      expect(["darwin", "linux", "win32"]).toContain(os);
    });
  });

  describe("scan", () => {
    it("should return a complete scan result", async () => {
      const result = await scanner.scan();

      expect(result.os).toBeTruthy();
      expect(result.arch).toBeTruthy();
      expect(result.nodeVersion).not.toBeNull(); // We know node is installed
      expect(Array.isArray(result.installedBrowsers)).toBe(true);
      expect(typeof result.networkConnectivity).toBe("boolean");
    });
  });
});
