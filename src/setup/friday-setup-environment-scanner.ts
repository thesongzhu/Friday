/**
 * Environment Scanner — Detects installed software, versions, and system state.
 *
 * Used by the setup recipe executor to check prerequisites before running recipes.
 *
 * @module setup
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { arch, platform } from "node:os";

import type {
  FridayEnvironmentScanner,
  FridayEnvironmentScanResult,
} from "./friday-setup.types.js";

// ─── Helpers ───

function execCommand(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(command, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
    proc.stdin?.end();
  });
}

function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+[\.\d]*)/);
  return match ? match[1] : null;
}

// ─── Factory ───

export function createFridayEnvironmentScanner(): FridayEnvironmentScanner {
  return {
    async isInstalled(command: string): Promise<boolean> {
      try {
        await execCommand("which", [command]);
        return true;
      } catch {
        return false;
      }
    },

    async getVersion(command: string): Promise<string | null> {
      try {
        const output = await execCommand(command, ["--version"]);
        return extractVersion(output);
      } catch {
        return null;
      }
    },

    async isReachable(url: string, timeoutMs = 5000): Promise<boolean> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
        });
        clearTimeout(timer);
        return response.ok || response.status < 500;
      } catch {
        return false;
      }
    },

    async fileExists(path: string): Promise<boolean> {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },

    getEnvVar(name: string): string | undefined {
      return process.env[name];
    },

    getOs(): string {
      return platform();
    },

    async scan(): Promise<FridayEnvironmentScanResult> {
      const [
        nodeVersion,
        npmVersion,
        pythonVersion,
        gitVersion,
        dockerVersion,
      ] = await Promise.all([
        this.getVersion("node"),
        this.getVersion("npm"),
        this.getVersion("python3").then((v) => v ?? this.getVersion("python")),
        this.getVersion("git"),
        this.getVersion("docker"),
      ]);

      // Detect installed browsers
      const browserChecks = await Promise.all([
        this.isInstalled("google-chrome").then((ok) => (ok ? "chrome" : null)),
        this.isInstalled("chromium").then((ok) => (ok ? "chromium" : null)),
        this.isInstalled("firefox").then((ok) => (ok ? "firefox" : null)),
        // macOS-specific browser detection
        platform() === "darwin"
          ? this.fileExists("/Applications/Google Chrome.app").then((ok) =>
              ok ? "chrome" : null,
            )
          : Promise.resolve(null),
        platform() === "darwin"
          ? this.fileExists("/Applications/Firefox.app").then((ok) =>
              ok ? "firefox" : null,
            )
          : Promise.resolve(null),
        platform() === "darwin"
          ? this.fileExists("/Applications/Safari.app").then((ok) =>
              ok ? "safari" : null,
            )
          : Promise.resolve(null),
      ]);

      const installedBrowsers: string[] = [...new Set(browserChecks.filter((b): b is NonNullable<typeof b> => b !== null) as string[])];

      // Network connectivity check
      const networkConnectivity = await this.isReachable("https://httpbin.org/get", 5000);

      return {
        os: platform(),
        arch: arch(),
        nodeVersion,
        npmVersion,
        pythonVersion,
        gitVersion,
        dockerVersion,
        installedBrowsers,
        networkConnectivity,
      };
    },
  };
}
