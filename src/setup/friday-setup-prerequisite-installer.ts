/**
 * Prerequisite Auto-Installer — Automatically installs missing prerequisites.
 *
 * Detects missing software (Node.js, Docker, Homebrew, etc.) and orchestrates
 * installation via the autonomous engine or shell commands.
 *
 * @module setup
 */

import type { FridayEnvironmentScanner } from "./friday-setup.types.js";

// ─── Types ───

export type FridayPrerequisiteInstallStatus =
  | "not_needed"
  | "installing"
  | "installed"
  | "failed"
  | "skipped";

export interface FridayPrerequisiteInstallResult {
  readonly software: string;
  readonly status: FridayPrerequisiteInstallStatus;
  readonly version?: string;
  readonly errorMessage?: string;
}

export interface FridayPrerequisiteInstallPlan {
  readonly software: string;
  readonly installCommand: string;
  readonly verifyCommand: string;
  readonly platform: "darwin" | "linux" | "win32" | "all";
  readonly description: string;
  /** If true, requires user confirmation before installing. */
  readonly requiresApproval: boolean;
}

export interface FridayPrerequisiteInstaller {
  /**
   * Check which prerequisites are missing and return an install plan.
   */
  planInstallations(
    required: readonly string[],
  ): Promise<readonly FridayPrerequisiteInstallPlan[]>;

  /**
   * Execute a single prerequisite installation.
   */
  install(
    plan: FridayPrerequisiteInstallPlan,
    signal: AbortSignal,
  ): Promise<FridayPrerequisiteInstallResult>;

