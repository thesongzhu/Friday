import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

import * as wsModule from "ws";

import { FridayDomainError } from "#errors";

import {
  agree,
  buildAuthProof,
  decodeSealed,
  deviceKeypairFromSecret,
  encodeSealed,
  open,
  seal,
  X25519_PUBKEY_LEN,
} from "./friday-rust-hub-agent-run-ws-sealed-crypto.js";

/**
 * WIRED into the production read-only Rust agent-run route, gated DEFAULT-OFF — TS->Rust
 * AGENT-RUN SEALED WS CLIENT for the executeRun-replacement (sub-slice B1) — the REAL
 * sealed-protocol client half. As of B1-compose this client is constructed by the sealed-client
 * service adapter that `composeRustReadOnlyAgentRun` drives on the live `routeStartRun` path —
 * so the prior "no production route consumes this" claim is no longer true. It does NOT run in
 * default prod: the route branch is gated DEFAULT-OFF behind `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST`
 * (operator cutover pending) and only fires for a qualifying read-only run.
 *
 * ## What this is (and how it differs from the S-D stub)
 * The S-D client (`friday-rust-hub-agent-run-ws-client.ts`) is a DARK STUB: it opens a plain
 * `new WebSocket(url)` and sends the INNER message JSON UNSEALED. It does NOT speak the
 * server's protocol. THIS client speaks the server's REAL sealed ECDH protocol
 * (`hub_agent_run_server.rs` + `friday-crypto` + `friday-transport`):
 *   1. `net.connect` → a RAW TCP socket (NOT `new WebSocket(url)`, whose HTTP upgrade fires
 *      immediately and would corrupt the raw preamble).
 *   2. RAW length-prefixed preamble frames BEFORE the WS upgrade:
 *        write client X25519 pubkey (32B) → read server pubkey (32B) → read session_nonce (64B).
 *   3. A MANUAL RFC6455 client upgrade over the SAME socket, then `ws`'s `Sender`/`Receiver`
 *      drive masked WebSocket frames (tungstenite rejects UNMASKED client frames).
 *   4. `session_key = HKDF(X25519(client_priv, server_pub))`.
 *   5. Send an `AgentRunRequest` Envelope sealed under the session key (XChaCha20-Poly1305),
 *      with a per-request `auth_proof` sealed over `AUTH_CHALLENGE || session_nonce`.
 *   6. (leg-A decouple, #655 Part 4) SETTLE on the FIRST inbound sealed envelope — the refs-only
 *      `AgentRunResult` (status + answer fingerprint + A1 counts) — ALONE. The client no longer
 *      awaits the SECOND owner-sealed body frame: the authoritative answer body is sourced by
 *      compose from the owner-gated DB readback, not from the WS frame. The server still emits the
 *      body frame after the refs frame, and still persists the body to the Hub DB BEFORE emitting
 *      refs (so the readback always finds a committed row when refs arrive — no not_found race);
 *      this client simply settles on refs and tears down without draining the body frame.
 *
 * ## Threat model (HONEST — loopback only)
 * The server binds 127.0.0.1 only; this client connects only to loopback. The client
 * INTENTIONALLY does NOT authenticate the server (NO server-pubkey pinning) — acceptable on
 * loopback because there is no relay to substitute keys. The load-bearing properties are
 * SERVER-side and are NOT confidentiality: (1) peer-pubkey allowlist (SecureStore), (2)
 * owner-allowlist, (3) per-handshake nonce anti-replay. This client is the client half of
 * that handshake; it does not defend confidentiality against a non-existent relay.
 *
 * ## Fail-closed contract (the load-bearing invariant)
 * Any non-clean settle — connect error, socket close before a result, bounded timeout, a
 * preamble of the wrong width, an envelope that fails to open/parse, a missing required ref —
 * throws the SAME 503-shaped {@link FridayDomainError}. A non-allowlisted / forged client
 * pubkey (the server establishes NO session and sends NOTHING) and a non-allowlisted forwarded
 * principal (the server ends the session with no result) BOTH surface as this fail-closed
 * error — never a hang, never a partial success, never a surfaced body on an error.
 *
 * ## Truth labels
 * - Consumed by the production route handler, gated DEFAULT-OFF: the sealed-client service
 *   adapter constructs this client and `composeRustReadOnlyAgentRun` drives its `dispatchRun`
 *   on the live `routeStartRun` path, so it IS reached by a production route (NOT "no production
 *   route consumes it"). It stays inert in default prod until the operator flips
 *   `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (cutover pending).
 * - `rust_wired` ceiling: confers NO v1 GO. Narrow (read-only); not a full executeRun
 *   replacement until the operator cutover.
 */

/**
 * S-C session AAD — `SESSION_AAD` in `hub_agent_run_server.rs`. Every envelope on the session
 * is sealed under this AAD. Byte-identical to the Rust constant (asserted in the KATs).
 */
const SESSION_AAD = Buffer.from("friday:execrun:ws:s-c:agent-run-session:aad:v1", "utf8");
/**
 * S-C auth challenge — `AUTH_CHALLENGE` in `hub_agent_run_server.rs`. The peer seals
 * `AUTH_CHALLENGE || session_nonce` as its possession-of-session proof.
 */
const AUTH_CHALLENGE = Buffer.from("friday:execrun:ws:s-c:authed-run:challenge:v1", "utf8");

/** Protocol schema version — `CURRENT_SCHEMA_VERSION` in friday-protocol (must be 12). */
const SCHEMA_VERSION = 12;
/** The expected width of the server's per-handshake session nonce (used VERBATIM). */
const SESSION_NONCE_LEN = 64;
/** Max length-prefixed preamble frame (defensive; mirrors transport `MAX_FRAME`). */
const MAX_FRAME = 1 << 20;
/** The RFC6455 GUID used to compute `Sec-WebSocket-Accept`. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const DEFAULT_TIMEOUT_MS = 30_000;

// `@types/ws` types only the default `WebSocket` export (`export = WebSocket`); it does NOT type
// the low-level `Sender`/`Receiver` classes (which `ws` DOES export at runtime). We need those for
// socket adoption AFTER the raw preamble (a plain `new WebSocket(url)` would fire its HTTP upgrade
// immediately and corrupt the preamble). Pull them off the module at runtime with a precise, minimal
// local typing of exactly the surface we use.
interface WsSender {
  send(data: Buffer, options: { binary: boolean; mask: boolean; fin: boolean }): void;
}
interface WsReceiver {
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "conclude" | "error", listener: (...args: unknown[]) => void): void;
  write(chunk: Buffer): void;
  removeAllListeners(): void;
}
interface WsRuntime {
  Sender: new (socket: Socket, extensions: undefined, generateMask: () => Buffer) => WsSender;
  Receiver: new (options: { isServer: boolean; binaryType: string; skipUTF8Validation: boolean }) => WsReceiver;
}
// `@types/ws` declares `export = WebSocket` and types the namespace's extra exports loosely; the
// `Sender`/`Receiver` runtime classes are reached off the module namespace via this minimal cast.
// A namespace import bundles correctly in BOTH esm and cjs (unlike `createRequire(import.meta.url)`,
// which esbuild stubs to `undefined` in a cjs bundle).
const wsRuntime = wsModule as unknown as WsRuntime;

/** A dispatched agent-run, TS-side (camelCase; mapped to the snake_case wire fields). */
export interface FridayRustHubAgentRunSealedRequest {
  /** Caller-chosen idempotency/run identifier. */
  readonly runId: string;
  /** The agent task/prompt to run on the Rust loop. */
  readonly task: string;
  /** The TS-token-resolved principal the trusted peer forwards (allowlist-checked by the server). */
  readonly forwardedPrincipal: string;
  /**
   * (A2a Phase 1) The session key for a MULTI-TURN (sessioned) read-only chat run. When
   * NON-EMPTY it is forwarded on the wire as `session_id`, which makes the Rust server's
   * dispatch arm branch into the sessioned loop (history reload/append). ABSENT or BLANK ⇒
   * the `session_id` field is OMITTED from the wire entirely, so the envelope is
   * BYTE-IDENTICAL to the pre-A2a sessionless request and routes through the unchanged
   * sessionless dispatch path. **SECURITY: this only SELECTS the session row; the run's
   * owner is the authenticated `forwardedPrincipal`, verified server-side — never this key.**
   */
  readonly sessionKey?: string;
  /**
   * (A1 run-controls) Per-run CONSTRAINTS the trusted peer asserts; the Rust server COMPOSES
   * them onto the run's `RunPolicy` (read-only / disabled-tools / max-turns) so they can ONLY
   * ever TIGHTEN a run (a restriction, never a grant). ABSENT (`undefined`) ⇒ the `constraints`
   * field is OMITTED from the wire entirely, so the envelope is BYTE-IDENTICAL to the pre-A1
   * request and the server applies NO override (boot policy unchanged). DARK + DEPLOY-GO-gated:
   * the server APPLIES these only behind its default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`
   * flag, so emitting them changes no live behavior until that flag is on. Mirrors the
   * `sessionKey` additive-optional discipline.
   */
  readonly constraints?: FridayRustHubAgentRunConstraints;
  /**
   * (NS45-PR1 / M-4) The FIRST-CLASS Mission handle this run participates in. A real handle
   * `{fridayConversationId, missionId, workItemId}` (from the NS-5 `MissionIntakeResult`) is
   * emitted on the wire as the snake_case `mission_context` block, which lets the Rust dispatch
   * resolve the Mission via `MissionContextLookup::by_mission_work_item` and route through the
   * mission-bound run path (`run_authed_agent_loop_mission_bound`). ABSENT (`undefined`) ⇒ the
   * `mission_context` field is OMITTED from the wire entirely, so the envelope is BYTE-IDENTICAL
   * to the pre-NS45 request and routes through the UNCHANGED unbound dispatch path. DARK + gated:
   * the server walks the bound path only behind its default-off `FRIDAY_MISSION_BOUND_RUN` flag,
   * so emitting the handle changes no live behavior until that flag is on. **SECURITY: this only
   * SELECTS which Mission/WorkItem the run binds to; it confers NO authority — the run's bound
   * owner is the authenticated `forwardedPrincipal`, gated server-side, never this handle.**
   * Mirrors the `sessionKey`/`constraints` additive-optional discipline.
   */
  readonly missionContext?: FridayRustHubAgentRunMissionContext;
}

/**
 * (NS45-PR1 / M-4) The TS-side first-class Mission handle (camelCase; mapped to the snake_case
 * `MissionWorkItemContextWire` the Rust server decodes). All three fields are REQUIRED on the wire
 * struct (`friday_protocol::MissionWorkItemContextWire` — `friday_conversation_id` / `mission_id` /
 * `work_item_id`, none `Option`), so this TS shape REQUIRES all three too (no collapse-to-absent on
 * an individual field). Presence of the whole object is what is optional, mirroring `sessionKey`.
 */
export interface FridayRustHubAgentRunMissionContext {
  /** The canonical Friday conversation this run belongs to (Rust `friday_conversation_id`). */
  readonly fridayConversationId: string;
  /** The Mission this run binds to (Rust `mission_id`). */
  readonly missionId: string;
  /** The WorkItem this run advances (Rust `work_item_id`). */
  readonly workItemId: string;
}

/**
 * (A1 run-controls) The TS-side per-run constraint shape (camelCase; mapped to the snake_case
 * `AgentRunConstraintsWire`). Every field is OPTIONAL and a RESTRICTION only — there is no field
 * that can WIDEN a run. An all-absent object serializes to no wire field at all (see the emit
 * site), preserving byte-identity.
 */
export interface FridayRustHubAgentRunConstraints {
  /** When `true`, the run is read-only: a mutating tool is blocked before execution. */
  readonly readOnly?: boolean;
  /** Tools disabled for THIS run (the TS oracle's `disabledTools`); a restriction, never a grant. */
  readonly disabledTools?: readonly string[];
  /** A per-run `max_turns` cap; the server takes `min(runtime_default, this)` (can only LOWER). */
  readonly maxTurns?: number;
}

/**
 * The result of a sealed dispatch: the REFS-ONLY receipt (status + answer fingerprint +
 * A1 counts). (leg-A decouple, #655 Part 4) The dispatch now SETTLES on the refs envelope
 * ALONE — it no longer awaits or surfaces the owner-sealed body frame. The authoritative
 * answer body is sourced by compose from the owner-gated DB readback
 * (`FridayRustHubRunAnswerReadbackService.readAnswer`), never from the WS body frame, so the
 * client carries NO `body` field. (The Rust server still PERSISTS the body to the Hub DB and
 * still emits the body frame after the refs frame; this client simply does not wait for it.)
 */
export interface FridayRustHubAgentRunSealedResult {
  readonly truthLabel: "rust_wired";
  /** The run this result terminates (echoes the request run id). */
  readonly runId: string;
  /** Coarse loop-status label (e.g. `delivered_to_authenticated_owner` / denied / no_answer). */
  readonly status: string;
  /** sha256 of the answer body — a REF — when an answer exists. */
  readonly answerSha256?: string;
  /** Byte length of the answer body — a measure — when an answer exists. */
  readonly answerLen?: number;
  /**
   * (A1 transport-truth) REFS-surface run METADATA: the model-turn COUNT the loop took.
   * A COUNT only — never a turn body/message. `undefined` when the server omits it (an OLD
   * server that predates A1, or a non-delivered outcome) — never fabricated.
   */
  readonly turns?: number;
  /**
   * (A1) REFS-surface run METADATA: the count of tools that actually executed. A COUNT only
   * — never a tool name/args. `undefined` when absent (old server / non-delivered).
   */
  readonly executedTools?: number;
  /**
   * (A1) REFS-surface run METADATA: prompt-token total, when known. A COUNT only. Wire-shape
   * reserved; population is DEFERRED server-side (the per-turn usage is billed to the Rust
   * token_ledger, not carried on the loop outcome), so this is `undefined` for now.
   */
  readonly promptTokens?: number;
  /** (A1) REFS-surface run METADATA: completion-token total, when known. DEFERRED ⇒ `undefined`. */
  readonly completionTokens?: number;
}

/**
 * (A3 courier) The PAUSED dispatch outcome: the Rust server's loop gate PAUSED a mutating tool on
 * the run and emitted a `Message::AgentRunPaused` frame instead of an `AgentRunResult`. This settles
 * `dispatchRun` with a NEW non-result outcome carrying REFS ONLY (the single-use approval nonce + the
 * action digest + a coarse body-free summary) so the operator can be prompted to sign (out-of-band)
 * and the courier can later relay an `AgentRunResume`.
 *
 * **INV-1 (no signing material):** this carries NO signing key, NO private material, and NO mutation
 * body/args — only the references the operator's OWN signer binds an Ed25519 approval over. TS
 * inspects nothing inside the eventual signed blob; it is a pure courier.
 *
 * **Wire mapping (matches the merged `AgentRunPaused` EXACTLY — `friday-protocol::Message`):**
 *   - `approvalId` ← the wire `nonce` (the `pending_approval_request.approval_id` the operator signs
 *     over; the A2 design doc §2.3 names it "the approval_id nonce"). A nonce, not a secret.
 *   - `actionDigest` ← the wire `action_digest` (hex SHA-256 of `canonical_action_bytes` — binds the
 *     EXACT paused action, transitively principal/scope/params). A fingerprint, never a body.
 *   - `ownerSealedSummary` ← the wire `summary` (a coarse, body-free action-verb summary). Optional.
 *   - `expiresAt`: the merged `AgentRunPaused` does NOT carry an expiry field, so this is parsed
 *     DEFENSIVELY (forward-compatible) and is `undefined` today — never fabricated. (The approval's
 *     real expiry is enforced server-side by `resume_with_approval`, not surfaced on this refs frame.)
 *
 * The `outcome: "paused"` discriminant lets the consumer (compose) tell a paused settle apart from a
 * normal `AgentRunResult` WITHOUT touching the existing result shape (which carries no `outcome` key).
 */
