import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FridayDomainError } from "#errors";

/**
 * TS->Rust bridge for the A6/R3 `hub_workflow_catalog` dev bin (#657) — the Tier-2
 * WORKFLOW catalog-MUTATION surface.
 *
 * It clones the execFile shape of `friday-rust-hub-run-task-bridge-service.ts`: it spawns
 * the prebuilt `hub_workflow_catalog` binary (or falls back to `cargo run --bin`), drives
 * the five catalog ops the retired TS `workflows.*` mutation surface maps to —
 * `create / update / archive / publish / deploy` — and validates the bin's REFS-ONLY
 * stdout into a receipt. The bin emits ONLY safe identifiers/labels/counts and a BOUNDED
 * projection (`<field>_sha256` + `<field>_len`) of the free-form caller strings; the
 * verbatim `slug` / `name` / `description` / `tags_json` columns and the definition
 * BODIES (`definition_json` / `source_meta`) are NEVER emitted by the bin — and this
 * bridge's `parseReceipt` REJECTS them as defense-in-depth (a body field that ever
 * appeared would fail the receipt closed, 503).
 *
 * DARK / `rust_wired_dev` ceiling — confers no v1 GO. This bridge is consulted ONLY on the
 * flag-on branch of the workflow catalog-mutation routes, gated DEFAULT-OFF behind
 * `FRIDAY_ROUTE_WORKFLOWS_VIA_RUST` (operator cutover pending). With the flag OFF (default)
 * the routes stay byte-identical to today's fail-closed/retired behavior
 * (`TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED`, 503) and this bridge is never built/consulted.
 *
 * ## DEV-DB CEILING (a load-bearing cut-over caveat)
 * `hub_workflow_catalog` opens the target DB with `Db::open_hub`, which MIGRATES on open and
 * is documented "dev/temp DBs ONLY — NEVER the production hub DB." So flipping the flag on
 * with the bin pointed at a DEV DB proves the TS->Rust catalog path end-to-end, but it does
 * NOT (and must not) write the production catalog. The production cut-over therefore needs a
 * separate answer to the prod-DB-vs-migrate-on-open question (see the PR body). The DB path is
 * supplied via `FRIDAY_HUB_WORKFLOW_CATALOG_DB_PATH` (mirroring `FRIDAY_HUB_AGENT_RUN_DB_PATH`);
 * absent ⇒ the bridge fails closed (503) — it NEVER guesses/creates a DB.
 *
 * The bridge fails CLOSED (503) on any non-zero exit, timeout, parse failure, invalid shape,
 * `ok:false` receipt, or any payload that carries a forbidden body/verbatim field.
 */
const execFileAsync = promisify(execFile);

/** The catalog mutation ops the retired TS `workflows.*` surface maps to. */
export type FridayRustHubWorkflowCatalogOp =
  | "create"
  | "update"
  | "archive"
  | "publish"
  | "deploy";

/**
 * Refs-only catalog-mutation receipt — no definition bodies, no verbatim free-form strings,
 * no secrets, no PII. The free-form caller strings are present ONLY as a bounded
 * sha256+length projection (the bin's contract). `description` is nullable: a NULL
 * description yields `descriptionSha256: null` / `descriptionLen: null`.
 */
export interface FridayRustHubWorkflowCatalogReceipt {
  /** Always the dev tier — this is NOT a product/proven receipt. */
  readonly truthLabel: "rust_wired_dev";
  /** Always true — a loud reminder this is a dev bridge, not a product path. */
  readonly proofOnly: true;
  /** Which catalog op produced this receipt (echoed by the bin). */
  readonly op: string;
  readonly workflowId: string;
  /** Bounded projection of the free-form caller strings (never the verbatim value). */
  readonly slugSha256: string;
  readonly slugLen: number;
  readonly nameSha256: string;
  readonly nameLen: number;
  readonly descriptionSha256: string | null;
  readonly descriptionLen: number | null;
  readonly tagsJsonSha256: string;
  readonly tagsJsonLen: number;
  /** Safe identity/state/concurrency refs (emitted verbatim by the bin). */
  readonly isArchived: boolean;
  readonly revision: number;
  /** sha256 etag — the optimistic-concurrency token for the next mutation. */
  readonly etag: string;
  /** The deployed version pointer, or null when nothing is deployed. */
  readonly deployedVersion: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** Present only on `publish` (the just-published version). */
  readonly publishedVersion?: number;
}

