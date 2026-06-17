#!/usr/bin/env node
// ─── DIAGNOSTIC — S6 "transport-A" PROOF DRIVER (operator-run; NOT a product surface) ───
//
// TRUTH LABEL (read before anything else):
//   This is the v1-FAITHFUL TRANSPORT-A LIVE PRODUCT proof: it drives a MUTATING agent run DIRECTLY
//   over the LIVE SEALED-WS to the Rust hub WS server (127.0.0.1:48750) by reusing the SHIPPED
//   PRODUCTION sealed client (`dist/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js`)
//   and the SHIPPED X25519 secret resolver. It is NOT a dev bin and NOT a fork of the transport — it
//   exercises the EXACT bytes the in-product compose path would send. It exists ONLY because the
//   TS-HTTP courier compose is broken (it forces constraints.readOnly:true on the run, so a mutating
//   run can never PAUSE through it); this driver bypasses that one broken courier wrapper and speaks
//   the same sealed client the courier wraps.
//
//   HONEST CEILING: running this — even to a clean PAUSE + a successful operator-signed RESUME — does
//   NOT by itself move the v1 release gate. It is one (important) S6-in-product proof. The gate still
//   needs the operator's offline Ed25519 signature on the paused action AND the broader v1 gate
//   (parity / device / sync / operator-approved release). A green run here is a de-risk, not a GO.
//
// SECURITY POSTURE:
//   • The X25519 client SECRET is resolved IN-PROCESS via the shipped `resolveRustAgentRunWsClient-
//     X25519Secret()` (derived from getMasterKey via SecureStore) and is NEVER printed, logged, or
//     handled by this script directly. If it resolves to null we FAIL LOUD telling the operator to
//     export FRIDAY_MASTER_KEY (the resolver's getMasterKey reads it).
//   • The master key is reached ONLY through the resolver. This script NEVER reads ~/.friday/master.key,
//     NEVER touches FRIDAY_MASTER_KEY itself, and NEVER prints any key/secret/session-key/signed bytes.
//   • The client PUBKEY (32 bytes) and the action_digest (hex) are NON-secret and ARE printed (debug).
//
// HOW IT RUNS (no tsx / no repo build needed beyond the already-present dist/):
//   It imports the SHIPPED, BUILT sealed client + secret resolver from dist/. Because the file lives
//   inside the project, Node's `#providers` import map (package.json "imports") resolves so the
//   resolver's `import { getMasterKey } from "#providers"` works. DB reads (pending_approval_request
//   → pending-request.json, token_ledger landing check) use the `sqlite3 -readonly` CLI against the
//   live rust-hub.sqlite. The sealed client opens the raw TCP preamble + ECDH + RFC6455 itself.
//
// MODES:
//   --mode dispatch-mutating [--artifact-dir <dir>] [--proof-file <path>]
//       (default artifact dir: $TMPDIR/friday-s6-transport-a; default proof-file under it)
//       Resolve the client secret (fail loud on null). Optionally print the NON-secret client pubkey.
//       dispatchRun a MUTATING run (NO readOnly constraint) instructing a write_file to <proof-file>.
//       EXPECT a PAUSED outcome (outcome==="paused"). Print runId/approvalId/actionDigest/summary,
//       read the persisted pending_approval_request row by run_id, and write pending-request.json
//       under the artifact dir in the EXACT schema friday-operator-approve sign --request consumes.
//       A NON-paused outcome (normal result / no_answer) is a REAL PROBLEM (the gate did not pause)
//       ⇒ FAIL LOUD.
//
//   --mode resume --run-id <id> --approval <signed-approval.json>
//       Read the operator-signed CanonicalApproval JSON file bytes VERBATIM as a Uint8Array (NO
//       base64 / NO re-parse — the sealed client relays the blob as-is; INV-1 pure courier) and call
//       resumeWithApproval({ runId, opaqueSignedBlob }). Print op/accepted/status/auditRef.
//       accepted===true ⇒ "MUTATION RESUMED — verify the proof-file + a fresh token_ledger row".
//       accepted===false ⇒ "REFUSED (fail-closed)".
//
//   --mode resume-negative --run-id <id> --kind <empty|wrongkey> [--approval <wrongkey-signed.json>]
//       Adversarial: prove an ABSENT or FORGED signature does NOT execute.
//         empty    : pass an EMPTY Uint8Array. The shipped client guards length===0 and REJECTS
//                    (client-side courier refusal) BEFORE opening a socket — caught as the expected
//                    fail-closed refusal, NOT a crash.
//         wrongkey : pass a real Ed25519 signature from a THROWAWAY key (NOT the operator's). The blob
//                    is non-empty so it reaches the server; the server either returns accepted===false
//                    OR closes the session (client rejects). BOTH are the negative PASS. accepted===true
//                    would mean a forged signature EXECUTED ⇒ loud ALARM.
//
// FAIL LOUD: every error prints an exact failure CATEGORY (network / secret-resolve-null /
// non-paused-outcome / db-missing / forged-executed). No secret ever appears in output.

