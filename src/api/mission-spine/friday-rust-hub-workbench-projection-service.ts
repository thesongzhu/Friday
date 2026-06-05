import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";
import type {
  FridayMissionSpineWorkbenchProjectionInput,
  FridayMissionSpineWorkbenchProjectionService,
} from "../http/routes/friday-mission-spine-routes.js";
import type { FridayMissionSpineWorkbenchSnapshot } from "../model/friday-api-mission-spine.types.js";

const execFileAsync = promisify(execFile);

export interface CreateFridayRustHubWorkbenchProjectionServiceOptions {
  readonly stateDir: string;
  readonly repoRoot?: string;
  readonly dbPath?: string;
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_WORKBENCH_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "api:/v1/mission-spine/workbench",
      projection: "rust_hub_unavailable",
      proofReady: false,
    },
  });
}

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unwrapSnapshot(payload: unknown): FridayMissionSpineWorkbenchSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust Hub workbench adapter returned an invalid projection payload.");
  }
  const root = payload as Record<string, unknown>;
  const snapshot = root.snapshot && typeof root.snapshot === "object" && !Array.isArray(root.snapshot)
    ? root.snapshot
    : root;
  return snapshot as FridayMissionSpineWorkbenchSnapshot;
}

function resolveDefaultRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "../../..");
}

export function createFridayRustHubWorkbenchProjectionService(
  options: CreateFridayRustHubWorkbenchProjectionServiceOptions,
): FridayMissionSpineWorkbenchProjectionService {
  const dbPath = resolve(
    options.dbPath ??
      process.env.FRIDAY_MISSION_SPINE_HUB_DB_PATH ??
      join(options.stateDir, "rust-hub.sqlite"),
  );
  const repoRoot = resolve(options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot());
  const rustCoreRoot = resolve(process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"));
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_MISSION_SPINE_WORKBENCH_ADAPTER_BIN;
  const timeoutMs = options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_MISSION_SPINE_WORKBENCH_ADAPTER_TIMEOUT_MS, 120_000);

  return {
    async getSnapshot(input: FridayMissionSpineWorkbenchProjectionInput): Promise<FridayMissionSpineWorkbenchSnapshot> {
      if (!existsSync(dbPath)) {
        throw unavailable("Rust Hub workbench DB is not present for this runtime.");
      }

      const adapterArgs = ["--db", dbPath];
      if (input.missionId) {
        adapterArgs.push("--mission-id", input.missionId);
      }

      const command = adapterBin ?? "cargo";
      const args = adapterBin
        ? adapterArgs
        : [
            "run",
            "--quiet",
            "--manifest-path",
            join(rustCoreRoot, "Cargo.toml"),
            "-p",
            "friday-hub",
            "--bin",
            "mission_workbench_projection",
            "--",
            ...adapterArgs,
          ];

      let stdout = "";
      try {
        const result = await execFileAsync(command, args, {
          cwd: repoRoot,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...process.env,
            RUST_BACKTRACE: "0",
          },
        });
        stdout = result.stdout;
      } catch {
        throw unavailable("Rust Hub workbench adapter could not produce a live projection.");
      }

      try {
        return unwrapSnapshot(JSON.parse(stdout));
      } catch (error) {
        if (error instanceof FridayDomainError) throw error;
        throw unavailable("Rust Hub workbench adapter returned invalid JSON.");
      }
    },
  };
}