export interface FridayRustHubWorkflowCatalogCreateInput {
  readonly op: "create";
  readonly workflowId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly tagsJson?: string;
  /** The workflow definition body JSON, passed through to the bin as `--def-json`. */
  readonly defJson: string;
  readonly nowMs?: number;
}

export interface FridayRustHubWorkflowCatalogUpdateInput {
  readonly op: "update";
  readonly workflowId: string;
  /** Optimistic-concurrency token — the bin's `--expected-revision`. */
  readonly expectedRevision: number;
  readonly name?: string;
  /**
   * Tri-state description: a string SETS it, `null` CLEARS it (`--clear-description`),
   * `undefined` leaves it unchanged. SET and CLEAR are mutually exclusive in the bin.
   */
  readonly description?: string | null;
  readonly tagsJson?: string;
  readonly nowMs?: number;
}

export interface FridayRustHubWorkflowCatalogArchiveInput {
  readonly op: "archive";
  readonly workflowId: string;
  readonly expectedRevision: number;
  readonly nowMs?: number;
}

export interface FridayRustHubWorkflowCatalogPublishInput {
  readonly op: "publish";
  readonly workflowId: string;
  readonly version: number;
}

export interface FridayRustHubWorkflowCatalogDeployInput {
  readonly op: "deploy";
  readonly workflowId: string;
  readonly expectedRevision: number;
  readonly nowMs?: number;
}

export type FridayRustHubWorkflowCatalogInput =
  | FridayRustHubWorkflowCatalogCreateInput
  | FridayRustHubWorkflowCatalogUpdateInput
  | FridayRustHubWorkflowCatalogArchiveInput
  | FridayRustHubWorkflowCatalogPublishInput
  | FridayRustHubWorkflowCatalogDeployInput;

export interface CreateFridayRustHubWorkflowCatalogBridgeServiceOptions {
  readonly repoRoot?: string;
  /**
   * Path to the DEV hub DB the bin mutates (must exist). Default =
   * `process.env.FRIDAY_HUB_WORKFLOW_CATALOG_DB_PATH`. NEVER the production hub DB — the
   * bin migrates on open (see the file header). Absent ⇒ the bridge fails closed.
   */
  readonly dbPath?: string;
  /** Path to a prebuilt `hub_workflow_catalog` binary; falls back to `cargo run --bin` when absent. */
  readonly adapterBin?: string;
  readonly timeoutMs?: number;
}

export interface FridayRustHubWorkflowCatalogBridgeService {
  mutateCatalog(
    input: FridayRustHubWorkflowCatalogInput,
  ): Promise<FridayRustHubWorkflowCatalogReceipt>;
}

function unavailable(message: string): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_WORKFLOW_CATALOG_BRIDGE_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_workflow_catalog_bridge",
      bridge: "rust_wired_dev",
      proofOnly: true,
      proofReady: false,
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A `<field>_sha256` projection: a non-empty string (a present projection) OR `null` (an
 * explicitly-absent nullable field, e.g. a NULL description). Any other value is a shape
 * violation. Returns `{ ok, value }` so the caller can fail closed on a missing pair.
 */
function asNullableShaProjection(value: unknown): { ok: boolean; value: string | null } {
  if (value === null) return { ok: true, value: null };
  const s = asString(value);
  if (s !== undefined) return { ok: true, value: s };
  return { ok: false, value: null };
}

function asNullableLenProjection(value: unknown): { ok: boolean; value: number | null } {
  if (value === null) return { ok: true, value: null };
  const n = asNumber(value);
  if (n !== undefined) return { ok: true, value: n };
  return { ok: false, value: null };
}

/** The forbidden VERBATIM / BODY keys the bin never emits — a body-leak boundary. */
const FORBIDDEN_RECEIPT_KEYS: readonly string[] = [
  "slug",
  "name",
  "description",
  "tags_json",
  "definition_json",
  "source_meta",
];

/** A required non-empty string ref, or fail closed with a missing-refs message. */
function reqString(value: unknown, what: string): string {
  const s = asString(value);
  if (s === undefined) {
    throw unavailable(`Rust hub_workflow_catalog bridge payload is missing ${what}.`);
  }
  return s;
}

/** A required finite-number ref, or fail closed with a missing-refs message. */
function reqNumber(value: unknown, what: string): number {
  const n = asNumber(value);
  if (n === undefined) {
    throw unavailable(`Rust hub_workflow_catalog bridge payload is missing ${what}.`);
  }
  return n;
}