export interface FridayRustHubAgentRunPausedOutcome {
  /** Discriminant: distinguishes a paused settle from a normal `AgentRunResult` (no `outcome` key). */
  readonly outcome: "paused";
  readonly truthLabel: "rust_wired";
  /** The run that paused (echoes the request run id). */
  readonly runId: string;
  /** The single-use approval nonce the operator signs over (wire `nonce`). A nonce, never a secret. */
  readonly approvalId: string;
  /** Hex SHA-256 of the canonical action bytes (wire `action_digest`). A fingerprint, never a body. */
  readonly actionDigest: string;
  /** A coarse, body-free summary of WHAT paused (wire `summary`). Never the tool args/params/body. */
  readonly ownerSealedSummary?: string;
  /** Approval expiry (epoch ms), when the wire carries one. DEFERRED — the merged wire omits it ⇒ `undefined`. */
  readonly expiresAt?: number;
}

/**
 * (A3 courier) The discriminated outcome of a sealed dispatch: EITHER the refs-only `AgentRunResult`
 * (the {@link FridayRustHubAgentRunSealedResult}, today's ONLY outcome — carries NO `outcome` key so
 * the legacy `toEqual` shape is byte-identical) OR — ONLY when the courier's default-off run-control
 * flag is on AND the server emits an `AgentRunPaused` — the {@link FridayRustHubAgentRunPausedOutcome}.
 * With the flag OFF an `AgentRunPaused` is an unknown inbound and stays fail-closed (503), so the
 * union NARROWS to exactly `FridayRustHubAgentRunSealedResult` and the type is byte-identical to today.
 */
export type FridayRustHubAgentRunSealedDispatchOutcome =
  | FridayRustHubAgentRunSealedResult
  | FridayRustHubAgentRunPausedOutcome;

/**
 * (A3 courier) The result of relaying an operator-signed approval to RESUME a paused run — the
 * REFS-ONLY `Message::AgentRunControlResult` the server returns. Carries the coarse
 * `op`/`accepted`/`status` + an optional soft `auditRef` — NEVER the mutation body, args, or answer.
 * `accepted=false` is a fail-closed refusal (forged/replayed/expired blob / unprovisioned verify key
 * / storage error); the `status` says why at a coarse grain.
 */
export interface FridayRustHubAgentRunResumeResult {
  readonly truthLabel: "rust_wired";
  /** The run this control op terminates (echoes the request run id). */
  readonly runId: string;
  /** The control op (`resume`). */
  readonly op: string;
  /** Whether the op was accepted (`true`) or refused fail-closed (`false`). */
  readonly accepted: boolean;
  /** Coarse, body-free outcome label. */
  readonly status: string;
  /** Soft link to the hash-chained audit receipt, when one was written. A ref, never a body. */
  readonly auditRef?: string;
}

export interface CreateFridayRustHubAgentRunSealedClientOptions {
  /** Loopback host for the Rust agent-run WS server. Defaults to `127.0.0.1`. */
  readonly host?: string;
  /** Port the Rust agent-run WS server listens on. */
  readonly port: number;
  /**
   * The client's 32-byte X25519 SECRET scalar. The matching pubkey MUST be enrolled in the
   * server's SecureStore peer-allowlist or the server establishes NO session (fail-closed).
   * Held in-process only; never logged.
   */
  readonly clientSecret: Uint8Array;
  /** Bounded await (ms) for the dispatch to settle before failing closed. */
  readonly timeoutMs?: number;
  /**
   * (A3 courier) Run-control flag, DEFAULT-OFF. Mirrors the Phase-2 server's default-off
   * `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag posture EXACTLY. When `false`/absent (the default):
   *   - an inbound `AgentRunPaused` is an UNKNOWN message ⇒ fail-closed (503), byte-identical to today;
   *   - {@link FridayRustHubAgentRunSealedClient.resumeWithApproval} is fail-closed (the courier
   *     relays nothing).
   * When `true`, the new courier behavior is enabled: an `AgentRunPaused` settles `dispatchRun` with
   * the {@link FridayRustHubAgentRunPausedOutcome}, and `resumeWithApproval` relays the opaque blob.
   * The success (`AgentRunResult`) path and the trailing unknown→fail-closed are UNTOUCHED by this
   * flag — so flag-off behavior is exactly today's.
   */
  readonly agentRunControlViaRust?: boolean;
}

export interface FridayRustHubAgentRunSealedClient {
  /**
   * Dispatch one agent-run over a sealed session and await its REFS-ONLY result. Connects, runs
   * the preamble + WS upgrade, seals the request, reads the FIRST (refs) result envelope, then
   * settles and closes — it does NOT await the owner-sealed body frame (leg-A decouple, #655 Part
   * 4; compose sources the body from the owner-gated DB readback). Fails closed (503) on any
   * non-clean settle, including a session that closes BEFORE any refs arrive.
   *
   * (A3 courier) Returns the discriminated {@link FridayRustHubAgentRunSealedDispatchOutcome}: a
   * normal refs-only `AgentRunResult` OR — ONLY when `agentRunControlViaRust` is on AND the server
   * emits an `AgentRunPaused` — a {@link FridayRustHubAgentRunPausedOutcome}. With the flag OFF an
   * `AgentRunPaused` is an unknown inbound ⇒ fail-closed (503), so the outcome is byte-identical to
   * today's `FridayRustHubAgentRunSealedResult`.
   */
  dispatchRun(
    request: FridayRustHubAgentRunSealedRequest,
  ): Promise<FridayRustHubAgentRunSealedDispatchOutcome>;
  /**
   * (A3 courier) Relay an operator's out-of-band Ed25519-signed approval to RESUME a paused run.
   * Opens a FRESH sealed session bound to the SAME credentials (`clientSecret`) and the SAME
   * `run_id` (the merged `AgentRunResume` is self-authenticating via the blob's nonce/digest — it
   * carries no `auth_proof`/`forwarded_principal`; the A2 design §2.1 blesses reconnect because the
   * NONCE is the single-use authority, not the socket), sends `Message::AgentRunResume {run_id,
   * signed_blob}`, and awaits the refs-only `AgentRunControlResult`.
   *
   * **INV-1 (pure courier):** `opaqueSignedBlob` is treated as OPAQUE bytes — TS inspects NOTHING
   * inside it, mints no signature, holds no signing key, and authors none of the approval's
   * semantics. The server decodes + verifies + consumes the nonce + executes the ONE mutation.
   *
   * Fail-closed (503) when the run-control flag is OFF (the courier relays nothing) or on any
   * non-clean settle. A server refusal (`accepted=false`) is a SUCCESSFUL relay of a refusal
   * outcome, not a transport failure — it resolves with `{accepted:false, status}`.
   */
  resumeWithApproval(
    request: FridayRustHubAgentRunResumeRequest,
  ): Promise<FridayRustHubAgentRunResumeResult>;
  /**
   * (A1 run-controls) OWNER-auth reject of ONE pending tool approval on a paused run —
   * `Message::AgentRunReject`. Unlike `resumeWithApproval`, this does not carry an operator
   * signature blob; it carries the same sealed-session possession proof as dispatch/cancel and the
   * server checks the forwarded principal against the pending approval owner before writing
   * `pending_approval_request.status='rejected'`.
   */
  rejectApproval(
    request: FridayRustHubAgentRunRejectRequest,
  ): Promise<FridayRustHubAgentRunResumeResult>;
  /**
   * (Lane B) Resolve/create a Mission from one surface input over a sealed session —
   * `Message::MissionIntakeRequest`. PURE Hub mutation (no model/provider call). Opens a fresh
   * sealed session (the channel auth), sends the intake envelope, and awaits the FIRST
   * `MissionIntakeResult`. Fails closed (503) on any non-clean settle or any other inbound
   * (including the server's `Error` envelope), never a partial.
   */
  intakeMission(
    request: FridayRustHubMissionIntakeRequest,
  ): Promise<FridayRustHubMissionIntakeResult>;
  /**
   * (Lane B) Advance ONE Mission's lifecycle over a sealed session —
   * `Message::MissionLifecycleRequest`. PURE Hub mutation. Awaits the FIRST
   * `MissionLifecycleResult`; fails closed on any other inbound. A `status` here is a Mission-
   * management fact, NOT provider completion unless `proofRef` says so.
   */
  transitionMission(
    request: FridayRustHubMissionLifecycleRequest,
  ): Promise<FridayRustHubMissionLifecycleResult>;
  /**
   * (Lane B) Advance ONE WorkItem's status over a sealed session —
   * `Message::WorkItemStatusRequest`. PURE Hub mutation. Awaits the FIRST `WorkItemStatusResult`;
   * fails closed on any other inbound. **Proof-on-completion is enforced SERVER-side:** a
   * `completed_with_proof` target with an empty/absent `proofReceipt` is rejected as a typed
   * `Error` ⇒ this fails closed (never a fake-ready result).
   */
  transitionWorkItem(
    request: FridayRustHubWorkItemStatusRequest,
  ): Promise<FridayRustHubWorkItemStatusResult>;
  /**
   * (D20 W1-S3) Apply one OWNER route-decision veto/override over a sealed session —
   * `Message::RouteDecisionControlRequest`. PURE Hub mutation. Awaits the FIRST
   * `RouteDecisionControlResult`; fails closed on any other inbound. The storage lifecycle hook
   * makes this control load-bearing at `ReadyToDispatch -> Dispatched`; this is not a decorative
   * UI-only field.
   */
  controlRouteDecision(
    request: FridayRustHubRouteDecisionControlRequest,
  ): Promise<FridayRustHubRouteDecisionControlResult>;
  /**
   * (Lane M) Apply the OWNER's explicit confirm/reject to ONE pending memory candidate over a
   * sealed session — `Message::MemoryDecisionRequest`. PURE Hub `&Db` mutation (NO model/provider
   * call). Awaits the FIRST `MemoryDecisionResult`; fails closed on any other inbound (including the
   * server's `Error` envelope). The `status`/`recallable` here are the Hub's honest outcome — a
   * `status:"blocked"` (scope mismatch / unknown / terminal / invalid decision) is a SUCCESSFUL
   * round-trip of a refusal, NOT a transport failure, and surfaces as a parsed result.
   */
  decideMemory(
    request: FridayRustHubMemoryDecisionRequest,
  ): Promise<FridayRustHubMemoryDecisionResult>;
  /**
   * (A1) Apply the OWNER's explicit confirm/reject to ONE pending run-outcome learning candidate over
   * a sealed session — `Message::RunOutcomeLearningDecisionRequest`. PURE Hub mutation; no
   * provider/model call and no answer body. `status:"blocked"` is an honest refusal receipt.
   */
  decideRunOutcomeLearning(
    request: FridayRustHubRunOutcomeLearningDecisionRequest,
  ): Promise<FridayRustHubRunOutcomeLearningDecisionResult>;
  /**
   * (CORE-A CR-3) Create/ensure ONE agent-session row over a sealed session —
   * `Message::SessionCreateRequest`. PURE Hub `&Db` mutation (no model/provider call). Opens a fresh
   * sealed session (the channel auth), sends the create envelope, and awaits the FIRST refs-only
   * `SessionCreateResult`. Fails closed (503) on any non-clean settle or any other inbound (including
   * the server's `Error` envelope — which is how an owner mismatch surfaces).
   */
  createSession(
    request: FridayRustHubSessionCreateRequest,
  ): Promise<FridayRustHubSessionCreateResult>;
  /**
   * (CORE-A CR-3) Append ONE conversation message to an existing session over a sealed session —
   * `Message::SessionMessageAppendRequest`. PURE Hub `&Db` mutation. OWNER-GATED server-side. Awaits
   * the FIRST refs-only `SessionMessageAppendResult`; fails closed (503) on any other inbound
   * (including the server's `Error` — the owner-mismatch refusal). The body rides the sealed session.
   */
  appendSessionMessage(
    request: FridayRustHubSessionMessageAppendRequest,
  ): Promise<FridayRustHubSessionMessageAppendResult>;
}

/** (A3 courier) A resume relay: the run to resume + the operator's OPAQUE signed approval blob. */
export interface FridayRustHubAgentRunResumeRequest {
  /** The paused run to resume (echoes the paused `run_id`). */
  readonly runId: string;
  /**
   * The operator's canonical Ed25519-signed approval bytes (the S6c CLI output). OPAQUE to the
   * courier — relayed VERBATIM as the wire `signed_blob`; TS inspects/derives/authors NOTHING.
   */
  readonly opaqueSignedBlob: Uint8Array;
}

/** (A1 run-controls) Reject ONE pending approval by owner-auth, without signing or resuming it. */
export interface FridayRustHubAgentRunRejectRequest {
  /** The paused run carrying the pending approval. */
  readonly runId: string;
  /** The pending approval nonce to reject (`AgentRunPaused.nonce` / `approval_id`). */
  readonly approvalId: string;
  /** The TS-token-resolved principal the trusted peer forwards; server verifies ownership. */
  readonly forwardedPrincipal: string;
}

// ─── (Lane B) Mission-spine organic mutation requests/results ───────────────
//
// The keystone (#741) wired three Hub-owned, PURE-`&Db` mutations into the live
// `hub_agent_run_server` behind a SERVER flag (`FRIDAY_MISSION_INTAKE` for intake,
// `FRIDAY_MISSION_SPINE_DISPATCH` for lifecycle/work-item), each replying with the
// matching `*Result` (or a typed `Error` on an illegal hop / missing entity /
// proofless completion). These wire shapes carry NO per-request `auth_proof`/
// `forwarded_principal` — the sealed session IS the channel auth (single-peer/
// single-owner SERVER invariant), mirroring the merged mission-intake arm. These
// methods build the EXACT `friday-protocol` wire shapes and settle on the FIRST
// matching Result; ANY other inbound (including the server's `Error` envelope) is
// a typed fail-closed (503), never a partial.

/**
 * NEW-2 organic provenance: a signed operator attestation that marks a Codex organic spawn.
 * This is TS-side provenance only; it is intentionally not forwarded on the Rust mission-intake
 * wire. The Rust result still produces the mission/work-item handle, while the TS auto-dispatch
 * driver stamps this verified provenance onto the agent-run row it starts.
 */
