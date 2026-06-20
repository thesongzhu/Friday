import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";
import type { FridaySystemIntentAction, FridaySystemIntentResult } from "../../system/model/friday-system.types.js";
import type { FridayExecuteSystemIntentRequest, FridayExecuteSystemIntentResponse } from "../model/friday-api-system.types.js";

const execFileAsync = promisify(execFile);

export const FRIDAY_SYSTEM_INTENT_RUST_FLAG = "FRIDAY_SYSTEM_INTENT_RUST_ENTRYPOINT";

export interface CreateFridayRustHubSystemIntentServiceOptions {
  readonly repoRoot?: string;
  readonly dbPath?: string;
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
  readonly nowMs?: () => number;
}

export interface FridayRustHubSystemIntentService {
  execute(req: FridayExecuteSystemIntentRequest): Promise<FridayExecuteSystemIntentResponse>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("SYSTEM_INTENT_RUST_ENTRYPOINT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:system_intent_rust_entrypoint",
      truthLabel: "b3_system_intent_rust_dark_entrypoint",
    },
  });
}

function readTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveDefaultRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "../../..");
}

function requireExistingFile(path: string | undefined, label: string): string {
  const resolved = path ? resolve(path) : "";
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw unavailable(`${label} is not provisioned.`);
  }
  return resolved;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw unavailable(`System-intent bridge payload is missing ${field}.`);
  }
  return value;
}

function boolField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw unavailable(`System-intent bridge payload is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function refsOnlyTarget(req: FridayExecuteSystemIntentRequest): string | undefined {
  return (req.targetKind !== "url" ? req.target : undefined)
    ?? req.appIdentifier
    ?? req.windowId
    ?? req.notificationId
    ?? req.deviceId
    ?? (req.projectPath ? `project:${req.projectPath}` : undefined);
}

function actorKind(req: FridayExecuteSystemIntentRequest): string {
  return req.actorKind ?? "api";
}

function actorId(req: FridayExecuteSystemIntentRequest): string {
  return req.actorId ?? `${actorKind(req)}:system-intent`;
}

function intentId(req: FridayExecuteSystemIntentRequest): string {
  return `system-intent:${actorKind(req)}:${actorId(req)}:${req.idempotencyKey}`;
}

function parseReceipt(req: FridayExecuteSystemIntentRequest, payload: unknown, performedAt: string): FridayExecuteSystemIntentResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("System-intent bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;
  if (root.truth_label !== "b3_system_intent_rust_dark_entrypoint") {
    throw unavailable("System-intent bridge returned the wrong truth label.");
  }
  const ok = boolField(root.ok, "ok");
  const status = stringField(root.status, "status") as FridaySystemIntentResult["status"];
  return {
    result: {
      id: intentId(req),
      action: stringField(root.action, "action") as FridaySystemIntentAction,
      status,
      message: stringField(root.message, "message"),
      performedAt,
      controlLeaseId: optionalString(root.control_lease_id),
      payload: {
        truthLabel: "b3_system_intent_rust_dark_entrypoint",
        ok,
        live: boolField(root.live, "live"),
        dryRun: boolField(root.dry_run, "dry_run"),
        executionDeferred: boolField(root.execution_deferred, "execution_deferred"),
        osActuated: boolField(root.os_actuated, "os_actuated"),
        completesEffect: boolField(root.completes_effect, "completes_effect"),
        completesHostEffect: boolField(root.completes_host_effect, "completes_host_effect"),
        gateReason: optionalString(root.gate_reason),
      },
    },
  };
}

export function createFridayRustHubSystemIntentService(
  options: CreateFridayRustHubSystemIntentServiceOptions = {},
): FridayRustHubSystemIntentService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_SYSTEM_INTENT_RUST_BIN;
  const dbPath = options.dbPath ?? process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH;
  const timeoutMs =
    options.timeoutMs ?? readTimeoutMs(process.env.FRIDAY_SYSTEM_INTENT_RUST_TIMEOUT_MS, 120_000);
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    async execute(req): Promise<FridayExecuteSystemIntentResponse> {
      const db = requireExistingFile(dbPath, "Rust hub DB");
      const args = [
        "dispatch",
        "--db",
        db,
        "--intent-id",
        intentId(req),
        "--action",
        req.action,
        "--actor-id",
        actorId(req),
        "--actor-kind",
        actorKind(req),
        "--now-ms",
        String(nowMs()),
      ];
      const targetRef = refsOnlyTarget(req);
      if (targetRef) {
        args.push("--target-ref", targetRef);
      }
      if (req.reason) {
        args.push("--reason", req.reason);
      }
      if (typeof req.leaseTtlMs === "number" && Number.isFinite(req.leaseTtlMs)) {
        args.push("--lease-ttl-ms", String(Math.floor(req.leaseTtlMs)));
      }

      const command = adapterBin ?? "cargo";
      const commandArgs = adapterBin
        ? args
        : [
            "run",
            "--quiet",
            "--manifest-path",
            join(rustCoreRoot, "Cargo.toml"),
            "-p",
            "friday-hub",
            "--bin",
            "hub_system_intent_dispatch",
            "--",
            ...args,
          ];
      let stdout = "";
      try {
        const result = await execFileAsync(command, commandArgs, {
          cwd: repoRoot,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            RUST_BACKTRACE: "0",
            [FRIDAY_SYSTEM_INTENT_RUST_FLAG]: "1",
          },
        });
        stdout = result.stdout;
      } catch {
        throw unavailable("System-intent bridge could not produce a refs-only receipt.");
      }
      try {
        return parseReceipt(req, JSON.parse(stdout), new Date(nowMs()).toISOString());
      } catch (err) {
        if (err instanceof FridayDomainError) throw err;
        throw unavailable("System-intent bridge returned invalid JSON.");
      }
    },
  };
}