/**
 * Guard the receipt-LEVEL boundaries (object shape, the no-verbatim/no-body field boundary,
 * the truth label, and `ok:false`). Extracted from {@link parseReceipt} to keep its complexity
 * bounded. Returns the validated root record.
 */
function guardReceiptEnvelope(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unavailable("Rust hub_workflow_catalog bridge returned a non-object payload.");
  }
  const root = payload as Record<string, unknown>;
  // Hard boundary: the verbatim free-form columns + definition bodies must NEVER cross
  // the bridge — only the bounded `_sha256`/`_len` projections + safe refs may.
  for (const key of FORBIDDEN_RECEIPT_KEYS) {
    if (key in root) {
      throw unavailable(
        "Rust hub_workflow_catalog bridge payload carried a forbidden verbatim/body field (rejected).",
      );
    }
  }
  if (root.truth_label !== "rust_wired_dev") {
    throw unavailable("Rust hub_workflow_catalog bridge payload is not labeled rust_wired_dev.");
  }
  if (root.ok === false) {
    throw unavailable("Rust hub_workflow_catalog bridge reported a fail-closed mutation.");
  }
  return root;
}

/** The nullable `deployed_version` pointer (null = no deploy pointer yet). */
function parseDeployedVersion(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const dv = asNumber(value);
  if (dv === undefined) {
    throw unavailable("Rust hub_workflow_catalog bridge payload has an invalid deployed_version.");
  }
  return dv;
}

/**
 * Validate + normalize the Rust bin's refs-only stdout into a receipt. Fails closed on any
 * shape violation AND on any attempt to carry a verbatim free-form string or a definition
 * body (the boundary this bridge enforces, mirroring the bin's own output guard).
 */
function parseReceipt(payload: unknown): FridayRustHubWorkflowCatalogReceipt {
  const root = guardReceiptEnvelope(payload);

  const isArchived = root.is_archived;
  if (typeof isArchived !== "boolean") {
    throw unavailable("Rust hub_workflow_catalog bridge payload is missing is_archived.");
  }

  // The nullable description projection (NULL distinguishable from empty-string).
  const descSha = asNullableShaProjection(root.description_sha256);
  const descLen = asNullableLenProjection(root.description_len);
  if (!descSha.ok || !descLen.ok) {
    throw unavailable("Rust hub_workflow_catalog bridge payload has an invalid description projection.");
  }

  return {
    truthLabel: "rust_wired_dev",
    proofOnly: true,
    op: reqString(root.op, "the op"),
    workflowId: reqString(root.workflow_id, "the workflow id"),
    slugSha256: reqString(root.slug_sha256, "slug_sha256"),
    slugLen: reqNumber(root.slug_len, "slug_len"),
    nameSha256: reqString(root.name_sha256, "name_sha256"),
    nameLen: reqNumber(root.name_len, "name_len"),
    descriptionSha256: descSha.value,
    descriptionLen: descLen.value,
    tagsJsonSha256: reqString(root.tags_json_sha256, "tags_json_sha256"),
    tagsJsonLen: reqNumber(root.tags_json_len, "tags_json_len"),
    isArchived,
    revision: reqNumber(root.revision, "revision"),
    etag: reqString(root.etag, "etag"),
    deployedVersion: parseDeployedVersion(root.deployed_version),
    createdAtMs: reqNumber(root.created_at_ms, "created_at_ms"),
    updatedAtMs: reqNumber(root.updated_at_ms, "updated_at_ms"),
    publishedVersion: asNumber(root.published_version),
  };
}