import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

// ─── Shipped production building blocks (compiled .js — the SAME bytes compose would use) ───
const PROJECT_ROOT = "/Users/jarvis/Projects/Friday";
const SEALED_CLIENT_JS =
  process.env.FRIDAY_S6_SEALED_CLIENT_JS ||
  `${PROJECT_ROOT}/dist/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.js`;
const SECRET_RESOLVER_JS =
  process.env.FRIDAY_S6_SECRET_RESOLVER_JS ||
  `${PROJECT_ROOT}/dist/api/mission-spine/friday-rust-hub-agent-run-ws-client-x25519-secret.js`;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 48750; // FRIDAY_HUB_AGENT_RUN_WS_PORT on the live hub
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ARTIFACT_DIR =
  process.env.FRIDAY_S6_ARTIFACT_DIR || path.join(os.tmpdir(), "friday-s6-transport-a");
const DEFAULT_PROOF_BASENAME = "s6-proof-artifact.txt";
const DEFAULT_PENDING_REQUEST_BASENAME = "pending-request.json";
const DEFAULT_SIGNED_APPROVAL_BASENAME = "signed-approval.json";
const FORWARDED_PRINCIPAL = "admin-001";
const DEFAULT_RUST_HUB_DB =
  "/Users/jarvis/Library/Application Support/Friday/state/rust-hub.sqlite";