export interface FridayOrganicRunProvenance {
  readonly organic: true;
  readonly principal: string;
  readonly source: "operator_signature";
  readonly attestationRef: string;
  readonly publicKeyId?: string;
  readonly taskSha256: string;
  readonly issuedAt: string;
  readonly route: string;
}

/** (Lane B) A Mission intake/preflight request — `MissionIntakeRequestWire`. */
export interface FridayRustHubMissionIntakeRequest {
  readonly fridayConversationId: string;
  readonly ownerPrincipal: string;
  readonly surfaceThreadId: string;
  readonly surfaceKind: string;
  readonly deliveryRoute: string;
  readonly visibilityPolicy: string;
  readonly missionId: string;
  readonly workItemId: string;
  readonly title: string;
  readonly intent: string;
  readonly lane: string;
  readonly targetProviderOrAgent?: string;
  readonly capabilityId?: string;
  readonly bodyRef?: string;
  readonly proofRequirements?: readonly string[];
  readonly includesSensitiveContext?: boolean;
  readonly organicProvenance?: FridayOrganicRunProvenance;
}

/** (Lane B) Refs-only Mission intake result — `MissionIntakeResultWire`. */
export interface FridayRustHubMissionIntakeResult {
  readonly truthLabel: "rust_wired";
  readonly fridayConversationId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly surfaceThreadId: string;
  readonly status: string;
  readonly blockers: readonly string[];
  readonly duplicateMissionId?: string;
  readonly duplicateWorkItemId?: string;
  readonly createdOrReady: boolean;
  /** Server-selected WorkItem route, surfaced only when Rust sends it. */
  readonly selectedLane?: string;
  readonly selectedTargetProviderOrAgent?: string;
  /**
   * (Mission-intake clarification — DARK, default-OFF) The specific clarifying questions for an
   * UNDER-SPECIFIED intent. NON-EMPTY only when `status === "needs_clarification"` (the Rust
   * producer's flag-gated clarification arm); every existing ready/blocked path omits it.
   * Surfaced only when present (the Rust wire skips the field when empty), never fabricated.
   */
  readonly clarificationQuestions?: readonly string[];
}

/** (Lane B) A Mission lifecycle transition request — `MissionLifecycleRequestWire`. */
export interface FridayRustHubMissionLifecycleRequest {
  readonly fridayConversationId: string;
  readonly missionId: string;
  readonly targetStatus: string;
  readonly actorRef: string;
  readonly reason: string;
  readonly proofRef?: string;
  readonly mergedIntoMissionId?: string;
}

/** (Lane B) Refs-only Mission lifecycle result — `MissionLifecycleResultWire`. */
export interface FridayRustHubMissionLifecycleResult {
  readonly truthLabel: "rust_wired";
  readonly fridayConversationId: string;
  readonly missionId: string;
  readonly previousStatus: string;
  readonly status: string;
  readonly actorRef: string;
  readonly reason: string;
  readonly proofRef?: string;
  readonly mergedIntoMissionId?: string;
  readonly activeMissionIds: readonly string[];
  readonly updatedAtMs: number;
}

/** (Lane B) A WorkItem status transition request — `WorkItemStatusRequestWire`. */
export interface FridayRustHubWorkItemStatusRequest {
  readonly workItemId: string;
  readonly targetStatus: string;
  readonly actorRef: string;
  readonly reason: string;
  /**
   * REQUIRED (non-empty) when `targetStatus === "completed_with_proof"`; the Rust persistence
   * boundary REJECTS a proofless completion as a typed `Error` (the proof-on-completion invariant).
   * Absent ⇒ no receipt is appended (the key is OMITTED from the wire, byte-clean).
   */
  readonly proofReceipt?: string;
}

/** (Lane B) Refs-only WorkItem status result — `WorkItemStatusResultWire`. */
export interface FridayRustHubWorkItemStatusResult {
  readonly truthLabel: "rust_wired";
  readonly workItemId: string;
  readonly missionId: string;
  readonly previousStatus: string;
  readonly status: string;
  readonly actorRef: string;
  readonly reason: string;
  /** COUNT of persisted proof receipts (never the raw receipt refs themselves). */
  readonly proofReceiptCount: number;
  readonly updatedAtMs: number;
}

/** (D20 W1-S3) A pre-dispatch route decision veto/override — `RouteDecisionControlRequestWire`. */
export interface FridayRustHubRouteDecisionControlRequest {
  readonly decisionId: string;
  readonly missionId?: string;
  readonly workItemId?: string;
  readonly controlKind: "veto" | "override";
  readonly overrideLane?: string;
  readonly overrideProviderOrAgent?: string;
  readonly actorRef: string;
  readonly reason: string;
}

/** (D20 W1-S3) Refs-only route decision control result — `RouteDecisionControlResultWire`. */
export interface FridayRustHubRouteDecisionControlResult {
  readonly truthLabel: "rust_wired";
  readonly decisionId: string;
  readonly missionId: string;
  readonly workItemId: string;
  readonly controlKind: "veto" | "override";
  readonly overrideLane?: string;
  readonly overrideProviderOrAgent?: string;
  readonly actorRef: string;
  readonly reason: string;
  readonly updatedAtMs: number;
}

// ─── (Lane M) Memory-confirmation loop terminal mutation request/result ──────
//
// The merged Rust arm (#753) wired an OWNER-authed memory decision into the live
// `hub_agent_run_server` behind a SERVER flag (`FRIDAY_MEMORY_CONFIRM`, DEFAULT-OFF):
// an inbound `Message::MemoryDecisionRequest { request: MemoryDecisionRequestWire }`
// applies the OWNER's explicit confirm/reject to ONE pending memory candidate (a
// confirm makes it durable/recallable; a reject is terminal) and replies with a
// `Message::MemoryDecisionResult { result: MemoryDecisionResultWire }`. This is a PURE
// `&Db` mutation — NO provider/model call, ZERO token_ledger rows. Like the
// mission-spine arms, the wire carries NO per-request `auth_proof`/`forwarded_principal`
// — the sealed session IS the channel auth (single-peer/single-owner SERVER invariant).
// The decision is owner/namespace-scoped: it applies ONLY when `owner_principal` matches
// the candidate's owning principal (the server fails closed — `status:"blocked"` — on a
// scope mismatch / unknown / terminal / invalid decision).

/** (Lane M) An OWNER memory confirm/reject decision — `MemoryDecisionRequestWire`. */
export interface FridayRustHubMemoryDecisionRequest {
  /** The candidate `memory_item` to decide on. */
  readonly memoryId: string;
  /** The owner principal asserting the decision (MUST match the candidate's owning principal). */
  readonly ownerPrincipal: string;
  /** The explicit decision — `"confirm"` (→ durable/recallable) or `"reject"` (→ terminal). */
  readonly decision: "confirm" | "reject";
}

/** (Lane M) Refs-only memory decision result — `MemoryDecisionResultWire`. */
export interface FridayRustHubMemoryDecisionResult {
  readonly truthLabel: "rust_wired";
  readonly memoryId: string;
  /** Resulting lifecycle state token (`"candidate"` / `"confirmed"` / `"rejected"` / `"unknown"`). */
  readonly state: string;
  /** Coarse outcome — `"confirmed"` / `"rejected"` / `"blocked"`. */
  readonly status: string;
  /** Coarse block reason — present ONLY when `status === "blocked"` (never echoes candidate content). */
  readonly blocker?: string;
  /** Whether the candidate is now recallable (durable `Confirmed`). */
  readonly recallable: boolean;
}

/** (A1) An OWNER confirm/reject decision for one refs-only run-outcome learning candidate. */
export interface FridayRustHubRunOutcomeLearningDecisionRequest {
  readonly candidateId: string;
  readonly decision: "confirm" | "reject";
  readonly reason?: string;
}

/** (A1) Refs-only run-outcome learning decision result. */
export interface FridayRustHubRunOutcomeLearningDecisionResult {
  readonly truthLabel: "rust_wired";
  readonly candidateId: string;
  readonly runId?: string;
  readonly kind?: string;
  readonly state: string;
  readonly status: string;
  readonly blocker?: string;
}

/**
 * (CORE-A CR-3) Create/ensure ONE agent-session row — `Message::SessionCreateRequest`. The OWNER is
 * bound SERVER-side to the authenticated principal (single-peer session = channel auth); `userId`
 * here is the forwarded owner (the server FIX-Q3b-refuses a value that disagrees), NOT an authority.
 * The remaining axes are descriptive surface metadata.
 */
export interface FridayRustHubSessionCreateRequest {
  /** The canonical session key (`agent_session_id`) to ensure. Non-empty. */
  readonly sessionId: string;
  readonly channel?: string;
  readonly chatId?: string;
  /** The forwarded OWNER principal (server binds the authenticated owner; a mismatch is refused). */
  readonly userId?: string;
  readonly accountId?: string;
  readonly chatKind?: string;
  /** Opaque client metadata as a JSON STRING (refs-only; not persisted by the minimal store). */
  readonly metadataJson?: string;
}