/** Build the bin argv for a given catalog op (fail-closed: never synthesize a missing required arg). */
function buildAdapterArgs(dbPath: string, input: FridayRustHubWorkflowCatalogInput): string[] {
  const args = ["--db", dbPath, "--op", input.op, "--workflow-id", input.workflowId];
  switch (input.op) {
    case "create": {
      args.push("--slug", input.slug, "--name", input.name, "--def-json", input.defJson);
      if (input.description !== undefined) {
        args.push("--description", input.description);
      }
      if (input.tagsJson !== undefined) {
        args.push("--tags-json", input.tagsJson);
      }
      if (typeof input.nowMs === "number") {
        args.push("--now-ms", String(input.nowMs));
      }
      break;
    }
    case "update": {
      args.push("--expected-revision", String(input.expectedRevision));
      if (input.name !== undefined) {
        args.push("--name", input.name);
      }
      // Tri-state description: string SETS, null CLEARS, undefined unchanged.
      if (input.description === null) {
        args.push("--clear-description");
      } else if (input.description !== undefined) {
        args.push("--description", input.description);
      }
      if (input.tagsJson !== undefined) {
        args.push("--tags-json", input.tagsJson);
      }
      if (typeof input.nowMs === "number") {
        args.push("--now-ms", String(input.nowMs));
      }
      break;
    }
    case "archive": {
      args.push("--expected-revision", String(input.expectedRevision));
      if (typeof input.nowMs === "number") {
        args.push("--now-ms", String(input.nowMs));
      }
      break;
    }
    case "publish": {
      args.push("--version", String(input.version));
      break;
    }
    case "deploy": {
      args.push("--expected-revision", String(input.expectedRevision));
      if (typeof input.nowMs === "number") {
        args.push("--now-ms", String(input.nowMs));
      }
      break;
    }
  }
  return args;
}

export function createFridayRustHubWorkflowCatalogBridgeService(
  options: CreateFridayRustHubWorkflowCatalogBridgeServiceOptions = {},
): FridayRustHubWorkflowCatalogBridgeService {
  const repoRoot = resolve(
    options.repoRoot ?? process.env.FRIDAY_REPO_ROOT ?? resolveDefaultRepoRoot(),
  );
  const rustCoreRoot = resolve(
    process.env.FRIDAY_MISSION_SPINE_RUST_CORE_ROOT ?? join(repoRoot, "rust-core"),
  );
  const adapterBin = options.adapterBin ?? process.env.FRIDAY_HUB_WORKFLOW_CATALOG_BIN;
  const dbPathRaw = options.dbPath ?? process.env.FRIDAY_HUB_WORKFLOW_CATALOG_DB_PATH;
  const timeoutMs =
    options.timeoutMs ??
    readTimeoutMs(process.env.FRIDAY_HUB_WORKFLOW_CATALOG_TIMEOUT_MS, 120_000);

  // One-time guard so the (loud) cargo-run-fallback warning is logged once per service
  // instance, not on every mutation. Flipped true the first time the fallback is taken.
  let warnedCargoFallback = false;

  return {
    async mutateCatalog(
      input: FridayRustHubWorkflowCatalogInput,
    ): Promise<FridayRustHubWorkflowCatalogReceipt> {
      // A missing/empty DB path FAILS CLOSED — the bridge never guesses or creates a DB.
      if (!dbPathRaw) {
        throw unavailable("Rust hub_workflow_catalog bridge requires a DB path.");
      }
      const dbPath = resolve(dbPathRaw);
      // The dev hub DB must ALREADY exist — a missing DB is fail-closed (the bin would
      // also refuse, but we refuse before spawning).
      if (!existsSync(dbPath)) {
        throw unavailable("Rust hub_workflow_catalog DB is not present for this runtime.");
      }
      if (!input.workflowId) {
        throw unavailable("Rust hub_workflow_catalog bridge requires a workflow id.");
      }

      const adapterArgs = buildAdapterArgs(dbPath, input);

      // Prefer the PREBUILT binary (`FRIDAY_HUB_WORKFLOW_CATALOG_BIN` / `adapterBin`). The
      // `cargo run` fallback COMPILES the bin in the request hot path (latency + a
      // non-JSON-stdout failure surface), so emit a LOUD one-time warning when it is taken.
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
            "hub_workflow_catalog",
            "--",
            ...adapterArgs,
          ];
      if (!adapterBin && !warnedCargoFallback) {
        warnedCargoFallback = true;
        console.warn(
          "[friday][rust-workflow-catalog] FRIDAY_HUB_WORKFLOW_CATALOG_BIN is not set — " +
            "falling back to `cargo run` in the request hot path (compiles per cold start; " +
            "adds latency and a failure surface). Set it to a prebuilt hub_workflow_catalog " +
            "binary at deploy time.",
        );
      }

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
        // Non-zero exit, timeout, or spawn failure → fail closed (no detail surfaced).
        throw unavailable("Rust hub_workflow_catalog bridge could not produce a refs-only receipt.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw unavailable("Rust hub_workflow_catalog bridge returned invalid JSON.");
      }
      return parseReceipt(parsed);
    },
  };
}