// ─── tiny arg parser (mirrors the existing friday-s6-proof-driver.mjs) ───
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function die(category, msg, extra) {
  console.error(`\n[s6-transport-a] FATAL [${category}]: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function resolvePathArg(value, fallback) {
  const selected = typeof value === "string" && value.length > 0 ? value : fallback;
  return path.resolve(selected);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── rust-hub.sqlite reads via the sqlite3 CLI (read-only) — mirrors the existing driver ───
function rustHubDbPath() {
  return process.env.FRIDAY_HUB_AGENT_RUN_DB_PATH || DEFAULT_RUST_HUB_DB;
}

function sqliteQuery(dbPath, sql) {
  // -readonly: never mutate the live db. -json: parseable. file: URI so WAL companions resolve.
  const uri = `file:${dbPath}?mode=ro`;
  const raw = execFileSync("sqlite3", ["-readonly", "-json", uri, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function pendingRequestRowForRun(runId) {
  const db = rustHubDbPath();
  if (!fs.existsSync(db)) {
    return { dbMissing: true, db };
  }
  try {
    const rows = sqliteQuery(
      db,
      `SELECT approval_id, run_id, action, action_digest, principal_id, surface,
              resource_type, resource_id, expires_at, issuer, status, created_at
       FROM pending_approval_request WHERE run_id = '${runId.replace(/'/g, "''")}'
       ORDER BY created_at DESC;`,
    );
    return { db, rows };
  } catch (err) {
    return { db, error: err?.message ?? String(err) };
  }
}

function tokenLedgerRowForRun(runId) {
  const db = rustHubDbPath();
  if (!fs.existsSync(db)) {
    return { dbMissing: true, db };
  }
  try {
    const rows = sqliteQuery(
      db,
      `SELECT ledger_id, run_id, session_id, provider_kind, model, total_tokens, fallback, created_at
       FROM token_ledger WHERE run_id = '${runId.replace(/'/g, "''")}'
       ORDER BY created_at DESC LIMIT 5;`,
    );
    return { db, rows };
  } catch (err) {
    return { db, error: err?.message ?? String(err) };
  }
}

// ─── shipped-module loaders (fail loud with the build hint) ───
async function loadSealedClientFactory() {
  if (!fs.existsSync(SEALED_CLIENT_JS)) {
    die(
      "build",
      `sealed client not built at ${SEALED_CLIENT_JS}. Run npm run build (or set ` +
        "FRIDAY_S6_SEALED_CLIENT_JS). This MUST be the SHIPPED compiled client so the wire bytes " +
        "match the in-product compose path.",
    );
  }
  const mod = await import(pathToFileURL(SEALED_CLIENT_JS).href);
  if (typeof mod.createFridayRustHubAgentRunSealedClient !== "function") {
    die("build", `createFridayRustHubAgentRunSealedClient not exported from ${SEALED_CLIENT_JS}`);
  }
  return mod.createFridayRustHubAgentRunSealedClient;
}

async function loadSecretResolver() {
  if (!fs.existsSync(SECRET_RESOLVER_JS)) {
    die(
      "build",
      `secret resolver not built at ${SECRET_RESOLVER_JS}. Run npm run build (or set ` +
        "FRIDAY_S6_SECRET_RESOLVER_JS).",
    );
  }
  // This import drags in `#providers` (getMasterKey) — which is exactly why this file MUST live
  // inside the project so the package.json "imports" map resolves.
  const mod = await import(pathToFileURL(SECRET_RESOLVER_JS).href);
  if (typeof mod.resolveRustAgentRunWsClientX25519Secret !== "function") { // pragma: allowlist secret
    die("build", `resolveRustAgentRunWsClientX25519Secret not exported from ${SECRET_RESOLVER_JS}`);
  }
  return mod;
}

// ─── resolve the client secret (NEVER printed) — fail loud on null ───
function resolveClientSecretOrDie(resolverMod) {
  let secret;
  try {
    secret = resolverMod.resolveRustAgentRunWsClientX25519Secret();
  } catch (err) {
    die(
      "secret-resolve-throw",
      `the X25519 secret resolver THREW: ${err?.message ?? String(err)}. This is a misconfig ` +
        "(e.g. an invalid FRIDAY_MASTER_KEY). Export the canonical FRIDAY_MASTER_KEY (sourced from " +
        "the hub plist) and retry.",
    );
  }
  if (!secret) {
    die(
      "secret-resolve-null",
      "resolveRustAgentRunWsClientX25519Secret() returned null ⇒ no X25519 client secret. The " +
        "resolver derives it from getMasterKey (SecureStore). EXPORT the canonical FRIDAY_MASTER_KEY " +
        "(sourced from the hub plist / ~/.friday/master.key) before running, then retry. This script " +
        "REFUSES to handle the master key itself.",
    );
  }
  if (!(secret instanceof Uint8Array) || secret.length !== 32) {
    die(
      "secret-resolve-shape",
      `resolved client secret is not a 32-byte Uint8Array (got len=${secret?.length}); refusing to ` +
        "open a session with a malformed key.",
    );
  }
  return secret; // NEVER logged.
}

function maybePrintClientPubkey(resolverMod, secret) {
  // The pubkey is NON-secret (it is exactly what the operator enrolls in the server peer-allowlist).
  // Printing it helps the operator confirm THIS host's key matches the enrolled peer when a dispatch
  // fails closed at the handshake (auto-resolved key ≠ 6b-enrolled key).
  try {
    const pub = resolverMod.deriveRustAgentRunWsClientX25519PublicKey(secret);
    console.log(`[s6-transport-a] client pubkey (NON-secret) = ${Buffer.from(pub).toString("hex")}`);
  } catch {
    // non-fatal: the pubkey is a debug aid only.
  }
}

function makeClient(createFactory, secret) {
  // agentRunControlViaRust:true in ALL modes — without it dispatch won't recognize the paused frame
  // and resume immediately rejects as flag-off. Mirrors the live hub's FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1.
  return createFactory({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    clientSecret: secret,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    agentRunControlViaRust: true,
  });
}

function freshRunId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `s6-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ─── MODE 1: dispatch-mutating ───
async function modeDispatchMutating(args, createFactory, resolverMod) {
  const artifactDir = resolvePathArg(args["artifact-dir"], DEFAULT_ARTIFACT_DIR);
  ensurePrivateDir(artifactDir);
  const proofFile = resolvePathArg(
    args["proof-file"],
    path.join(artifactDir, DEFAULT_PROOF_BASENAME),
  );
  const pendingRequestPath = resolvePathArg(
    args["pending-request-file"],
    path.join(artifactDir, DEFAULT_PENDING_REQUEST_BASENAME),
  );
  const signedApprovalPath = resolvePathArg(
    args["signed-approval-file"],
    path.join(artifactDir, DEFAULT_SIGNED_APPROVAL_BASENAME),
  );
  ensurePrivateDir(path.dirname(pendingRequestPath));
  ensurePrivateDir(path.dirname(signedApprovalPath));
  const secret = resolveClientSecretOrDie(resolverMod);
  maybePrintClientPubkey(resolverMod, secret);
  const client = makeClient(createFactory, secret);

  const runId = freshRunId();
  const task =
    `Use the write_file tool to write the exact text "S6_MUTATION_OK" to the file ${proofFile}, ` +
    "then reply with exactly: S6_WRITE_DONE";

  console.log(
    `[dispatch-mutating] sealed-WS → ${DEFAULT_HOST}:${DEFAULT_PORT} runId=${runId} ` +
      `principal=${FORWARDED_PRINCIPAL} artifactDir=${artifactDir} proofFile=${proofFile} ` +
      "(NO readOnly constraint)",
  );

  let outcome;
  try {
    // MUTATING run: OMIT constraints.readOnly entirely (pass constraints:{} so nothing tightens —
    // buildConstraintsWire returns undefined and the wire is byte-identical to no-constraints). The
    // server's loop gate must then PAUSE the write_file mutation pending an operator signature.
    outcome = await client.dispatchRun({
      runId,
      task,
      forwardedPrincipal: FORWARDED_PRINCIPAL,
      constraints: {},
    });
  } catch (err) {
    die(
      "network",
      `dispatchRun failed to settle cleanly: ${err?.message ?? String(err)}. A session that closes ` +
        "BEFORE any refs is the fail-closed handshake path — most often the resolved client pubkey is " +
        "NOT the 6b-enrolled peer (auto-resolved key ≠ the hub's enrolled key). EXPORT the canonical " +
        "FRIDAY_MASTER_KEY (sourced from the hub plist) so the derived pubkey matches the peer-allowlist, " +
        "then retry. (Also confirm the hub WS is up on " +
        `${DEFAULT_HOST}:${DEFAULT_PORT} and FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1.)`,
    );
  }

  if (!outcome || outcome.outcome !== "paused") {
    // The gate did NOT pause a mutating run — a REAL problem to surface (NOT the expected S6 path).
    die(
      "non-paused-outcome",
      "dispatchRun did NOT return a PAUSED outcome for a mutating write_file run. The server's " +
        "loop gate should have paused pending an operator signature. A normal AgentRunResult / " +
        "no_answer here means the mutation was NOT gated — investigate the hub.",
      `full outcome:\n${JSON.stringify(outcome, null, 2)}`,
    );
  }

  console.log("\n[dispatch-mutating] PAUSED (the mutating tool was gated as expected):");
  console.log(`  runId        = ${outcome.runId}`);
  console.log(`  approvalId   = ${outcome.approvalId}`);
  console.log(`  actionDigest = ${outcome.actionDigest}`); // NON-secret fingerprint, OK to print
  if (outcome.ownerSealedSummary !== undefined) {
    console.log(`  summary      = ${outcome.ownerSealedSummary}`);
  }
  if (outcome.expiresAt !== undefined) {
    console.log(`  expiresAt    = ${outcome.expiresAt}`);
  }

  // Read the persisted pending_approval_request row and write pending-request.json (EXACT schema
  // friday-operator-approve sign --request consumes — verified to round-trip in the HTTP driver).
  const pr = pendingRequestRowForRun(outcome.runId);
  if (pr.dbMissing) {
    die(
      "db-missing",
      `the run PAUSED but rust-hub.sqlite is not at ${pr.db} — cannot read the pending_approval_request ` +
        "row to build pending-request.json. Set FRIDAY_HUB_AGENT_RUN_DB_PATH.",
    );
  }
  if (pr.error) {
    die(
      "db-read",
      `the run PAUSED but reading pending_approval_request failed: ${pr.error}.`,
    );
  }
  if (pr.rows.length === 0) {
    die(
      "db-row-missing",
      `the run PAUSED (approvalId=${outcome.approvalId}) but NO pending_approval_request row exists ` +
        `for runId=${outcome.runId} in ${pr.db}. The pause frame and the persisted row disagree — ` +
        "investigate the hub (the row should be committed before the pause frame is emitted).",
    );
  }

  const row = pr.rows[0];
  // EXACT friday-operator-cli PendingRequest shape (required: approval_id, action_digest, expires_at,
  // decision; optional: issuer, principal, action, surface). decision defaults "approved" — the
  // operator edits to "denied" to reject. IDENTICAL keys to the HTTP driver's pending-request.json.
  const pending = {
    approval_id: row.approval_id,
    action_digest: row.action_digest,
    expires_at: row.expires_at,
    decision: "approved",
    issuer: row.issuer,
    principal: row.principal_id ?? undefined,
    action: row.action ?? undefined,
    surface: row.surface ?? undefined,
  };
  fs.writeFileSync(pendingRequestPath, JSON.stringify(pending, null, 2) + "\n");
  console.log(`\n[dispatch-mutating] wrote pending-request.json → ${pendingRequestPath}`);
  console.log(JSON.stringify(pending, null, 2));

  // Cross-check: the persisted action_digest MUST match the pause frame's actionDigest (binds the
  // EXACT paused action). A mismatch would be a real integrity problem.
  if (row.action_digest && outcome.actionDigest && row.action_digest !== outcome.actionDigest) {
    die(
      "digest-mismatch",
      `the pause-frame actionDigest (${outcome.actionDigest}) does NOT match the persisted row's ` +
        `action_digest (${row.action_digest}). These must bind the same action — investigate.`,
    );
  }

  console.log(
    "\n[dispatch-mutating] OPERATOR NEXT STEPS:\n" +
      `  1. friday-operator-approve sign --key <operator.key> --request ${pendingRequestPath} > ${signedApprovalPath}\n` +
      `  2. node ${path.resolve(process.argv[1])} --mode resume --run-id ${outcome.runId} ` +
      `--approval ${signedApprovalPath}\n` +
      "  3. verify the proof-file write + a fresh token_ledger row for the runId.\n" +
      "[dispatch-mutating] (this PAUSE is a real S6-in-product proof, but does NOT move the v1 gate " +
      "until the operator signs + the broader gate passes.)",
  );
}