/** (CORE-A CR-3) Refs-only session create receipt — `SessionCreateResultWire` (id + timestamps). */
export interface FridayRustHubSessionCreateResult {
  readonly truthLabel: "rust_wired";
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * (CORE-A CR-3) Append ONE conversation message to a session — `Message::SessionMessageAppendRequest`.
 * OWNER-GATED server-side: refused unless the authenticated principal owns `sessionId`. `content` is a
 * BODY that rides the SEALED session (never a refs field).
 */
export interface FridayRustHubSessionMessageAppendRequest {
  readonly sessionId: string;
  /** Speaker role (e.g. `user` / `assistant`). Non-empty. */
  readonly role: string;
  /** Message body kept Hub-side (sealed on the wire). */
  readonly content: string;
  /** Optional soft-link ref (e.g. producing run id). */
  readonly refs?: string;
}

/** (CORE-A CR-3) Refs-only append receipt — `SessionMessageAppendResultWire` (id + seq + timestamps). */
export interface FridayRustHubSessionMessageAppendResult {
  readonly truthLabel: "rust_wired";
  readonly messageId: string;
  readonly seq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function unavailable(message: string, details?: Record<string, unknown>): FridayDomainError {
  return new FridayDomainError("MISSION_SPINE_RUST_AGENT_RUN_SEALED_WS_CLIENT_UNAVAILABLE", message, {
    httpStatus: 503,
    details: {
      surface: "service:rust_hub_agent_run_sealed_ws_client",
      bridge: "rust_wired",
      proofOnly: true,
      proofReady: false,
      ...(details ?? {}),
    },
  });
}

/**
 * Convert Rust's typed `Message::Error` envelope into the same fail-closed 503 shape while keeping
 * the safe code/message locally inspectable. HTTP still applies its existing 5xx redaction layer.
 */
export function missionSpineUnavailableFromRustErrorEnvelope(
  leg: string,
  fields: Record<string, unknown>,
): FridayDomainError {
  const code = asString(fields.code) ?? "unknown";
  const message = asString(fields.message) ?? "unknown";
  const details = {
    leg,
    rustError: { code, message },
  };
  if (
    leg === "mission-intake" &&
    message === "mission intake owner_principal does not match the authenticated owner"
  ) {
    return new FridayDomainError(
      "MISSION_SPINE_OWNER_PRINCIPAL_MISMATCH",
      "Mission intake owner_principal does not match the authenticated owner.",
      {
        httpStatus: 403,
        details: {
          surface: "service:rust_hub_agent_run_sealed_ws_client",
          bridge: "rust_wired",
          proofOnly: true,
          proofReady: false,
          ...details,
        },
      },
    );
  }
  return unavailable(`Sealed mission-spine client (${leg}) received a Rust Error envelope.`, {
    ...details,
  });
}

/** Read exactly `n` bytes from a buffered socket reader, or fail closed on EOF/timeout. */
type FrameReader = {
  readFrame(): Promise<Uint8Array>;
  /** Hand the remaining buffered bytes + the socket to the WS layer after the preamble. */
  takeover(): { socket: Socket; leftover: Buffer };
};

/**
 * A minimal buffered reader over the raw socket for the cleartext length-prefixed preamble
 * (`[u32 big-endian length][payload]`). Buffers inbound data; resolves one frame at a time.
 * After the preamble, `takeover()` returns the socket plus any already-buffered bytes (there
 * should be none before the WS upgrade, but we hand them on defensively).
 */
function createPreambleReader(socket: Socket): FrameReader {
  // Typed as the wide `Buffer` (= `Buffer<ArrayBufferLike>`) so inbound socket chunks (also wide)
  // can be assigned directly without an ArrayBuffer-vs-ArrayBufferLike mismatch.
  let buffer: Buffer = Buffer.alloc(0);
  let pending: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  let fatal: Error | null = null;

  function settlePending(): void {
    if (!pending) return;
    if (fatal) {
      const p = pending;
      pending = null;
      p.reject(fatal);
      return;
    }
    if (buffer.length >= pending.need) {
      const p = pending;
      const out = buffer.subarray(0, p.need);
      buffer = buffer.subarray(p.need);
      pending = null;
      p.resolve(out);
    }
  }

  function onData(chunk: Buffer): void {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    settlePending();
  }
  function onError(err: Error): void {
    fatal = err;
    settlePending();
  }
  function onClose(): void {
    fatal = fatal ?? new Error("socket closed during preamble");
    settlePending();
  }

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  function readExact(n: number): Promise<Buffer> {
    if (fatal) return Promise.reject(fatal);
    return new Promise<Buffer>((resolve, reject) => {
      pending = { need: n, resolve, reject };
      settlePending();
    });
  }

  return {
    async readFrame(): Promise<Uint8Array> {
      const header = await readExact(4);
      const len = header.readUInt32BE(0);
      if (len > MAX_FRAME) {
        throw new Error(`preamble frame too large: ${len}`);
      }
      const payload = await readExact(len);
      return new Uint8Array(payload);
    },
    takeover(): { socket: Socket; leftover: Buffer } {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      const leftover = buffer;
      buffer = Buffer.alloc(0);
      return { socket, leftover };
    },
  };
}

/** Build a length-prefixed preamble frame `[u32be len][payload]`. */
function frameBytes(payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  Buffer.from(payload).copy(out, 4);
  return out;
}

/**
 * Perform the manual RFC6455 client upgrade over the (preamble-consumed) raw socket: send the
 * GET/Upgrade request, await the `101 Switching Protocols` response, and validate
 * `Sec-WebSocket-Accept`. Resolves once the response headers are fully read; any leftover bytes
 * after the header terminator are post-upgrade WS frame data and are returned for the Receiver.
 */
function wsClientUpgrade(socket: Socket, host: string, port: number): Promise<Buffer> {
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
  const request =
    `GET / HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `\r\n`;

  return new Promise<Buffer>((resolve, reject) => {
    let buf: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const head = buf.subarray(0, sep).toString("utf8");
      const leftover = buf.subarray(sep + 4);
      cleanup();
      const statusLine = head.split("\r\n")[0] ?? "";
      if (!/HTTP\/1\.1\s+101/i.test(statusLine)) {
        reject(new Error(`ws upgrade rejected: ${statusLine}`));
        return;
      }
      const acceptMatch = head.match(/sec-websocket-accept:\s*(.+)\r?/i);
      if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
        reject(new Error("ws upgrade: bad Sec-WebSocket-Accept"));
        return;
      }
      resolve(leftover);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("socket closed during ws upgrade"));
    };
    function cleanup(): void {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.write(request);
  });
}

/** A decoded inbound envelope: the inner message kind plus the fields we read. */
export interface InboundEnvelope {
  readonly kind: string;
  readonly fields: Record<string, unknown>;
}

/** Seal + frame an Envelope as a masked WS Binary message and send it. */
function sealAndSend(sender: WsSender, sessionKey: Uint8Array, envelope: unknown): void {
  const json = Buffer.from(JSON.stringify(envelope), "utf8");
  const wire = encodeSealed(seal(sessionKey, json, SESSION_AAD));
  // CLIENT frames MUST be masked (tungstenite rejects unmasked client frames). The Sender was
  // constructed with a mask generator, so mask:true uses it.
  sender.send(Buffer.from(wire), { binary: true, mask: true, fin: true });
}

/**
 * (A1 run-controls) Map the TS-side per-run constraints onto the snake_case
 * `AgentRunConstraintsWire` shape — or `undefined` when NOTHING is asserted, so the caller OMITS
 * the whole `constraints` key (byte-identity with the pre-A1 request).
 *
 * The emitted object MIRRORS the Rust serde discipline EXACTLY so the round-trip is faithful:
 *   - `read_only` is emitted as a bool ONLY when the caller asserts `readOnly === true` (the Rust
 *     field has `#[serde(default)]`, so an absent `read_only` deserializes to `false` — we never
 *     emit `read_only: false`, keeping the block minimal and a read-only-off run byte-clean);
 *   - `disabled_tools` is emitted ONLY when the normalized (trimmed, de-duped, non-empty) set is
 *     non-empty (Rust `skip_serializing_if = "Vec::is_empty"`);
 *   - `max_turns` is emitted ONLY when a finite positive integer cap is given (Rust
 *     `skip_serializing_if = "Option::is_none"`).
 * If, after normalization, NONE of the three is present, the run asserts no tightening at all and
 * this returns `undefined` (no wire block). A constraint can ONLY tighten — there is no field that
 * widens — so a hostile/garbled value at worst under-restricts to "no constraint", never a grant.
 */
export function buildConstraintsWire(
  constraints: FridayRustHubAgentRunConstraints | undefined,
): Record<string, unknown> | undefined {
  if (constraints === undefined) {
    return undefined;
  }
  const wire: Record<string, unknown> = {};
  if (constraints.readOnly === true) {
    wire.read_only = true;
  }
  if (Array.isArray(constraints.disabledTools)) {
    // Normalize like the Rust `RunPolicy::new` / the TS oracle's `normalizeToolNameSet`: trim,
    // drop empties, de-dup — so a whitespace/duplicate entry can never bloat or weaken the set.
    const normalized = Array.from(
      new Set(
        constraints.disabledTools
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      ),
    );
    if (normalized.length > 0) {
      wire.disabled_tools = normalized;
    }
  }
  if (
    typeof constraints.maxTurns === "number" &&
    Number.isInteger(constraints.maxTurns) &&
    constraints.maxTurns > 0
  ) {
    wire.max_turns = constraints.maxTurns;
  }
  return Object.keys(wire).length > 0 ? wire : undefined;
}

/**
 * (NS45-PR1 / M-4) Map the TS-side first-class Mission handle onto the snake_case
 * `MissionWorkItemContextWire` shape the Rust server decodes — or `undefined` when NO handle is
 * given, so the caller OMITS the whole `mission_context` key (byte-identity with the pre-NS45
 * request). Unlike `buildConstraintsWire` there is NO tightening/collapse logic: the Rust struct's
 * three fields are ALL required (`friday_conversation_id` / `mission_id` / `work_item_id`, none
 * `Option`), so a defined handle ALWAYS emits the full three-field object. This is presence-based
 * (mirrors `session_id`), NOT value-collapsing. The handle is a client ASSERTION of which Mission
 * the run binds to — it confers no authority; the bound owner is the authenticated principal,
 * gated server-side. EXPORTED + pure so the precise wire shape is unit-testable without a socket
 * (mirrors {@link buildConstraintsWire}).
 */
export function buildMissionContextWire(
  missionContext: FridayRustHubAgentRunMissionContext | undefined,
): Record<string, unknown> | undefined {
  if (missionContext === undefined) {
    return undefined;
  }
  return {
    friday_conversation_id: missionContext.fridayConversationId,
    mission_id: missionContext.missionId,
    work_item_id: missionContext.workItemId,
  };
}

/**
 * (A3 courier) Build the `AgentRunResume` envelope that relays an operator's OPAQUE signed approval.
 * The merged wire (`friday-protocol::Message::AgentRunResume`) is exactly `{run_id, signed_blob}` —
 * serde `Vec<u8>` serializes as a JSON ARRAY of byte numbers (NOT base64/hex), EXACTLY like the
 * dispatch envelope's `auth_proof`. The blob is relayed VERBATIM via `Array.from` — TS inspects,
 * derives, and authors NOTHING inside it (INV-1, a pure courier). EXPORTED + pure so the precise
 * wire shape is unit-testable without a socket (mirrors {@link buildConstraintsWire}).
 */
export function buildResumeEnvelope(
  runId: string,
  opaqueSignedBlob: Uint8Array,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    msg_id: `agent-run-resume-${runId}`,
    correlation_id: `agent-run-resume-${runId}`,
    sent_at: Date.now(),
    message: {
      kind: "AgentRunResume",
      run_id: runId,
      // serde `Vec<u8>` ⇒ a JSON ARRAY of byte numbers (NOT base64/hex). VERBATIM relay (INV-1).
      signed_blob: Array.from(opaqueSignedBlob),
    },
  };
}

/**
 * (A1 run-controls) Build the `AgentRunReject` envelope. This is owner-authed, not
 * operator-signed: the auth proof is the sealed-session possession proof bound to
 * `(forwardedPrincipal, runId)`, and the server verifies that owner against the pending approval row.
 * The wire is refs-only: no body, no signature material, no tool args.
 */
export function buildRejectEnvelope(
  runId: string,
  approvalId: string,
  forwardedPrincipal: string,
  authProof: Uint8Array,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    msg_id: `agent-run-reject-${runId}-${approvalId}`,
    correlation_id: `agent-run-reject-${runId}-${approvalId}`,
    sent_at: Date.now(),
    message: {
      kind: "AgentRunReject",
      run_id: runId,
      approval_id: approvalId,
      forwarded_principal: forwardedPrincipal,
      auth_proof: Array.from(authProof),
    },
  };
}

/**
 * (Lane B) Wrap a built inner message in the standard Envelope shape (mirrors the dispatch +
 * resume envelopes). `msgId`/`correlationId` are derived from a stable per-entity key so the
 * server's `with_correlation(msg_id)` round-trips deterministically.
 *
 * **msg_id collision is a NON-ISSUE here (verified):** each mission call (`runMissionRoundTrip`)
 * opens a FRESH sealed session and sends EXACTLY ONE envelope. The server's `IdempotencyTracker`
 * is constructed FRESH per connection (`serve_sealed_session` stack-local, `hub_agent_run_server`),
 * so it only dedupes WITHIN a session — it never sees a second envelope on the same session. A
 * stable per-entity key therefore cannot be misread as a within-session replay even when the same
 * mission/work-item transitions repeatedly (each transition is its own connection). No per-call
 * suffix is needed; cross-handshake replay is defeated by the per-handshake `session_nonce`.
 */
function buildMissionEnvelope(key: string, message: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    msg_id: key,
    correlation_id: key,
    sent_at: Date.now(),
    message,
  };
}

/**
 * (Lane B) Build the `MissionIntakeRequest` inner message — the EXACT `MissionIntakeRequestWire`
 * shape. Required string fields ride verbatim; the four Option fields use the same conditional-
 * spread discipline as {@link buildConstraintsWire} (absent ⇒ key OMITTED, byte-clean). The bool
 * `includes_sensitive_context` has `#[serde(default)]` Rust-side, so we emit it ONLY when the
 * caller asserts `true` (an absent/false value deserializes to `false`). EXPORTED + pure so the
 * precise wire shape is unit-testable without a socket.
 */
export function buildMissionIntakeEnvelope(
  request: FridayRustHubMissionIntakeRequest,
): Record<string, unknown> {
  // WIRE NESTING (HOLE-1 fix): `Message::MissionIntakeRequest { request: MissionIntakeRequestWire }`
  // is a SINGLE-FIELD wrapper, and `Message` is `#[serde(tag = "kind")]` (internally tagged). serde
  // therefore emits the inner wire fields NESTED under a `request` key, NOT flat under `message`:
  //   {"kind":"MissionIntakeRequest","request":{ …fields… }}
  // The pre-fix flat shape failed `Envelope::decode` server-side (missing `request` key) ⇒ 503. The
  // byte-exact nesting is pinned by the Rust-emitted golden cross-check in the wire test.
  const inner: Record<string, unknown> = {
    friday_conversation_id: request.fridayConversationId,
    owner_principal: request.ownerPrincipal,
    surface_thread_id: request.surfaceThreadId,
    surface_kind: request.surfaceKind,
    delivery_route: request.deliveryRoute,
    visibility_policy: request.visibilityPolicy,
    mission_id: request.missionId,
    work_item_id: request.workItemId,
    title: request.title,
    intent: request.intent,
    lane: request.lane,
    ...(request.targetProviderOrAgent !== undefined
      ? { target_provider_or_agent: request.targetProviderOrAgent }
      : {}),
    ...(request.capabilityId !== undefined ? { capability_id: request.capabilityId } : {}),
    ...(request.bodyRef !== undefined ? { body_ref: request.bodyRef } : {}),
    ...(request.proofRequirements !== undefined ? { proof_requirements: request.proofRequirements } : {}),
    // `includes_sensitive_context` is `#[serde(default)]` WITHOUT `skip_serializing_if` Rust-side,
    // so an absent key deserializes to `false` (interop-safe). We OMIT it when false to keep the
    // outbound minimal; serde's `default` accepts the omission. We only EMIT it when true.
    ...(request.includesSensitiveContext === true ? { includes_sensitive_context: true } : {}),
  };
  return buildMissionEnvelope(`mission-intake-${request.missionId}`, {
    kind: "MissionIntakeRequest",
    request: inner,
  });
}

/**
 * (Lane B) Build the `MissionLifecycleRequest` inner message — the EXACT
 * `MissionLifecycleRequestWire` shape. `proof_ref`/`merged_into_mission_id` use conditional-spread
 * (absent ⇒ key OMITTED). EXPORTED + pure for socket-free wire testing.
 */
export function buildMissionLifecycleEnvelope(
  request: FridayRustHubMissionLifecycleRequest,
): Record<string, unknown> {
  // WIRE NESTING (HOLE-1 fix): inner fields nest under `request` (single-field wrapper +
  // internally-tagged `Message`); see {@link buildMissionIntakeEnvelope}.
  const inner: Record<string, unknown> = {
    friday_conversation_id: request.fridayConversationId,
    mission_id: request.missionId,
    target_status: request.targetStatus,
    actor_ref: request.actorRef,
    reason: request.reason,
    ...(request.proofRef !== undefined ? { proof_ref: request.proofRef } : {}),
    ...(request.mergedIntoMissionId !== undefined
      ? { merged_into_mission_id: request.mergedIntoMissionId }
      : {}),
  };
  return buildMissionEnvelope(`mission-lifecycle-${request.missionId}`, {
    kind: "MissionLifecycleRequest",
    request: inner,
  });
}

/**
 * (Lane B) Build the `WorkItemStatusRequest` inner message — the EXACT `WorkItemStatusRequestWire`
 * shape. `proof_receipt` uses conditional-spread (absent ⇒ key OMITTED). The proof-on-completion
 * invariant is enforced SERVER-side (a proofless `completed_with_proof` is a typed `Error`); this
 * builder never fabricates a receipt. EXPORTED + pure for socket-free wire testing.
 */
export function buildWorkItemStatusEnvelope(
  request: FridayRustHubWorkItemStatusRequest,
): Record<string, unknown> {
  // WIRE NESTING (HOLE-1 fix): inner fields nest under `request` (single-field wrapper +
  // internally-tagged `Message`); see {@link buildMissionIntakeEnvelope}.
  const inner: Record<string, unknown> = {
    work_item_id: request.workItemId,
    target_status: request.targetStatus,
    actor_ref: request.actorRef,
    reason: request.reason,
    ...(request.proofReceipt !== undefined ? { proof_receipt: request.proofReceipt } : {}),
  };
  return buildMissionEnvelope(`work-item-status-${request.workItemId}`, {
    kind: "WorkItemStatusRequest",
    request: inner,
  });
}

/**
 * (D20 W1-S3) Build the `RouteDecisionControlRequest` inner message — the EXACT
 * `RouteDecisionControlRequestWire` shape. `override_*` fields are omitted unless present; Rust
 * validates the control kind and lane fail-closed.
 */
export function buildRouteDecisionControlEnvelope(
  request: FridayRustHubRouteDecisionControlRequest,
): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    decision_id: request.decisionId,
    ...(request.missionId !== undefined ? { mission_id: request.missionId } : {}),
    ...(request.workItemId !== undefined ? { work_item_id: request.workItemId } : {}),
    control_kind: request.controlKind,
    ...(request.overrideLane !== undefined ? { override_lane: request.overrideLane } : {}),
    ...(request.overrideProviderOrAgent !== undefined
      ? { override_provider_or_agent: request.overrideProviderOrAgent }
      : {}),
    actor_ref: request.actorRef,
    reason: request.reason,
  };
  return buildMissionEnvelope(`route-decision-control-${request.decisionId}`, {
    kind: "RouteDecisionControlRequest",
    request: inner,
  });
}

/**
 * (Lane M) Build the `MemoryDecisionRequest` inner message — the EXACT `MemoryDecisionRequestWire`
 * shape. CRITICAL: `Message::MemoryDecisionRequest { request: MemoryDecisionRequestWire }` is a
 * SINGLE-FIELD wrapper on an internally-tagged (`#[serde(tag = "kind")]`) `Message`, so serde
 * NESTS the inner wire fields under a `request` key:
 *   {"kind":"MemoryDecisionRequest","request":{ memory_id, owner_principal, decision }}
 * A prior surface shipped a FLAT shape that failed `Envelope::decode` server-side (missing the
 * `request` key) ⇒ 503 every call — the byte-exact `{kind,request}` nesting (cross-checked against
 * the Rust round-trip test at friday-protocol lib.rs:2158-2172) is the regression guard. All three
 * fields are REQUIRED (no Option / conditional-spread); the server parses `decision` fail-closed.
 * EXPORTED + pure so the precise wire shape is unit-testable without a socket.
 */