  /**
   * Install all missing prerequisites from a list.
   * Returns results for each item.
   */
  installAll(
    required: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly FridayPrerequisiteInstallResult[]>;
}

export interface CreateFridayPrerequisiteInstallerDeps {
  readonly environmentScanner: FridayEnvironmentScanner;
  readonly execCommand: (command: string, args: string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

// ─── Install Recipes ───

const INSTALL_RECIPES: Record<string, Omit<FridayPrerequisiteInstallPlan, "software">> = {
  node: {
    installCommand: "brew install node",
    verifyCommand: "node --version",
    platform: "darwin",
    description: "Install Node.js via Homebrew",
    requiresApproval: true,
  },
  npm: {
    installCommand: "brew install node",
    verifyCommand: "npm --version",
    platform: "darwin",
    description: "Install npm (bundled with Node.js) via Homebrew",
    requiresApproval: true,
  },
  git: {
    installCommand: "brew install git",
    verifyCommand: "git --version",
    platform: "darwin",
    description: "Install Git via Homebrew",
    requiresApproval: true,
  },
  docker: {
    installCommand: "brew install --cask docker",
    verifyCommand: "docker --version",
    platform: "darwin",
    description: "Install Docker Desktop via Homebrew",
    requiresApproval: true,
  },
  python3: {
    installCommand: "brew install python3",
    verifyCommand: "python3 --version",
    platform: "darwin",
    description: "Install Python 3 via Homebrew",
    requiresApproval: true,
  },
  homebrew: {
    installCommand: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    verifyCommand: "brew --version",
    platform: "darwin",
    description: "Install Homebrew package manager",
    requiresApproval: true,
  },
};

// ─── Linux install recipes ───

const LINUX_INSTALL_RECIPES: Record<string, Omit<FridayPrerequisiteInstallPlan, "software">> = {
  node: {
    installCommand: "sudo apt-get install -y nodejs",
    verifyCommand: "node --version",
    platform: "linux",
    description: "Install Node.js via apt",
    requiresApproval: true,
  },
  npm: {
    installCommand: "sudo apt-get install -y npm",
    verifyCommand: "npm --version",
    platform: "linux",
    description: "Install npm via apt",
    requiresApproval: true,
  },
  git: {
    installCommand: "sudo apt-get install -y git",
    verifyCommand: "git --version",
    platform: "linux",
    description: "Install Git via apt",
    requiresApproval: true,
  },
  docker: {
    installCommand: "sudo apt-get install -y docker.io",
    verifyCommand: "docker --version",
    platform: "linux",
    description: "Install Docker via apt",
    requiresApproval: true,
  },
  python3: {
    installCommand: "sudo apt-get install -y python3",
    verifyCommand: "python3 --version",
    platform: "linux",
    description: "Install Python 3 via apt",
    requiresApproval: true,
  },
};

// ─── Factory ───

export function createFridayPrerequisiteInstaller(
  deps: CreateFridayPrerequisiteInstallerDeps,
): FridayPrerequisiteInstaller {
  const { environmentScanner, execCommand } = deps;

  function executeShellCommand(commandLine: string): ReturnType<typeof execCommand> {
    const os = environmentScanner.getOs();
    if (os === "win32") {
      return execCommand("cmd.exe", ["/d", "/s", "/c", commandLine]);
    }
    return execCommand("/bin/sh", ["-lc", commandLine]);
  }

  function getRecipesForPlatform(): Record<string, Omit<FridayPrerequisiteInstallPlan, "software">> {
    const os = environmentScanner.getOs();
    if (os === "linux") return LINUX_INSTALL_RECIPES;
    // Default to macOS (darwin) recipes; Windows is not yet supported
    return INSTALL_RECIPES;
  }

  async function isInstalled(software: string): Promise<boolean> {
    return environmentScanner.isInstalled(software);
  }

  return {
    async planInstallations(required) {
      const recipes = getRecipesForPlatform();
      const plans: FridayPrerequisiteInstallPlan[] = [];

      for (const software of required) {
        const installed = await isInstalled(software);
        if (installed) continue;

        const recipe = recipes[software];
        if (!recipe) {
          // No known install recipe for this software
          plans.push({
            software,
            installCommand: "",
            verifyCommand: `${software} --version`,
            platform: "all",
            description: `No automatic installer for "${software}". Manual installation required.`,
            requiresApproval: false,
          });
          continue;
        }

        plans.push({ software, ...recipe });
      }

      return plans;
    },

    async install(plan, signal) {
      if (signal.aborted) {
        return { software: plan.software, status: "skipped" as const };
      }

      // If no install command, cannot install
      if (!plan.installCommand) {
        return {
          software: plan.software,
          status: "failed" as const,
          errorMessage: `No automatic installer available for "${plan.software}".`,
        };
      }

      try {
        const result = await executeShellCommand(plan.installCommand);

        if (signal.aborted) {
          return { software: plan.software, status: "skipped" as const };
        }

        if (result.exitCode !== 0) {
          return {
            software: plan.software,
            status: "failed" as const,
            errorMessage: result.stderr || `Exit code ${result.exitCode}`,
          };
        }

        // Verify installation
        const verifyResult = await executeShellCommand(plan.verifyCommand);

        if (verifyResult.exitCode === 0) {
          const version = verifyResult.stdout.trim().split("\n")[0];
          return {
            software: plan.software,
            status: "installed" as const,
            version,
          };
        }

        return {
          software: plan.software,
          status: "failed" as const,
          errorMessage: "Installation succeeded but verification failed",
        };
      } catch (error) {
        return {
          software: plan.software,
          status: "failed" as const,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async installAll(required, signal) {
      const plans = await this.planInstallations(required);
      const results: FridayPrerequisiteInstallResult[] = [];

      // Check already-installed items first
      for (const software of required) {
        const installed = await isInstalled(software);
        if (installed) {
          const version = await environmentScanner.getVersion(software);
          results.push({
            software,
            status: "not_needed" as const,
            version: version ?? undefined,
          });
        }
      }

      // Install missing items sequentially
      for (const plan of plans) {
        if (signal.aborted) {
          results.push({ software: plan.software, status: "skipped" as const });
          continue;
        }

        const result = await this.install(plan, signal);
        results.push(result);
      }

      return results;
    },
  };
}