// ─── MODE 2: resume (positive — relays the operator-signed approval) ───
async function modeResume(args, createFactory, resolverMod) {
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : undefined;
  const approvalPath = typeof args.approval === "string" ? args.approval : undefined;
  if (!runId) die("usage", "--run-id <id> is required for resume");
  if (!approvalPath) die("usage", "--approval <signed-approval.json> is required for resume");
  if (!fs.existsSync(approvalPath)) die("usage", `signed approval file not found: ${approvalPath}`);

  const secret = resolveClientSecretOrDie(resolverMod);
  const client = makeClient(createFactory, secret);

  // VERBATIM raw file bytes as a Uint8Array — NO base64, NO re-parse. The sealed client relays the
  // blob as-is (Array.from internally; INV-1 pure courier). The server does serde_json::from_str /
  // verifies the Ed25519 signature over the canonical bytes.
  const approvalBytes = new Uint8Array(fs.readFileSync(approvalPath));
  console.log(
    `[resume] sealed-WS → ${DEFAULT_HOST}:${DEFAULT_PORT} runId=${runId} ` +
      `(opaqueSignedBlob ${approvalBytes.length}B, relayed verbatim — never logged)`,
  );

  let result;
  try {
    result = await client.resumeWithApproval({ runId, opaqueSignedBlob: approvalBytes });
  } catch (err) {
    die(
      "network",
      `resumeWithApproval failed to settle: ${err?.message ?? String(err)}. A close-before-result is ` +
        "the fail-closed path (forged/replayed/expired blob, unprovisioned verify key, or the resolved " +
        "client pubkey is not the enrolled peer). EXPORT the canonical FRIDAY_MASTER_KEY and confirm the " +
        "signature matches the paused action_digest, then retry.",
    );
  }

  console.log(
    `[resume] op=${result.op} accepted=${result.accepted} status=${result.status}` +
      (result.auditRef !== undefined ? ` auditRef=${result.auditRef}` : ""),
  );
  if (result.accepted === true) {
    console.log(
      "[resume] MUTATION RESUMED — verify the proof-file + a fresh token_ledger row for the runId:",
    );
    const ledger = tokenLedgerRowForRun(runId);
    if (ledger.dbMissing) {
      console.log(`[resume]   token_ledger check SKIPPED — rust-hub.sqlite not at ${ledger.db}`);
    } else if (ledger.error) {
      console.log(`[resume]   token_ledger check ERROR: ${ledger.error}`);
    } else if (ledger.rows.length > 0) {
      console.log(`[resume]   token_ledger ROW(S) for runId:\n${JSON.stringify(ledger.rows, null, 2)}`);
    } else {
      console.log(
        `[resume]   NO token_ledger row yet for runId=${runId} (the mutation may still be in flight; ` +
          `re-query: SELECT * FROM token_ledger WHERE run_id='${runId}';).`,
      );
    }
  } else {
    console.log(
      "[resume] REFUSED (fail-closed): the server rejected the approval (forged/replayed/expired " +
        "signature, unprovisioned verify key, owner mismatch, or a non-paused/cancelled run). No " +
        "mutation executed.",
    );
  }
}