export function buildMemoryDecisionEnvelope(
  request: FridayRustHubMemoryDecisionRequest,
): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    memory_id: request.memoryId,
    owner_principal: request.ownerPrincipal,
    decision: request.decision,
  };
  return buildMissionEnvelope(`memory-decision-${request.memoryId}`, {
    kind: "MemoryDecisionRequest",
    request: inner,
  });
}

/**
 * (CORE-A CR-3) Build the `SessionCreateRequest` inner message — the EXACT `SessionCreateRequestWire`
 * shape nested under `request` (single-field wrapper on the internally-tagged `Message`, same
 * `{kind,request}` nesting as {@link buildMemoryDecisionEnvelope}; a flat shape 503s server-side).
 * `session_id` is required; the descriptive axes + `metadata_json` use conditional-spread (absent ⇒
 * key OMITTED, byte-clean, round-trips to `None`). EXPORTED + pure for socket-free wire testing.
 */
export function buildSessionCreateEnvelope(
  request: FridayRustHubSessionCreateRequest,
): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    session_id: request.sessionId,
    ...(request.channel !== undefined ? { channel: request.channel } : {}),
    ...(request.chatId !== undefined ? { chat_id: request.chatId } : {}),
    ...(request.userId !== undefined ? { user_id: request.userId } : {}),
    ...(request.accountId !== undefined ? { account_id: request.accountId } : {}),
    ...(request.chatKind !== undefined ? { chat_kind: request.chatKind } : {}),
    ...(request.metadataJson !== undefined ? { metadata_json: request.metadataJson } : {}),
  };
  return buildMissionEnvelope(`session-create-${request.sessionId}`, {
    kind: "SessionCreateRequest",
    request: inner,
  });
}

/**
 * (CORE-A CR-3) Build the `SessionMessageAppendRequest` inner message — the EXACT
 * `SessionMessageAppendRequestWire` shape nested under `request`. `session_id`/`role`/`content` are
 * required; `refs` uses conditional-spread (absent ⇒ OMITTED). EXPORTED + pure for socket-free wire
 * testing.
 */
export function buildSessionMessageAppendEnvelope(
  request: FridayRustHubSessionMessageAppendRequest,
): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    session_id: request.sessionId,
    role: request.role,
    content: request.content,
    ...(request.refs !== undefined ? { refs: request.refs } : {}),
  };
  return buildMissionEnvelope(`session-message-append-${request.sessionId}`, {
    kind: "SessionMessageAppendRequest",
    request: inner,
  });
}

/** Build the exact nested `RunOutcomeLearningDecisionRequest { request: ... }` wire message. */
export function buildRunOutcomeLearningDecisionEnvelope(
  request: FridayRustHubRunOutcomeLearningDecisionRequest,
): Record<string, unknown> {
  const inner: Record<string, unknown> = {
    candidate_id: request.candidateId,
    decision: request.decision,
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
  };
  return buildMissionEnvelope(`run-outcome-learning-decision-${request.candidateId}`, {
    kind: "RunOutcomeLearningDecisionRequest",
    request: inner,
  });
}

/**
 * (Lane B) Parse a `MissionIntakeResult` inbound into the refs-only TS result. Returns `undefined`
 * (caller fails closed) when a REQUIRED ref is missing/ill-typed. The optional refs are surfaced
 * only when present (absent ⇒ omitted, never fabricated). EXPORTED + pure for socket-free testing.
 */
export function parseMissionIntakeResult(
  fields: Record<string, unknown>,
): FridayRustHubMissionIntakeResult | undefined {
  // HOLE-1 fix: the refs live NESTED under `result` (single-field wrapper); unwrap fail-closed.
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const fridayConversationId = asString(r.friday_conversation_id);
  const missionId = asString(r.mission_id);
  const surfaceThreadId = asString(r.surface_thread_id);
  const status = asString(r.status);
  const blockers = r.blockers;
  const createdOrReady = r.created_or_ready;
  if (
    !fridayConversationId ||
    !missionId ||
    !surfaceThreadId ||
    !status ||
    !Array.isArray(blockers) ||
    !blockers.every((b): b is string => typeof b === "string") ||
    typeof createdOrReady !== "boolean"
  ) {
    return undefined;
  }
  const workItemId = asString(r.work_item_id);
  const duplicateMissionId = asString(r.duplicate_mission_id);
  const duplicateWorkItemId = asString(r.duplicate_work_item_id);
  const selectedLane = asString(r.selected_lane);
  const selectedTargetProviderOrAgent = asString(r.selected_target_provider_or_agent);
  // (Mission-intake clarification — DARK) Optional, ADDITIVE: surfaced only when the server sends a
  // non-empty `clarification_questions` (the flag-gated needs_clarification arm). Absent / empty /
  // non-array / non-string entries ⇒ the field is OMITTED (never fabricated, never a parse failure
  // — backward-compatible with every existing ready/blocked payload that omits it).
  const rawQuestions = r.clarification_questions;
  const clarificationQuestions =
    Array.isArray(rawQuestions) && rawQuestions.every((q): q is string => typeof q === "string")
      ? rawQuestions
      : undefined;
  return {
    // `MissionIntakeResultWire` carries NO `truth_label` field (verified in friday-protocol), so the
    // server cannot send one — this `rust_wired` label is the TS-side ceiling for a Rust-served refs
    // result, asserted by construction (not read from the wire). It confers no v1 GO.
    truthLabel: "rust_wired",
    fridayConversationId,
    missionId,
    surfaceThreadId,
    status,
    blockers,
    createdOrReady,
    ...(workItemId !== undefined ? { workItemId } : {}),
    ...(duplicateMissionId !== undefined ? { duplicateMissionId } : {}),
    ...(duplicateWorkItemId !== undefined ? { duplicateWorkItemId } : {}),
    ...(selectedLane !== undefined ? { selectedLane } : {}),
    ...(selectedTargetProviderOrAgent !== undefined
      ? { selectedTargetProviderOrAgent }
      : {}),
    ...(clarificationQuestions !== undefined && clarificationQuestions.length > 0
      ? { clarificationQuestions }
      : {}),
  };
}

/**
 * (Lane B) Parse a `MissionLifecycleResult` inbound into the refs-only TS result. Returns
 * `undefined` when a REQUIRED ref is missing/ill-typed. EXPORTED + pure for socket-free testing.
 */
export function parseMissionLifecycleResult(
  fields: Record<string, unknown>,
): FridayRustHubMissionLifecycleResult | undefined {
  // HOLE-1 fix: the refs live NESTED under `result` (single-field wrapper); unwrap fail-closed.
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const fridayConversationId = asString(r.friday_conversation_id);
  const missionId = asString(r.mission_id);
  const previousStatus = asString(r.previous_status);
  const status = asString(r.status);
  const actorRef = asString(r.actor_ref);
  const reason = asString(r.reason);
  const activeMissionIds = r.active_mission_ids;
  const updatedAtMs = asNumber(r.updated_at_ms);
  if (
    !fridayConversationId ||
    !missionId ||
    !previousStatus ||
    !status ||
    !actorRef ||
    !reason ||
    !Array.isArray(activeMissionIds) ||
    !activeMissionIds.every((m): m is string => typeof m === "string") ||
    updatedAtMs === undefined
  ) {
    return undefined;
  }
  const proofRef = asString(r.proof_ref);
  const mergedIntoMissionId = asString(r.merged_into_mission_id);
  return {
    // No `truth_label` on `MissionLifecycleResultWire`; TS-side ceiling label (see intake parser).
    truthLabel: "rust_wired",
    fridayConversationId,
    missionId,
    previousStatus,
    status,
    actorRef,
    reason,
    activeMissionIds,
    updatedAtMs,
    ...(proofRef !== undefined ? { proofRef } : {}),
    ...(mergedIntoMissionId !== undefined ? { mergedIntoMissionId } : {}),
  };
}

/**
 * (Lane B) Parse a `WorkItemStatusResult` inbound into the refs-only TS result. Returns `undefined`
 * when a REQUIRED ref is missing/ill-typed. `proof_receipt_count` is a COUNT (never raw refs).
 * EXPORTED + pure for socket-free testing.
 */
export function parseWorkItemStatusResult(
  fields: Record<string, unknown>,
): FridayRustHubWorkItemStatusResult | undefined {
  // HOLE-1 fix: the refs live NESTED under `result` (single-field wrapper); unwrap fail-closed.
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const workItemId = asString(r.work_item_id);
  const missionId = asString(r.mission_id);
  const previousStatus = asString(r.previous_status);
  const status = asString(r.status);
  const actorRef = asString(r.actor_ref);
  const reason = asString(r.reason);
  const proofReceiptCount = asNumber(r.proof_receipt_count);
  const updatedAtMs = asNumber(r.updated_at_ms);
  if (
    !workItemId ||
    !missionId ||
    !previousStatus ||
    !status ||
    !actorRef ||
    !reason ||
    proofReceiptCount === undefined ||
    updatedAtMs === undefined
  ) {
    return undefined;
  }
  return {
    // No `truth_label` on `WorkItemStatusResultWire`; TS-side ceiling label (see intake parser).
    truthLabel: "rust_wired",
    workItemId,
    missionId,
    previousStatus,
    status,
    actorRef,
    reason,
    proofReceiptCount,
    updatedAtMs,
  };
}

/**
 * (D20 W1-S3) Parse a `RouteDecisionControlResult` inbound into the refs-only TS result.
 */
export function parseRouteDecisionControlResult(
  fields: Record<string, unknown>,
): FridayRustHubRouteDecisionControlResult | undefined {
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const decisionId = asString(r.decision_id);
  const missionId = asString(r.mission_id);
  const workItemId = asString(r.work_item_id);
  const controlKind = asString(r.control_kind);
  const overrideLane = asString(r.override_lane);
  const overrideProviderOrAgent = asString(r.override_provider_or_agent);
  const actorRef = asString(r.actor_ref);
  const reason = asString(r.reason);
  const updatedAtMs = asNumber(r.updated_at_ms);
  if (
    !decisionId ||
    !missionId ||
    !workItemId ||
    (controlKind !== "veto" && controlKind !== "override") ||
    !actorRef ||
    !reason ||
    updatedAtMs === undefined
  ) {
    return undefined;
  }
  return {
    truthLabel: "rust_wired",
    decisionId,
    missionId,
    workItemId,
    controlKind,
    ...(overrideLane !== undefined ? { overrideLane } : {}),
    ...(overrideProviderOrAgent !== undefined ? { overrideProviderOrAgent } : {}),
    actorRef,
    reason,
    updatedAtMs,
  };
}

/**
 * (Lane M) Parse a `MemoryDecisionResult` inbound into the refs-only TS result. Returns `undefined`
 * (caller fails closed 503) when a REQUIRED ref is missing/ill-typed. `recallable` is a REQUIRED
 * boolean and `false` is a VALID value (a rejected/blocked candidate) — checked with an explicit
 * `typeof === "boolean"`, NEVER a truthy test (mirrors `created_or_ready`). `blocker` is
 * `skip_serializing_if Option::is_none` Rust-side ⇒ OMITTED from the wire when absent; surfaced
 * only when present, never fabricated. EXPORTED + pure for socket-free testing.
 */
export function parseMemoryDecisionResult(
  fields: Record<string, unknown>,
): FridayRustHubMemoryDecisionResult | undefined {
  // The refs live NESTED under `result` (single-field wrapper); unwrap fail-closed.
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const memoryId = asString(r.memory_id);
  const state = asString(r.state);
  const status = asString(r.status);
  const recallable = r.recallable;
  if (!memoryId || !state || !status || typeof recallable !== "boolean") {
    return undefined;
  }
  const blocker = asString(r.blocker);
  return {
    // No `truth_label` on `MemoryDecisionResultWire`; TS-side ceiling label (see intake parser).
    truthLabel: "rust_wired",
    memoryId,
    state,
    status,
    recallable,
    ...(blocker !== undefined ? { blocker } : {}),
  };
}

/**
 * (CORE-A CR-3) Parse a nested `SessionCreateResult { result: ... }` into the refs-only TS shape.
 * Fail-closed: a missing/wrong-typed id or timestamp ⇒ `undefined` (the round-trip then rejects →
 * 503), so a malformed receipt never surfaces as a fake success.
 */
