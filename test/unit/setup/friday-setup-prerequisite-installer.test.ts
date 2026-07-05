import { describe, it, expect, vi } from "vitest";
import { createFridayPrerequisiteInstaller } from "../../../src/setup/friday-setup-prerequisite-installer.js";
import type { FridayEnvironmentScanner } from "../../../src/setup/friday-setup.types.js";

function createMockScanner(overrides?: Partial<FridayEnvironmentScanner>): FridayEnvironmentScanner {
  return {
    isInstalled: vi.fn().mockResolvedValue(false),
    getVersion: vi.fn().mockResolvedValue(null),
    isReachable: vi.fn().mockResolvedValue(true),
    fileExists: vi.fn().mockResolvedValue(false),
    getEnvVar: vi.fn().mockReturnValue(undefined),
    getOs: vi.fn().mockReturnValue("darwin"),
    scan: vi.fn().mockResolvedValue({
      os: "darwin",
      arch: "arm64",
      nodeVersion: null,
      npmVersion: null,
      pythonVersion: null,
      gitVersion: null,
      dockerVersion: null,
      installedBrowsers: [],
      networkConnectivity: true,
    }),
    ...overrides,
  };
}

function createMockExec(exitCode = 0, stdout = "", stderr = "") {
  return vi.fn().mockResolvedValue({ exitCode, stdout, stderr });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("FridayPrerequisiteInstaller", () => {
  describe("planInstallations", () => {
    it("should return empty plan when all software is installed", async () => {
      const scanner = createMockScanner({
        isInstalled: vi.fn().mockResolvedValue(true),
      });
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: createMockExec(),
      });

      const plans = await installer.planInstallations(["node", "git"]);
      expect(plans).toHaveLength(0);
    });

    it("should return install plans for missing software", async () => {
      const scanner = createMockScanner();
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: createMockExec(),
      });

      const plans = await installer.planInstallations(["node", "git"]);
      expect(plans).toHaveLength(2);
      expect(plans[0].software).toBe("node");
      expect(plans[0].installCommand).toContain("brew");
      expect(plans[1].software).toBe("git");
    });

    it("should handle unknown software gracefully", async () => {
      const scanner = createMockScanner();
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: createMockExec(),
      });

      const plans = await installer.planInstallations(["some-unknown-tool"]);
      expect(plans).toHaveLength(1);
      expect(plans[0].installCommand).toBe("");
      expect(plans[0].description).toContain("Manual installation");
      expect(plans[0].requiresApproval).toBe(true);
    });

    it("should use Linux recipes on Linux", async () => {
      const scanner = createMockScanner({
        getOs: vi.fn().mockReturnValue("linux"),
      });
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: createMockExec(),
      });

      const plans = await installer.planInstallations(["node"]);
      expect(plans).toHaveLength(1);
      expect(plans[0].installCommand).toContain("apt");
    });
  });

  describe("install", () => {
    it("should install a prerequisite successfully", async () => {
      const execFn = vi.fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // install
        .mockResolvedValueOnce({ exitCode: 0, stdout: "v22.0.0\n", stderr: "" }); // verify

      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: createMockScanner(),
        execCommand: execFn,
      });

      const result = await installer.install(
        {
          software: "node",
          installCommand: "brew install node",
          verifyCommand: "node --version",
          platform: "darwin",
          description: "Install Node.js",
          requiresApproval: false,
        },
        signal(),
      );

      expect(result.status).toBe("installed");
      expect(result.version).toBe("v22.0.0");
    });

    it("should return failed when install command fails", async () => {
      const execFn = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "Permission denied",
      });

      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: createMockScanner(),
        execCommand: execFn,
      });

      const result = await installer.install(
        {
          software: "node",
          installCommand: "brew install node",
          verifyCommand: "node --version",
          platform: "darwin",
          description: "Install Node.js",
          requiresApproval: false,
        },
        signal(),
      );

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("Permission denied");
    });

    it("should not execute approval-gated install plans without an approval ticket", async () => {
      const execFn = createMockExec(0, "v22.0.0\n");
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: createMockScanner(),
        execCommand: execFn,
      });

      const result = await installer.install(
        {
          software: "node",
          installCommand: "brew install node",
          verifyCommand: "node --version",
          platform: "darwin",
          description: "Install Node.js",
          requiresApproval: true,
        },
        signal(),
      );

      expect(execFn).not.toHaveBeenCalled();
      expect(result.status).toBe("skipped");
      expect(result.errorMessage).toContain("Approval required");
    });

    it("should return failed when no install command exists", async () => {
      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: createMockScanner(),
        execCommand: createMockExec(),
      });

      const result = await installer.install(
        {
          software: "unknown",
          installCommand: "",
          verifyCommand: "unknown --version",
          platform: "all",
          description: "Unknown tool",
          requiresApproval: false,
        },
        signal(),
      );

      expect(result.status).toBe("failed");
    });

    it("should return skipped when aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: createMockScanner(),
        execCommand: createMockExec(),
      });

      const result = await installer.install(
        {
          software: "node",
          installCommand: "brew install node",
          verifyCommand: "node --version",
          platform: "darwin",
          description: "Install Node.js",
          requiresApproval: true,
        },
        controller.signal,
      );

      expect(result.status).toBe("skipped");
    });
  });

  describe("installAll", () => {
    it("should report already-installed software as not_needed", async () => {
      const scanner = createMockScanner({
        isInstalled: vi.fn().mockResolvedValue(true),
        getVersion: vi.fn().mockResolvedValue("22.0.0"),
      });

      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: createMockExec(),
      });

      const results = await installer.installAll(["node"], signal());
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("not_needed");
      expect(results[0].version).toBe("22.0.0");
    });

    it("should skip approval-gated missing software instead of executing it", async () => {
      // isInstalled always returns false, so nothing is "already installed"
      const scanner = createMockScanner({
        isInstalled: vi.fn().mockResolvedValue(false),
        getVersion: vi.fn().mockResolvedValue(null),
      });

      const execFn = createMockExec();

      const installer = createFridayPrerequisiteInstaller({
        environmentScanner: scanner,
        execCommand: execFn,
      });

      const results = await installer.installAll(["node"], signal());
      expect(execFn).not.toHaveBeenCalled();
      expect(results).toEqual([
        expect.objectContaining({
          software: "node",
          status: "skipped",
          errorMessage: expect.stringContaining("Approval required"),
        }),
      ]);
    });
  });
});