// ─── MODE 3: resume-negative (adversarial — absent / forged signature MUST NOT execute) ───
async function modeResumeNegative(args, createFactory, resolverMod) {
  const runId = typeof args["run-id"] === "string" ? args["run-id"] : undefined;
  const kind = typeof args.kind === "string" ? args.kind : undefined;
  if (!runId) die("usage", "--run-id <id> is required for resume-negative");
  if (kind !== "empty" && kind !== "wrongkey") {
    die("usage", "--kind must be one of: empty | wrongkey");
  }

  const secret = resolveClientSecretOrDie(resolverMod);
  const client = makeClient(createFactory, secret);

  let blob;
  if (kind === "empty") {
    blob = new Uint8Array(0);
    console.log(`[resume-negative:empty] runId=${runId} sending an EMPTY blob (expect a refusal).`);
  } else {
    const approvalPath = typeof args.approval === "string" ? args.approval : undefined;
    if (!approvalPath) {
      die(
        "usage",
        "--kind wrongkey requires --approval <wrongkey-signed.json> (a real Ed25519 signature from a " +
          "THROWAWAY key, NOT the operator's). The point: a forged signature MUST NOT execute.",
      );
    }
    if (!fs.existsSync(approvalPath)) die("usage", `wrongkey approval file not found: ${approvalPath}`);
    blob = new Uint8Array(fs.readFileSync(approvalPath));
    console.log(
      `[resume-negative:wrongkey] runId=${runId} sending a FORGED-key blob ` +
        `(${blob.length}B, never logged) — expect accepted===false or a closed session.`,
    );
  }

  let result;
  try {
    result = await client.resumeWithApproval({ runId, opaqueSignedBlob: blob });
  } catch (err) {
    // EXPECTED negative pass for BOTH kinds:
    //   • empty   : the shipped client guards length===0 and REJECTS before opening a socket — a
    //               CLIENT-SIDE courier refusal (it won't relay emptiness), NOT a crash, NOT server
    //               signature verification.
    //   • wrongkey: the server may CLOSE the session for a bad blob ⇒ the client rejects
    //               "closed before a result". Also a valid fail-closed.
    console.log(
      `[resume-negative:${kind}] PASS — refused (fail-closed) via rejection: ` +
        `${err?.message ?? String(err)}`,
    );
    if (kind === "empty") {
      console.log(
        "[resume-negative:empty]   (this is the client-side courier guard: an empty blob carries no " +
          "signature, so it is refused before any socket is opened — the absent signature never reached, " +
          "and never could have executed, the server.)",
      );
    }
    return;
  }

  // The relay returned an AgentRunControlResult (the server processed the blob and refused it).
  console.log(
    `[resume-negative:${kind}] op=${result.op} accepted=${result.accepted} status=${result.status}` +
      (result.auditRef !== undefined ? ` auditRef=${result.auditRef}` : ""),
  );
  if (result.accepted === false) {
    console.log(
      `[resume-negative:${kind}] PASS — REFUSED (fail-closed): the server rejected the ` +
        `${kind === "empty" ? "absent" : "forged"} signature. No mutation executed.`,
    );
    return;
  }
  // accepted===true ⇒ a forged/absent signature EXECUTED. This is a SECURITY ALARM — fail loud.
  die(
    "forged-executed",
    `ALARM: resume-negative kind=${kind} was ACCEPTED (accepted===true) — an ${kind === "empty" ? "absent" : "forged"} ` +
      "signature EXECUTED a mutation. The gate did NOT fail closed. This is a real security defect — " +
      "STOP and surface it to the operator.",
    `full result:\n${JSON.stringify(result, null, 2)}`,
  );
}