export function parseSessionCreateResult(
  fields: Record<string, unknown>,
): FridayRustHubSessionCreateResult | undefined {
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const sessionId = asString(r.session_id);
  const createdAt = asNumber(r.created_at);
  const updatedAt = asNumber(r.updated_at);
  if (!sessionId || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return { truthLabel: "rust_wired", sessionId, createdAt, updatedAt };
}

/**
 * (CORE-A CR-3) Parse a nested `SessionMessageAppendResult { result: ... }` into the refs-only TS
 * shape. `seq` is validated with `asNumber` (accepts 0 — the first message's ordinal). Fail-closed on
 * any missing/wrong-typed field.
 */
export function parseSessionMessageAppendResult(
  fields: Record<string, unknown>,
): FridayRustHubSessionMessageAppendResult | undefined {
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const messageId = asString(r.message_id);
  const seq = asNumber(r.seq);
  const createdAt = asNumber(r.created_at);
  const updatedAt = asNumber(r.updated_at);
  if (!messageId || seq === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return { truthLabel: "rust_wired", messageId, seq, createdAt, updatedAt };
}

/** Parse a nested `RunOutcomeLearningDecisionResult { result: ... }` into refs-only TS shape. */
export function parseRunOutcomeLearningDecisionResult(
  fields: Record<string, unknown>,
): FridayRustHubRunOutcomeLearningDecisionResult | undefined {
  const r = unwrapResult(fields);
  if (r === undefined) {
    return undefined;
  }
  const candidateId = asString(r.candidate_id);
  const state = asString(r.state);
  const status = asString(r.status);
  if (!candidateId || !state || !status) {
    return undefined;
  }
  const runId = asString(r.run_id);
  const kind = asString(r.kind);
  const blocker = asString(r.blocker);
  return {
    truthLabel: "rust_wired",
    candidateId,
    state,
    status,
    ...(runId !== undefined ? { runId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(blocker !== undefined ? { blocker } : {}),
  };
}

/** Open + decode one inbound sealed WS Binary payload into its inner message. */
function openInbound(sessionKey: Uint8Array, payload: Buffer): InboundEnvelope {
  const sealed = decodeSealed(new Uint8Array(payload));
  const ptBytes = open(sessionKey, sealed, SESSION_AAD);
  const env = JSON.parse(Buffer.from(ptBytes).toString("utf8")) as Record<string, unknown>;
  const message = env.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("inbound envelope has no message object");
  }
  const fields = message as Record<string, unknown>;
  const kind = typeof fields.kind === "string" ? fields.kind : "";
  return { kind, fields };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * (Lane B, HOLE-1 fix) Unwrap the NESTED `result` sub-object from a mission `*Result` inbound's
 * fields. `Message::Mission*Result { result: …Wire }` is a SINGLE-FIELD wrapper on an internally-
 * tagged (`#[serde(tag = "kind")]`) enum, so the wire nests the result fields under a `result` key:
 *   {"kind":"Mission*Result","result":{ …refs… }}
 * The `inbound.fields` handed to a parser is the whole `message` object (`{kind, result:{…}}`), NOT
 * the inner refs. Returns `undefined` (caller fails closed 503) when `result` is missing/ill-typed —
 * this MUST not throw, because `parse()` runs OUTSIDE the inbound try/catch in `runMissionRoundTrip`.
 */
function unwrapResult(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = fields.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  return result as Record<string, unknown>;
}

/** The refs accumulated from the FIRST inbound envelope (the refs-only `AgentRunResult`). */
interface ResultRefs {
  runId: string;
  status: string;
  answerSha256?: string;
  answerLen?: number;
  // (A1 transport-truth) REFS-surface run COUNTS — counts only, never a body. Absent when the
  // server omits them (old server / non-delivered / deferred token counts).
  turns?: number;
  executedTools?: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * The refs read state + settlement callbacks, shared between the inbound-message handler and the
 * server-close handler. Extracted to a module-level factory so the dispatch closure stays small
 * and the settle logic is testable in isolation.
 *
 * (leg-A decouple, #655 Part 4) The dispatch settles on the FIRST (refs) envelope alone; `refs`
 * is the only accumulated state, read by the close handler to distinguish a clean settle from a
 * close-before-any-refs fail-closed.
 *
 * EXPORTED (with {@link handleResult} / {@link handleServerClose}) ONLY so the settle-branch logic
 * is unit-testable against a fake ctx without a socket; not part of the public dispatch surface.
 */
export interface InboundContext {
  /** Set once the handshake derives the session key (mutated in the async setup). */
  sessionKey: Uint8Array;
  /** Mutable refs slot — set by the result handler, read by the close handler. */
  refs: ResultRefs | null;
  /**
   * (A3 courier) The run-control flag, DEFAULT-OFF. Gates ONLY the new `AgentRunPaused` inbound
   * branch: OFF ⇒ an `AgentRunPaused` is an unknown message and fails closed (byte-identical to
   * today); ON ⇒ it settles with the paused outcome. The `AgentRunResult` path is flag-independent.
   * Defaults to `false` when a caller (e.g. a legacy test) omits it.
   */
  controlEnabled?: boolean;
  /**
   * (A3 courier) Settle with the dispatch outcome. Widened from the legacy
   * `FridayRustHubAgentRunSealedResult`-only signature to the discriminated union so a paused
   * settle can flow through — a normal result (no `outcome` key) is unchanged.
   */
  succeed(result: FridayRustHubAgentRunSealedDispatchOutcome): void;
  fail(error: FridayDomainError): void;
}

/** Settle from the accumulated refs (status + answer fingerprint + A1 counts). */
function finishFromRefs(ctx: InboundContext): void {
  const { refs } = ctx;
  if (!refs) {
    ctx.fail(unavailable("Sealed agent-run client never received a result ref."));
    return;
  }
  ctx.succeed({
    truthLabel: "rust_wired",
    runId: refs.runId,
    status: refs.status,
    ...(refs.answerSha256 !== undefined ? { answerSha256: refs.answerSha256 } : {}),
    ...(refs.answerLen !== undefined ? { answerLen: refs.answerLen } : {}),
    // (A1) Surface the run COUNTS when the server carried them (absent ⇒ omitted, not 0-faked).
    ...(refs.turns !== undefined ? { turns: refs.turns } : {}),
    ...(refs.executedTools !== undefined ? { executedTools: refs.executedTools } : {}),
    ...(refs.promptTokens !== undefined ? { promptTokens: refs.promptTokens } : {}),
    ...(refs.completionTokens !== undefined ? { completionTokens: refs.completionTokens } : {}),
  });
}

/**
 * Handle the refs-only `AgentRunResult` envelope (the FIRST and ONLY inbound the client awaits).
 *
 * (leg-A decouple, #655 Part 4) SETTLE IMMEDIATELY on the refs — whether or not a fingerprint is
 * present. Previously, a result carrying `answer_sha256`/`answer_len` made the client WAIT for a
 * SECOND owner-sealed body frame; that wait is removed. The body is sourced by compose from the
 * owner-gated DB readback, and the server persists the body BEFORE emitting these refs, so a
 * committed row is guaranteed to exist when this settles (no not_found race). A missing required
 * ref (`run_id`/`status`) still fails closed — the refs-surface contract is preserved.
 */
export function handleResult(ctx: InboundContext, fields: Record<string, unknown>): void {
  const runId = asString(fields.run_id);
  const status = asString(fields.status);
  if (!runId || !status) {
    ctx.fail(unavailable("Sealed agent-run client result is missing a required ref."));
    return;
  }
  const answerSha256 = asString(fields.answer_sha256);
  const answerLen = asNumber(fields.answer_len);
  // (A1) REFS-surface run COUNTS — parse when present; `asNumber` yields `undefined` for an
  // absent/non-numeric field (an OLD server omits them entirely ⇒ undefined, never 0-faked).
  const turns = asNumber(fields.turns);
  const executedTools = asNumber(fields.executed_tools);
  const promptTokens = asNumber(fields.prompt_tokens);
  const completionTokens = asNumber(fields.completion_tokens);
  ctx.refs = {
    runId,
    status,
    ...(answerSha256 !== undefined ? { answerSha256 } : {}),
    ...(answerLen !== undefined ? { answerLen } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(executedTools !== undefined ? { executedTools } : {}),
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
  // (leg-A decouple) Settle on the refs ALONE — the body frame (if any) is no longer awaited.
  finishFromRefs(ctx);
}

/**
 * (A3 courier) Handle the merged `Message::AgentRunPaused` inbound — settle the in-flight dispatch
 * with the {@link FridayRustHubAgentRunPausedOutcome}, carrying REFS ONLY (the approval nonce + the
 * action digest + a coarse summary). Maps the wire fields to the TS outcome EXACTLY:
 *   `nonce` → `approvalId`, `action_digest` → `actionDigest`, `summary` → `ownerSealedSummary?`.
 * `expiresAt` is parsed defensively (the merged wire omits it ⇒ `undefined`, forward-compatible).
 *
 * **FLAG-GATED:** this is reached ONLY when `ctx.controlEnabled` is true (the run-control flag is
 * on). With the flag off, `handleInbound` never routes an `AgentRunPaused` here — it falls to the
 * unknown→fail-closed branch, byte-identical to today. A pause frame MISSING a required ref
 * (`run_id`/`nonce`/`action_digest`) fails closed — the refs-surface contract is preserved.
 *
 * **INV-1:** carries NO signing material; TS authors no approval. EXPORTED only so the settle-branch
 * logic is unit-testable against a fake ctx without a socket.
 */
export function handlePaused(ctx: InboundContext, fields: Record<string, unknown>): void {
  const runId = asString(fields.run_id);
  const approvalId = asString(fields.nonce);
  const actionDigest = asString(fields.action_digest);
  if (!runId || !approvalId || !actionDigest) {
    ctx.fail(unavailable("Sealed agent-run client pause is missing a required ref."));
    return;
  }
  const ownerSealedSummary = asString(fields.summary);
  // The merged `AgentRunPaused` carries NO expiry field; parse defensively for forward-compat (a
  // later wire revision may add `expires_at`) — `undefined` today, never fabricated.
  const expiresAt = asNumber(fields.expires_at);
  ctx.succeed({
    outcome: "paused",
    truthLabel: "rust_wired",
    runId,
    approvalId,
    actionDigest,
    ...(ownerSealedSummary !== undefined ? { ownerSealedSummary } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

/**
 * (A3 courier) Parse the refs-only `Message::AgentRunControlResult` the server returns for a resume
 * relay into the {@link FridayRustHubAgentRunResumeResult}. REFS-ONLY: the coarse `op`/`accepted`/
 * `status` + an optional soft `audit_ref` — NEVER a body. A frame missing a required ref
 * (`run_id`/`op`/`status`, or a non-boolean `accepted`) returns `undefined` (the caller fails
 * closed). A server REFUSAL (`accepted=false`) is a VALID parse — it is a refusal outcome, not a
 * parse failure. EXPORTED only so the parse is unit-testable against a fake field map without a socket.
 */
export function parseControlResult(
  fields: Record<string, unknown>,
): FridayRustHubAgentRunResumeResult | undefined {
  const runId = asString(fields.run_id);
  const op = asString(fields.op);
  const status = asString(fields.status);
  const accepted = fields.accepted;
  if (!runId || !op || !status || typeof accepted !== "boolean") {
    return undefined;
  }
  const auditRef = asString(fields.audit_ref);
  return {
    truthLabel: "rust_wired",
    runId,
    op,
    accepted,
    status,
    ...(auditRef !== undefined ? { auditRef } : {}),
  };
}

/**
 * Dispatch one opened inbound envelope to its handler. (leg-A decouple, #655 Part 4) The client
 * settles synchronously on the FIRST `AgentRunResult`, so any later frame (e.g. the now-ignored
 * owner-sealed body `AskFridayStream`) arrives after teardown removed the listeners and after the
 * `settled` guard is set — a no-op. We keep the kind dispatch narrow: only `AgentRunResult` is a
 * recognized inbound; anything else BEFORE a result is fail-closed.
 *
 * (A3 courier) When the run-control flag is ON (`ctx.controlEnabled`), `AgentRunPaused` is ALSO a
 * recognized inbound and settles with the paused outcome. With the flag OFF an `AgentRunPaused` is
 * NOT recognized — it falls to the unknown→fail-closed branch, byte-identical to today.
 *
 * EXPORTED only so the flag-gated kind-dispatch (incl. the flag-off `AgentRunPaused`→fail-closed
 * byte-identity) is unit-testable against a pre-opened field map without a socket. Takes the already
 * decoded {@link InboundEnvelope} so the test does not need session crypto.
 */
export function routeInboundEnvelope(ctx: InboundContext, inbound: InboundEnvelope): void {
  if (inbound.kind === "AgentRunResult") {
    handleResult(ctx, inbound.fields);
    return;
  }
  // (A3 courier) FLAG-GATED: a paused frame is recognized ONLY when run-control is on. Flag off ⇒
  // it falls through to the unknown→fail-closed branch below (byte-identical to today).
  if (ctx.controlEnabled === true && inbound.kind === "AgentRunPaused") {
    handlePaused(ctx, inbound.fields);
    return;
  }
  ctx.fail(unavailable("Sealed agent-run client received an unknown message shape."));
}

function handleInbound(ctx: InboundContext, payload: Buffer): void {
  let inbound: InboundEnvelope;
  try {
    inbound = openInbound(ctx.sessionKey, payload);
  } catch {
    ctx.fail(unavailable("Sealed agent-run client could not open an inbound envelope."));
    return;
  }
  routeInboundEnvelope(ctx, inbound);
}

/**
 * Handle the server ending the session. A close BEFORE any refs is the FAIL-CLOSED path (forged
 * peer / bad principal — the server established no session or ran nothing) and stays a 503. With
 * refs present the client already settled on them, so `succeed`'s `settled` guard makes this a
 * no-op; `finishFromRefs` is a defensive backstop for the (unreached) refs-present close.
 */
export function handleServerClose(ctx: InboundContext): void {
  if (!ctx.refs) {
    ctx.fail(unavailable("Sealed agent-run client connection closed before a result."));
    return;
  }
  finishFromRefs(ctx);
}

/**
 * (Lane B) Parameters for the generic sealed mission round-trip — the connect/preamble/derive-key/
 * upgrade machinery, factored from {@link FridayRustHubAgentRunResumeRequest}'s handshake.
 */
interface MissionRoundTripParams<TResult> {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly keypair: { readonly publicKey: Uint8Array; readonly secret: Uint8Array };
  /** The pre-built Envelope to seal + send (one of the `build*Envelope` outputs). */
  readonly envelope: Record<string, unknown>;
  /** The ONLY inbound message kind accepted; any other kind fails closed. */
  readonly expectedKind: string;
  /** Parse the accepted inbound's fields into the refs-only result, or `undefined` ⇒ fail closed. */
  readonly parse: (fields: Record<string, unknown>) => TResult | undefined;
  /** A short label for the fail-closed messages (e.g. "mission-intake"). */
  readonly leg: string;
}

interface AgentRunOwnerControlRoundTripParams {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly keypair: { readonly publicKey: Uint8Array; readonly secret: Uint8Array };
  readonly runId: string;
  readonly forwardedPrincipal: string;
  readonly leg: string;
  readonly buildEnvelope: (authProof: Uint8Array) => Record<string, unknown>;
}

/**
 * (A1 run-controls) Run one owner-authed agent-run control round-trip
 * (`AgentRunReject`, later reusable for cancel if TS needs it). This mirrors dispatch's sealed
 * possession proof and resume's strict `AgentRunControlResult` settle, without reading or minting
 * operator signatures.
 */
function runAgentRunOwnerControlRoundTrip(
  params: AgentRunOwnerControlRoundTripParams,
): Promise<FridayRustHubAgentRunResumeResult> {
  const { host, port, timeoutMs, keypair, runId, forwardedPrincipal, leg, buildEnvelope } = params;
  return new Promise<FridayRustHubAgentRunResumeResult>((resolve, reject) => {
    let settled = false;
    let socket: Socket | null = null;
    let receiver: WsReceiver | null = null;
    let sessionKey: Uint8Array = new Uint8Array(0);

    const timer = setTimeout(() => {
      fail(unavailable(`Sealed agent-run client ${leg} timed out awaiting a control result.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function teardown(): void {
      clearTimeout(timer);
      if (receiver) {
        receiver.removeAllListeners();
      }
      if (socket) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        try {
          socket.destroy();
        } catch {
          // best-effort; the result is already decided.
        }
      }
    }
    function succeed(result: FridayRustHubAgentRunResumeResult): void {
      if (settled) return;
      settled = true;
      teardown();
      resolve(result);
    }
    function fail(error: FridayDomainError): void {
      if (settled) return;
      settled = true;
      teardown();
      reject(error);
    }
    function onClose(): void {
      fail(unavailable(`Sealed agent-run client ${leg} connection closed before a control result.`));
    }
    function onInbound(payload: Buffer): void {
      let inbound: InboundEnvelope;
      try {
        inbound = openInbound(sessionKey, payload);
      } catch {
        fail(unavailable(`Sealed agent-run client ${leg} could not open an inbound envelope.`));
        return;
      }
      if (inbound.kind !== "AgentRunControlResult") {
        fail(unavailable(`Sealed agent-run client ${leg} received an unknown message shape.`));
        return;
      }
      const parsed = parseControlResult(inbound.fields);
      if (!parsed) {
        fail(unavailable(`Sealed agent-run client ${leg} result is missing a required ref.`));
        return;
      }
      succeed(parsed);
    }

    void (async () => {
      let connected: Socket;
      try {
        connected = await new Promise<Socket>((res, rej) => {
          const s = connect({ host, port }, () => res(s));
          socket = s;
          s.once("error", rej);
        });
      } catch {
        fail(unavailable(`Sealed agent-run client ${leg} could not open a connection.`));
        return;
      }
      socket = connected;
      socket.setNoDelay(true);

      const reader = createPreambleReader(socket);
      try {
        socket.write(frameBytes(keypair.publicKey));
        const serverPub = await reader.readFrame();
        if (serverPub.length !== X25519_PUBKEY_LEN) {
          throw new Error("server pubkey wrong width");
        }
        const sessionNonce = await reader.readFrame();
        if (sessionNonce.length !== SESSION_NONCE_LEN) {
          throw new Error("session nonce wrong width");
        }

        sessionKey = agree(keypair.secret, serverPub);
        const { socket: sock, leftover: preambleLeftover } = reader.takeover();
        if (preambleLeftover.length > 0) {
          throw new Error("unexpected buffered bytes before ws upgrade");
        }
        const leftover = await wsClientUpgrade(sock, host, port);

        const sender = new wsRuntime.Sender(sock, undefined, () => randomBytes(4));
        const recv = new wsRuntime.Receiver({ isServer: false, binaryType: "nodebuffer", skipUTF8Validation: true });
        receiver = recv;

        recv.on("message", (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            fail(unavailable(`Sealed agent-run client ${leg} received a non-binary frame.`));
            return;
          }
          onInbound(data);
        });
        recv.on("conclude", onClose);
        recv.on("error", () => {
          fail(unavailable(`Sealed agent-run client ${leg} received a malformed WS frame.`));
        });

        sock.on("data", (chunk: Buffer) => recv.write(chunk));
        sock.on("error", () => {
          fail(unavailable(`Sealed agent-run client ${leg} connection error.`));
        });
        sock.on("close", onClose);
        if (leftover.length > 0) {
          recv.write(leftover);
        }

        const authProof = buildAuthProof({
          sessionKey,
          sessionNonce,
          sessionAad: SESSION_AAD,
          authChallenge: AUTH_CHALLENGE,
          forwardedPrincipal,
          runId,
        });
        sealAndSend(sender, sessionKey, buildEnvelope(authProof));
      } catch {
        fail(unavailable(`Sealed agent-run client ${leg} handshake failed.`));
      }
    })();
  });
}

/**
 * (Lane B) Run ONE sealed request→response round-trip for a mission-spine mutation. Mirrors the
 * `resumeWithApproval` handshake EXACTLY (connect → length-prefixed preamble → X25519+HKDF session
 * key → RFC6455 upgrade → seal+send → await the FIRST matching Result → settle), reusing the SAME
 * module-level helpers. FAIL-CLOSED (503) contract:
 *   - any non-clean settle (connect error / socket close before a result / timeout / wrong-width
 *     preamble / un-openable envelope) → fail closed;
 *   - ANY inbound whose kind != `expectedKind` — INCLUDING the server's `Error` envelope (illegal
 *     hop / missing entity / proofless completion) — → fail closed, never a partial;
 *   - a matching kind that fails to parse (missing required ref) → fail closed.
 * Never logs/returns secrets or raw bodies; the result is refs-only by construction.
 */
function runMissionRoundTrip<TResult>(params: MissionRoundTripParams<TResult>): Promise<TResult> {
  const { host, port, timeoutMs, keypair, envelope, expectedKind, parse, leg } = params;
  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let socket: Socket | null = null;
    let receiver: WsReceiver | null = null;
    let sessionKey: Uint8Array = new Uint8Array(0);

    const timer = setTimeout(() => {
      fail(unavailable(`Sealed mission-spine client (${leg}) timed out awaiting a result.`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    function teardown(): void {
      clearTimeout(timer);
      if (receiver) {
        receiver.removeAllListeners();
      }
      if (socket) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        try {
          socket.destroy();
        } catch {
          // best-effort; the result is already decided.
        }
      }
    }
    function succeed(result: TResult): void {
      if (settled) return;
      settled = true;
      teardown();
      resolve(result);
    }
    function fail(error: FridayDomainError): void {
      if (settled) return;
      settled = true;
      teardown();
      reject(error);
    }
    // The server ending the session BEFORE a result is the fail-closed path (forged peer / the
    // server ran nothing). A result already settled ⇒ this is a guarded no-op.
    function onClose(): void {
      fail(unavailable(`Sealed mission-spine client (${leg}) connection closed before a result.`));
    }
    function onInbound(payload: Buffer): void {
      let inbound: InboundEnvelope;
      try {
        inbound = openInbound(sessionKey, payload);
      } catch {
        fail(unavailable(`Sealed mission-spine client (${leg}) could not open an inbound envelope.`));
        return;
      }
      // STRICT: only the matching Result kind is accepted. A server `Error` envelope (or any other
      // kind) is a typed fail-closed — never coerced to a result, never a partial. The typed Rust
      // error keeps safe local diagnostics so a real intake/preflight failure is not masked as an
      // undifferentiated unknown-shape transport failure.
      if (inbound.kind === "Error") {
        fail(missionSpineUnavailableFromRustErrorEnvelope(leg, inbound.fields));
        return;
      }
      if (inbound.kind !== expectedKind) {
        fail(unavailable(`Sealed mission-spine client (${leg}) received an unknown message shape.`));
        return;
      }
      const parsed = parse(inbound.fields);
      if (parsed === undefined) {
        fail(unavailable(`Sealed mission-spine client (${leg}) result is missing a required ref.`));
        return;
      }
      succeed(parsed);
    }

    void (async () => {
      // (1) RAW TCP connect (NOT new WebSocket(url)) — preamble first, like dispatch/resume.
      let connected: Socket;
      try {
        connected = await new Promise<Socket>((res, rej) => {
          const s = connect({ host, port }, () => res(s));
          socket = s;
          s.once("error", rej);
        });
      } catch {
        fail(unavailable(`Sealed mission-spine client (${leg}) could not open a connection.`));
        return;
      }
      socket = connected;
      socket.setNoDelay(true);

      const reader = createPreambleReader(socket);
      try {
        // (2) preamble: write client pubkey → read server pubkey (32B) → read nonce (64B).
        socket.write(frameBytes(keypair.publicKey));
        const serverPub = await reader.readFrame();
        if (serverPub.length !== X25519_PUBKEY_LEN) {
          throw new Error("server pubkey wrong width");
        }
        const sessionNonce = await reader.readFrame();
        if (sessionNonce.length !== SESSION_NONCE_LEN) {
          throw new Error("session nonce wrong width");
        }

        // (3) derive the session key (X25519 + HKDF) over the agreed peer pubkey. The mission wire
        // shapes carry NO per-request `auth_proof` — the sealed session IS the channel auth (the
        // server enforces single-peer/single-owner), so this leg builds no possession proof.
        const derived = agree(keypair.secret, serverPub);
        sessionKey = derived;

        // (4) hand off to the WS layer over the SAME socket: manual RFC6455 upgrade, then
        // Sender/Receiver. (`sessionNonce` is consumed only to validate preamble width here.)
        void sessionNonce;
        const { socket: sock, leftover: preambleLeftover } = reader.takeover();
        if (preambleLeftover.length > 0) {
          throw new Error("unexpected buffered bytes before ws upgrade");
        }
        const leftover = await wsClientUpgrade(sock, host, port);

        const sender = new wsRuntime.Sender(sock, undefined, () => randomBytes(4));
        const recv = new wsRuntime.Receiver({ isServer: false, binaryType: "nodebuffer", skipUTF8Validation: true });
        receiver = recv;

        recv.on("message", (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            fail(unavailable(`Sealed mission-spine client (${leg}) received a non-binary frame.`));
            return;
          }
          onInbound(data);
        });
        recv.on("conclude", onClose);
        recv.on("error", () => {
          fail(unavailable(`Sealed mission-spine client (${leg}) received a malformed WS frame.`));
        });

        sock.on("data", (chunk: Buffer) => recv.write(chunk));
        sock.on("error", () => {
          fail(unavailable(`Sealed mission-spine client (${leg}) connection error.`));
        });
        sock.on("close", onClose);
        if (leftover.length > 0) {
          recv.write(leftover);
        }

        // (5) seal + send the pre-built mission envelope.
        sealAndSend(sender, derived, envelope);
      } catch {
        fail(unavailable(`Sealed mission-spine client (${leg}) handshake failed.`));
      }
    })();
  });
}

export function createFridayRustHubAgentRunSealedClient(
  options: CreateFridayRustHubAgentRunSealedClientOptions,
): FridayRustHubAgentRunSealedClient {
  const host = options.host ?? "127.0.0.1";
  const { port } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (options.clientSecret.length !== X25519_PUBKEY_LEN) {
    throw new RangeError(`clientSecret must be ${X25519_PUBKEY_LEN} bytes`);
  }
  const keypair = deviceKeypairFromSecret(options.clientSecret);
  // (A3 courier) DEFAULT-OFF run-control flag. Gates ONLY the new `AgentRunPaused` inbound branch
  // (in the dispatch ctx) and the `resumeWithApproval` method. OFF ⇒ byte-identical to today.
  const controlEnabled = options.agentRunControlViaRust === true;

  return {
    dispatchRun(
      request: FridayRustHubAgentRunSealedRequest,
    ): Promise<FridayRustHubAgentRunSealedDispatchOutcome> {
      if (!request.runId) {
        return Promise.reject(unavailable("Sealed agent-run client requires a run id."));
      }

      return new Promise<FridayRustHubAgentRunSealedDispatchOutcome>((resolve, reject) => {
        let settled = false;
        let socket: Socket | null = null;
        let receiver: WsReceiver | null = null;

        const timer = setTimeout(() => {
          fail(unavailable("Sealed agent-run client timed out awaiting a result."));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();

        function teardown(): void {
          clearTimeout(timer);
          if (receiver) {
            receiver.removeAllListeners();
          }
          if (socket) {
            socket.removeAllListeners();
            // Drop a late inbound frame onto a no-op so the destroyed socket cannot throw.
            socket.on("error", () => {});
            try {
              socket.destroy();
            } catch {
              // best-effort; the result is already decided.
            }
          }
        }
        function succeed(result: FridayRustHubAgentRunSealedDispatchOutcome): void {
          if (settled) return;
          settled = true;
          teardown();
          resolve(result);
        }
        function fail(error: FridayDomainError): void {
          if (settled) return;
          settled = true;
          teardown();
          reject(error);
        }

        // The accumulated read state across the two inbound envelopes (refs first, body optional),
        // bundled with the settlement callbacks so the module-level handlers can drive it. (A3) the
        // DEFAULT-OFF run-control flag flows in so a flag-on dispatch can settle on `AgentRunPaused`;
        // flag-off keeps the paused frame in the unknown→fail-closed bucket (byte-identical).
        const ctx: InboundContext = {
          sessionKey: new Uint8Array(0),
          refs: null,
          controlEnabled,
          succeed,
          fail,
        };

        void (async () => {
          // (1) RAW TCP connect (NOT new WebSocket(url) — its HTTP upgrade would corrupt the
          // raw preamble). connect first, then run the preamble on the raw socket.
          let connected: Socket;
          try {
            connected = await new Promise<Socket>((res, rej) => {
              const s = connect({ host, port }, () => res(s));
              // Capture the connecting socket into the outer slot SYNCHRONOUSLY, so a timeout that
              // fires DURING a slow connect still has teardown destroy it (no leaked half-open socket).
              socket = s;
              s.once("error", rej);
            });
          } catch {
            fail(unavailable("Sealed agent-run client could not open a connection."));
            return;
          }
          socket = connected;
          socket.setNoDelay(true);

          const reader = createPreambleReader(socket);
          try {
            // (2) preamble: write client pubkey → read server pubkey (32B) → read nonce (64B).
            socket.write(frameBytes(keypair.publicKey));
            const serverPub = await reader.readFrame();
            if (serverPub.length !== X25519_PUBKEY_LEN) {
              throw new Error("server pubkey wrong width");
            }
            const sessionNonce = await reader.readFrame();
            if (sessionNonce.length !== SESSION_NONCE_LEN) {
              throw new Error("session nonce wrong width");
            }

            // (3) derive the session key (X25519 + HKDF) over the agreed peer pubkey.
            const sessionKey = agree(keypair.secret, serverPub);
            ctx.sessionKey = sessionKey;

            // (4) hand off to the WS layer over the SAME socket: manual RFC6455 upgrade, then
            // Sender/Receiver. The preamble reader detaches its listeners on takeover().
            const { socket: sock, leftover: preambleLeftover } = reader.takeover();
            // INVARIANT: tungstenite cannot send the 101 before it receives our GET (written inside
            // wsClientUpgrade, AFTER takeover), so the preamble reader cannot have buffered any
            // upgrade-response bytes. If it somehow did (a pipelining non-loopback server), the fresh
            // upgrade read would silently lose them — so fail CLOSED here instead of dropping them.
            if (preambleLeftover.length > 0) {
              throw new Error("unexpected buffered bytes before ws upgrade");
            }
            const leftover = await wsClientUpgrade(sock, host, port);

            const sender = new wsRuntime.Sender(sock, undefined, () => randomBytes(4));
            const recv = new wsRuntime.Receiver({ isServer: false, binaryType: "nodebuffer", skipUTF8Validation: true });
            receiver = recv;

            recv.on("message", (data: Buffer, isBinary: boolean) => {
              if (!isBinary) {
                fail(unavailable("Sealed agent-run client received a non-binary frame."));
                return;
              }
              handleInbound(ctx, data);
            });
            // The server closed the session. Before any refs ⇒ fail-closed (forged peer / bad
            // principal). After refs the client already settled, so this is a guarded no-op
            // (leg-A decouple: a body-frame-less close is no longer a failure).
            recv.on("conclude", () => handleServerClose(ctx));
            recv.on("error", () => {
              fail(unavailable("Sealed agent-run client received a malformed WS frame."));
            });

            sock.on("data", (chunk: Buffer) => recv.write(chunk));
            sock.on("error", () => {
              fail(unavailable("Sealed agent-run client connection error."));
            });
            sock.on("close", () => handleServerClose(ctx));
            // Feed any bytes that arrived bundled with the upgrade response.
            if (leftover.length > 0) {
              recv.write(leftover);
            }

            // (5) seal + send the AgentRunRequest envelope.
            const authProof = buildAuthProof({
              sessionKey,
              sessionNonce,
              sessionAad: SESSION_AAD,
              authChallenge: AUTH_CHALLENGE,
              forwardedPrincipal: request.forwardedPrincipal,
              runId: request.runId,
            });
            // (A2a Phase 1) Forward `session_id` ONLY when the run carries a non-empty session
            // key. A blank/absent key OMITS the field entirely (it is NOT set to null/undefined),
            // so the serialized envelope is BYTE-IDENTICAL to the pre-A2a sessionless request —
            // the Rust server then routes it through the unchanged sessionless dispatch path.
            const sessionId =
              typeof request.sessionKey === "string" && request.sessionKey.trim().length > 0
                ? request.sessionKey.trim()
                : undefined;
            // (A1 run-controls) Derive the snake_case `constraints` wire block from the request's
            // per-run constraints, emitting it ONLY when the caller actually asserts a TIGHTENING
            // (read-only, a non-empty disabled-tool set, or a max-turns cap). When NOTHING is
            // asserted the whole `constraints` key is OMITTED, so the serialized envelope is
            // BYTE-IDENTICAL to the pre-A1 request and the server applies no override. This
            // mirrors the `session_id` conditional-spread discipline.
            const constraintsWire = buildConstraintsWire(request.constraints);
            // (NS45-PR1 / M-4) Derive the snake_case `mission_context` wire block from the request's
            // first-class Mission handle, emitting it ONLY when a handle is present. When NO handle is
            // given the whole `mission_context` key is OMITTED, so the serialized envelope is
            // BYTE-IDENTICAL to the pre-NS45 request and the server routes through the unchanged
            // unbound dispatch path. This mirrors the `session_id` conditional-spread discipline.
            const missionContextWire = buildMissionContextWire(request.missionContext);
            const envelope = {
              schema_version: SCHEMA_VERSION,
              msg_id: `agent-run-${request.runId}`,
              correlation_id: `agent-run-${request.runId}`,
              sent_at: Date.now(),
              message: {
                kind: "AgentRunRequest",
                run_id: request.runId,
                task: request.task,
                forwarded_principal: request.forwardedPrincipal,
                // serde `Vec<u8>` serializes as a JSON ARRAY of byte numbers (NOT base64/hex).
                auth_proof: Array.from(authProof),
                // Conditional spread: present ⇒ `session_id` rides the wire; absent ⇒ no key.
                ...(sessionId !== undefined ? { session_id: sessionId } : {}),
                // Conditional spread: present ⇒ `constraints` rides the wire; absent ⇒ no key.
                ...(constraintsWire !== undefined ? { constraints: constraintsWire } : {}),
                // Conditional spread: present ⇒ `mission_context` rides the wire; absent ⇒ no key.
                ...(missionContextWire !== undefined ? { mission_context: missionContextWire } : {}),
              },
            };
            sealAndSend(sender, sessionKey, envelope);
          } catch {
            fail(unavailable("Sealed agent-run client handshake failed."));
          }
        })();
      });
    },

    resumeWithApproval(
      request: FridayRustHubAgentRunResumeRequest,
    ): Promise<FridayRustHubAgentRunResumeResult> {
      // (A3 courier) FLAG-GATED: with the run-control flag OFF the courier relays NOTHING — it fails
      // closed without opening a socket. This keeps the default-off posture byte-identical (the
      // method exists but is inert) and never sends an `AgentRunResume` the server would ignore.
      if (!controlEnabled) {
        return Promise.reject(
          unavailable("Sealed agent-run client run-control is disabled (resume relay refused)."),
        );
      }
      if (!request.runId) {
        return Promise.reject(unavailable("Sealed agent-run client resume requires a run id."));
      }
      // INV-1 (pure courier): the blob is OPAQUE — TS inspects/derives/authors NOTHING inside it. We
      // require only that SOME bytes are present (an empty blob can carry no signature ⇒ fail closed).
      if (!(request.opaqueSignedBlob instanceof Uint8Array) || request.opaqueSignedBlob.length === 0) {
        return Promise.reject(
          unavailable("Sealed agent-run client resume requires a signed approval blob."),
        );
      }

      // Open a FRESH sealed session bound to the SAME credentials (`clientSecret`) + the SAME run_id
      // (design §2.1: reconnect is safe because the NONCE inside the blob is the single-use authority,
      // not the socket). The merged `AgentRunResume` is SELF-authenticating via the blob — it carries
      // NO `auth_proof`/`forwarded_principal` — so this leg does not rebuild a possession proof.
      return new Promise<FridayRustHubAgentRunResumeResult>((resolve, reject) => {
        let settled = false;
        let socket: Socket | null = null;
        let receiver: WsReceiver | null = null;
        let controlResult: FridayRustHubAgentRunResumeResult | null = null;
        // Typed as the WIDE `Uint8Array` (matching `InboundContext.sessionKey`) so the
        // `agree()`-derived key (`Uint8Array<ArrayBufferLike>`) assigns without a buffer-kind mismatch.
        let resumeSessionKey: Uint8Array = new Uint8Array(0);

        const timer = setTimeout(() => {
          fail(unavailable("Sealed agent-run client resume timed out awaiting a result."));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();

        function teardown(): void {
          clearTimeout(timer);
          if (receiver) {
            receiver.removeAllListeners();
          }
          if (socket) {
            socket.removeAllListeners();
            socket.on("error", () => {});
            try {
              socket.destroy();
            } catch {
              // best-effort; the result is already decided.
            }
          }
        }
        function succeed(result: FridayRustHubAgentRunResumeResult): void {
          if (settled) return;
          settled = true;
          teardown();
          resolve(result);
        }
        function fail(error: FridayDomainError): void {
          if (settled) return;
          settled = true;
          teardown();
          reject(error);
        }
        // The server ending the session BEFORE a control result is the fail-closed path (forged peer /
        // bad blob / the server ran nothing). A control result already settled ⇒ guarded no-op.
        function onClose(): void {
          if (controlResult) {
            succeed(controlResult);
            return;
          }
          fail(unavailable("Sealed agent-run client resume connection closed before a result."));
        }
        function onInbound(payload: Buffer): void {
          let inbound: InboundEnvelope;
          try {
            inbound = openInbound(resumeSessionKey, payload);
          } catch {
            fail(unavailable("Sealed agent-run client resume could not open an inbound envelope."));
            return;
          }
          if (inbound.kind !== "AgentRunControlResult") {
            fail(unavailable("Sealed agent-run client resume received an unknown message shape."));
            return;
          }
          const parsed = parseControlResult(inbound.fields);
          if (!parsed) {
            fail(unavailable("Sealed agent-run client resume result is missing a required ref."));
            return;
          }
          // A server REFUSAL (`accepted=false`) is a SUCCESSFUL relay of a refusal outcome — resolve
          // with it (the caller inspects `accepted`), it is NOT a transport failure.
          controlResult = parsed;
          succeed(parsed);
        }

        void (async () => {
          // (1) RAW TCP connect (NOT new WebSocket(url)) — preamble first, like dispatch.
          let connected: Socket;
          try {
            connected = await new Promise<Socket>((res, rej) => {
              const s = connect({ host, port }, () => res(s));
              socket = s;
              s.once("error", rej);
            });
          } catch {
            fail(unavailable("Sealed agent-run client resume could not open a connection."));
            return;
          }
          socket = connected;
          socket.setNoDelay(true);

          const reader = createPreambleReader(socket);
          try {
            // (2) preamble: write client pubkey → read server pubkey (32B) → read nonce (64B).
            socket.write(frameBytes(keypair.publicKey));
            const serverPub = await reader.readFrame();
            if (serverPub.length !== X25519_PUBKEY_LEN) {
              throw new Error("server pubkey wrong width");
            }
            const sessionNonce = await reader.readFrame();
            if (sessionNonce.length !== SESSION_NONCE_LEN) {
              throw new Error("session nonce wrong width");
            }

            // (3) derive the session key (X25519 + HKDF) over the agreed peer pubkey.
            const sessionKey = agree(keypair.secret, serverPub);
            resumeSessionKey = sessionKey;

            // (4) hand off to the WS layer over the SAME socket: manual RFC6455 upgrade, then
            // Sender/Receiver.
            const { socket: sock, leftover: preambleLeftover } = reader.takeover();
            if (preambleLeftover.length > 0) {
              throw new Error("unexpected buffered bytes before ws upgrade");
            }
            const leftover = await wsClientUpgrade(sock, host, port);

            const sender = new wsRuntime.Sender(sock, undefined, () => randomBytes(4));
            const recv = new wsRuntime.Receiver({ isServer: false, binaryType: "nodebuffer", skipUTF8Validation: true });
            receiver = recv;

            recv.on("message", (data: Buffer, isBinary: boolean) => {
              if (!isBinary) {
                fail(unavailable("Sealed agent-run client resume received a non-binary frame."));
                return;
              }
              onInbound(data);
            });
            recv.on("conclude", onClose);
            recv.on("error", () => {
              fail(unavailable("Sealed agent-run client resume received a malformed WS frame."));
            });

            sock.on("data", (chunk: Buffer) => recv.write(chunk));
            sock.on("error", () => {
              fail(unavailable("Sealed agent-run client resume connection error."));
            });
            sock.on("close", onClose);
            if (leftover.length > 0) {
              recv.write(leftover);
            }

            // (5) seal + send the AgentRunResume envelope (built by the pure, wire-tested
            // `buildResumeEnvelope` — `{run_id, signed_blob}`, the blob relayed VERBATIM; INV-1).
            const envelope = buildResumeEnvelope(request.runId, request.opaqueSignedBlob);
            sealAndSend(sender, sessionKey, envelope);
          } catch {
            fail(unavailable("Sealed agent-run client resume handshake failed."));
          }
        })();
      });
    },

    rejectApproval(
      request: FridayRustHubAgentRunRejectRequest,
    ): Promise<FridayRustHubAgentRunResumeResult> {
      if (!controlEnabled) {
        return Promise.reject(
          unavailable("Sealed agent-run client run-control is disabled (reject refused)."),
        );
      }
      if (!request.runId) {
        return Promise.reject(unavailable("Sealed agent-run client reject requires a run id."));
      }
      if (!request.approvalId) {
        return Promise.reject(unavailable("Sealed agent-run client reject requires an approval id."));
      }
      if (!request.forwardedPrincipal) {
        return Promise.reject(
          unavailable("Sealed agent-run client reject requires a forwarded principal."),
        );
      }
      return runAgentRunOwnerControlRoundTrip({
        host,
        port,
        timeoutMs,
        keypair,
        runId: request.runId,
        forwardedPrincipal: request.forwardedPrincipal,
        leg: "reject",
        buildEnvelope: (authProof) =>
          buildRejectEnvelope(
            request.runId,
            request.approvalId,
            request.forwardedPrincipal,
            authProof,
          ),
      });
    },

    intakeMission(
      request: FridayRustHubMissionIntakeRequest,
    ): Promise<FridayRustHubMissionIntakeResult> {
      if (!request.missionId || !request.fridayConversationId) {
        return Promise.reject(
          unavailable("Sealed mission-spine client intake requires a mission id and conversation id."),
        );
      }
      return runMissionRoundTrip<FridayRustHubMissionIntakeResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildMissionIntakeEnvelope(request),
        expectedKind: "MissionIntakeResult",
        parse: parseMissionIntakeResult,
        leg: "mission-intake",
      });
    },

    transitionMission(
      request: FridayRustHubMissionLifecycleRequest,
    ): Promise<FridayRustHubMissionLifecycleResult> {
      if (!request.missionId || !request.targetStatus) {
        return Promise.reject(
          unavailable("Sealed mission-spine client lifecycle requires a mission id and target status."),
        );
      }
      return runMissionRoundTrip<FridayRustHubMissionLifecycleResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildMissionLifecycleEnvelope(request),
        expectedKind: "MissionLifecycleResult",
        parse: parseMissionLifecycleResult,
        leg: "mission-lifecycle",
      });
    },

    transitionWorkItem(
      request: FridayRustHubWorkItemStatusRequest,
    ): Promise<FridayRustHubWorkItemStatusResult> {
      if (!request.workItemId || !request.targetStatus) {
        return Promise.reject(
          unavailable("Sealed mission-spine client work-item requires a work-item id and target status."),
        );
      }
      return runMissionRoundTrip<FridayRustHubWorkItemStatusResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildWorkItemStatusEnvelope(request),
        expectedKind: "WorkItemStatusResult",
        parse: parseWorkItemStatusResult,
        leg: "work-item-status",
      });
    },

    controlRouteDecision(
      request: FridayRustHubRouteDecisionControlRequest,
    ): Promise<FridayRustHubRouteDecisionControlResult> {
      if (!request.decisionId || !request.controlKind) {
        return Promise.reject(
          unavailable("Sealed mission-spine client route decision control requires a decision id and control kind."),
        );
      }
      return runMissionRoundTrip<FridayRustHubRouteDecisionControlResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildRouteDecisionControlEnvelope(request),
        expectedKind: "RouteDecisionControlResult",
        parse: parseRouteDecisionControlResult,
        leg: "route-decision-control",
      });
    },

    decideMemory(
      request: FridayRustHubMemoryDecisionRequest,
    ): Promise<FridayRustHubMemoryDecisionResult> {
      if (!request.memoryId || !request.ownerPrincipal) {
        return Promise.reject(
          unavailable("Sealed memory-spine client decision requires a memory id and owner principal."),
        );
      }
      if (request.decision !== "confirm" && request.decision !== "reject") {
        return Promise.reject(
          unavailable("Sealed memory-spine client decision must be 'confirm' or 'reject'."),
        );
      }
      return runMissionRoundTrip<FridayRustHubMemoryDecisionResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildMemoryDecisionEnvelope(request),
        expectedKind: "MemoryDecisionResult",
        parse: parseMemoryDecisionResult,
        leg: "memory-decision",
      });
    },

    decideRunOutcomeLearning(
      request: FridayRustHubRunOutcomeLearningDecisionRequest,
    ): Promise<FridayRustHubRunOutcomeLearningDecisionResult> {
      if (!request.candidateId) {
        return Promise.reject(
          unavailable("Sealed A1 run-outcome learning decision requires a candidate id."),
        );
      }
      if (request.decision !== "confirm" && request.decision !== "reject") {
        return Promise.reject(
          unavailable("Sealed A1 run-outcome learning decision must be 'confirm' or 'reject'."),
        );
      }
      return runMissionRoundTrip<FridayRustHubRunOutcomeLearningDecisionResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildRunOutcomeLearningDecisionEnvelope(request),
        expectedKind: "RunOutcomeLearningDecisionResult",
        parse: parseRunOutcomeLearningDecisionResult,
        leg: "run-outcome-learning-decision",
      });
    },

    createSession(
      request: FridayRustHubSessionCreateRequest,
    ): Promise<FridayRustHubSessionCreateResult> {
      if (!request.sessionId) {
        return Promise.reject(
          unavailable("Sealed session client create requires a session id."),
        );
      }
      return runMissionRoundTrip<FridayRustHubSessionCreateResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildSessionCreateEnvelope(request),
        expectedKind: "SessionCreateResult",
        parse: parseSessionCreateResult,
        leg: "session-create",
      });
    },

    appendSessionMessage(
      request: FridayRustHubSessionMessageAppendRequest,
    ): Promise<FridayRustHubSessionMessageAppendResult> {
      if (!request.sessionId || !request.role) {
        return Promise.reject(
          unavailable("Sealed session client append requires a session id and role."),
        );
      }
      return runMissionRoundTrip<FridayRustHubSessionMessageAppendResult>({
        host,
        port,
        timeoutMs,
        keypair,
        envelope: buildSessionMessageAppendEnvelope(request),
        expectedKind: "SessionMessageAppendResult",
        parse: parseSessionMessageAppendResult,
        leg: "session-message-append",
      });
    },
  };
}