// ─── main ───
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  if (!mode || mode === true) {
    console.error(
      "usage: node friday-s6-transport-a-driver.mjs --mode <m> [opts]\n" +
        "  --mode dispatch-mutating [--artifact-dir <dir>] [--proof-file <path>]\n" +
        "                            [--pending-request-file <path>] [--signed-approval-file <path>]\n" +
        "  --mode resume            --run-id <id> --approval <signed-approval.json>\n" +
        "  --mode resume-negative   --run-id <id> --kind <empty|wrongkey> [--approval <wrongkey-signed.json>]\n" +
        "env: FRIDAY_MASTER_KEY (exported by the caller, sourced from the hub plist — the secret\n" +
        "       resolver's getMasterKey reads it; this script NEVER handles it directly),\n" +
        "     FRIDAY_HUB_AGENT_RUN_DB_PATH (rust-hub.sqlite, def state dir),\n" +
        `     FRIDAY_S6_ARTIFACT_DIR (default ${DEFAULT_ARTIFACT_DIR}),\n` +
        `     target hub sealed-WS = ${DEFAULT_HOST}:${DEFAULT_PORT}`,
    );
    process.exit(1);
  }

  const createFactory = await loadSealedClientFactory();
  const resolverMod = await loadSecretResolver();

  if (mode === "dispatch-mutating") {
    await modeDispatchMutating(args, createFactory, resolverMod);
  } else if (mode === "resume") {
    await modeResume(args, createFactory, resolverMod);
  } else if (mode === "resume-negative") {
    await modeResumeNegative(args, createFactory, resolverMod);
  } else {
    die("usage", `unknown --mode ${mode}`);
  }
}

main().catch((err) => die("unhandled", err?.message ?? String(err)));
