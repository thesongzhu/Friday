//! WS substrate **S-C** + **S-E** + **S-F** — `hub_agent_run_server`: the long-lived loopback
//! agent-run WS server bin, with the authed agent-run DISPATCH arm (S-C) HARDENED against REPLAY
//! (S-E) and the connecting PEER authenticated against a SecureStore pubkey allowlist (S-F).
//!
//! ## S-F peer authentication (this revision — DARK, security-critical)
//! S-C/S-E authenticated the *channel* (a correct ECDH handshake) and the *forwarded principal*
//! (owner-allowlist), but NOT the *peer process*: a FRESH local keypair could complete the
//! handshake and forge an openable `auth_proof` for an allowlisted owner string (owner strings are
//! identifiers, not secrets). That is the **FORGERY** gap S-E explicitly deferred. S-F closes it by
//! authenticating the PEER itself:
//! * **SecureStore peer-pubkey allowlist.** At boot the server loads, from [`SecureStore`], an
//!   allowlist of authorized peer X25519 public keys (the production TS-API peer's pubkey[s]). On
//!   each connection, [`establish_session`] checks the peer's pubkey against that allowlist as the
//!   FIRST gate — BEFORE the low-order check, BEFORE sending the server pubkey/nonce, BEFORE any
//!   `agree()`. A non-allowlisted pubkey ⇒ NO session (fail closed; the connection ends and the
//!   peer learns nothing — no server pubkey, no nonce, no agree, no auth, no dispatch). A fresh
//!   local keypair that is NOT in the allowlist can no longer forge a session.
//! * **Fail-closed on a missing/invalid allowlist.** [`load_peer_allowlist`] treats a MISSING entry
//!   (None) and an INVALID entry (empty, or not a nonzero multiple of 32 bytes) as a boot failure:
//!   the server REFUSES TO START rather than falling open to "accept any peer". It never defaults
//!   to an empty/open allowlist.
//!
//! **Key-material boundary + the persistent store (execrun-enablement slice 3).** The allowlist
//! material is SecureStore-derived and stays OUTSIDE agent-readable surfaces — NEVER in the repo,
//! logs, artifacts, or any prompt-visible config; the server reports only presence/validity (bool)
//! plus a count, never the pubkey bytes. At boot the server now opens the PERSISTENT
//! [`FileSecureStore`] the `hub_agent_run_enroll` CLI provisions: it reads the master key via
//! [`friday_hub::key_source::read_master_key`] (env-or-file, **never auto-generated**), derives the
//! store KEK via [`friday_hub::key_source::derive_file_store_kek`] and DROPS the `Zeroizing` master
//! immediately, resolves the store dir (`--store-dir`, default
//! [`friday_hub::key_source::default_store_dir`]), and opens the store under that KEK to load the
//! allowlist. An UNPROVISIONED host (no master key, or no/empty/corrupt allowlist) makes the binary
//! REFUSE TO BOOT — it never falls open to "accept any peer", and there is NO `--peer-pubkey`
//! arg/env fallback (the SecureStore-derived decision is binding). This still lands DARK: nothing
//! connects to it in production (no production caller, no LaunchAgent entry) until the slice-6
//! live-flip. Tests provision a temp [`FileSecureStore`] / [`friday_crypto::InMemorySecureStore`]
//! fixture and drive `accept_one`/`establish_session`/`load_peer_allowlist` directly (NOT `run()`),
//! so no real production key material is required to build or test.
//!
//! S-F is ADDITIVE: the peer gate is a NEW check BEFORE the S-C/S-E gates (low-order check,
//! per-handshake nonce, owner-allowlist, possession-of-session, msg_id dedup), not a reorder of
//! them — all of those PRESERVE'd properties still hold and are still exercised through the real
//! `accept_one` path (the migrated tests allowlist the client pubkey so each pre-existing gate is
//! still the layer that rejects in its own test). `rust_wired` at best; NOT v1 GO; `executeRun` is
//! NOT replaced; the live forged-peer proof is the coordinator's at slice-6.
//!
//! ## S-E anti-replay (this revision — DARK, security-critical)
//! S-C's adversarial panel found a REAL replay hole: the auth challenge was a FIXED constant and
//! `server_kp` is stable-per-boot, so a captured sealed `auth_proof` RE-AUTHENTICATED verbatim on
//! a later connection (the attacker replays the public peer-pubkey preamble → same session key →
//! the stale proof opens). S-E kills replay-to-AUTHENTICATE two ways:
//! * **per-handshake nonce.** [`establish_session`] generates a FRESH CSPRNG nonce per connection
//!   ([`generate_approval_nonce`], OsRng) and sends it cleartext; the peer must seal
//!   `AUTH_CHALLENGE || session_nonce` in its `auth_proof`. A proof captured under nonce `N1`
//!   cannot verify on a new handshake (nonce `N2`) — the attacker cannot re-seal `…||N2` without
//!   the paired ECDH private half. The AAD also length-binds `(principal, run_id)` so a proof
//!   can't be LIFTED to a different pair.
//! * **per-session msg_id dedup.** [`serve_sealed_session`] wires a fresh [`IdempotencyTracker`]
//!   so a replayed `msg_id` WITHIN a session is rejected fail-closed.
//!
//! S-E closes REPLAY. It did NOT add PEER authentication — a FRESH local process completing the
//! CURRENT handshake and forging a proof for an allowlisted owner string. **S-F (this revision)
//! CLOSES that FORGERY gap** with the SecureStore peer-pubkey allowlist gate described above: only
//! an allowlisted peer pubkey establishes a session.
//!
//! ## What this slice is (DARK)
//! S-B stood up the SERVER plus per-session sealed key establishment (peer pubkey from the
//! wire, ECDH to a session key) and a fail-closed serve loop with **NO dispatch**. **S-C**
//! adds, on a sealed [`Message::AgentRunRequest`]: VERIFY the forwarded principal against the
//! established session (via `AuthedPrincipal::authenticate_forwarded`, which checks
//! possession-of-session, non-empty, non-anonymous, and owner-allowlist), then DISPATCH to the
//! Rust agent loop ([`run_authed_agent_loop`]) and return a REFS-ONLY
//! [`Message::AgentRunResult`] over the wire while delivering the answer BODY **sealed** back
//! over the same session (the owner-only channel).
//!
//! It STILL lands DARK: nothing connects to it in production (no production caller, no
//! LaunchAgent entry). A LATER sub-slice (S-F) wires a production caller behind a default-off
//! flag and runs the live forged-principal-fails-closed proof. Removing this file reverts S-C.
//!
//! ## Truth label
//! WS substrate **S-C + S-E**. Loopback-only. **Dev key-exchange** (the PRODUCTION key source —
//! loopback pairing handshake vs SecureStore — is a LATER decision, deferred; here both peers
//! hold their OWN keypair and ECDH at connect). The bound principal is
//! **TRUSTED-PEER-FORWARDED** (the in-TCB TS API resolved it from a validated bearer token and
//! forwarded it over the sealed session) — NOT a client-asserted string; the sealed session is
//! the basis of trust and the owner-allowlist is the final ceiling.
//!
//! **S-E closes REPLAY** (a captured `auth_proof` no longer re-authenticates across handshakes —
//! per-handshake nonce; a replayed `msg_id` within a session is rejected). **PEER-AUTH is STILL
//! DEFERRED to S-F**: a fresh local process completing the CURRENT handshake can still forge a
//! proof for an allowlisted owner string — only loopback + the dark / no-prod-caller posture
//! bounds it. **Wire-format change (for S-F / the dark S-D TS client):** the server now emits a
//! cleartext NONCE frame AFTER its pubkey and BEFORE the WS upgrade; any real peer MUST read that
//! frame or its WS handshake desyncs. (The S-D TS client is hermetic/refs-only and does NOT speak
//! this preamble, so it is unaffected; S-F's production caller must read the nonce.) Production
//! key-source + a supervisor are deferred (open-qs). `rust_wired` at best; NOT v1 GO; `executeRun`
//! is NOT replaced; the live forged-principal proof is the coordinator's at S-F.
//!
//! ## Why this is NOT the `hub_authed_run` ECDH anti-pattern
//! The proof bin `hub_authed_run` generates BOTH ECDH halves in-process and seals to itself — an
//! auth BYPASS acceptable only for an in-process one-shot proof. This server does NOT: it
//! generates exactly ONE keypair (its OWN, at boot), and the EXTERNAL peer's public key is read
//! FROM THE WIRE. The server can never fabricate the peer's half — a caller that does not hold
//! the matching private key derives a different session key and its sealed envelopes (including
//! `auth_proof`) will not open (fail-closed). **A session key alone is NOT authorization:** even
//! a correct-handshake peer is rejected unless its forwarded principal is allowlisted.
//!
//! ## Hardening preconditions (S-B adversarial verify — gated BEFORE dispatch)
//! * **Non-contributory peer key rejected.** `agree()` discards `was_contributory()`, so a peer
//!   that sends a known low-order X25519 point would drive an all-zero shared secret. We reject
//!   the canonical low-order points in [`establish_session`] BEFORE deriving the session key —
//!   no session, no dispatch.
//! * **Per-connection read timeout.** Each accepted connection gets a [`READ_TIMEOUT`] on its
//!   `TcpStream` BEFORE the preamble read, so a stalled/slow-loris peer cannot wedge the
//!   long-lived single-threaded accept loop before auth/dispatch.
//!
//! ## Live key
//! [`HubRuntime::live`] reads the DeepSeek key from the env (`DeepSeekClient::from_env`, never
//! logged). It only CONSTRUCTS the client (no network call); running an actual agent-run needs
//! `FRIDAY_DEEPSEEK_API_KEY` — the SEPARATE operator live-proof. CI only BUILDS this bin and the
//! tests drive a MOCK-transport runtime (never [`HubRuntime::live`]).

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use friday_crypto::{seal, DataKey, DeviceKeypair, FileSecureStore};
use friday_deepseek::{Transport, UreqTransport};
use friday_hub::hub_server::{AuthedPrincipal, ForwardedAuth};
use friday_hub::key_source::{PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN};
use friday_hub::runtime::{HubConfig, HubRuntime};
// S-R0: the handshake + peer-allowlist + low-order check + sealed-proof codec now come from the
// SHARED substrate so the read server and this write server cannot drift in crypto/auth. The write
// path re-expresses its prior behavior through these — byte-identical (same preamble framing, same
// constants, same `bound_context = run_id.as_bytes()`).
use friday_hub::sealed_ws::{
    decode_sealed_proof, encode_sealed_proof, enforce_single_peer, establish_session,
    load_peer_allowlist,
};
use friday_protocol::{Envelope, IdempotencyTracker, Message, Seen};
use friday_transport::{ws_recv_envelope, ws_send_envelope, TransportError, WireWebSocket};

/// The session AAD binding every sealed envelope on an S-C session to this protocol/version.
/// A fixed, public, non-secret constant (the confidentiality is in the session key, not the AAD).
const SESSION_AAD: &[u8] = b"friday:execrun:ws:s-c:agent-run-session:aad:v1";

/// The BASE authentication challenge the trusted peer seals (in `auth_proof`) to prove
/// possession of the session key. A fixed, public, non-secret constant — but as of S-E it is
/// NOT the sole binding: the peer seals `AUTH_CHALLENGE || session_nonce` (a FRESH per-handshake
/// CSPRNG nonce), and the AAD additionally binds the principal + run_id. The security against
/// REPLAY is in the per-handshake nonce (a captured proof sealed a DIFFERENT nonce and no longer
/// verifies); the security against forgery is still in possessing the session key.
const AUTH_CHALLENGE: &[u8] = b"friday:execrun:ws:s-c:authed-run:challenge:v1";

/// Per-connection read timeout: a stalled peer cannot wedge the long-lived accept loop before
/// auth/dispatch. Set on the `TcpStream` BEFORE the cleartext preamble read; it propagates
/// through the WS layer (the underlying stream is the same socket).
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// M5 (within-session bound — defense-in-depth). The per-session [`IdempotencyTracker`] is
/// insert-only (never evicts — eviction would reopen anti-replay). It is minted on the stack of
/// `serve_sealed_session` and dropped on session END, so it cannot grow across sessions; this caps
/// the DISTINCT `msg_id`s a single authenticated session may stream before it is fail-closed (an
/// allowlisted peer streaming unbounded distinct ids = self-DoS). At the cap a NEW id ENDS the
/// session WITHOUT being inserted; a REPLAY of an already-seen id still hits the normal Replay path.
const MAX_SESSION_MSG_IDS: usize = 100_000;

// S-F: the SecureStore allowlist id (`PEER_PUBKEY_ALLOWLIST_ID`) and the X25519 pubkey width
// (`X25519_PUBKEY_LEN`) are NOT redefined here — they are imported from `friday_hub::key_source`
// (the single source of truth shared with the enroll CLI). MED-1: a local copy would let a future
// edit silently desync the enroll-CLI's id/len from the server's, fail-closing the allowlist read
// at cutover. The server now redefines NONE of {the id, the pubkey length, the KEK derivation, the
// store-dir default} — all come from key_source.

/// A boot-time failure category. Coarse + safe — the raw detail is NOT surfaced so a storage/init
/// error cannot leak a path or a key.
#[derive(Debug)]
enum ServerError {
    BadArgs,
    Bind,
    Init,
    /// S-F: the SecureStore peer-pubkey allowlist is MISSING or INVALID ⇒ FAIL CLOSED (the server
    /// refuses to start rather than accept any peer). The detail (which) is NOT surfaced.
    PeerAllowlist,
    /// FIX-Q3a (hardening): the allowlist loaded+parsed cleanly but holds MORE THAN ONE peer pubkey.
    /// Multi-peer is REFUSED until the multi-principal bindings land (FIX-Q2: bind exec owner to the
    /// authenticated caller; FIX-Q3b: a tamper-evident pubkey→principal map so the caller principal
    /// is DERIVED from the matched pubkey, not the wire-asserted `forwarded_principal`). Until then a
    /// 2nd enrolled pubkey + the client-asserted owner string would form a confidentiality-leaking
    /// chain (any enrolled peer forwards the single owner → receives the owner-sealed body). This
    /// turns the single-peer CLI convention into a SERVER invariant. The count is NOT surfaced.
    MultiPeerUnsupported,
    /// The master key (`FRIDAY_MASTER_KEY` / `~/.friday/master.key`) is absent or unreadable ⇒ the
    /// server REFUSES TO BOOT. An unprovisioned host has no service; it NEVER auto-generates a key
    /// (that would derive a KEK that cannot open the enroll CLI's store). The category only — never
    /// the key bytes or the file path.
    MasterKeyUnavailable,
    /// The persistent FileSecureStore cannot be resolved/opened (e.g. `$HOME` unset so the default
    /// store dir is unresolvable, or the open failed) ⇒ FAIL CLOSED. The category only — never the
    /// path (a path can carry the operator's home/username).
    StoreUnavailable,
    /// `FRIDAY_OPERATOR_VK_PATH` is SET but the file is unreadable or not a valid 64-hex Ed25519
    /// public key ⇒ REFUSE TO BOOT. A configured-but-broken operator key MUST be a loud, distinct
    /// failure (not the generic `init_failed`) so the operator notices — it NEVER silently degrades
    /// to "no key provisioned" (which would Pause every protected action). UNSET ⇒ this is not
    /// reached (that is `Ok(None)`, fail-closed Pause). The category only — never the (public, but
    /// operator-controlled) key bytes, never the path.
    OperatorVk,
}

fn main() {
    if let Err(err) = run() {
        let kind = match err {
            ServerError::BadArgs => "bad_args",
            ServerError::Bind => "bind_failed",
            ServerError::Init => "init_failed",
            // S-F: a missing/invalid SecureStore peer-pubkey allowlist fails the boot CLOSED. The
            // category only — never the (would-be) pubkey bytes.
            ServerError::PeerAllowlist => "peer_allowlist_unavailable",
            // FIX-Q3a: >1 enrolled peer pubkey is refused at boot (single-peer is now a code
            // invariant). The category only — never the count, never the pubkey bytes.
            ServerError::MultiPeerUnsupported => "peer_allowlist_multi_peer_unsupported",
            // Boot fail-closed reasons for the persistent store. NON-LEAKING: never the key bytes
            // and never the store path (which can carry the operator's home/username).
            ServerError::MasterKeyUnavailable => "master_key_unavailable",
            ServerError::StoreUnavailable => "secure_store_unavailable",
            // A configured-but-malformed operator verify key fails the boot CLOSED + DISTINCT from
            // a DB/init error (so the operator can tell a broken approval key apart from a storage
            // fault). The category only — never the key bytes, never the path.
            ServerError::OperatorVk => "operator_vk_malformed",
        };
        eprintln!("hub_agent_run_server_unavailable: {kind}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), ServerError> {
    let args: Vec<String> = env::args().collect();

    let workspace_root = arg_value(&args, "--workspace").ok_or(ServerError::BadArgs)?;
    let port: u16 = arg_value(&args, "--port")
        .map(|p| p.parse::<u16>().map_err(|_| ServerError::BadArgs))
        .transpose()?
        .unwrap_or(0);

    // The Hub OWNER allowlist (v1 = a single configured owner). HUB-SUPPLIED here (operator CLI
    // arg), NEVER client-controlled — it is the ceiling on which forwarded principals may run.
    // A blank/missing owner ⇒ an EMPTY allowlist ⇒ EVERY dispatch is rejected (fail-closed: a
    // server with no configured owner runs nothing).
    let owner_allowlist: Vec<String> = arg_value(&args, "--owner")
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .into_iter()
        .collect();

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let db_path = arg_value(&args, "--db").unwrap_or_else(|| {
        format!("{workspace_root}/.hub-agent-run-server-dev-{pid}-{nanos}.sqlite")
    });

    // (0) S-F PEER AUTH — open the PERSISTENT FileSecureStore the enroll CLI provisioned, then load
    // the authorized peer-pubkey allowlist from it BEFORE anything else, FAILING CLOSED at every
    // step. The store key material is sourced via `friday_hub::key_source` (the single source of
    // truth shared with the enroll CLI), NOT a CLI arg/env key:
    //   * read the master key fail-closed (env-or-file; NEVER auto-generated — a missing key means
    //     the host is UNPROVISIONED, so the server refuses to boot rather than mint a key that
    //     would derive a KEK the enroll CLI's store can't be opened under);
    //   * derive the FileSecureStore KEK and DROP the master immediately (it is `Zeroizing`, so the
    //     drop wipes it — the master never lives past the one derivation it is needed for);
    //   * resolve the store dir (`--store-dir`, default `key_source::default_store_dir()`, which is
    //     fail-closed if `$HOME` is unset) and open the store under the derived KEK.
    // An unprovisioned server (no master key, or no/empty/corrupt allowlist) REFUSES TO START — it
    // never falls open to "accept any peer". The store is only needed at boot to load the allowlist;
    // it is dropped immediately after (below) so the KEK does not sit in memory during the (long-
    // lived) serving loop. This STAYS DARK: nothing connects to it in production (no production
    // caller, no LaunchAgent entry) until the slice-6 live-flip. We report only the COUNT — never
    // the pubkey bytes, never the master, never the store path.
    let master = friday_hub::key_source::read_master_key().map_err(|_| {
        // The category is surfaced via the ServerError mapping; the key bytes are never touched.
        ServerError::MasterKeyUnavailable
    })?;
    let kek = friday_hub::key_source::derive_file_store_kek(&master);
    drop(master); // `Zeroizing` ⇒ the master is wiped now; only the KEK survives.
    let store_dir: PathBuf = match arg_value(&args, "--store-dir") {
        Some(d) => PathBuf::from(d),
        None => friday_hub::key_source::default_store_dir()
            .map_err(|_| ServerError::StoreUnavailable)?,
    };
    let secure_store =
        FileSecureStore::open(&store_dir, kek).map_err(|_| ServerError::StoreUnavailable)?;
    let peer_allowlist =
        load_peer_allowlist(&secure_store, PEER_PUBKEY_ALLOWLIST_ID).map_err(|_| {
            // The category is logged via the ServerError mapping; the bytes are never touched.
            ServerError::PeerAllowlist
        })?;
    // FIX-Q3a (hardening) — fail the BOOT closed unless EXACTLY ONE peer is enrolled. The loader is a
    // multi-key parser, so without this guard a 2nd enrolled pubkey would be silently admitted; with
    // no pubkey↔principal binding (FIX-Q3b) + config-sourced exec owner (FIX-Q2) that is a latent
    // confidentiality leak. A misconfigured (>1) store therefore never serves. DARK w.r.t. the
    // running bin: the live store has exactly 1 entry, so this is a no-op until a future redeploy.
    enforce_single_peer(&peer_allowlist).map_err(|_| ServerError::MultiPeerUnsupported)?;
    eprintln!(
        "hub_agent_run_server: peer-pubkey allowlist loaded from SecureStore (count={})",
        peer_allowlist.len()
    );
    // The KEK-holding store is no longer needed (the allowlist is in memory); drop it so the KEK
    // is wiped (Kek is ZeroizeOnDrop) rather than lingering for the lifetime of the serving loop.
    drop(secure_store);

    // (0b) S6d — LOAD the operator approval VERIFY key from the operator-controlled source BEFORE
    // building the runtime, so B4 (signed-mutation) + C1 positive-authorize can verify operator
    // signatures LIVE. This delegates to `friday_hub::operator_vk::provision_operator_vk_from_env`
    // (the SAME parse-only loader the lib uses; the Hub never references a SIGNING key, so it can
    // never mint the approvals it verifies — anti-self-mint). Fail-closed contract:
    //   * `FRIDAY_OPERATOR_VK_PATH` UNSET/empty ⇒ `Ok(None)` ⇒ the loop Pauses every protected
    //     action (BYTE-IDENTICAL to before this load was made explicit);
    //   * SET-but-unreadable/malformed ⇒ a HARD `ServerError::OperatorVk` ⇒ REFUSE TO BOOT with a
    //     DISTINCT, non-leaking message (never a silent degrade to None).
    // NB: `HubRuntime::live` ALSO backfills `operator_vk` from this same env path when the config
    // passes `None` — so passing the resolved `Some/None` here is idempotent with that backfill
    // (Some ⇒ `live` skips its own read; None ⇒ both yield None). Making it explicit at the serve
    // path is what gives the operator a BOOT LOG + a precise fail-closed error category.
    let operator_vk = friday_hub::operator_vk::provision_operator_vk_from_env()
        .map_err(|_| ServerError::OperatorVk)?;
    if operator_vk.is_some() {
        eprintln!(
            "hub_agent_run_server: operator approval verify-key LOADED from {} — protected actions can be operator-authorized",
            friday_hub::operator_vk::OPERATOR_VK_PATH_ENV
        );
    } else {
        eprintln!(
            "hub_agent_run_server: no operator vk provisioned (set {} to a 64-hex verify-key file) — protected actions Pause",
            friday_hub::operator_vk::OPERATOR_VK_PATH_ENV
        );
    }

    // (1) Build ONE HubRuntime at boot so the DeepSeek-client/DB cold-start is paid ONCE (not
    // per connection). S-C HOLDS this runtime and DISPATCHES into `run_task` for an authenticated
    // peer. The runtime is single-owner (v1): it is configured with the SAME principal the
    // allowlist admits, so owner-wiring records `owner == caller` and the body is releasable to
    // them. `HubRuntime::live` only CONSTRUCTS the provider client (no network call); an actual
    // run needs the env key — the separate operator live-proof.
    let mut runtime = HubRuntime::live(HubConfig {
        // Clone here so the `db_path` binding stays alive for the session-reaper tick below,
        // which opens its OWN connection to the SAME path (the accept-loop's runtime
        // connection is never shared across threads).
        db_path: db_path.clone(),
        workspace_root: PathBuf::from(&workspace_root),
        secret: ephemeral_dev_secret(pid, nanos),
        max_turns: 6,
        principal_id: owner_allowlist.first().cloned(),
        disabled_tools: vec![],
        read_only: false,
        operator_vk,
    })
    .map_err(|_| ServerError::Init)?;

    // (1b) BUG-6 — OPERATOR-TRIGGERED route validation. `HubRuntime::live` attaches a gated
    // secondary route (claude / codex) `available:true, validation_ok:false`; the route is NOT
    // dispatchable until validated, and `validate_and_enable_*` had NO production caller. When the
    // operator passes `--validate-claude` / `--validate-codex`, run the probe NOW on the held
    // serving runtime (so the in-process `validation_ok` flip lives in the long-lived process that
    // serves requests — a separate one-shot would persist nothing). DEFAULT (no flag) ⇒ skipped ⇒
    // ZERO quota, so a normal boot never spends an Anthropic token (the "never auto-run at boot"
    // requirement). Fail-soft: a failed secondary-route probe leaves it closed; DeepSeek serves on.
    let validate = ValidateRequest::from_args(&args);
    if validate.any() {
        run_boot_validation(&mut runtime, validate);
    }

    // (2) The server's OWN long-lived keypair (the ONLY `generate()` in non-test code). In
    // production this comes from SecureStore; the peer's public key arrives FROM THE PEER over
    // the wire — never fabricated here.
    let server_kp = DeviceKeypair::generate();

    let listener = AgentRunWsListener::bind_loopback(port).map_err(|_| ServerError::Bind)?;
    let addr = listener.local_addr().map_err(|_| ServerError::Bind)?;
    eprintln!(
        "hub_agent_run_server: listening (loopback-only) on {addr} — S-C authed dispatch arm active"
    );

    // (2b) Rust-owned session-lifecycle REAPER tick (DARK, DEFAULT-OFF). Spawn a background
    // thread that opens its OWN DB connection and runs `sweep_lifecycle` on an interval —
    // BUT ONLY when the operator has explicitly enabled it. The thread is spawned ONLY when
    // `FRIDAY_RUST_SESSION_REAPER_ENABLED` is "1"/"true"; unset/anything-else ⇒ NOT spawned
    // ⇒ no second DB connection, no reaping. This is what makes deploying the new binary
    // SAFE: the destructive reaper (it HARD-DELETES rows) does nothing until the flag is
    // flipped — wire-live = (rebuild bin + deploy + set the env flag) is a SEPARATE
    // operator-gated step. The reaper owns lifecycle on `agent_session` (the retired TS
    // `session-lifecycle-sweep` replacement).
    // (gap #25 / NEW-37) Read BOTH env vars unconditionally for diagnostics, but keep the
    // run/delete semantics unchanged: the retention sweep still rides only the session reaper.
    let reaper_raw = env::var(SESSION_REAPER_ENABLED_ENV).ok();
    let retention_raw = env::var(RETENTION_SWEEP_ENABLED_ENV).ok();
    let wiring = retention_wiring_from(reaper_raw.as_deref(), retention_raw.as_deref());
    match wiring {
        RetentionWiring::Enabled => {
            eprintln!(
                "hub_agent_run_server: artifact-RETENTION sweep ENABLED (FRIDAY_RETENTION_SWEEP) — rides the reaper tick"
            );
        }
        RetentionWiring::ReaperOnly => {
            eprintln!(
                "hub_agent_run_server: artifact-RETENTION sweep DISABLED (set FRIDAY_RETENTION_SWEEP=1 to enable)"
            );
        }
        RetentionWiring::MisparsedTruthy => {
            eprintln!(
                "hub_agent_run_server: WARN artifact-RETENTION requested but FRIDAY_RETENTION_SWEEP requires exactly '1'; retention is OFF"
            );
        }
        RetentionWiring::DeadConfigReaperOff => {
            eprintln!(
                "hub_agent_run_server: WARN artifact-RETENTION is DEAD-CONFIG: FRIDAY_RETENTION_SWEEP is set but the session reaper is DISABLED; also set FRIDAY_RUST_SESSION_REAPER_ENABLED=1"
            );
        }
        RetentionWiring::Disabled => {}
    }
    if reaper_enabled_from(reaper_raw.as_deref()) {
        spawn_session_reaper(
            db_path.clone(),
            retention_sweep_enabled_from(retention_raw.as_deref()),
        );
    } else {
        eprintln!(
            "hub_agent_run_server: session-lifecycle reaper DISABLED (set FRIDAY_RUST_SESSION_REAPER_ENABLED=1 to enable)"
        );
    }

    // (S10-B) The SCHEDULER TICK engine (DARK, DEFAULT-OFF). Spawn a background thread that opens
    // its OWN DB connection and runs the bounded `scheduler_tick::run_one_tick_live` on an interval —
    // BUT ONLY when the operator has explicitly enabled it via `FRIDAY_SCHEDULER_TICK_ENABLED` (exact
    // trimmed "1"). Unset/anything-else ⇒ the thread is NOT spawned ⇒ no second DB connection, no
    // scan, NOTHING fires ⇒ byte-identical to today (schedules never fire). This is what makes
    // deploying the binary SAFE: the tick (which dispatches REAL workflow runs) does nothing until
    // the operator flips the flag. Wire-live = (rebuild bin + deploy + enrol the lease holder + set
    // the env flag) is a SEPARATE operator-gated DEPLOY-GO step. The lease/pause kill-switch +
    // catch-up storm guard + per-tick caps live in `friday_hub::scheduler_tick`.
    if scheduler_tick_enabled() {
        spawn_scheduler_tick(db_path.clone(), workspace_root.clone());
    } else {
        eprintln!(
            "hub_agent_run_server: scheduler TICK engine DISABLED (set FRIDAY_SCHEDULER_TICK_ENABLED=1 to enable) — scheduled jobs never fire"
        );
    }

    // (INFO-sub2 observability) The OPTIONAL background AUDIT-CHAIN VERIFIER (DEFAULT-OFF). Spawn a
    // background thread that opens its OWN connection READ-ONLY and periodically recomputes the
    // hash-chained `audit_ledger` from genesis, logging the verified count or ALARMing on a broken
    // chain — BUT ONLY when the operator has explicitly enabled it via
    // `FRIDAY_AUDIT_CHAIN_VERIFY_ENABLED` (exact trimmed "1"). Unset/anything-else ⇒ the thread is
    // NOT spawned ⇒ no second DB connection, no chain recompute, NOTHING runs ⇒ byte-identical to
    // today. It is pure OBSERVABILITY: it NEVER writes (the read-only connection cannot) and NEVER
    // fails-closed/refuses service — a broken chain is an alarm, not a serve gate.
    if audit_chain_verify_enabled() {
        spawn_audit_chain_verifier(db_path.clone());
    } else {
        eprintln!(
            "hub_agent_run_server: audit-chain verifier DISABLED (set FRIDAY_AUDIT_CHAIN_VERIFY_ENABLED=1 to enable) — no background integrity verification"
        );
    }

    // (A1 run-controls) Read the run-control flag ONCE at boot (default-off). When false the
    // server emits/handles EXACTLY the pre-A1 wire (a paused run ⇒ `AgentRunResult{no_answer}`;
    // a control message ⇒ benign keepalive echo), so deploying a v13 binary changes NO live
    // behavior until the operator flips this SEPARATE flag.
    let run_control_enabled =
        agent_run_control_enabled_from(env::var(AGENT_RUN_CONTROL_ENABLED_ENV).ok().as_deref());
    if run_control_enabled {
        eprintln!(
            "hub_agent_run_server: on-wire run-CONTROL plane ENABLED (FRIDAY_AGENT_RUN_CONTROL_VIA_RUST)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: on-wire run-CONTROL plane DISABLED (set FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1 to enable)"
        );
    }

    // (NS-4) Read the MISSION-BOUND run seam flag ONCE at boot (default-off). When false, ordinary
    // no-handle requests still take the EXACT pre-NS-4 unbound path. A request that already carries
    // `mission_context` has asserted mission-bound intent and fails closed to NoAnswer instead of
    // running unbound under a false route projection.
    let mission_bound_run_enabled =
        mission_bound_run_enabled_from(env::var(MISSION_BOUND_RUN_ENABLED_ENV).ok().as_deref());
    if mission_bound_run_enabled {
        eprintln!(
            "hub_agent_run_server: MISSION-BOUND run seam ENABLED (FRIDAY_MISSION_BOUND_RUN) — a run whose mission_context resolves to a live Mission is dispatched bound"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: MISSION-BOUND run seam DISABLED (set FRIDAY_MISSION_BOUND_RUN=1 to enable) — no-handle runs dispatch unbound; mission_context runs fail closed"
        );
    }

    // (NS-5) Read the MISSION-INTAKE ingress flag ONCE at boot (default-off). When false the
    // dispatch arm NEVER handles a `MissionIntakeRequest` — it falls through to the EXISTING
    // catch-all keepalive echo (byte-identical to today, since the server has never had a
    // MissionIntakeRequest arm), so deploying this binary changes NO live behavior until the
    // operator flips this flag.
    let mission_intake_enabled =
        mission_intake_enabled_from(env::var(MISSION_INTAKE_ENABLED_ENV).ok().as_deref());
    if mission_intake_enabled {
        eprintln!(
            "hub_agent_run_server: MISSION-INTAKE ingress ENABLED (FRIDAY_MISSION_INTAKE) — an inbound MissionIntakeRequest births a Mission (no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: MISSION-INTAKE ingress DISABLED (set FRIDAY_MISSION_INTAKE=1 to enable) — a MissionIntakeRequest is a benign keepalive echo"
        );
    }

    // (KEYSTONE) Read the MISSION-SPINE DISPATCH flag ONCE at boot (default-off). When false the
    // dispatch arms NEVER handle a `MissionLifecycleRequest` / `WorkItemStatusRequest` /
    // `RouteDecisionControlRequest` — each falls through to the EXISTING catch-all keepalive echo
    // (byte-identical to today, since the server has never had these arms), so deploying this
    // binary changes NO live behavior until the operator flips this flag.
    let mission_spine_dispatch_enabled = mission_spine_dispatch_enabled_from(
        env::var(MISSION_SPINE_DISPATCH_ENABLED_ENV).ok().as_deref(),
    );
    if mission_spine_dispatch_enabled {
        eprintln!(
            "hub_agent_run_server: MISSION-SPINE dispatch ENABLED (FRIDAY_MISSION_SPINE_DISPATCH) — Mission/WorkItem lifecycle and RouteDecision control requests transition the Hub state machine (no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: MISSION-SPINE dispatch DISABLED (set FRIDAY_MISSION_SPINE_DISPATCH=1 to enable) — Mission/WorkItem lifecycle and RouteDecision control requests are benign keepalive echoes"
        );
    }

    // Read the MEMORY-CONFIRM ingress flag ONCE at boot (default-off). When false the dispatch arm
    // NEVER handles a `MemoryDecisionRequest` — it falls through to the EXISTING catch-all keepalive
    // echo (byte-identical to today, since the server has never had this arm), so deploying this
    // binary changes NO live behavior until the operator flips this flag.
    let memory_confirm_enabled =
        memory_confirm_enabled_from(env::var(MEMORY_CONFIRM_ENABLED_ENV).ok().as_deref());
    if memory_confirm_enabled {
        eprintln!(
            "hub_agent_run_server: MEMORY-CONFIRM ingress ENABLED (FRIDAY_MEMORY_CONFIRM) — an inbound owner-authed MemoryDecisionRequest confirms/rejects a memory candidate (a confirm makes it recallable; no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: MEMORY-CONFIRM ingress DISABLED (set FRIDAY_MEMORY_CONFIRM=1 to enable) — a MemoryDecisionRequest is a benign keepalive echo"
        );
    }

    let context_passport_transfer_enabled = context_passport_transfer_enabled_from(
        env::var(CONTEXT_PASSPORT_TRANSFER_ENABLED_ENV)
            .ok()
            .as_deref(),
    );
    if context_passport_transfer_enabled {
        eprintln!(
            "hub_agent_run_server: CONTEXT-PASSPORT transfer ENABLED (FRIDAY_CONTEXT_PASSPORT_TRANSFER) — an inbound ContextPassportTransferRequest mints a governed ContextPassport for an existing Mission (no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: CONTEXT-PASSPORT transfer DISABLED (set FRIDAY_CONTEXT_PASSPORT_TRANSFER=1 to enable) — a ContextPassportTransferRequest is a benign keepalive echo"
        );
    }

    let run_outcome_learning_confirm_enabled = run_outcome_learning_confirm_enabled_from(
        env::var(RUN_OUTCOME_LEARNING_CONFIRM_ENABLED_ENV)
            .ok()
            .as_deref(),
    );
    if run_outcome_learning_confirm_enabled {
        eprintln!(
            "hub_agent_run_server: RUN-OUTCOME-LEARNING confirm ENABLED (FRIDAY_RUN_OUTCOME_LEARNING_CONFIRM) — an inbound owner-authed RunOutcomeLearningDecisionRequest confirms/rejects a refs-only candidate (no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: RUN-OUTCOME-LEARNING confirm DISABLED (set FRIDAY_RUN_OUTCOME_LEARNING_CONFIRM=1 to enable) — a RunOutcomeLearningDecisionRequest is a benign keepalive echo"
        );
    }

    let activity_mark_done_enabled =
        activity_mark_done_enabled_from(env::var(ACTIVITY_MARK_DONE_ENABLED_ENV).ok().as_deref());
    if activity_mark_done_enabled {
        eprintln!(
            "hub_agent_run_server: ACTIVITY-MARK-DONE ingress ENABLED (FRIDAY_ACTIVITY_MARK_DONE) — an inbound owner-authed ActivityMarkDoneRequest marks one existing activity_item done (no model call)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: ACTIVITY-MARK-DONE ingress DISABLED (set FRIDAY_ACTIVITY_MARK_DONE=1 to enable) — an ActivityMarkDoneRequest is a benign keepalive echo"
        );
    }

    // (C1/C2 §3) Read the PROVIDER-WORKSPACE-DISPATCH flag ONCE at boot (default-off). It gates the
    // serve-bin's `ProviderWorkspaceActionRequest` arm: when false the dispatch arm NEVER handles a
    // `ProviderWorkspaceActionRequest` — it falls through to the EXISTING catch-all keepalive echo
    // (byte-identical to today, since the server has never had this arm), so deploying this binary
    // changes NO live behavior until the operator flips this flag. This is the SAME
    // `FRIDAY_PROVIDER_WORKSPACE_DISPATCH` flag #797 already reads INSIDE the producer to select the
    // live-vs-No adapter; here it ADDITIONALLY gates whether the arm is reached at all. Even with the
    // flag ON, the per-action capability must be `Verified` for the guard to route to the adapter (no
    // `friday_current()` capability is), so a real request is refused before the adapter regardless.
    let provider_workspace_dispatch_enabled =
        friday_hub::provider_dispatch_adapter::provider_workspace_dispatch_from(
            env::var(friday_hub::provider_dispatch_adapter::ENV_PROVIDER_WORKSPACE_DISPATCH).ok(),
        );
    if provider_workspace_dispatch_enabled {
        eprintln!(
            "hub_agent_run_server: PROVIDER-WORKSPACE dispatch ENABLED (FRIDAY_PROVIDER_WORKSPACE_DISPATCH) — a sealed-session ProviderWorkspaceActionRequest routes through the gated dispatch_provider_action (capability must still be Verified to reach the adapter)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: PROVIDER-WORKSPACE dispatch DISABLED (set FRIDAY_PROVIDER_WORKSPACE_DISPATCH=1 to enable) — a ProviderWorkspaceActionRequest is a benign keepalive echo"
        );
    }

    // (Loop4 wire-fields) Read the per-run TOKEN-SURFACE flag ONCE at boot (default-off). When false
    // the terminal `AgentRunResult` emits `prompt_tokens: None` / `completion_tokens: None` —
    // byte-identical to today (the agent-run path is LIVE in prod). When true the emit path sums the
    // run's `token_ledger` rows into the surface; a read error fails SAFE to `None`. So deploying
    // this binary changes NO live behavior until the operator flips this SEPARATE flag.
    let token_surface_enabled = agent_run_token_surface_enabled_from(
        env::var(AGENT_RUN_TOKEN_SURFACE_ENABLED_ENV)
            .ok()
            .as_deref(),
    );
    if token_surface_enabled {
        eprintln!(
            "hub_agent_run_server: per-run TOKEN SURFACE ENABLED (FRIDAY_AGENT_RUN_TOKEN_SURFACE) — AgentRunResult carries the summed token_ledger counts for the run"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: per-run TOKEN SURFACE DISABLED (set FRIDAY_AGENT_RUN_TOKEN_SURFACE=1 to enable) — AgentRunResult emits prompt_tokens/completion_tokens=None"
        );
    }

    // (2c) CRASH-RECOVERY reconciliation (D1 hardening). BEFORE accepting any connection, scan for
    // genuinely-orphaned in-flight WorkItems (a `Dispatched`/`HubAccepted` row a prior process died
    // mid-turn on, plus stale-executing PASS-2 rows) and advance each to a terminal
    // `FailedTerminal` with the `crash_recovery_abort` marker, via the LEGAL work-item state
    // machine. Legitimately-WAITING rows (paused/awaiting-clarification/provider-waiting, resumed by
    // the signed-mutation/approval/reconnect paths) are NEVER touched. FAIL-SAFE: a reconcile error
    // is LOGGED (category only) and SWALLOWED — it must NEVER block boot (the server coming up is
    // load-bearing). This is a hard boot safety sweep now, not an operator-flipped dark flag.
    run_boot_crash_recovery(&db_path);

    // (3) Long-lived accept loop. Each accepted connection: set the read timeout, read the peer
    // pubkey preamble, REJECT a non-allowlisted peer pubkey (S-F, the FIRST gate), reject low-order
    // points, run the WS handshake, derive the sealed session key, and serve sealed envelopes
    // fail-closed — dispatching authed agent-runs.
    loop {
        match listener.accept_one(
            &server_kp,
            &runtime,
            &owner_allowlist,
            &peer_allowlist,
            run_control_enabled,
            mission_bound_run_enabled,
            mission_intake_enabled,
            mission_spine_dispatch_enabled,
            memory_confirm_enabled,
            run_outcome_learning_confirm_enabled,
            token_surface_enabled,
            provider_workspace_dispatch_enabled,
        ) {
            Ok(_served) => {}
            // A connection-level error ends THAT connection only; the server keeps listening.
            Err(_e) => continue,
        }
    }
}

/// The env flag that gates the session-lifecycle reaper tick. DEFAULT-OFF: the tick is
/// spawned ONLY when `FRIDAY_RUST_SESSION_REAPER_ENABLED` is exactly `"1"` or `"true"`
/// (case-insensitive). Unset — or any other value — leaves the reaper DISABLED, so the
/// new binary deploys DARK (the destructive sweep never runs until the operator flips it).
const SESSION_REAPER_ENABLED_ENV: &str = "FRIDAY_RUST_SESSION_REAPER_ENABLED";

/// The reaper sweep cadence (120s), matching the old TS sweep's interval.
const SESSION_REAPER_INTERVAL: Duration = Duration::from_secs(120);

/// (gap #25) The env flag that gates the ARTIFACT-RETENTION sweep, which runs on the SAME reaper
/// tick (after `sweep_lifecycle`) and prunes the unbounded artifact tables — `token_ledger` /
/// `surface_event` (90d), terminal `mission` / `work_item` (365d), and rejected/expired memory
/// CANDIDATES (30d) — by age AND terminal-state, FK-safe + bounded + fail-safe. DEFAULT-OFF and
/// INDEPENDENT of the session reaper flag: the retention sweep runs ONLY when this is exactly
/// `"1"` (the trimmed exact-1 idiom, NOT the reaper's `1|true`). `audit_ledger` (the hash-chained
/// audit "chain") is NEVER touched. Unset/anything-else ⇒ no retention deletes (byte-identical to
/// the pre-#25 reaper, which only swept `agent_session`). Wire-live = (deploy + set this flag) is
/// a SEPARATE operator-gated step.
const RETENTION_SWEEP_ENABLED_ENV: &str = "FRIDAY_RETENTION_SWEEP";

/// (INFO-sub2 observability) The env flag that gates the OPTIONAL background AUDIT-CHAIN VERIFIER.
/// DEFAULT-OFF and STRICT exact-1 (the program-standard idiom used by the scheduler/retention
/// flags, NOT the reaper's `1|true`): the verifier thread is spawned ONLY when
/// `FRIDAY_AUDIT_CHAIN_VERIFY_ENABLED` is exactly the trimmed `"1"`. Unset, empty, `"true"`, `"0"`,
/// or any other value ⇒ the thread is NEVER spawned ⇒ no second DB connection, no chain recompute,
/// NOTHING runs ⇒ byte-identical to today. This is purely OBSERVABILITY: when ON it opens the DB
/// READ-ONLY and periodically recomputes the hash-chained `audit_ledger` from genesis, logging the
/// verified count or ALARMING on a broken chain (the `diagnostics`-policy Verified/Broken mapping).
/// It NEVER fails-closed / refuses boot and NEVER writes (the read-only connection physically
/// cannot) — the opposite of the verify-then-write anti-pattern. Wire-live = (deploy + set this
/// flag) is a SEPARATE operator step; OFF is the safe default for every deploy.
const AUDIT_CHAIN_VERIFY_ENABLED_ENV: &str = "FRIDAY_AUDIT_CHAIN_VERIFY_ENABLED";

/// The audit-chain verifier cadence. Deliberately CONSERVATIVE (hourly) and NOT copied from the
/// reaper's 120s / scheduler's 60s: `verify_audit_chain` recomputes the ENTIRE chain from genesis
/// on every call (O(full `audit_ledger`)), a different cost profile than those bounded per-tick
/// sweeps, so a tight cadence would re-walk the whole ledger needlessly. Hourly is ample for an
/// integrity-anomaly alarm.
const AUDIT_CHAIN_VERIFY_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// (A1 run-controls) The env flag that gates the on-wire RUN-CONTROL protocol. DEFAULT-OFF: the
/// server emits `AgentRunPaused` (instead of the pre-A1 `AgentRunResult{no_answer}` for a paused
/// run) and handles `AgentRunResume`/`AgentRunCancel`/`AgentRunReject` ONLY when
/// `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` is exactly `"1"`/`"true"` (case-insensitive). Unset — or any
/// other value — leaves the control plane DARK: a paused run emits EXACTLY the pre-A1
/// `AgentRunResult{status:"no_answer"}` bytes, and a control message is treated as a benign
/// keepalive (echoed), so deploying a v13 binary changes NO live behavior. SEPARATE from
/// `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (the run-START flag) — flipping THIS one is the run-CONTROL
/// live-flip, an operator DEPLOY-GO decision.
const AGENT_RUN_CONTROL_ENABLED_ENV: &str = "FRIDAY_AGENT_RUN_CONTROL_VIA_RUST";

/// Whether the operator has explicitly enabled the on-wire run-control plane. Fail-closed: only
/// the exact opt-in values enable it; everything else (including unset) is OFF.
fn agent_run_control_enabled_from(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true")
    )
}

/// (NS-4) The env flag that gates the MISSION-BOUND run seam. DEFAULT-OFF: a run is dispatched
/// through the Mission-bound entry ([`friday_hub::run_authed_agent_loop_mission_bound`] — which
/// mints the mission-birth + WorkItem bind) ONLY when `FRIDAY_MISSION_BOUND_RUN` is exactly
/// `"1"` (after trim). Unset — or any other value — leaves the seam DARK for ordinary runs: a
/// request with NO `mission_context` takes the EXISTING unbound dispatch
/// (`HubRuntime::run_session_task_with_overrides`, which BOTH the sessioned and the
/// ephemeral-per-run-session arms now use), so deploying this binary changes NO live behavior for
/// today's unbound courier. A request that DOES carry a FIRST-CLASS `mission_context` has asserted
/// mission-bound intent; with this flag OFF, or with this flag ON but an unresolvable handle, it
/// fails closed to body-free NoAnswer rather than falling through unbound. With the flag ON, a run
/// is bound only if that handle (NS45-PR1 / M-4) resolves to a live Mission/WorkItem via
/// `MissionContextLookup::by_mission_work_item`. SEPARATE from
/// `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (run-START) and `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`
/// (run-CONTROL); flipping THIS one is an operator cutover decision gated on organic Mission
/// ingress (the courier populating `AgentRunRequest.mission_context`).
const MISSION_BOUND_RUN_ENABLED_ENV: &str = "FRIDAY_MISSION_BOUND_RUN";

/// Pure flag-matcher for [`MISSION_BOUND_RUN_ENABLED_ENV`] (separated from the env read so it is
/// testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒
/// false; ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard
/// flag idiom; everything else (including `"true"`) ⇒ false.
fn mission_bound_run_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (NS-5) The env flag that gates the MISSION-INTAKE ingress arm. DEFAULT-OFF: an inbound
/// [`Message::MissionIntakeRequest`] is HANDLED (birthing a Mission + WorkItem(Draft) +
/// SurfaceThread + route_decision via the existing
/// [`friday_hub::hub_server::mission_intake_result_for_db`] and replying with a
/// [`Message::MissionIntakeResult`]) ONLY when `FRIDAY_MISSION_INTAKE` is exactly `"1"`
/// (after trim). Unset — or any other value — leaves the arm DARK: the
/// `MissionIntakeRequest` falls through to the EXISTING catch-all keepalive echo, BYTE-IDENTICAL to
/// today (the server has never had a MissionIntakeRequest arm, so the live behavior on this message
/// is the benign echo), so deploying this binary changes NO live behavior until the operator flips
/// this SEPARATE flag. No model call is made in intake (it is a pure `&Db` mutation ⇒ ZERO
/// `token_ledger` rows). SEPARATE from `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (run-START),
/// `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` (run-CONTROL), and `FRIDAY_MISSION_BOUND_RUN` (the bound-run
/// seam); flipping THIS one is an operator cutover decision gated on organic intake ingress.
const MISSION_INTAKE_ENABLED_ENV: &str = "FRIDAY_MISSION_INTAKE";

/// Pure flag-matcher for [`MISSION_INTAKE_ENABLED_ENV`] (separated from the env read so it is
/// testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒
/// false; ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard
/// flag idiom; everything else (including `"true"`) ⇒ false.
fn mission_intake_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// The env flag that gates the MISSION-SPINE DISPATCH arms (the keystone that makes the
/// operating-layer mission-spine REACHABLE). DEFAULT-OFF: a [`Message::MissionLifecycleRequest`]
/// (advance one canonical Mission's lifecycle through the Hub state machine) and a
/// [`Message::WorkItemStatusRequest`] (advance one WorkItem's lifecycle, with the
/// proof-on-completion invariant enforced at the persistence boundary) are HANDLED — birthing the
/// status transition + audit row via the existing
/// [`friday_hub::hub_server::mission_lifecycle_result_for_db`] /
/// [`friday_hub::hub_server::work_item_status_result_for_db`] and replying with the matching
/// `*Result` — ONLY when `FRIDAY_MISSION_SPINE_DISPATCH` is exactly `"1"` (after trim). Unset — or
/// any other value — leaves the arms DARK: each request falls through to the EXISTING catch-all
/// keepalive echo, BYTE-IDENTICAL to today (the server has never had these arms), so deploying this
/// binary changes NO live behavior until the operator flips this SEPARATE flag. No model call is
/// made (a pure `&Db` mutation ⇒ ZERO `token_ledger` rows). SEPARATE from
/// `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (run-START), `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` (run-CONTROL),
/// `FRIDAY_MISSION_BOUND_RUN` (the bound-run seam), and `FRIDAY_MISSION_INTAKE` (Mission birth);
/// flipping THIS one is an operator cutover decision. The sealed session IS the channel auth (the
/// single-peer/single-owner SERVER invariant `enforce_single_peer` upholds at boot — a non-owner
/// peer can never open a session), mirroring the merged `FRIDAY_MISSION_INTAKE` arm; these wire
/// shapes carry no per-request `auth_proof`.
const MISSION_SPINE_DISPATCH_ENABLED_ENV: &str = "FRIDAY_MISSION_SPINE_DISPATCH";

/// Pure flag-matcher for [`MISSION_SPINE_DISPATCH_ENABLED_ENV`] (separated from the env read so it
/// is testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒
/// false; ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard flag
/// idiom; everything else (including `"true"`) ⇒ false.
fn mission_spine_dispatch_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// The env flag that gates the MEMORY-CONFIRM dispatch arm — the live caller that CLOSES the
/// Memory-confirmation loop's terminal arm (the confirm/reject surface had NO live caller before
/// this; only `#[test]` callers reached `friday_storage::memory::decide`). DEFAULT-OFF: an inbound
/// [`Message::MemoryDecisionRequest`] is HANDLED — the OWNER's explicit confirm/reject is applied to
/// ONE pending memory candidate via the existing
/// [`friday_hub::hub_server::memory_decision_result_for_db`] (owner/namespace-scoped, fail-closed on
/// mismatch; a `confirm` makes the candidate durable AND recallable), replying with a
/// [`Message::MemoryDecisionResult`] — ONLY when `FRIDAY_MEMORY_CONFIRM` is exactly `"1"` (after
/// trim). Unset — or any other value — leaves the arm DARK: the `MemoryDecisionRequest` falls
/// through to the EXISTING catch-all keepalive echo, BYTE-IDENTICAL to today (the server has never
/// had this arm, so the live behavior on this message is the benign echo — births/changes nothing),
/// so deploying this binary changes NO live behavior until the operator flips this SEPARATE flag.
/// No model call is made (a pure `&Db` mutation ⇒ ZERO `token_ledger` rows). The decision is the
/// OWNER's OWN action — the sealed single-peer session IS the channel auth (the SAME invariant the
/// merged `FRIDAY_MISSION_INTAKE` / `FRIDAY_MISSION_SPINE_DISPATCH` arms rely on); it is NOT an
/// agent mutating-tool action, so it does NOT route through the approval/trust gate; this wire shape
/// carries no per-request `auth_proof`. SEPARATE from every other dark flag; flipping THIS one is an
/// operator cutover decision (and the TS driver route that constructs this request is a separate
/// operator-gated follow-up, like the mission-dispatch driver was).
const MEMORY_CONFIRM_ENABLED_ENV: &str = "FRIDAY_MEMORY_CONFIRM";

/// Pure flag-matcher for [`MEMORY_CONFIRM_ENABLED_ENV`] (separated from the env read so it is
/// testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false;
/// ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard flag idiom;
/// everything else (including `"true"`) ⇒ false.
fn memory_confirm_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

const CONTEXT_PASSPORT_TRANSFER_ENABLED_ENV: &str = "FRIDAY_CONTEXT_PASSPORT_TRANSFER";

fn context_passport_transfer_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

const RUN_OUTCOME_LEARNING_CONFIRM_ENABLED_ENV: &str = "FRIDAY_RUN_OUTCOME_LEARNING_CONFIRM";

fn run_outcome_learning_confirm_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

const ACTIVITY_MARK_DONE_ENABLED_ENV: &str = "FRIDAY_ACTIVITY_MARK_DONE";

fn activity_mark_done_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (Loop4 wire-fields) The env flag that gates the SERVER→CLIENT per-run TOKEN SURFACE on the
/// terminal [`Message::AgentRunResult`]. DEFAULT-OFF: when unset (or any value other than the exact
/// `"1"` after trim) the refs result emits `prompt_tokens: None` / `completion_tokens: None` —
/// BYTE-IDENTICAL to today (an absent `Option` is omitted via `skip_serializing_if`). The agent-run
/// dispatch path is LIVE in prod (the self-probe), so the surface stays DARK until the operator
/// flips THIS separate flag. When ON, the emit path computes the run's `prompt_tokens` /
/// `completion_tokens` by SUMMING the run-attributable `token_ledger` rows (keyed by `run_id`) via
/// [`friday_storage::agent_run_read::run_token_totals`] — a single COALESCE'd aggregate SELECT. A
/// ledger read error (or a count that does not fit `u64`) FAILS SAFE to `None` (today's behavior):
/// the surface is never allowed to break or block the answer. SEPARATE from
/// `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` (run-CONTROL), `FRIDAY_MISSION_BOUND_RUN` (the bound-run
/// seam), `FRIDAY_MISSION_INTAKE` (Mission birth), and `FRIDAY_MISSION_SPINE_DISPATCH`; flipping
/// THIS one is an operator cutover decision.
const AGENT_RUN_TOKEN_SURFACE_ENABLED_ENV: &str = "FRIDAY_AGENT_RUN_TOKEN_SURFACE";

/// Pure flag-matcher for [`AGENT_RUN_TOKEN_SURFACE_ENABLED_ENV`] (separated from the env read so it
/// is testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒
/// false; ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard flag
/// idiom; everything else (including `"true"`) ⇒ false.
fn agent_run_token_surface_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (Loop4 wire-fields) The run's per-run token surface for the terminal [`Message::AgentRunResult`],
/// as `(prompt_tokens, completion_tokens)`.
///
/// FAIL-SAFE by construction — returns `(None, None)`, today's exact emission, in EVERY case other
/// than "flag ON and the ledger read succeeded and the counts fit `u64`":
///   * `enabled == false` (flag OFF / default) ⇒ `(None, None)` WITHOUT touching the DB, so the
///     emission is byte-identical to the pre-Loop4 wire (a single early return, no read).
///   * a ledger read error (e.g. a transient lock / a corrupt DB) ⇒ `(None, None)` — the surface
///     NEVER breaks the result emission and NEVER panics (no `unwrap`/`expect`).
///   * a summed count that cannot be represented as `u64` (a SUM is `i64`; a negative is
///     impossible for token counts but is handled defensively) ⇒ that field is `None`.
///
/// When ON and the read succeeds, the values are the run-attributable totals from `run_token_totals`
/// (`WHERE run_id = ?1`, ask-path NULL-`run_id` rows excluded). A zero-billed run yields `Some(0)`
/// (COALESCE), which is the true sum, not absence.
fn run_token_surface(
    enabled: bool,
    conn: &rusqlite::Connection,
    run_id: &str,
) -> (Option<u64>, Option<u64>) {
    if !enabled {
        // Flag OFF (default): NO DB read, emit exactly today's `None`/`None`.
        return (None, None);
    }
    match friday_storage::agent_run_read::run_token_totals(conn, run_id) {
        Ok(totals) => (
            u64::try_from(totals.prompt).ok(),
            u64::try_from(totals.completion).ok(),
        ),
        // A ledger read failure is non-fatal: fall back to today's `None`/`None`. The answer is
        // already safely persisted; the token surface must never block or break its delivery.
        Err(_e) => (None, None),
    }
}

/// Pure flag-matcher (separated from the env read so it is testable without mutating the
/// process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false; only the exact opt-in
/// values `"1"`/`"true"` (case-insensitive, trimmed) ⇒ true; everything else ⇒ false.
fn reaper_enabled_from(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true")
    )
}

/// (gap #25) Pure flag-matcher for `FRIDAY_RETENTION_SWEEP` (separated from the env read so it is
/// testable without mutating the process environment). DEFAULT-OFF and STRICT: only the exact
/// trimmed `"1"` enables it (the program-standard exact-1 idiom used by mission-/run-control
/// flags); unset, empty, `"true"`, `"0"`, or any other value ⇒ false. OFF ⇒ the reaper tick runs
/// the pre-#25 behavior (session sweep only), byte-identical.
fn retention_sweep_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RetentionWiring {
    Enabled,
    ReaperOnly,
    MisparsedTruthy,
    DeadConfigReaperOff,
    Disabled,
}

fn retention_sweep_looks_requested(raw: Option<&str>) -> bool {
    let Some(trimmed) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    !matches!(
        trimmed.to_ascii_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    )
}

fn retention_wiring_from(reaper_raw: Option<&str>, retention_raw: Option<&str>) -> RetentionWiring {
    let reaper_on = reaper_enabled_from(reaper_raw);
    let retention_on = retention_sweep_enabled_from(retention_raw);
    let retention_requested = retention_sweep_looks_requested(retention_raw);

    match (reaper_on, retention_on, retention_requested) {
        (true, true, _) => RetentionWiring::Enabled,
        (true, false, true) => RetentionWiring::MisparsedTruthy,
        (true, false, false) => RetentionWiring::ReaperOnly,
        (false, _, true) => RetentionWiring::DeadConfigReaperOff,
        (false, _, false) => RetentionWiring::Disabled,
    }
}

fn run_session_reaper_tick(db: &friday_storage::Db, retention_on: bool, now_ms: i64) {
    match friday_storage::sweep_lifecycle(db.conn(), now_ms) {
        Ok(outcome) if !outcome.is_empty() => {
            eprintln!(
                "hub_agent_run_server: session sweep idled={} archived={} pruned={} hard_deleted={} messages_deleted={}",
                outcome.idled,
                outcome.archived,
                outcome.pruned,
                outcome.hard_deleted,
                outcome.messages_deleted,
            );
        }
        // An empty sweep is the common case — stay quiet to avoid log spam.
        Ok(_) => {}
        // A sweep error (e.g. a transient lock) is logged and the loop continues; the
        // reaper never crashes the daemon. Category only — never row contents.
        Err(_e) => {
            eprintln!("hub_agent_run_server: session sweep failed (continuing)");
        }
    }
    // (gap #25) On the SAME tick, run the artifact-retention sweep when enabled. It is
    // internally fail-safe (never returns Err; a per-table failure is counted, the sweep
    // moves on), so a retention problem can never crash the reaper. Refs-only count log on
    // a non-empty sweep; empty sweeps stay quiet.
    if retention_on {
        let r = friday_storage::sweep_retention(
            db.conn(),
            now_ms,
            friday_storage::RetentionWindows::default(),
        );
        if !r.is_empty() {
            eprintln!(
                "hub_agent_run_server: retention sweep token_ledger={} run_result={} agent_run_event={} agent_run={} surface_event={} provider_session_event={} provider_session_link={} process_observation={} route_decision_control={} route_decision={} mission_link={} mission_body_snapshot={} process_lease={} workspace_claim={} surface_thread={} mission={} work_item={} memory_item={} table_errors={}",
                r.token_ledger_deleted,
                r.run_result_deleted,
                r.agent_run_event_deleted,
                r.agent_run_deleted,
                r.surface_event_deleted,
                r.provider_session_event_deleted,
                r.provider_session_link_deleted,
                r.process_observation_deleted,
                r.route_decision_control_deleted,
                r.route_decision_deleted,
                r.mission_link_deleted,
                r.mission_body_snapshot_deleted,
                r.process_lease_deleted,
                r.workspace_claim_deleted,
                r.surface_thread_deleted,
                r.mission_deleted,
                r.work_item_deleted,
                r.memory_item_deleted,
                r.table_errors,
            );
        }
    }
}

/// Spawn the DARK session-lifecycle reaper tick on its OWN thread + OWN DB connection.
///
/// The thread opens a SEPARATE `Db::open_hub` connection (NOT the accept-loop's, never shared
/// across threads). `Db::open_hub` IS the concurrency-safe opener (`open_hub_concurrent`: WAL +
/// `HUB_BUSY_TIMEOUT_MS` busy_timeout + the bounded busy-retry on open), so this thread's writes
/// retry under contention instead of failing immediately — the same WAL/busy-retry posture every
/// other Hub writer uses. It calls `sweep_lifecycle` every [`SESSION_REAPER_INTERVAL`]. Errors (a
/// failed open, or a failed
/// sweep) are LOGGED and the loop continues — the reaper never panics the daemon. A
/// non-empty sweep logs its per-transition counts (refs-only: counts, never session bodies).
///
/// (gap #25) When `retention_on` is true the SAME tick ALSO runs the artifact-retention sweep
/// (`friday_storage::sweep_retention`) right after the session sweep, on the SAME connection. The
/// retention sweep is internally fail-safe (each table in its own txn; a per-table error is
/// recorded, not propagated) so it never returns `Err`; a non-empty retention sweep logs its
/// per-table counts (refs-only). When `retention_on` is false the retention call is never made —
/// byte-identical to the pre-#25 session-only reaper.
fn spawn_session_reaper(db_path: String, retention_on: bool) {
    thread::spawn(move || {
        // Open this thread's OWN connection. A failed open is logged and the reaper exits
        // (the daemon keeps serving); it does NOT crash the process.
        let db = match friday_storage::Db::open_hub(&db_path) {
            Ok(db) => db,
            Err(_e) => {
                // Category only — never the db_path (it can carry the operator's home/username).
                eprintln!(
                    "hub_agent_run_server: session reaper could not open its DB connection — reaper not running"
                );
                return;
            }
        };
        eprintln!(
            "hub_agent_run_server: session-lifecycle reaper ENABLED (interval={}s)",
            SESSION_REAPER_INTERVAL.as_secs()
        );
        loop {
            thread::sleep(SESSION_REAPER_INTERVAL);
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            run_session_reaper_tick(&db, retention_on, now_ms);
        }
    });
}

/// (INFO-sub2 observability) Whether the operator has explicitly enabled the background
/// audit-chain verifier. Fail-closed: only the exact trimmed `"1"` enables it; everything else
/// (including unset) is OFF.
fn audit_chain_verify_enabled() -> bool {
    audit_chain_verify_enabled_from(env::var(AUDIT_CHAIN_VERIFY_ENABLED_ENV).ok().as_deref())
}

/// Pure flag-matcher for [`AUDIT_CHAIN_VERIFY_ENABLED_ENV`] (separated from the env read so it is
/// testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false;
/// ON only for the exact opt-in value `"1"` (trimmed), matching the scheduler/retention exact-1
/// idiom; everything else (including `"true"`) ⇒ false.
fn audit_chain_verify_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// (INFO-sub2 observability) Run ONE audit-chain verification pass against `db` and surface the
/// result. READ-ONLY: it calls [`friday_storage::audit::verify_audit_chain`] (a SELECT-only chain
/// recompute that NEVER writes rows) and maps the outcome through the same `diagnostics`-module
/// policy — `Ok(entries)` ⇒ [`ChainStatus::Verified`] (log the verified count), `Err(_)` ⇒
/// [`ChainStatus::Broken`] (ALARM, never silently suppressed). It does NOT fail-closed / refuse
/// service: a broken chain is an OBSERVABILITY alarm, not a boot/serve gate. Logs are refs-only
/// (a count, or the broken-chain reason string which is an `audit_id`, never a row body).
///
/// This is the testable seam (mirrors `run_session_reaper_tick`): the spawned thread just loops
/// `sleep; tick`, so tests drive THIS function directly against a seeded DB without spawning a
/// thread or sleeping. Returns the surfaced [`ChainStatus`] (the thread discards it; tests assert
/// on it) so the Verified/Broken mapping is directly testable.
fn run_audit_chain_verify_tick(db: &friday_storage::Db) -> friday_hub::diagnostics::ChainStatus {
    use friday_hub::diagnostics::ChainStatus;
    // Map the read-only verify result through the SAME `diagnostics` policy (Ok→Verified /
    // Err→Broken). Routing through `ChainStatus` keeps this verifier's anomaly-surfacing semantics
    // identical to the `DiagnosticsSnapshot` collector.
    let status = match friday_storage::audit::verify_audit_chain(db.conn()) {
        Ok(entries) => ChainStatus::Verified { entries },
        Err(e) => ChainStatus::Broken {
            reason: e.to_string(),
        },
    };
    match &status {
        // Stay quiet on an empty/genesis ledger to avoid boot-time log spam; log only when there
        // is something verified.
        ChainStatus::Verified { entries } if *entries > 0 => {
            eprintln!(
                "hub_agent_run_server: audit-chain verifier OK — {entries} entries verified from genesis"
            );
        }
        ChainStatus::Verified { .. } => {}
        // ALARM (the diagnostics Err→Broken policy). Surfaced loudly; never suppressed, never
        // fail-closed (observability only). The reason is an `audit_id`, not a row body.
        ChainStatus::Broken { reason } => {
            eprintln!(
                "hub_agent_run_server: AUDIT-CHAIN BROKEN — integrity alarm: {reason} (observability alarm; serving continues)"
            );
        }
    }
    status
}

/// (INFO-sub2 observability) Spawn the OPTIONAL background audit-chain verifier on its OWN thread +
/// OWN DB connection (mirrors [`spawn_session_reaper`], EXCEPT it opens the DB **READ-ONLY** via
/// `Db::open_hub_readonly`). The read-only `SQLITE_OPEN_READ_ONLY` connection enforces the
/// read-only contract at the OS level — this thread CANNOT write audit rows even by mistake (the
/// opposite of the verify-then-write anti-pattern). It runs [`run_audit_chain_verify_tick`] (a
/// full chain recompute) ONCE immediately (the BOOT verify — this is `boot-chainverify`: a chain
/// already broken at startup must surface NOW, not one interval later) and then on every
/// [`AUDIT_CHAIN_VERIFY_INTERVAL`], logging OK / ALARMing on Broken. The boot verify is safe: by
/// the time this thread opens read-only, the main server connection has already migrated the DB
/// to the code's schema version, so the read-only open's strict version check passes. (It is a
/// `loop { tick; sleep }` — NOT the reaper's `loop { sleep; tick }` — precisely because the reaper
/// has nothing urgent at boot whereas a tamper alarm does.)
///
/// Errors are LOGGED and the thread exits or the loop continues — the verifier NEVER panics the
/// daemon and NEVER refuses service (it is observability, not a gate). A failed read-only open
/// (e.g. a schema-version mismatch during a deploy-gap) logs and the verifier simply does not run;
/// serving is unaffected.
fn spawn_audit_chain_verifier(db_path: String) {
    thread::spawn(move || {
        // Open this thread's OWN connection READ-ONLY. A failed open is logged and the verifier
        // exits (the daemon keeps serving); it does NOT crash the process and NEVER falls back to
        // a writable connection.
        let db = match friday_storage::Db::open_hub_readonly(&db_path) {
            Ok(db) => db,
            Err(_e) => {
                // Category only — never the db_path (it can carry the operator's home/username).
                eprintln!(
                    "hub_agent_run_server: audit-chain verifier could not open its READ-ONLY DB connection — verifier not running (serving unaffected)"
                );
                return;
            }
        };
        eprintln!(
            "hub_agent_run_server: audit-chain VERIFIER ENABLED (read-only, interval={}s)",
            AUDIT_CHAIN_VERIFY_INTERVAL.as_secs()
        );
        loop {
            // BOOT-first: verify ONCE immediately, THEN sleep — so a chain already broken at
            // startup alarms now, not one interval later. The tick logs/alarms internally; the
            // returned status is for tests.
            let _ = run_audit_chain_verify_tick(&db);
            thread::sleep(AUDIT_CHAIN_VERIFY_INTERVAL);
        }
    });
}

/// (S10-B) The env flag that gates the SCHEDULER TICK engine — the FIRING half of the scheduler
/// (S10-A built the parser/evaluator + storage rows/lease/control/receipts; this is the loop that
/// makes a DUE schedule actually fire). DEFAULT-OFF and STRICT exact-1 (the program-standard idiom
/// used by mission-/run-control/retention flags): the tick thread is spawned ONLY when
/// `FRIDAY_SCHEDULER_TICK_ENABLED` is exactly the trimmed `"1"`. Unset, empty, `"true"`, `"0"`, or
/// any other value ⇒ the thread is NEVER spawned ⇒ no second DB connection, no scan, NOTHING fires
/// ⇒ byte-identical to today (schedules never fire). Because the tick dispatches REAL workflow runs,
/// this is the riskiest dark flag — wire-live = (deploy + WAL flip + enrol the lease holder + set
/// this flag) is a SEPARATE operator-gated DEPLOY-GO step.
const SCHEDULER_TICK_ENABLED_ENV: &str = "FRIDAY_SCHEDULER_TICK_ENABLED";

/// The scheduler tick cadence (60s — one minute, the slot granularity). One tick per minute is
/// sufficient: the engine's storm guard collapses any missed ticks to the most-recent due slot, so a
/// slower-than-once-a-minute cadence never double-fires and never loses more than the most-recent
/// slot of a missed window.
const SCHEDULER_TICK_INTERVAL: Duration = Duration::from_secs(60);

/// The lease cadence: the holder claims the single-instance lease for a TTL of a few ticks so a
/// crashed holder is reclaimed within bounds, and refreshes it on every tick.
const SCHEDULER_LEASE_TTL: Duration = Duration::from_secs(180);

/// Whether the operator has explicitly enabled the scheduler tick engine. Fail-closed: only the
/// exact trimmed `"1"` enables it; everything else (including unset) is OFF.
fn scheduler_tick_enabled() -> bool {
    scheduler_tick_enabled_from(env::var(SCHEDULER_TICK_ENABLED_ENV).ok().as_deref())
}

/// Pure flag-matcher for [`SCHEDULER_TICK_ENABLED_ENV`] (separated from the env read so it is
/// testable without mutating the process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false;
/// ON only for the exact opt-in value `"1"` (trimmed), matching the program's standard flag idiom;
/// everything else (including `"true"`) ⇒ false.
fn scheduler_tick_enabled_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// Spawn the DARK scheduler TICK engine on its OWN thread + OWN DB connection (mirrors the reaper:
/// `Db::open_hub`, which IS the concurrency-safe `open_hub_concurrent` — WAL + `HUB_BUSY_TIMEOUT_MS`
/// busy_timeout + a bounded busy-retry on open — so a tick write under contention RETRIES instead of
/// failing/corrupting, the same posture every other Hub writer uses; the one-time WAL flip is a no-op
/// once the prod file is already WAL). On every [`SCHEDULER_TICK_INTERVAL`] it:
///   1. acquires/refreshes the SINGLE-INSTANCE lease (`acquire_lease`) for this holder. If another
///      LIVE holder owns it, this instance stands down for the tick (the containment layer — exactly
///      one daemon may tick at a time). A crashed holder's expired lease is superseded.
///   2. runs ONE bounded tick (`scheduler_tick::run_one_tick_live`) — pause-checked, storm-guarded,
///      serialization-guarded, fire/consider-capped — dispatching due workflows through the existing
///      `run_stored_published_workflow` seam with a DENY-ALL approval policy (so an unattended
///      scheduled run PAUSES at its first mutating step and never executes a side effect).
///
/// Errors (a failed open, a failed tick) are LOGGED (category only — never the db_path/row bodies)
/// and the loop CONTINUES — the tick never panics the daemon. A non-empty tick logs refs-only counts.
fn spawn_scheduler_tick(db_path: String, workspace_root: String) {
    thread::spawn(move || {
        // This thread's OWN connection. A failed open is logged (category only) and the tick exits;
        // the daemon keeps serving.
        let db = match friday_storage::Db::open_hub(&db_path) {
            Ok(db) => db,
            Err(_e) => {
                eprintln!(
                    "hub_agent_run_server: scheduler tick could not open its DB connection — tick not running"
                );
                return;
            }
        };
        // A stable, per-process lease holder id (pid-anchored). The lease is single-instance
        // containment; the HARD at-most-once is the engine's deterministic-run-id create_run PK.
        let holder = format!("hub-agent-run-server:{}", std::process::id());
        // The agent loop's fs tools are contained to the workspace root (the same root the live
        // session loop uses). Built once; reused across ticks.
        let executor = friday_hub::FsToolExecutor::new(PathBuf::from(&workspace_root));
        // DENY-ALL approval: a fired workflow's mutating/checkpoint step is never auto-approved — it
        // PAUSES (AwaitingCheckpoint). An unattended scheduled run can never execute a side effect.
        let deny_all = |_r: &friday_core::gate::MutatingActionRequest| -> Option<
            friday_core::gate::CanonicalApproval,
        > { None };
        // The engine evidence-signing secret. This is the scheduler thread's OWN ephemeral secret,
        // built ONCE and reused for every tick so it is self-consistent WITHIN this thread (a run's
        // read-step evidence verifies against the same key that signed it). It is NOT the main
        // server's session-loop secret (that one is seeded with real nanos); the two are independent
        // ephemeral keys. That is safe in this dark slice because a scheduled run is dispatched and
        // (for a read-only workflow) completes WITHIN this thread's run — it is never handed to the
        // main server's run-control plane for resume (scheduled-run resume is not wired here), so no
        // cross-secret evidence re-verification can occur. Under deny-all a mutating step PAUSES and
        // never executes, so this signs only read-step evidence.
        let secret = ephemeral_dev_secret(std::process::id(), 0);
        let bounds = friday_hub::scheduler_tick::TickBounds::default();
        eprintln!(
            "hub_agent_run_server: scheduler TICK engine ENABLED (interval={}s, holder={holder})",
            SCHEDULER_TICK_INTERVAL.as_secs()
        );
        loop {
            thread::sleep(SCHEDULER_TICK_INTERVAL);
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let lease_expires = now_ms + SCHEDULER_LEASE_TTL.as_millis() as i64;
            // (1) Single-instance containment: claim/refresh the lease. If a DIFFERENT live holder
            // owns it, stand down this tick (only one daemon ticks at a time). A lease error is
            // logged (category only) and the tick is skipped — never crashes the loop.
            match friday_storage::schedule::acquire_lease(db.conn(), &holder, lease_expires, now_ms)
            {
                Ok(friday_storage::schedule::LeaseAcquireOutcome::Acquired) => {}
                Ok(friday_storage::schedule::LeaseAcquireOutcome::HeldByOther) => {
                    // Another instance is the active ticker; this one is a hot standby.
                    continue;
                }
                Err(_e) => {
                    eprintln!(
                        "hub_agent_run_server: scheduler lease acquire failed (skipping tick)"
                    );
                    continue;
                }
            }
            // (NEW-38) Heal stale scheduled workflow-run orphans under the SAME scheduler lease,
            // before the next fire decision. This is limited to stale `sched:` Pending/Running rows;
            // boot recovery stays unconditional and manual workflow runs stay out of scope.
            match friday_hub::crash_recovery::reconcile_stale_scheduled_runs(&db, now_ms) {
                Ok(outcome) if !outcome.is_empty() => {
                    eprintln!(
                        "hub_agent_run_server: scheduler stale-run reconcile aborted={} skipped={}",
                        outcome.aborted, outcome.skipped,
                    );
                }
                Ok(_) => {}
                Err(_e) => {
                    eprintln!(
                        "hub_agent_run_server: scheduler stale-run reconcile failed (continuing)"
                    );
                }
            }
            // (2) Run ONE bounded tick. A tick error is logged (category only) and the loop
            // continues; the tick never crashes the daemon.
            match friday_hub::scheduler_tick::run_one_tick_live(
                &db, &bounds, now_ms, &executor, &secret, &deny_all,
            ) {
                Ok(out) if !out.is_empty() => {
                    eprintln!(
                        "hub_agent_run_server: scheduler tick fired={} considered={} paused={}",
                        out.fired, out.considered, out.paused,
                    );
                }
                // A quiet tick (nothing due) stays silent to avoid log spam.
                Ok(_) => {}
                Err(_e) => {
                    eprintln!("hub_agent_run_server: scheduler tick failed (continuing)");
                }
            }
        }
    });
}

/// (gap #24) Run ONE boot-time crash-recovery sweep — FAIL-SAFE. Opens its OWN short-lived `Db`
/// connection (the accept-loop runtime connection is never shared), reconciles genuinely-orphaned
/// in-flight WorkItems to `FailedTerminal`, and LOGS a refs-only count line. EVERY error path
/// (a failed open, a failed scan) is LOGGED (category only — never the db_path, which can carry the
/// operator's home/username) and SWALLOWED: this MUST NEVER block server boot. Runs synchronously
/// here, before the accept loop, so the cleanup completes before any connection is served.
fn run_boot_crash_recovery(db_path: &str) {
    let db = match friday_storage::Db::open_hub(db_path) {
        Ok(db) => db,
        Err(_e) => {
            eprintln!(
                "hub_agent_run_server: crash-recovery could not open its DB connection — skipping (boot continues)"
            );
            return;
        }
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    match friday_hub::crash_recovery::reconcile_orphaned_work_items(&db, now_ms) {
        Ok(outcome) => {
            eprintln!(
                "hub_agent_run_server: crash-recovery hard-enabled — reconcile scanned={} aborted={} skipped={}",
                outcome.scanned, outcome.aborted, outcome.skipped,
            );
        }
        // A scan-level error is non-fatal: the server still comes up (boot is load-bearing). Category
        // only — never row contents / the db_path.
        Err(_e) => {
            eprintln!(
                "hub_agent_run_server: crash-recovery reconcile failed (continuing — boot is not blocked)"
            );
        }
    }
    // (#784(b)) ALSO reconcile orphaned SCHEDULED workflow runs to `Failed`. A scheduled run executes
    // synchronously inside one scheduler tick, so a `Pending`/`Running` `sched:` run at boot is a
    // daemon that DIED mid-tick; left non-terminal it permanently WEDGES its schedule (the tick's
    // serialization guard refuses to fire while a prior run is non-terminal). This runs BEFORE the
    // scheduler tick thread is spawned, so a cleared wedge fires again on the first post-boot tick.
    // Same fail-safe posture as the WorkItem sweep — a scan/per-row error is logged + swallowed.
    match friday_hub::crash_recovery::reconcile_orphaned_scheduled_runs(&db, now_ms) {
        Ok(outcome) if !outcome.is_empty() => {
            eprintln!(
                "hub_agent_run_server: crash-recovery scheduled-run reconcile aborted={} skipped={}",
                outcome.aborted, outcome.skipped,
            );
        }
        // No orphaned scheduled runs (the common case) — stay quiet to avoid boot log spam.
        Ok(_) => {}
        Err(_e) => {
            eprintln!(
                "hub_agent_run_server: crash-recovery scheduled-run reconcile failed (continuing — boot is not blocked)"
            );
        }
    }
}

/// The loopback-only S-C WS listener. Owns the socket lifecycle; the session/serve/dispatch
/// semantics live in [`establish_session`] / [`serve_sealed_session`].
struct AgentRunWsListener {
    listener: TcpListener,
}

impl AgentRunWsListener {
    /// Bind a **loopback-only** listener on `127.0.0.1:<port>` (`port = 0` lets the OS assign).
    /// Binding [`Ipv4Addr::LOCALHOST`] (NEVER `0.0.0.0`/LAN) is the "this Mac only" guarantee:
    /// off-box reachability is zero.
    fn bind_loopback(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        Ok(Self { listener })
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept exactly ONE connection, set the per-connection read timeout, establish the sealed
    /// session (peer pubkey from the wire; S-F: a NON-ALLOWLISTED peer pubkey is rejected FIRST;
    /// then low-order points rejected), and serve it fail-closed — dispatching authed agent-runs.
    /// Returns the count of envelopes processed on that session.
    // (NS-5) Boot flags are threaded as booleans, mirroring NS-4/A1; bundling them into a struct is
    // deferred until a future flag warrants it (a DARK byte-identical slice avoids the churn).
    #[allow(clippy::too_many_arguments)]
    fn accept_one<T: Transport>(
        &self,
        server_kp: &DeviceKeypair,
        runtime: &HubRuntime<T>,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
        run_control_enabled: bool,
        mission_bound_run_enabled: bool,
        mission_intake_enabled: bool,
        mission_spine_dispatch_enabled: bool,
        memory_confirm_enabled: bool,
        run_outcome_learning_confirm_enabled: bool,
        token_surface_enabled: bool,
        provider_workspace_dispatch_enabled: bool,
    ) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        Self::serve_accepted_stream(
            stream,
            server_kp,
            runtime,
            owner_allowlist,
            peer_allowlist,
            run_control_enabled,
            mission_bound_run_enabled,
            mission_intake_enabled,
            mission_spine_dispatch_enabled,
            memory_confirm_enabled,
            run_outcome_learning_confirm_enabled,
            token_surface_enabled,
            provider_workspace_dispatch_enabled,
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn accept_one_with_timeout<T: Transport>(
        &self,
        timeout: Duration,
        server_kp: &DeviceKeypair,
        runtime: &HubRuntime<T>,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
        run_control_enabled: bool,
        mission_bound_run_enabled: bool,
        mission_intake_enabled: bool,
        mission_spine_dispatch_enabled: bool,
        memory_confirm_enabled: bool,
        run_outcome_learning_confirm_enabled: bool,
        token_surface_enabled: bool,
        provider_workspace_dispatch_enabled: bool,
    ) -> Result<usize, TransportError> {
        self.listener.set_nonblocking(true)?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match self.listener.accept() {
                Ok((stream, _peer)) => {
                    self.listener.set_nonblocking(false)?;
                    stream.set_nonblocking(false)?;
                    return Self::serve_accepted_stream(
                        stream,
                        server_kp,
                        runtime,
                        owner_allowlist,
                        peer_allowlist,
                        run_control_enabled,
                        mission_bound_run_enabled,
                        mission_intake_enabled,
                        mission_spine_dispatch_enabled,
                        memory_confirm_enabled,
                        run_outcome_learning_confirm_enabled,
                        token_surface_enabled,
                        provider_workspace_dispatch_enabled,
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        self.listener.set_nonblocking(false)?;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "timed out waiting for TS interop client connection",
                        )
                        .into());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    self.listener.set_nonblocking(false)?;
                    return Err(e.into());
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn serve_accepted_stream<T: Transport>(
        stream: TcpStream,
        server_kp: &DeviceKeypair,
        runtime: &HubRuntime<T>,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
        run_control_enabled: bool,
        mission_bound_run_enabled: bool,
        mission_intake_enabled: bool,
        mission_spine_dispatch_enabled: bool,
        memory_confirm_enabled: bool,
        run_outcome_learning_confirm_enabled: bool,
        token_surface_enabled: bool,
        provider_workspace_dispatch_enabled: bool,
    ) -> Result<usize, TransportError> {
        // HARDENING: a per-connection read timeout BEFORE any read, so a stalled peer cannot
        // wedge the single-threaded accept loop before auth/dispatch.
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let (mut ws, session_key, session_nonce) =
            establish_session(stream, server_kp, peer_allowlist)?;
        serve_sealed_session(
            &mut ws,
            &session_key,
            &session_nonce,
            runtime,
            owner_allowlist,
            run_control_enabled,
            mission_bound_run_enabled,
            mission_intake_enabled,
            mission_spine_dispatch_enabled,
            memory_confirm_enabled,
            run_outcome_learning_confirm_enabled,
            token_surface_enabled,
            provider_workspace_dispatch_enabled,
        )
    }
}

/// Serve sealed envelopes over ONE established session until the peer disconnects, sends an
/// envelope that fails to open under the session key, OR completes/fails an agent-run dispatch.
///
/// **S-C dispatch arm.** A sealed envelope that opens to [`Message::AgentRunRequest`] is the
/// dispatch path:
/// 1. [`AuthedPrincipal::authenticate_forwarded`] verifies the forwarded principal against the
///    session (possession-of-session proof + non-empty + non-anonymous + owner-allowlist).
/// 2. `Some(caller)` ⇒ [`run_authed_agent_loop`] runs the Rust loop AS the authed owner; a
///    REFS-ONLY [`Message::AgentRunResult`] (status + answer sha256/len — NEVER the body) is
///    sent over the wire, and the answer BODY is delivered SEALED back over the SAME session
///    (the owner-only channel) — never as a refs field.
/// 3. `None` (auth fail: forged / empty / anonymous / non-allowlisted principal, OR an
///    `auth_proof` that does not open) ⇒ **fail closed**: NO run, NO body, END the session.
///    Never a partial success.
///
/// Any other (benign) opened envelope is echoed sealed (a keepalive), as in S-B. An envelope
/// that fails to open under the session key ENDS the session (fail-closed) — no dispatch.
///
/// **S-E anti-replay — msg_id dedup.** A per-session [`IdempotencyTracker`] records each opened
/// envelope's `msg_id`; a REPLAYED `msg_id` within this session is rejected fail-closed (END the
/// session, no echo, no dispatch). The tracker is fresh per connection (it lives on the stack of
/// THIS call), so it defends WITHIN-session replay; CROSS-handshake replay is defeated separately
/// by the per-handshake `session_nonce` bound into the auth challenge.
///
/// Returns the number of envelopes processed before the session ended — `0` means the first
/// envelope failed to open OR failed auth (the fail-closed path: no echo, no dispatch).
// (NS-5) Boot flags are threaded as booleans, mirroring NS-4/A1; bundling them into a struct is
// deferred until a future flag warrants it (a DARK byte-identical slice avoids the churn).
#[allow(clippy::too_many_arguments)]
fn serve_sealed_session<S: Read + Write, T: Transport>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    session_nonce: &[u8],
    runtime: &HubRuntime<T>,
    owner_allowlist: &[String],
    run_control_enabled: bool,
    mission_bound_run_enabled: bool,
    mission_intake_enabled: bool,
    mission_spine_dispatch_enabled: bool,
    memory_confirm_enabled: bool,
    run_outcome_learning_confirm_enabled: bool,
    token_surface_enabled: bool,
    provider_workspace_dispatch_enabled: bool,
) -> Result<usize, TransportError> {
    let mut processed = 0usize;
    let activity_mark_done_enabled =
        activity_mark_done_enabled_from(env::var(ACTIVITY_MARK_DONE_ENABLED_ENV).ok().as_deref());
    let context_passport_transfer_enabled = context_passport_transfer_enabled_from(
        env::var(CONTEXT_PASSPORT_TRANSFER_ENABLED_ENV)
            .ok()
            .as_deref(),
    );
    // S-E: per-session msg_id dedup. A reconnect mints a FRESH tracker (so it is not a
    // cross-connection store) — combined with the per-handshake nonce, a captured envelope is
    // useless both within a session (dedup) and across handshakes (nonce).
    let mut seen_ids = IdempotencyTracker::new();
    loop {
        let env = match ws_recv_envelope(ws, session_key, SESSION_AAD) {
            Ok(e) => e,
            // EOF / disconnect / un-openable seal (wrong key or tamper) → END the session.
            // No dispatch, no processing — fail closed.
            Err(_) => return Ok(processed),
        };
        // M5: within-session bound (defense-in-depth). At the cap, a NEW msg_id fail-closes the
        // session WITHOUT being recorded (no evict — eviction would reopen anti-replay). A REPLAY of
        // an already-seen id falls through to the existing Replay check below. Same fail-close form.
        if seen_ids.len() >= MAX_SESSION_MSG_IDS && !seen_ids.has_seen(&env.msg_id) {
            return Ok(processed);
        }
        // S-E: reject a REPLAYED msg_id within this session (fail-closed: END the session, no
        // echo, no dispatch). Checked BEFORE any branch so it covers dispatch AND keepalive.
        if let Seen::Replay = seen_ids.observe(&env.msg_id) {
            return Ok(processed);
        }
        match env.message {
            Message::AgentRunRequest {
                run_id,
                task,
                forwarded_principal,
                auth_proof,
                session_id,
                // (A1 run-controls — APPLICATION) The per-run CONSTRAINTS the peer asserts. The
                // wire SHAPE + the pure mapping landed in #660; THIS slice APPLIES them on the live
                // dispatch by COMPOSING them onto the runtime's boot policy
                // ([`friday_hub::agent_run_control::effective_run_policy_over`]) and threading the
                // result through the per-run policy override the runtime now accepts. ABSENT
                // (`None`) ⇒ NO override ⇒ the boot policy/ceiling, byte-identical to pre-A1.
                constraints,
                // (NS45-PR1 / M-4) The FIRST-CLASS Mission handle this run binds to, retiring the
                // `session_id`-as-surface-thread shim NS-4 used for mission resolution. ABSENT
                // (`None`) ⇒ NO handle ⇒ the run is NOT mission-resolvable ⇒ the unbound path,
                // byte-identical to today. PRESENT ⇒ the mission-bound seam (when the flag is ON)
                // resolves the Mission via `by_mission_work_item` from this handle.
                mission_context,
            } => {
                // The dispatch arm: AUTH BEFORE ANY RUN. The `auth_proof` is the peer-sealed
                // challenge; reconstruct it as a `Sealed` for the session-key open. A malformed
                // proof that cannot decode is an auth failure (None below), not a panic. S-E: the
                // verifier binds THIS handshake's `session_nonce` into the challenge and the
                // `(principal, run_id)` into the AAD — a captured/lifted proof fails to verify.
                let caller = decode_sealed_proof(&auth_proof).and_then(|proof| {
                    AuthedPrincipal::authenticate_forwarded(
                        session_key,
                        SESSION_AAD,
                        AUTH_CHALLENGE,
                        ForwardedAuth {
                            auth_proof: &proof,
                            session_nonce,
                            // S-R0: the write path binds the proof to the `run_id` bytes — the
                            // SAME bytes the prior `run_id: &str` field produced, so the AAD is
                            // byte-unchanged for writes.
                            bound_context: run_id.as_bytes(),
                            forwarded_principal: &forwarded_principal,
                        },
                        owner_allowlist,
                    )
                });
                let Some(caller) = caller else {
                    // FAIL CLOSED: a correct-handshake peer with a forged / empty / anonymous /
                    // non-allowlisted principal (or an un-openable proof) is REJECTED. NO run,
                    // NO body, END the session — never a partial success.
                    return Ok(processed);
                };

                // AUTHENTICATED: run the Rust loop AS the bound owner. A route/provider failure
                // is a SAFE FAILURE (body-free NoAnswer) — never a panic, never a partial body.
                //
                // (A2a Phase 1 / memory-loop) Dispatch on the client-asserted `session_id`, but
                // BOTH arms now run the SESSIONED entry [`HubRuntime::run_session_task_with_overrides`]
                // (the EXISTING `run_session_loop`), with the session OWNER = the AUTHENTICATED
                // `caller` (NEVER the client-asserted `session_id`):
                //   * PRESENT (non-empty) ⇒ the caller's STABLE session id — reloads its history,
                //     appends this turn (a real multi-turn conversation).
                //   * ABSENT (or blank) ⇒ an EPHEMERAL per-run session id == the `run_id`. It loads
                //     EMPTY history (behaviorally one-shot, like the prior sessionless arm) but now
                //     fires the flag-gated post-run memory extraction + writes session/message rows,
                //     CLOSING the extract→confirm→recall loop on the common live path (extraction
                //     structurally needs a session; recall is owner-namespace-keyed, not
                //     session-keyed, so the per-run session still recalls across runs as the owner).
                // A blank/whitespace `session_id` is treated as ABSENT. Both arms share the IDENTICAL
                // refs + owner-sealed-body emit below (the body is owner-gated by
                // `project_answer_for_authed` in BOTH), so the only difference is which session id ran.
                let now_ms = now_ms();

                // (A1 run-controls — APPLICATION) Compute the per-run policy + max-turns OVERRIDE
                // ONCE (before the session/sessionless branch) so BOTH arms apply the SAME
                // effective gate. The override COMPOSES the peer's asserted `constraints` onto the
                // runtime's boot policy ([`effective_run_policy_over`]) so it can ONLY TIGHTEN
                // (read-only OR, disabled-tools UNION; the bound owner is unchanged).
                //
                // DARK + DEPLOY-GO-gated, TWO independent reasons it changes NO live behavior:
                //   (1) FLAG: the override is built ONLY when `run_control_enabled`
                //       (`FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`, default-off). Flag OFF ⇒ `None`
                //       override ⇒ the boot policy/ceiling, byte-identical to pre-A1 — even if a
                //       peer somehow asserted constraints, they are IGNORED with the flag off.
                //   (2) ABSENT: even with the flag on, a request that carries NO `constraints`
                //       block (every live courier today) yields `effective_run_policy_over(boot,
                //       None) == boot.clone()` ⇒ `Some(boot-equal)` which gates identically to the
                //       boot policy, and `effective_max_turns(default, None) == default`. So the
                //       only behavior change is for a request that EXPLICITLY asserts a TIGHTER
                //       constraint while the flag is on — strictly a restriction.
                //
                // We pass the override as `Some(&effective_policy)` whenever the flag is on (even
                // for absent constraints, where it equals boot) so the application path is
                // exercised uniformly; absent + flag-on stays byte-equivalent because the composed
                // policy equals boot. With the flag off we pass `None` so the runtime takes its
                // own `self.policy` reference (no clone, the exact pre-A1 object).
                let effective_policy = if run_control_enabled {
                    Some(friday_hub::agent_run_control::effective_run_policy_over(
                        runtime.policy(),
                        constraints.as_ref(),
                    ))
                } else {
                    None
                };
                let max_turns_override = if run_control_enabled {
                    constraints.as_ref().and_then(|c| c.max_turns)
                } else {
                    None
                };
                let policy_override = effective_policy.as_ref();

                // (NS45-PR1 / M-4) MISSION-BOUND seam — FLAG-GATED, the FIRST dispatch consulted.
                // When `FRIDAY_MISSION_BOUND_RUN` is ON **and** this run carries a FIRST-CLASS
                // `mission_context` handle that resolves to a live Mission/WorkItem, the run is
                // dispatched BOUND through that WorkItem's routed provider seam and returns
                // `Some(answer)`. A present handle that cannot be serviced fails closed to
                // body-free `NoAnswer`; only a request with NO handle falls through to the
                // EXISTING unbound dispatch below.
                //
                // The mission handle, NOT the `session_id` shim, is now the resolution source
                // (M-4: the provisional surface-thread conflation is retired). With the flag OFF
                // and NO handle the `else` arm binds `None` WITHOUT ever calling the seam. With the
                // flag OFF but a handle present, fail closed rather than running unbound under a
                // mission-bound route projection.
                let mission_bound = if mission_bound_run_enabled {
                    friday_hub::hub_server::run_authed_agent_loop_mission_bound(
                        runtime,
                        &caller,
                        &run_id,
                        &task,
                        mission_context.as_ref(),
                        policy_override,
                        max_turns_override,
                        now_ms,
                    )
                } else if mission_context.is_some() {
                    Some(friday_hub::hub_server::AuthedAnswer::NoAnswer {
                        run_id: run_id.clone(),
                    })
                } else {
                    None
                };

                let (outcome, mission_bound_learning_session_id) =
                    if let Some(answer) = mission_bound {
                        let learning_session_id = session_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .unwrap_or(&run_id)
                            .to_string();
                        (answer, Some(learning_session_id))
                    } else {
                        let answer = match session_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                        {
                            Some(sid) => runtime.run_session_task_with_overrides(
                                &caller,
                                &run_id,
                                sid,
                                &task,
                                policy_override,
                                max_turns_override,
                                now_ms,
                            ),
                            // (memory-loop) The no-`session_id` arm now routes through the SAME
                            // SESSIONED entry with an EPHEMERAL per-run session_id == the run_id. This
                            // CLOSES the previously-inert extract→confirm→recall loop on the common
                            // live path: extraction structurally needs a session (it reads the
                            // session's pending messages + derives the owner-composite namespace), and
                            // recall is NAMESPACE-keyed (owner-derived), NOT session-keyed — so a
                            // per-run ephemeral session writes a candidate under owner O's composite
                            // namespace that a LATER run as O recalls across runs. A per-run id loads
                            // EMPTY history, so the turn is behaviorally one-shot (equivalent to the
                            // old sessionless arm) while now also writing session/message rows + firing
                            // the flag-gated, Finished-only, failure-isolated post-run extraction.
                            //
                            // NO-DEGRADE caveat (deliberate, see the PR body): this arm is NO LONGER
                            // byte-identical — closing an inert loop requires it. With
                            // FRIDAY_RUN_LOOP_MEMORY_EXTRACTION ON (a memory feature flag, default-OFF)
                            // every Finished run makes ONE extra extraction model call ⇒ one
                            // token_ledger row (the intended memory behavior). Extraction is
                            // failure-isolated (`let _` in the runtime) and can NEVER flip the run's
                            // answer/status. The owner binding stays the AUTHENTICATED `caller` (never
                            // the client-asserted session_id), so there is no cross-owner leak.
                            None => runtime.run_session_task_with_overrides(
                                &caller,
                                &run_id,
                                /* session_id = */ &run_id,
                                &task,
                                policy_override,
                                max_turns_override,
                                now_ms,
                            ),
                        };
                        (answer, None)
                    };

                // (refs) REFS-ONLY terminal receipt over the wire: status + answer FINGERPRINT
                // (sha256/len) + (A1) the run COUNTS (turns / executed_tools) — NEVER the body.
                // Mirrors `AuthedAnswer::proof_refs_json`. Counts are metadata; token counts
                // are DEFERRED (`None`) — not on `LoopOutcome`. An absent count is omitted from
                // the wire (`skip_serializing_if`) ⇒ byte-identical to the pre-A1 result.
                let refs = result_refs(&outcome);
                // (observability) Structured, body-free log of the answer-return so a 503
                // can be traced to a leg (the run_id appeared in NO log for the
                // 503-after-billing event). We log the run_id + the refs `status` + whether
                // a body will be delivered — NEVER the answer body, sha, key, or task. The
                // `has_body` flag lets the next failure distinguish a delivered-eligible run
                // (DB row present, body to send) from a denied/no-answer one. `?` on the
                // sends below means a transport drop ends the session; this line records that
                // the refs leg was REACHED with the run_id, closing the diagnostic gap.
                let has_body = outcome.delivered_body().is_some();
                if let Some(sid) = mission_bound_learning_session_id.as_deref() {
                    runtime.maybe_emit_run_outcome_learning_candidates_from_refs(
                        sid,
                        &run_id,
                        &refs.status,
                        refs.turns,
                        refs.executed_tools,
                        now_ms,
                    );
                }
                eprintln!(
                    "hub_agent_run_server_dispatch: run_id={run_id} leg=refs status={} has_body={has_body}",
                    refs.status
                );
                // (A1 run-controls) PAUSE-SURFACING — discriminate the NoAnswer black hole. When
                // the run produced NO body, it is EITHER a genuine no-answer OR a PAUSE (the loop
                // persisted a `pending_approval_request` before returning, and the server only
                // sees `NoAnswer`). FLAG-GATED + DARK: only when the run-control flag is ON do we
                // probe the DB for a live pending row and, if found, emit `AgentRunPaused` instead
                // of `AgentRunResult{no_answer}`. With the flag OFF this branch is never taken, so
                // a paused run emits EXACTLY the pre-A1 `AgentRunResult{status:"no_answer"}` bytes
                // (the deploy-safety invariant). The pause frame is REFS-ONLY (nonce + digest +
                // action-verb summary — never the tool body/args).
                let result = if run_control_enabled && !has_body {
                    match friday_hub::agent_run_control::detect_pause(runtime.db().conn(), &run_id)
                    {
                        Ok(Some(pause)) => {
                            eprintln!(
                                "hub_agent_run_server_dispatch: run_id={run_id} leg=paused (run-control enabled)"
                            );
                            Some(Envelope::new(
                                format!("agent-run-paused-{run_id}"),
                                now_ms,
                                Message::AgentRunPaused {
                                    run_id: run_id.clone(),
                                    nonce: pause.nonce,
                                    action_digest: pause.action_digest,
                                    summary: pause.summary,
                                },
                            ))
                        }
                        // No live pending row (genuine no-answer) ⇒ fall through to the unchanged
                        // refs result. A DB probe error is non-fatal: fail SAFE to the pre-A1 path
                        // (never panic, never fabricate a pause).
                        _ => None,
                    }
                } else {
                    None
                };
                // (Loop4 wire-fields) Compute the run's per-run TOKEN SURFACE for the refs result.
                // FLAG-GATED + FAIL-SAFE: with `token_surface_enabled` OFF (default) this returns
                // `(None, None)` WITHOUT a DB read, so the `AgentRunResult` below is byte-identical
                // to the pre-Loop4 wire; with it ON, the surface is the SUM of this run's
                // `token_ledger` rows (a ledger read error falls back to `None`, never panics, never
                // blocks the already-persisted answer). This is computed ONCE before the
                // `unwrap_or_else` (the `AgentRunPaused` branch above has NO token fields and is
                // unaffected; the closure that consumes the surface only runs for the refs result).
                let (prompt_tokens, completion_tokens) =
                    run_token_surface(token_surface_enabled, runtime.db().conn(), &run_id);
                let result = result
                    .unwrap_or_else(|| {
                        Envelope::new(
                            format!("agent-run-result-{run_id}"),
                            now_ms,
                            Message::AgentRunResult {
                                run_id: run_id.clone(),
                                status: refs.status,
                                answer_sha256: refs.answer_sha256,
                                answer_len: refs.answer_len,
                                turns: refs.turns,
                                executed_tools: refs.executed_tools,
                                prompt_tokens,
                                completion_tokens,
                            },
                        )
                    })
                    .with_correlation(env.msg_id.clone());
                if let Err(err) = ws_send_envelope(ws, session_key, &result, SESSION_AAD) {
                    // The refs frame could not be sent (transport closed). Log which leg
                    // failed (run_id + leg) before ending the session — this is the leg-A
                    // "closed-before-the-result" surface; the body is safely in the DB.
                    eprintln!(
                        "hub_agent_run_server_dispatch: run_id={run_id} leg=refs_send error=transport_closed"
                    );
                    return Err(err);
                }

                // (body) Deliver the answer BODY ONLY to the authed owner — SEALED back over the
                // SAME session (the owner-only channel). The body NEVER travels in the refs
                // result. We DOUBLY seal it: `seal(session_key, body)` first (so the body bytes
                // are owner-sealed ciphertext BEFORE they enter any Message), then the transport
                // seals the envelope again — so even a future plaintext log of the carrier never
                // exposes the body. The owner-sealed ciphertext rides the `AskFridayStream.chunk`
                // (the existing Friday-answer-to-owner channel) as hex, terminated by the refs
                // `AgentRunResult` already sent above. A non-delivered outcome (denied /
                // no-answer) sends NO body envelope. Reuses ONLY public protocol/transport items.
                if let Some(body) = outcome.delivered_body() {
                    let sealed_body = seal(session_key, body.as_bytes(), SESSION_AAD)?;
                    let body_env = Envelope::new(
                        format!("agent-run-body-{run_id}"),
                        now_ms,
                        Message::AskFridayStream {
                            seq: 0,
                            chunk: hex_encode(&encode_sealed_proof(&sealed_body)),
                        },
                    )
                    .with_correlation(env.msg_id.clone());
                    if let Err(err) = ws_send_envelope(ws, session_key, &body_env, SESSION_AAD) {
                        // The owner-sealed BODY frame could not be sent. This is the leg-A
                        // "closed-before-the-body" surface: the refs were sent + the answer is
                        // safely persisted in the DB, but the body frame dropped → the TS
                        // sealed client 503s post-billing. Log run_id + leg (NEVER the body)
                        // so the next occurrence is attributable. (See the deferred leg-A
                        // decouple in the PR body.)
                        eprintln!(
                            "hub_agent_run_server_dispatch: run_id={run_id} leg=body_send error=transport_closed"
                        );
                        return Err(err);
                    }
                    eprintln!(
                        "hub_agent_run_server_dispatch: run_id={run_id} leg=body_send status=delivered"
                    );
                }
                processed += 1;
            }
            // (A1 run-controls) RESUME — relay an operator's signed approval to the S6 spine.
            // FLAG-GATED: when the flag is OFF this is a benign keepalive (echoed), so deploying a
            // v13 binary changes no behavior; only when ON do we verify+execute. Resume is
            // SELF-authenticating (the operator's Ed25519 signature is the authority); it uses the
            // runtime's verify key + executor and pre-checks the reject/cancel coupling.
            Message::AgentRunResume {
                ref run_id,
                ref signed_blob,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match runtime.operator_vk() {
                    // MISSION-BOUND seam (FRIDAY_MISSION_BOUND_RUN, default-OFF): when ON, route
                    // resume through the mission-bound wrapper, which (1) delegates VERBATIM to the
                    // SAME `agent_run_control::resume` spine and then (2) — ONLY on a proven
                    // execution (`accepted == executed == true`) AND a run that resolves to its OWN
                    // pause-time bound WorkItem — advances that WorkItem ProviderRouted →
                    // CompletedWithProof. A run with no resolvable bound WorkItem (every non-mission
                    // resume) returns the bare-resume `ControlOutcome` UNMODIFIED after only reads,
                    // so a flag-ON non-mission resume is BYTE-IDENTICAL to the bare path. Flag OFF ⇒
                    // the bare spine, byte-identical to today.
                    Some(vk) if mission_bound_run_enabled => {
                        friday_hub::mission_runtime::resume_agent_loop_for_mission(
                            runtime.db(),
                            runtime.executor(),
                            vk,
                            run_id,
                            signed_blob,
                            now_ms,
                        )
                        .unwrap_or_else(|_| {
                            friday_hub::agent_run_control::ControlOutcome {
                                op: "resume",
                                accepted: false,
                                status: "storage_failed".to_string(),
                                audit_ref: None,
                            }
                        })
                    }
                    Some(vk) => friday_hub::agent_run_control::resume(
                        runtime.db().conn(),
                        runtime.executor(),
                        vk,
                        run_id,
                        signed_blob,
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        // A storage error is a fail-closed refusal (never a panic / partial).
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "resume",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    // No operator key provisioned ⇒ cannot verify ⇒ fail-closed refusal.
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "resume",
                        accepted: false,
                        status: "operator_vk_unprovisioned".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // (A1 run-controls) CANCEL — owner-authed terminal stop. FLAG-GATED (keepalive when
            // off). The forwarded principal is authenticated against the sealed session (the SAME
            // possession proof an AgentRunRequest carries, bound to this run_id), then the control
            // module requires that authenticated principal == the run's bound owner.
            Message::AgentRunCancel {
                ref run_id,
                ref forwarded_principal,
                ref auth_proof,
                ref reason,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match authenticate_control_caller(
                    session_key,
                    session_nonce,
                    owner_allowlist,
                    auth_proof,
                    run_id,
                    forwarded_principal,
                ) {
                    Some(caller) => friday_hub::agent_run_control::cancel(
                        runtime.db().conn(),
                        run_id,
                        caller.principal(),
                        reason.as_deref(),
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "cancel",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    // Session auth failed (forged / non-allowlisted / un-openable proof) ⇒
                    // fail-closed refusal. We do NOT end the session (a control op is not a
                    // dispatch); we answer the refusal and keep serving.
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "cancel",
                        accepted: false,
                        status: "auth_failed".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // (A1 run-controls) REJECT — owner-authed refusal of ONE pending tool-approval.
            // FLAG-GATED (keepalive when off). Same owner-auth as cancel.
            Message::AgentRunReject {
                ref run_id,
                ref approval_id,
                ref forwarded_principal,
                ref auth_proof,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match authenticate_control_caller(
                    session_key,
                    session_nonce,
                    owner_allowlist,
                    auth_proof,
                    run_id,
                    forwarded_principal,
                ) {
                    Some(caller) => friday_hub::agent_run_control::reject(
                        runtime.db().conn(),
                        run_id,
                        approval_id,
                        caller.principal(),
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "reject",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "reject",
                        accepted: false,
                        status: "auth_failed".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // (NS-5) MISSION-INTAKE ingress — FLAG-GATED. When `FRIDAY_MISSION_INTAKE` is ON, an
            // inbound `MissionIntakeRequest` BIRTHS a Mission (Mission + WorkItem(Draft) +
            // SurfaceThread + route_decision) via the EXISTING
            // `friday_hub::hub_server::mission_intake_result_for_db` — the SAME Mission-birth path
            // the `HubServer::dispatch` arm uses — and replies with a `MissionIntakeResult` (or an
            // `Error` envelope on a validation/preflight failure), sealed back over the SAME
            // session and correlated to the request. The intake is a PURE `&Db` mutation: NO
            // provider/model call, so it writes ZERO `token_ledger` rows. The session is the
            // channel auth (the sealed session opened ⇒ the peer holds the session key); intake
            // carries no per-run `auth_proof`, mirroring `HubServer::dispatch`'s session-authed
            // intake. When the flag is OFF this guard FAILS and a `MissionIntakeRequest` falls
            // through to the catch-all keepalive echo below — BYTE-IDENTICAL to today (the server
            // has never had a MissionIntakeRequest arm), the deploy-safety invariant.
            Message::MissionIntakeRequest { request } if mission_intake_enabled => {
                let now_ms = now_ms();
                // (FIX-Q3b) BIND the persisted Mission/conversation owner to the Rust-derived
                // AUTHENTICATED owner (`runtime.policy().principal_id()` == the configured
                // `--owner`), NOT the self-asserted `request.owner_principal` body field. A body
                // owner that does not match the authenticated owner is fail-closed (writes ZERO
                // rows) — mirroring the MemoryDecisionRequest arm. NO-DEGRADE: under single-peer
                // the body owner already equals the configured owner (the same string the bound
                // run forwards + the allowlist gates), so the live auto-dispatch path is unchanged.
                let result = friday_hub::hub_server::mission_intake_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=mission_intake (mission-intake enabled)",
                    env.msg_id
                );
                // Correlate the reply to the inbound request (consistent with every other bin
                // reply + the `mission_intake_result` dispatch caller's `.with_correlation`).
                ws_send_envelope(
                    ws,
                    session_key,
                    &result.with_correlation(env.msg_id.clone()),
                    SESSION_AAD,
                )?;
                processed += 1;
            }
            // (KEYSTONE) MISSION-LIFECYCLE dispatch — FLAG-GATED. When `FRIDAY_MISSION_SPINE_DISPATCH`
            // is ON, an inbound `MissionLifecycleRequest` advances ONE canonical Mission through the
            // Hub state machine via the EXISTING `friday_hub::hub_server::mission_lifecycle_result_for_db`
            // — the SAME transition the `HubServer::dispatch` arm uses — and replies with a
            // `MissionLifecycleResult` (or an `Error` on an unknown status / illegal hop / missing
            // Mission). PURE `&Db` mutation: NO provider/model call, ZERO `token_ledger` rows. The
            // sealed session IS the channel auth (single-peer/single-owner SERVER invariant; this wire
            // shape carries no per-request `auth_proof`), mirroring the merged mission-intake arm. When
            // the flag is OFF this guard FAILS and the request falls through to the catch-all keepalive
            // echo below — BYTE-IDENTICAL to today (the server has never had this arm).
            Message::MissionLifecycleRequest { request } if mission_spine_dispatch_enabled => {
                let now_ms = now_ms();
                // (FIX-Q3b) BIND the transition to the Rust-derived AUTHENTICATED owner
                // (`runtime.policy().principal_id()` == the configured `--owner`): the target
                // Mission MUST be owned by it, else fail-closed (no transition). An unknown Mission
                // still surfaces the existing not-found Error. NO-DEGRADE under single-peer.
                let result = friday_hub::hub_server::mission_lifecycle_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=mission_lifecycle (mission-spine enabled)",
                    env.msg_id
                );
                ws_send_envelope(
                    ws,
                    session_key,
                    &result.with_correlation(env.msg_id.clone()),
                    SESSION_AAD,
                )?;
                processed += 1;
            }
            // (KEYSTONE) WORK-ITEM-STATUS dispatch — FLAG-GATED. When `FRIDAY_MISSION_SPINE_DISPATCH`
            // is ON, an inbound `WorkItemStatusRequest` advances ONE WorkItem through the Hub state
            // machine via the EXISTING `friday_hub::hub_server::work_item_status_result_for_db` and
            // replies with a `WorkItemStatusResult` (or an `Error`). **Proof-on-completion is
            // ENFORCED at the persistence boundary:** a `completed_with_proof` target with no
            // (or empty/whitespace) `proof_receipt` is REJECTED as a typed `Error` — "done" can
            // never be claimed without proof. PURE `&Db` mutation: NO provider/model call, ZERO
            // `token_ledger` rows; the sealed session is the channel auth. When the flag is OFF this
            // guard FAILS and the request falls through to the catch-all keepalive echo below —
            // BYTE-IDENTICAL to today.
            Message::WorkItemStatusRequest { request } if mission_spine_dispatch_enabled => {
                let now_ms = now_ms();
                // (FIX-Q3b) BIND the transition to the Rust-derived AUTHENTICATED owner
                // (`runtime.policy().principal_id()` == the configured `--owner`): the target
                // WorkItem MUST be owned by it, else fail-closed (no transition). An unknown
                // WorkItem still surfaces the existing not-found Error. NO-DEGRADE under single-peer.
                let result = friday_hub::hub_server::work_item_status_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=work_item_status (mission-spine enabled)",
                    env.msg_id
                );
                ws_send_envelope(
                    ws,
                    session_key,
                    &result.with_correlation(env.msg_id.clone()),
                    SESSION_AAD,
                )?;
                processed += 1;
            }
            // (D20 W1-S3) ROUTE-DECISION CONTROL — FLAG-GATED. When
            // `FRIDAY_MISSION_SPINE_DISPATCH` is ON, an inbound `RouteDecisionControlRequest`
            // persists an OWNER veto/override before dispatch. The storage lifecycle hook then
            // blocks or remaps the later `ReadyToDispatch -> Dispatched` transition in the same DB
            // transaction. PURE `&Db` mutation: NO provider/model call, ZERO `token_ledger` rows.
            // When the flag is OFF this falls through to the catch-all keepalive echo below —
            // byte-identical deploy safety.
            Message::RouteDecisionControlRequest { request } if mission_spine_dispatch_enabled => {
                let now_ms = now_ms();
                let result = friday_hub::hub_server::route_decision_control_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=route_decision_control (mission-spine enabled)",
                    env.msg_id
                );
                ws_send_envelope(
                    ws,
                    session_key,
                    &result.with_correlation(env.msg_id.clone()),
                    SESSION_AAD,
                )?;
                processed += 1;
            }
            // MEMORY-CONFIRM dispatch — FLAG-GATED. When `FRIDAY_MEMORY_CONFIRM` is ON, an inbound
            // `MemoryDecisionRequest` applies the OWNER's explicit confirm/reject to ONE pending
            // memory candidate via the existing `friday_hub::hub_server::memory_decision_result_for_db`
            // — scoped by the Rust-derived AUTHENTICATED owner's COMPOSITE namespace candidate list
            // (the SAME list recall uses), fail-closed on mismatch / unowned / unknown / terminal — and
            // replies with a `MemoryDecisionResult` (confirmed / rejected / blocked). A `confirm` makes
            // the candidate durable AND recallable; this is the live caller that CLOSES the
            // Memory-confirmation loop's terminal arm. PURE `&Db` mutation: NO provider/model call,
            // ZERO `token_ledger` rows. The decision is the owner's OWN action — the sealed session IS
            // the channel auth (single-peer/single-owner SERVER invariant; this wire shape carries no
            // per-request `auth_proof`), mirroring the merged mission-intake/spine arms; it does NOT
            // route through the approval/trust gate. When the flag is OFF this guard FAILS and the
            // request falls through to the catch-all keepalive echo below — BYTE-IDENTICAL to today
            // (the server has never had this arm), births/changes nothing.
            Message::MemoryDecisionRequest { request } if memory_confirm_enabled => {
                let now_ms = now_ms();
                // The SCOPE source is the Rust-derived AUTHENTICATED owner
                // (`runtime.policy().principal_id()`), NOT the raw `request.owner_principal` body
                // field — the candidate's `principal_id` is the owner-COMPOSITE namespace (what
                // the live extraction keys it on), which the raw body field never equals. This is
                // the confirm-side half of the memory-loop fix (mirrors #759's recall alignment).
                let result = friday_hub::hub_server::memory_decision_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=memory_decision (memory-confirm enabled)",
                    env.msg_id
                );
                // The handler already correlates the reply to `msg_id`; send it sealed.
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            // (CORE-A CR-3) SESSION-CREATE dispatch — FLAGLESS (always-on). An inbound
            // `SessionCreateRequest` ensures ONE `agent_session` row via the EXISTING
            // `friday_hub::hub_server::session_create_result_for_db` — owner bound to the Rust-derived
            // AUTHENTICATED owner (`runtime.policy().principal_id()` == the configured `--owner`),
            // FIX-Q3b fail-closed on a disagreeing body owner — and replies with a refs-only
            // `SessionCreateResult` (or an `Error`). PURE `&Db` mutation: NO provider/model call, ZERO
            // `token_ledger` rows; the sealed session IS the channel auth (single-peer/single-owner
            // SERVER invariant). **UNLIKE the DARK-first sibling arms above (mission-intake /
            // memory-confirm) this arm is intentionally NOT flag-gated:** R14 requires a FLAGLESS
            // production-default Rust session path, and `SessionCreateRequest` is a BRAND-NEW wire kind
            // that no existing client constructs — so handling it always-on is BYTE-IDENTICAL for ALL
            // existing traffic (the deploy-safety concern the sibling flags addressed for DARK-first
            // wire-before-handler splits does not apply when wire + handler ship together).
            Message::SessionCreateRequest { request } => {
                let now_ms = now_ms();
                let result = friday_hub::hub_server::session_create_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=session_create (flagless)",
                    env.msg_id
                );
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            // (CORE-A CR-3) SESSION-MESSAGE-APPEND dispatch — FLAGLESS (always-on; same rationale as
            // the session-create arm). An inbound `SessionMessageAppendRequest` appends ONE message
            // via the EXISTING owner-gated `friday_hub::hub_server::session_message_append_result_for_db`
            // — OWNER-GATED fail-closed against the Rust-derived AUTHENTICATED owner (a message for a
            // session the authenticated principal does not own writes ZERO rows) — and replies with a
            // refs-only `SessionMessageAppendResult` (or an `Error`). PURE `&Db` mutation: NO
            // provider/model call, ZERO `token_ledger` rows.
            Message::SessionMessageAppendRequest { request } => {
                let now_ms = now_ms();
                let result = friday_hub::hub_server::session_message_append_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=session_message_append (flagless)",
                    env.msg_id
                );
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            Message::ContextPassportTransferRequest { request }
                if context_passport_transfer_enabled =>
            {
                let now_ms = now_ms();
                let result =
                    friday_hub::hub_server::context_passport_transfer_result_for_db_as_owner(
                        runtime.db(),
                        &env.msg_id,
                        request,
                        runtime.policy().principal_id(),
                        now_ms,
                    );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=context_passport_transfer (context-passport transfer enabled)",
                    env.msg_id
                );
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            Message::RunOutcomeLearningDecisionRequest { request }
                if run_outcome_learning_confirm_enabled =>
            {
                let now_ms = now_ms();
                let result = friday_hub::hub_server::run_outcome_learning_decision_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=run_outcome_learning_decision (run-outcome-learning confirm enabled)",
                    env.msg_id
                );
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            Message::ActivityMarkDoneRequest { request } if activity_mark_done_enabled => {
                let now_ms = now_ms();
                let result = friday_hub::hub_server::activity_mark_done_result_for_db(
                    runtime.db(),
                    &env.msg_id,
                    request,
                    // M6: thread the run's bound principal as the authenticated owner (mirror
                    // the memory_decision / run_outcome_learning sibling arms above) so the
                    // mark-done is owner-scoped.
                    runtime.policy().principal_id(),
                    now_ms,
                );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=activity_mark_done (activity-mark-done enabled)",
                    env.msg_id
                );
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;
                processed += 1;
            }
            // (C1/C2 §3) PROVIDER-WORKSPACE dispatch — FLAG-GATED. When `FRIDAY_PROVIDER_WORKSPACE_DISPATCH`
            // is ON, an inbound `ProviderWorkspaceActionRequest` is routed through the EXISTING
            // `friday_hub::hub_server::provider_workspace_action_result_for_db` — the SAME GATE-FIRST
            // path the `HubServer::dispatch` arm uses: it loads the Hub provider-session link, runs
            // the PWS-003 capability guard, and (only on an accepted+routed action) hands it to
            // `dispatch_provider_action` → the flag-selected adapter. It replies with a
            // `ProviderWorkspaceActionResult` carrying the guard's accepted/routed/status/blocker.
            //
            // GATE LAYERS (fail-closed, no new unauthenticated surface): (1) the SEALED SESSION is
            // the channel auth (an allowlisted peer holding the session key — the boot
            // `enforce_single_peer` guard pins this to ONE owner), mirroring the merged
            // mission-intake/spine/memory arms which also carry no per-request `auth_proof`; (2)
            // owner-binding is STRUCTURAL via the request's Mission context (the producer resolves it
            // to a live WorkItem and requires WorkItem.target_provider == session.provider == request
            // provider), so a detached/foreign-mission request fails closed before the adapter; (3)
            // the capability must be `Verified` for the guard to ROUTE — no `friday_current()`
            // capability is, so today every real request is REFUSED before the adapter regardless of
            // this flag. This arm makes the #797 dark machinery REACHABLE from the live serve-bin
            // (closing the C1/C2 §3 parity reachability gap) WITHOUT routing any verified action yet.
            //
            // PURE provider-metadata path: the live set (`list_sessions`/`start_session`) spends ZERO
            // model tokens (NO `token_ledger` row), and the producer never surfaces provider
            // credentials/account-ids/raw output (fixed wire blockers). When the flag is OFF this
            // guard FAILS and the request falls through to the catch-all keepalive echo below —
            // BYTE-IDENTICAL to today (the server has never had this arm).
            Message::ProviderWorkspaceActionRequest { request }
                if provider_workspace_dispatch_enabled =>
            {
                let now_ms = now_ms();
                let result =
                    friday_hub::hub_server::provider_workspace_action_result_for_db_as_owner(
                        runtime.db(),
                        &env.msg_id,
                        request,
                        runtime.policy().principal_id(),
                        now_ms,
                    );
                eprintln!(
                    "hub_agent_run_server_dispatch: msg_id={} leg=provider_workspace_action (provider-workspace dispatch enabled)",
                    env.msg_id
                );
                // Correlate the reply to the inbound request (consistent with the sibling arms).
                ws_send_envelope(
                    ws,
                    session_key,
                    &result.with_correlation(env.msg_id.clone()),
                    SESSION_AAD,
                )?;
                processed += 1;
            }
            // Benign keepalive (S-B behaviour): echo the opened envelope back, sealed under the
            // SAME session key, correlated to the request. NO dispatch. This is ALSO where a
            // control message lands when the run-control flag is OFF (the guards above are not
            // met), so a v13 control message on a DARK server is a harmless echo — no handling.
            // (NS-5) A `MissionIntakeRequest` with the mission-intake flag OFF ALSO lands here, so
            // a DARK server treats it as a harmless echo — byte-identical to today. A
            // `MemoryDecisionRequest` with `FRIDAY_MEMORY_CONFIRM` OFF lands here too. (C1/C2) A
            // `ProviderWorkspaceActionRequest` with `FRIDAY_PROVIDER_WORKSPACE_DISPATCH` OFF lands
            // here too — the dark-when-off echo (the server has never had a provider arm).
            _ => {
                let reply = Envelope::new(env.msg_id.clone(), env.sent_at, env.message)
                    .with_correlation(env.msg_id.clone());
                ws_send_envelope(ws, session_key, &reply, SESSION_AAD)?;
                processed += 1;
            }
        }
    }
}

/// The current wall-clock in epoch-millis (best-effort; 0 on a pre-epoch clock).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// (A1 run-controls) Authenticate an owner-authed control op's forwarded principal against the
/// sealed session — the SAME possession-of-session + nonce-bound-challenge + owner-allowlist chain
/// the `AgentRunRequest` dispatch arm uses, bound to THIS control op's `run_id`. Returns the bound
/// principal on success, `None` (fail-closed) on any failure (un-openable proof / forged / empty /
/// anonymous / non-allowlisted). The caller then matches this principal to the run's bound owner.
fn authenticate_control_caller(
    session_key: &DataKey,
    session_nonce: &[u8],
    owner_allowlist: &[String],
    auth_proof: &[u8],
    run_id: &str,
    forwarded_principal: &str,
) -> Option<AuthedPrincipal> {
    decode_sealed_proof(auth_proof).and_then(|proof| {
        AuthedPrincipal::authenticate_forwarded(
            session_key,
            SESSION_AAD,
            AUTH_CHALLENGE,
            ForwardedAuth {
                auth_proof: &proof,
                session_nonce,
                // S-R0: control ops bind to the `run_id` bytes — byte-unchanged vs the prior
                // `run_id: &str` field.
                bound_context: run_id.as_bytes(),
                forwarded_principal,
            },
            owner_allowlist,
        )
    })
}

/// (A1 run-controls) Send the REFS-ONLY [`Message::AgentRunControlResult`] receipt for a control
/// op, sealed under the session and correlated to the request. Never a body — only the coarse
/// op/accepted/status + a soft audit ref.
fn send_control_result<S: Read + Write>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    correlation_msg_id: &str,
    run_id: &str,
    outcome: &friday_hub::agent_run_control::ControlOutcome,
    now_ms: i64,
) -> Result<(), TransportError> {
    eprintln!(
        "hub_agent_run_server_control: run_id={run_id} op={} accepted={} status={}",
        outcome.op, outcome.accepted, outcome.status
    );
    let result = Envelope::new(
        format!("agent-run-control-result-{run_id}"),
        now_ms,
        Message::AgentRunControlResult {
            run_id: run_id.to_string(),
            op: outcome.op.to_string(),
            accepted: outcome.accepted,
            status: outcome.status.clone(),
            audit_ref: outcome.audit_ref.clone(),
        },
    )
    .with_correlation(correlation_msg_id.to_string());
    ws_send_envelope(ws, session_key, &result, SESSION_AAD)
}

/// The REFS-ONLY terminal projection of a dispatch outcome: status + answer sha256/len +
/// (A1) the run COUNTS (turns / executed_tools). NEVER carries the body. Derived from the
/// `proof_refs_json` projection so the wire result and the proof surface agree on the same
/// numbers. Token counts are DEFERRED (not on `LoopOutcome`) ⇒ always `None` here.
struct ResultRefs {
    status: String,
    answer_sha256: Option<String>,
    answer_len: Option<u64>,
    /// (A1) REFS-surface run COUNTS — a COUNT only, never a turn body / tool name / args.
    turns: Option<u64>,
    executed_tools: Option<u64>,
}

/// Project a dispatch outcome to its REFS-ONLY terminal fields. NEVER returns the body.
fn result_refs(outcome: &friday_hub::hub_server::AuthedAnswer) -> ResultRefs {
    let refs = outcome.proof_refs_json();
    let status = refs
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            refs.get("outcome")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        })
        .to_string();
    let answer_sha256 = refs
        .get("answer_sha256")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let answer_len = refs.get("answer_len").and_then(|v| v.as_u64());
    // (A1) The run COUNTS surface on `Delivered` only (null/absent otherwise).
    let turns = refs.get("turns").and_then(|v| v.as_u64());
    let executed_tools = refs.get("executed_tools").and_then(|v| v.as_u64());
    ResultRefs {
        status,
        answer_sha256,
        answer_len,
        turns,
        executed_tools,
    }
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

/// True iff the bare flag `name` appears as its OWN argument (no value form). Used for the
/// operator-triggered validate flags below.
fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// (BUG-6) The operator CLI flag that triggers a ONE-SHOT live Claude key probe at boot, BEFORE
/// the serve loop, marking the in-process `claude` route `validation_ok: true` on success so a
/// claude-PINNED / claude-SIZE-ROUTED request becomes SELECTABLE in the long-lived serving runtime.
/// DEFAULT-ABSENT: a normal boot passes this flag NOT AT ALL ⇒ no probe ⇒ ZERO Anthropic quota
/// spent (the `validate_and_enable_claude` probe spends ~1-2 tokens, so it MUST NOT auto-run — this
/// explicit, operator-supplied flag is the trigger). Only meaningful with
/// `FRIDAY_CLAUDE_ROUTE_ENABLED=1` (else the `claude` route is not attached and the mark is a no-op).
pub const VALIDATE_CLAUDE_FLAG: &str = "--validate-claude";

/// (BUG-6) The operator CLI flag that triggers a ONE-SHOT creds-light Codex app-server health probe
/// at boot, BEFORE the serve loop, marking the in-process `codex` route `validation_ok: true` on a
/// healthy probe (spawns a local app-server; NO model turn ⇒ ZERO completion quota). DEFAULT-ABSENT
/// (mirrors [`VALIDATE_CLAUDE_FLAG`]). Only meaningful with `FRIDAY_CODEX_ROUTE_ENABLED=1`.
pub const VALIDATE_CODEX_FLAG: &str = "--validate-codex";

/// Which routes the operator asked to validate at boot (pure parse of the CLI args — no env, no
/// network — so it is unit-testable). The serve `run()` consults this AFTER building the runtime
/// and BEFORE the serve loop. Absent flags ⇒ all `false` ⇒ no probe, no quota (the prod default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ValidateRequest {
    pub claude: bool,
    pub codex: bool,
}

impl ValidateRequest {
    pub fn from_args(args: &[String]) -> Self {
        ValidateRequest {
            claude: has_flag(args, VALIDATE_CLAUDE_FLAG),
            codex: has_flag(args, VALIDATE_CODEX_FLAG),
        }
    }

    fn any(&self) -> bool {
        self.claude || self.codex
    }
}

/// (BUG-6) Run the operator-requested route validation against the HELD serving runtime, in place,
/// BEFORE the serve loop. This is the SINGLE production caller of
/// [`HubRuntime::validate_and_enable_claude`] / [`HubRuntime::validate_and_enable_codex`] — without
/// it those methods had ZERO bin callers, so `FRIDAY_CLAUDE_ROUTE_ENABLED=1` attached the route
/// `available:true, validation_ok:false` and a claude-pinned/size-routed request fail-closed
/// `NoEligibleRoute` forever (the silent route-selection no-op BUG-6 names).
///
/// FAIL-SOFT, not fail-boot: a CredentialMissing / Invalid / Unavailable / unhealthy outcome is
/// LOGGED (coarse, secret-free label) and leaves that route NON-validated (claude/codex requests
/// `NoEligibleRoute`; the DeepSeek primary is UNAFFECTED). Aborting the whole boot over a
/// SECONDARY-route validation failure would needlessly take down a healthy DeepSeek hub — the
/// safe posture is "DeepSeek serves; the unvalidated secondary route stays closed". The mutation is
/// in-process only (mirrors `validate_and_enable_*`), which is exactly why it must run on the
/// long-lived serving runtime here, not in a separate one-shot process that would exit and persist
/// nothing.
fn run_boot_validation(runtime: &mut HubRuntime<UreqTransport>, req: ValidateRequest) {
    if req.claude {
        eprintln!("hub_agent_run_server: --validate-claude — running live Claude key probe (spends ~1-2 Anthropic tokens)");
        let outcome = runtime.validate_and_enable_claude();
        if outcome.is_confirmed_valid() {
            eprintln!("hub_agent_run_server: claude route VALIDATED — claude-pinned/size-routed requests now selectable");
        } else {
            eprintln!(
                "hub_agent_run_server: claude validation NOT confirmed ({}) — claude route stays closed (DeepSeek unaffected)",
                outcome.label()
            );
        }
    }
    if req.codex {
        eprintln!("hub_agent_run_server: --validate-codex — running creds-light Codex app-server health probe (no model turn)");
        match runtime.validate_and_enable_codex() {
            Ok(_summary) => eprintln!(
                "hub_agent_run_server: codex route VALIDATED — codex-pinned/size-routed requests now selectable"
            ),
            Err(_e) => eprintln!(
                "hub_agent_run_server: codex validation NOT confirmed (app-server health probe failed) — codex route stays closed (DeepSeek unaffected)"
            ),
        }
    }
}

/// Ephemeral, non-secret bytes for the boot-time runtime config (dormant under deny-all).
/// Derived, not read from any key store.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-agent-run-server-dev:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
}

/// Lowercase-hex encode (the owner-sealed body ciphertext rides `AskFridayStream.chunk`, a
/// `String`). No new dep — a trivial loop over the bytes.
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    // `InMemorySecureStore` is TEST-ONLY now (slice 3 moved `run()` to `FileSecureStore`), so its
    // import lives here — keeping it top-level would be an unused import in the non-test bin compile
    // (clippy `-D warnings`). `FileSecureStore` is imported via `use super::*` (run() uses it).
    use friday_crypto::open as crypto_open;
    use friday_crypto::{InMemorySecureStore, SecureStore};
    use friday_deepseek::{DeepSeekClient, DeepSeekError};
    use friday_hub::hub_server::{auth_aad, nonce_bound_challenge};
    use friday_hub::runtime::DenyAllApprovals;
    // S-R0: the substrate items the tests exercise directly (the non-test bin imports only the
    // subset `run()`/`accept_one` use, to keep clippy `-D warnings` clean). These are the shared
    // peer-gate / low-order / codec / nonce-width primitives the migrated S-F/S-E tests drive.
    use friday_hub::sealed_ws::{
        is_low_order_x25519, peer_is_allowlisted, PeerAllowlistError, LOW_ORDER_X25519_POINTS,
        SESSION_NONCE_LEN,
    };
    use friday_hub::DeepSeekAgentLlmClient;
    use friday_transport::{read_frame, write_frame, ws_connect, ws_send_envelope};
    use rusqlite::OptionalExtension;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static C: AtomicU64 = AtomicU64::new(0);

    const OWNER: &str = "principal:owner-allowlisted";
    const BODY: &str = "S-C-DISPATCH-BODY-CANARY-owner-only";

    /// A FIXED non-secret test client secret scalar (small primes). Using a known secret lets a
    /// test compute the client's pubkey up-front (to put it in the S-F peer allowlist) AND
    /// reconstruct the SAME keypair inside a spawned thread (`DeviceKeypair` is not Clone/Send).
    /// This is a TEST FIXTURE, not real key material.
    const CLIENT_SECRET: [u8; 32] = [
        // pragma: allowlist secret
        7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101,
        103, 107, 109, 113, 127, 131, 137, 139, 149,
    ];

    /// Build a single-entry S-F peer allowlist from a peer pubkey (the common test case: the test's
    /// client is the authorized peer). Helper so the migrated S-C/S-E tests clear the peer gate and
    /// keep exercising their OWN gate (principal / proof / wrong-key / low-order), not the peer gate.
    fn allowlist_of(peer_pub: [u8; 32]) -> Vec<[u8; X25519_PUBKEY_LEN]> {
        vec![peer_pub]
    }

    /// A unique temp workspace dir (the agent loop's fs tools are contained to it).
    struct TempWs(PathBuf);
    impl TempWs {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "friday-execrun-sc-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempWs(p)
        }
    }
    impl Drop for TempWs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A MOCK transport that finishes the loop in one turn with `answer` as the final message —
    /// so the dispatch tests NEVER reach `HubRuntime::live` / a real DeepSeek key.
    struct FinishTransport {
        answer: String,
    }
    impl Transport for FinishTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            let content = format!("{{\"tool\":\"none\",\"answer\":\"{}\"}}", self.answer);
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    /// Build a MOCK-transport runtime configured with `principal` as the single owner.
    fn mock_runtime(tag: &str, principal: &str) -> (HubRuntime<FinishTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(
            FinishTransport {
                answer: BODY.to_string(),
            },
            "k".into(), // pragma: allowlist secret
        );
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: std::env::temp_dir()
                    .join(format!(
                        "friday-execrun-sc-{}-{}-{}.sqlite",
                        std::process::id(),
                        tag,
                        C.fetch_add(1, Ordering::Relaxed)
                    ))
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-sc-test-secret-0123456789ab".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    /// Drive the cleartext pubkey preamble from the CLIENT side, read the server pubkey AND the
    /// S-E per-handshake nonce, then run the WS upgrade and derive the client's view of the
    /// session key. The client keypair is generated HERE (test-only), never by the server.
    /// Returns `(ws, session_key, session_nonce)` — the nonce MUST be threaded into the proof.
    fn client_handshake(
        addr: SocketAddr,
        client_kp: &DeviceKeypair,
    ) -> (WireWebSocket<TcpStream>, DataKey, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &client_kp.public_bytes()).unwrap();
        let server_pub_bytes = read_frame(&mut stream).unwrap();
        let server_pub: [u8; 32] = server_pub_bytes.as_slice().try_into().unwrap();
        // S-E: the server sends a fresh per-handshake nonce in cleartext AFTER its pubkey.
        let session_nonce = read_frame(&mut stream).unwrap();
        let ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let session = client_kp.agree(&server_pub);
        (ws, session, session_nonce)
    }

    /// Build a sealed `auth_proof` over the S-E nonce-bound challenge (`AUTH_CHALLENGE ||
    /// session_nonce`) under the client's session view, with the per-request auth AAD binding
    /// `(principal, run_id)`. This is what the trusted peer does post-handshake — the proof is
    /// NOT precomputable before the nonce is known.
    fn auth_proof_bytes(
        client_session: &DataKey,
        session_nonce: &[u8],
        principal: &str,
        run_id: &str,
    ) -> Vec<u8> {
        let challenge = nonce_bound_challenge(AUTH_CHALLENGE, session_nonce);
        let req_aad = auth_aad(SESSION_AAD, principal, run_id.as_bytes());
        let sealed = seal(client_session, &challenge, &req_aad).unwrap();
        encode_sealed_proof(&sealed)
    }

    /// An `AgentRunRequest` envelope for `run_id` forwarding `principal`, with an `auth_proof`
    /// sealed under `client_session` and bound to THIS handshake's `session_nonce` (the peer's
    /// possession-of-session-AND-this-handshake proof).
    fn agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        client_session: &DataKey,
        session_nonce: &[u8],
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session, session_nonce, principal, run_id),
                session_id: None,
                constraints: None,
                mission_context: None,
            },
        )
    }

    /// A sealed `AgentRunRequest` carrying the FIRST-CLASS Mission/WorkItem handle emitted by
    /// mission intake. This is the real Rust surface the TS auto-dispatch path ultimately drives:
    /// the request is authenticated exactly like the unbound run, but it gives the mission-bound
    /// dispatch arm enough canonical context to bind the run to product work.
    fn mission_bound_agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        client_session: &DataKey,
        session_nonce: &[u8],
        mission_context: friday_protocol::MissionWorkItemContextWire,
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session, session_nonce, principal, run_id),
                session_id: None,
                constraints: None,
                mission_context: Some(mission_context),
            },
        )
    }

    /// (A2a Phase 1) A SESSIONED `AgentRunRequest` — identical to [`agent_run_request`] but
    /// carrying a non-empty `session_id`, so the server's dispatch arm branches into
    /// `run_session_task` (the existing `run_session_loop`) instead of `run_authed_agent_loop`.
    fn sessioned_agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        session_id: &str,
        client_session: &DataKey,
        session_nonce: &[u8],
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session, session_nonce, principal, run_id),
                session_id: Some(session_id.to_string()),
                constraints: None,
                mission_context: None,
            },
        )
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let d = Sha256::digest(bytes);
        d.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The OWNER-side hex decode (mirrors what a real owner peer does to recover the sealed body
    /// ciphertext from the carrier chunk). `None` on non-hex / odd-length input.
    fn hex_decode(s: &str) -> Option<Vec<u8>> {
        if s.len() % 2 != 0 {
            return None;
        }
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(s.len() / 2);
        for pair in bytes.chunks_exact(2) {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
        }
        Some(out)
    }

    /// What the client peer observed on a dispatch exchange. `HubRuntime` is NOT `Send` (its
    /// `Box<dyn ApprovalPolicy>` is not), so the SERVER (holding the runtime) runs on the MAIN
    /// thread and the CLIENT runs in this spawned thread — the inverse of the S-B tests.
    struct ClientObservations {
        /// The refs-only `AgentRunResult` reply (None if the server failed closed with no reply).
        result: Option<Message>,
        /// The owner-sealed body chunk (hex of session-sealed ciphertext), if delivered.
        body_chunk: Option<String>,
    }

    /// Spawn the CLIENT peer: handshake (which reads the S-E per-handshake nonce), then call
    /// `build` with the derived `(session_key, session_nonce)` to construct the request POST-
    /// handshake (the auth_proof binds the nonce, so it CANNOT be precomputed). `build` returns
    /// `(req, seal_key, recv_key)` so a test can seal under a wrong key or recv under a different
    /// key. Reads up to two replies (refs result + owner-sealed body). The server runs on the
    /// caller's (main) thread via `accept_one`.
    fn spawn_client<F>(
        addr: SocketAddr,
        client_kp: DeviceKeypair,
        build: F,
    ) -> thread::JoinHandle<ClientObservations>
    where
        F: FnOnce(&DataKey, &[u8]) -> (Envelope, DataKey, DataKey) + Send + 'static,
    {
        thread::spawn(move || {
            let (mut ws, session, session_nonce) = client_handshake(addr, &client_kp);
            let (req, seal_key, recv_key) = build(&session, &session_nonce);
            ws_send_envelope(&mut ws, &seal_key, &req, SESSION_AAD).unwrap();
            let result = ws_recv_envelope(&mut ws, &recv_key, SESSION_AAD)
                .ok()
                .map(|e| e.message);
            let body_chunk = match &result {
                // Only an accepted dispatch sends a (possible) second body envelope.
                Some(Message::AgentRunResult { .. }) => {
                    match ws_recv_envelope(&mut ws, &recv_key, SESSION_AAD) {
                        Ok(e) => match e.message {
                            Message::AskFridayStream { chunk, .. } => Some(chunk),
                            _ => None,
                        },
                        Err(_) => None,
                    }
                }
                _ => None,
            };
            ClientObservations { result, body_chunk }
        })
    }

    // LOOPBACK CONTAINMENT (restored — the S-C rewrite dropped S-B's guard for this exact
    // security property; off-box reachability must stay zero, and S-E/S-F keep editing this bin).
    #[test]
    fn listener_binds_loopback_only_not_all_interfaces() {
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(
            addr.ip().is_loopback(),
            "agent-run WS listener must bind 127.0.0.1 (this Mac), never 0.0.0.0/LAN"
        );
        assert_ne!(
            addr.ip(),
            std::net::IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            "must NOT bind 0.0.0.0"
        );
    }

    // (a) VALID AUTHORIZED PEER over a real loopback socket: correct key + allowlisted forwarded
    // principal ⇒ the loop runs, a REFS-ONLY result is returned, and the BODY is delivered SEALED
    // (never in the refs result).
    #[test]
    fn authorized_peer_runs_and_body_is_sealed_never_in_refs() {
        let (rt, _ws) = mock_runtime("authz", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        // The client derives the SAME session the server will (ECDH). We precompute its session
        // view here to OPEN the sealed body reply later; the auth_proof itself is built INSIDE the
        // client thread (it must bind the per-handshake nonce, unknown until after the handshake).
        let client_kp = DeviceKeypair::generate();
        let client_session = client_kp.agree(&server_kp.public_bytes());
        // S-F: ALLOWLIST this client's pubkey so the handshake clears the peer gate and the test
        // exercises the S-C dispatch/body path (NOT the peer gate). Captured before the move.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-1", "run-sc-1", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });

        // SERVER on the main thread (holds the non-Send runtime).
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one authed dispatch processed");

        let obs = client.join().unwrap();
        // (refs) the REFS-ONLY result: status + fingerprint, NEVER the body.
        let Some(Message::AgentRunResult {
            run_id,
            answer_sha256,
            answer_len,
            ..
        }) = obs.result.clone()
        else {
            panic!("expected AgentRunResult, got {:?}", obs.result);
        };
        assert_eq!(run_id, "run-sc-1");
        assert_eq!(
            answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(answer_len, Some(BODY.len() as u64));
        // CANARY: the refs result NEVER carries the body bytes.
        assert!(
            !format!("{:?}", obs.result).contains(BODY),
            "refs result leaked the body"
        );

        // (body) the BODY is delivered SEALED over the SAME session (owner-only). The carrier's
        // chunk is hex of the owner-sealed ciphertext — NOT the plaintext body. Only the owner
        // (holding the session key) can open it back to the exact body.
        let chunk = obs.body_chunk.expect("owner-sealed body delivered");
        assert!(!chunk.contains(BODY), "the body carrier leaked plaintext");
        let inner_bytes = hex_decode(&chunk).expect("body chunk is hex");
        let inner = decode_sealed_proof(&inner_bytes).expect("owner-sealed body decodes");
        let opened = friday_crypto::open(&client_session, &inner, SESSION_AAD).unwrap();
        assert_eq!(opened, BODY.as_bytes(), "owner opens the sealed body");
    }

    // Explicit mission_context means "mission-bound or fail closed." If the server-side
    // FRIDAY_MISSION_BOUND_RUN gate is off, the request must NOT run unbound and then surface a
    // normal answer under the caller's mission/provider projection.
    #[test]
    fn mission_context_with_mission_bound_flag_off_returns_no_answer_not_unbound_success() {
        let (rt, _ws) = mock_runtime("mission-flag-off", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let mission_context = friday_protocol::MissionWorkItemContextWire {
            friday_conversation_id: "fconv_flag_off".into(),
            mission_id: "mission-flag-off".into(),
            work_item_id: "work-flag-off".into(),
        };
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = mission_bound_agent_run_request(
                "req-mission-flag-off",
                "run-mission-flag-off",
                OWNER,
                session,
                nonce,
                mission_context,
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound run OFF: explicit handle must fail closed
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(processed, 1, "one authed dispatch processed");

        let obs = client.join().unwrap();
        let Some(Message::AgentRunResult {
            run_id,
            status,
            answer_sha256,
            answer_len,
            ..
        }) = obs.result.clone()
        else {
            panic!(
                "expected AgentRunResult no-answer frame, got {:?}",
                obs.result
            );
        };
        assert_eq!(run_id, "run-mission-flag-off");
        assert_eq!(
            status, "no_answer_safe_failure",
            "mission_context with the mission-bound flag off must fail closed, not execute unbound"
        );
        assert!(
            answer_sha256.is_none(),
            "no answer fingerprint on fail-closed no-answer"
        );
        assert!(
            answer_len.is_none(),
            "no answer length on fail-closed no-answer"
        );
        assert!(
            obs.body_chunk.is_none(),
            "fail-closed mission-context request must not deliver the unbound body"
        );
        let answer = rt
            .db()
            .conn()
            .query_row(
                "SELECT answer_sha256 FROM run_result WHERE run_id = ?1",
                ["run-mission-flag-off"],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap();
        assert!(
            answer.is_none(),
            "mission_context flag-off fail-closed path must not persist an unbound run_result"
        );
    }

    /// A MOCK transport that PROPOSES a mutating tool call (write_file) every turn. With the
    /// runtime's `operator_vk: None` (DenyAll), the gate's `RequiresApproval` is never upgraded ⇒
    /// the loop PAUSES and persists a `pending_approval_request` before returning the body-free
    /// NoAnswer. Used by the deploy-safety pause-surfacing tests.
    struct PauseTransport;
    impl Transport for PauseTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            // Propose a mutating write_file tool call (the gate Pauses it under DenyAll).
            let content = r#"{"tool":"write_file","path":"out.txt","content":"X"}"#;
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    /// Build a MOCK-transport runtime whose loop PAUSES on a mutating tool (operator_vk: None).
    fn pausing_runtime(tag: &str, principal: &str) -> (HubRuntime<PauseTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(PauseTransport, "k".into()); // pragma: allowlist secret
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: std::env::temp_dir()
                    .join(format!(
                        "friday-execrun-pause-{}-{}-{}.sqlite",
                        std::process::id(),
                        tag,
                        C.fetch_add(1, Ordering::Relaxed)
                    ))
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-pause-test-secret-0123456789".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None, // DenyAll ⇒ a mutating tool Pauses (never upgraded)
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    /// Run ONE authed dispatch against a PAUSING runtime with the run-control flag set to
    /// `run_control_enabled`, returning the client's first observed reply message.
    fn dispatch_pausing_with_flag(tag: &str, run_control_enabled: bool) -> Message {
        let (rt, _ws) = pausing_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-pause", "run-pause-1", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                run_control_enabled,
                false, // (NS-4) mission-bound seam OFF for the run-control flag tests
                false, // (NS-5) mission-intake ingress OFF for the run-control flag tests
                false, // (KEYSTONE) mission-spine dispatch OFF for the run-control flag tests
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "[{tag}] the paused dispatch is processed");
        client.join().unwrap().result.expect("a reply is sent")
    }

    /// DEPLOY-SAFETY (the load-bearing test): with the run-control flag OFF, a PAUSED run emits
    /// EXACTLY the pre-A1 `AgentRunResult{status:"no_answer"}` — byte-for-byte the current live
    /// behavior, so deploying a v13 binary changes nothing. With the flag ON, the SAME paused run
    /// emits `AgentRunPaused` (refs-only: nonce + digest + summary) instead. ONE test, BOTH legs.
    #[test]
    fn paused_run_emits_no_answer_when_flag_off_and_paused_when_on() {
        // FLAG OFF ⇒ pre-A1 no_answer result (unchanged live behavior). The exact pre-A1 status
        // for a paused/no-body run is `no_answer_safe_failure` (the `AuthedAnswer::NoAnswer`
        // projection) — this is the byte-for-byte current behavior that must be preserved.
        match dispatch_pausing_with_flag("pause-off", false) {
            Message::AgentRunResult { run_id, status, .. } => {
                assert_eq!(run_id, "run-pause-1");
                assert_eq!(
                    status, "no_answer_safe_failure",
                    "flag OFF: a paused run MUST emit the pre-A1 no_answer result (deploy-safe)"
                );
            }
            other => panic!("flag OFF must emit AgentRunResult, got {other:?}"),
        }

        // FLAG ON ⇒ AgentRunPaused with refs-only pause info.
        match dispatch_pausing_with_flag("pause-on", true) {
            Message::AgentRunPaused {
                run_id,
                nonce,
                action_digest,
                summary,
            } => {
                assert_eq!(run_id, "run-pause-1");
                assert_eq!(nonce.len(), 64, "the CSPRNG approval nonce is surfaced");
                assert_eq!(action_digest.len(), 64);
                assert!(
                    summary.contains("write_file"),
                    "the action-verb summary is surfaced (refs-only)"
                );
                // CANARY: the pause frame never carries the tool body/args.
                let frame = format!("{run_id}{nonce}{action_digest}{summary}");
                assert!(!frame.contains("\"content\""), "pause leaked tool params");
            }
            other => panic!("flag ON must emit AgentRunPaused, got {other:?}"),
        }
    }

    // === (Loop4 wire-fields) per-run TOKEN-SURFACE flag + helper + dispatch wiring ===========

    /// Seed ONE run-attributable `token_ledger` row (`run_id = <run_id>`) directly on `conn`, a
    /// TEST FIXTURE for the token-surface KATs. Mirrors the raw-INSERT seeding the storage
    /// migration/atomic suites use — the public `Db::insert_token_ledger` always writes a NULL
    /// `run_id` (ask-path), and `record_run_model_call` needs a full ledger/activity/audit triple,
    /// so a direct INSERT is the focused way to bill a known `(prompt, completion)` to a run.
    fn seed_run_ledger_row(
        conn: &rusqlite::Connection,
        ledger_id: &str,
        run_id: &str,
        prompt: i64,
        completion: i64,
    ) {
        conn.execute(
            "INSERT INTO token_ledger
                (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
                 prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
                 result_link, created_at, run_id)
             VALUES (?1, NULL, NULL, 'deepseek', 'deepseek-v4-flash', 'api.deepseek.com',
                     ?3, ?4, ?5, NULL, 0, NULL, 100, ?2)",
            rusqlite::params![ledger_id, run_id, prompt, completion, prompt + completion],
        )
        .unwrap();
    }

    /// KAT (the standard exact-`"1"` flag idiom): the token-surface flag matcher is DEFAULT-OFF,
    /// ON only for the trimmed exact `"1"` — mirroring run-control / mission-* (NOT the reaper's
    /// looser `"true"` form), so a future env typo can never silently light up a LIVE-path surface.
    #[test]
    fn token_surface_flag_matcher_is_default_off_and_exact_one() {
        assert!(
            !agent_run_token_surface_enabled_from(None),
            "unset ⇒ disabled (DARK by default)"
        );
        assert!(
            !agent_run_token_surface_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(
            !agent_run_token_surface_enabled_from(Some("0")),
            "0 ⇒ disabled"
        );
        assert!(
            !agent_run_token_surface_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !agent_run_token_surface_enabled_from(Some("on")),
            "on ⇒ disabled"
        );
        assert!(
            agent_run_token_surface_enabled_from(Some("1")),
            "1 ⇒ enabled"
        );
        assert!(
            !agent_run_token_surface_enabled_from(Some("true")),
            "true is NOT the opt-in value (exact-1 idiom; differs from the reaper flag)"
        );
        assert!(
            agent_run_token_surface_enabled_from(Some("  1  ")),
            "1 with surrounding whitespace ⇒ enabled (trimmed)"
        );
        // The const name is the operator-facing contract — pin it so a rename is a conscious change.
        assert_eq!(
            AGENT_RUN_TOKEN_SURFACE_ENABLED_ENV,
            "FRIDAY_AGENT_RUN_TOKEN_SURFACE"
        );
    }

    /// KAT (helper, flag ON ⇒ summed): with the flag ON the helper returns the run-attributable
    /// SUM of `token_ledger` (`Some(prompt)`, `Some(completion)`), and a DIFFERENT run's rows never
    /// leak in (run-scoped `WHERE run_id = ?1`).
    #[test]
    fn run_token_surface_sums_run_ledger_when_enabled() {
        let db = friday_storage::Db::open_hub(
            &std::env::temp_dir()
                .join(format!(
                    "friday-token-surface-on-{}-{}.sqlite",
                    std::process::id(),
                    C.fetch_add(1, Ordering::Relaxed)
                ))
                .to_string_lossy(),
        )
        .unwrap();
        // Two rows for the run (must sum) + a row for a DIFFERENT run (must be excluded).
        seed_run_ledger_row(db.conn(), "l1", "run-tok", 11, 8);
        seed_run_ledger_row(db.conn(), "l2", "run-tok", 4, 2);
        seed_run_ledger_row(db.conn(), "l-other", "run-other", 999, 999);

        let (prompt, completion) = run_token_surface(true, db.conn(), "run-tok");
        assert_eq!(prompt, Some(15), "11 + 4, run-scoped (other run excluded)");
        assert_eq!(completion, Some(10), "8 + 2, run-scoped");

        // A run with NO billed rows yields Some(0) (the true COALESCE'd sum), not None.
        let (zp, zc) = run_token_surface(true, db.conn(), "run-with-no-rows");
        assert_eq!((zp, zc), (Some(0), Some(0)), "zero-billed run ⇒ Some(0)");
    }

    /// KAT (helper, flag OFF ⇒ None — byte-identical): with the flag OFF the helper returns
    /// `(None, None)` EVEN WHEN ledger rows exist for the run — proving the OFF emission is
    /// byte-identical to today regardless of DB state (an absent `Option` is omitted on the wire).
    #[test]
    fn run_token_surface_is_none_when_disabled_even_with_rows() {
        let db = friday_storage::Db::open_hub(
            &std::env::temp_dir()
                .join(format!(
                    "friday-token-surface-off-{}-{}.sqlite",
                    std::process::id(),
                    C.fetch_add(1, Ordering::Relaxed)
                ))
                .to_string_lossy(),
        )
        .unwrap();
        seed_run_ledger_row(db.conn(), "l1", "run-tok", 11, 8);
        let (prompt, completion) = run_token_surface(false, db.conn(), "run-tok");
        assert_eq!(
            (prompt, completion),
            (None, None),
            "flag OFF ⇒ (None, None) even with ledger rows present (deploy-safe, byte-identical)"
        );
    }

    /// KAT (helper, ledger read error ⇒ None — fail-safe): a ledger read failure (here: the
    /// `token_ledger` table is gone) must NOT panic and must fall back to `(None, None)` — the
    /// surface can never break the result emission.
    #[test]
    fn run_token_surface_is_none_on_ledger_read_error() {
        let db = friday_storage::Db::open_hub(
            &std::env::temp_dir()
                .join(format!(
                    "friday-token-surface-err-{}-{}.sqlite",
                    std::process::id(),
                    C.fetch_add(1, Ordering::Relaxed)
                ))
                .to_string_lossy(),
        )
        .unwrap();
        // Force the aggregate SELECT to error: drop the table the helper reads.
        db.conn().execute("DROP TABLE token_ledger", []).unwrap();
        let (prompt, completion) = run_token_surface(true, db.conn(), "run-tok");
        assert_eq!(
            (prompt, completion),
            (None, None),
            "a ledger read error fails SAFE to None (never panics, never blocks the answer)"
        );
    }

    /// WIRING KAT (end-to-end dispatch): with the token-surface flag ON, the emitted
    /// `AgentRunResult` actually CARRIES the summed token counts (proving the threaded bool reaches
    /// the construction and the helper is keyed on the dispatch's `run_id`); with it OFF the SAME
    /// run — ledger rows and all — emits `None`/`None` (byte-identical). The emitted value is tied
    /// to the post-dispatch ledger SUM (not a constant), so the loop's own billing is absorbed.
    #[test]
    fn dispatch_emits_summed_tokens_when_flag_on_and_none_when_off() {
        // Drive the SAME accept_one dispatch as `authorized_peer_runs_and_body_is_sealed_*`,
        // toggling ONLY the trailing token-surface flag, and seeding a known run-attributable row.
        fn dispatch_with_token_flag(
            tag: &str,
            token_surface_enabled: bool,
        ) -> (Message, (i64, i64)) {
            let (rt, _ws) = mock_runtime(tag, OWNER);
            // Seed a known row for the dispatch's run_id BEFORE the run, so the post-dispatch SUM
            // is guaranteed > 0 (the assertion is meaningful, not a Some(0)==Some(0) tautology).
            seed_run_ledger_row(rt.db().conn(), "seed-l1", "run-tok-wire", 100, 50);
            let server_kp = DeviceKeypair::generate();
            let listener = AgentRunWsListener::bind_loopback(0).unwrap();
            let addr = listener.local_addr().unwrap();
            let allowlist = vec![OWNER.to_string()];
            let client_kp = DeviceKeypair::generate();
            let peer_allowlist = allowlist_of(client_kp.public_bytes());
            let client = spawn_client(addr, client_kp, |session, nonce| {
                let req = agent_run_request("req-tok", "run-tok-wire", OWNER, session, nonce);
                (req, session.clone(), session.clone())
            });
            let processed = listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &peer_allowlist,
                    false, // run-control OFF
                    false, // mission-bound seam OFF
                    false, // mission-intake ingress OFF
                    false, // mission-spine dispatch OFF
                    false, // memory-confirm ingress OFF
                    false, // run-outcome-learning confirm OFF — byte-identical to today
                    token_surface_enabled,
                    false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
                )
                .unwrap();
            assert_eq!(processed, 1, "[{tag}] the authed dispatch is processed");
            let reply = client.join().unwrap().result.expect("a reply is sent");
            // Read the run's ledger SUM AFTER the dispatch — the run is complete, so this equals the
            // helper's emission-time read (the loop's own billing, if any, is included here too).
            let totals =
                friday_storage::agent_run_read::run_token_totals(rt.db().conn(), "run-tok-wire")
                    .unwrap();
            (reply, (totals.prompt, totals.completion))
        }

        // FLAG ON ⇒ the refs result carries the summed tokens, tied to the post-dispatch ledger SUM.
        let (on_reply, (sum_prompt, sum_completion)) =
            dispatch_with_token_flag("tok-wire-on", true);
        let Message::AgentRunResult {
            run_id,
            prompt_tokens,
            completion_tokens,
            ..
        } = on_reply
        else {
            panic!("flag ON must emit AgentRunResult, got {on_reply:?}");
        };
        assert_eq!(run_id, "run-tok-wire");
        assert!(
            sum_prompt >= 100 && sum_completion >= 50,
            "the seeded row (100/50) is billed to the run ⇒ a meaningful non-zero SUM"
        );
        assert_eq!(
            prompt_tokens,
            Some(sum_prompt as u64),
            "flag ON: emitted prompt_tokens == the run's token_ledger SUM"
        );
        assert_eq!(
            completion_tokens,
            Some(sum_completion as u64),
            "flag ON: emitted completion_tokens == the run's token_ledger SUM"
        );

        // FLAG OFF ⇒ the SAME run (ledger rows present) emits None/None — byte-identical to today.
        let (off_reply, _) = dispatch_with_token_flag("tok-wire-off", false);
        let Message::AgentRunResult {
            prompt_tokens,
            completion_tokens,
            ..
        } = off_reply
        else {
            panic!("flag OFF must emit AgentRunResult, got {off_reply:?}");
        };
        assert_eq!(
            (prompt_tokens, completion_tokens),
            (None, None),
            "flag OFF: AgentRunResult emits None/None even with ledger rows (DARK, byte-identical)"
        );
    }

    /// DARK-when-OFF for control MESSAGES: a control message (e.g. AgentRunCancel) arriving with
    /// the run-control flag OFF is treated as a benign keepalive (echoed back), NOT handled — so a
    /// v13 control message on a dark server effects no state change. (Flag-ON handling is covered
    /// by the `agent_run_control` unit suite in tests/a1_run_control.rs.)
    #[test]
    fn control_message_is_keepalive_echo_when_flag_off() {
        let (rt, _ws) = mock_runtime("ctl-off", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = Envelope::new(
                "req-cancel",
                1000,
                Message::AgentRunCancel {
                    run_id: "run-x".into(),
                    forwarded_principal: OWNER.into(),
                    auth_proof: vec![1, 2, 3],
                    reason: None,
                },
            );
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the control message is processed as a keepalive"
        );
        // The flag is OFF ⇒ the message is ECHOED verbatim (keepalive), NOT a control result.
        match client.join().unwrap().result.expect("an echo reply") {
            Message::AgentRunCancel { run_id, .. } => assert_eq!(run_id, "run-x"),
            other => panic!("flag OFF must echo the control message, got {other:?}"),
        }
    }

    // (b) THE PRECONDITION: a correct-handshake peer (real session key) with a NON-ALLOWLISTED /
    // forged / empty / anonymous forwarded principal is REJECTED — NO run, NO body. A session key
    // is NOT authorization.
    fn reject_case(tag: &str, forwarded: &str) {
        let (rt, _ws) = mock_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake SUCCEEDS and the rejection is
        // attributable to the PRINCIPAL gate (forged/empty/anonymous owner), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let forwarded = forwarded.to_string();
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-x", "run-rej", &forwarded, session, nonce);
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 0, "[{tag}] rejected dispatch processes ZERO");

        let obs = client.join().unwrap();
        // The server failed closed: NO reply at all (no run, no body).
        assert!(
            obs.result.is_none(),
            "[{tag}] a rejected dispatch must end the session with no reply (no run, no body)"
        );
        assert!(obs.body_chunk.is_none(), "[{tag}] no body on rejection");
    }

    #[test]
    fn session_reaper_flag_is_default_off_and_fail_closed() {
        // The reaper tick is DEFAULT-OFF: unset ⇒ disabled. Only the exact opt-in values
        // enable it; everything else (empty, "0", "yes", "false", garbage) is OFF.
        assert!(!reaper_enabled_from(None), "unset ⇒ disabled (default-off)");
        assert!(!reaper_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!reaper_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(!reaper_enabled_from(Some("false")), "false ⇒ disabled");
        assert!(!reaper_enabled_from(Some("no")), "no ⇒ disabled");
        assert!(!reaper_enabled_from(Some("enabled")), "garbage ⇒ disabled");
        // Only the exact opt-in values enable it (case-insensitive, trimmed).
        assert!(reaper_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(reaper_enabled_from(Some("true")), "true ⇒ enabled");
        assert!(reaper_enabled_from(Some("TRUE")), "TRUE ⇒ enabled");
        assert!(
            reaper_enabled_from(Some("  true  ")),
            "padded true ⇒ enabled"
        );
        assert!(reaper_enabled_from(Some(" 1 ")), "padded 1 ⇒ enabled");
    }

    #[test]
    fn scheduler_tick_flag_is_default_off_and_fail_closed() {
        // (S10-B) DEFAULT-OFF + STRICT exact-1 (the program-standard idiom; NOT the reaper's
        // 1|true). This is the byte-identical guarantee for the riskiest dark flag: unset/empty/0/
        // false/true/garbage ⇒ the tick thread is NEVER spawned ⇒ nothing fires ⇒ today's behavior.
        assert!(
            !scheduler_tick_enabled_from(None),
            "unset ⇒ disabled (default-off; the tick thread is never spawned)"
        );
        assert!(!scheduler_tick_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!scheduler_tick_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !scheduler_tick_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !scheduler_tick_enabled_from(Some("true")),
            "true is NOT the opt-in value (exact-1 idiom)"
        );
        assert!(
            !scheduler_tick_enabled_from(Some("enabled")),
            "garbage ⇒ disabled"
        );
        // Only the exact (trimmed) "1" enables it.
        assert!(scheduler_tick_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            scheduler_tick_enabled_from(Some(" 1 ")),
            "padded 1 ⇒ enabled (trimmed)"
        );
    }

    #[test]
    fn retention_sweep_flag_is_default_off_and_fail_closed() {
        // (gap #25) DEFAULT-OFF + STRICT exact-1 (NOT the reaper's 1|true): unset/empty/0/false/
        // garbage ⇒ no retention sweep. OFF is what makes deploying the binary byte-identical to
        // the pre-#25 session-only reaper.
        assert!(
            !retention_sweep_enabled_from(None),
            "unset ⇒ disabled (default-off)"
        );
        assert!(!retention_sweep_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!retention_sweep_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !retention_sweep_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !retention_sweep_enabled_from(Some("true")),
            "true is NOT the opt-in value (exact-1 idiom; differs from the reaper flag)"
        );
        assert!(
            !retention_sweep_enabled_from(Some("enabled")),
            "garbage ⇒ disabled"
        );
        // Only the exact (trimmed) "1" enables it.
        assert!(retention_sweep_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            retention_sweep_enabled_from(Some(" 1 ")),
            "padded 1 ⇒ enabled (trimmed)"
        );
    }

    #[test]
    fn retention_wiring_surfaces_dead_config_and_parse_asymmetry() {
        assert_eq!(
            retention_wiring_from(None, Some("1")),
            RetentionWiring::DeadConfigReaperOff,
            "retention ON with the reaper OFF is a dead config that must be surfaced"
        );
        assert_eq!(
            retention_wiring_from(Some("0"), Some("1")),
            RetentionWiring::DeadConfigReaperOff,
            "an explicit reaper OFF still makes retention a dead config"
        );
        assert_eq!(
            retention_wiring_from(Some("true"), Some("true")),
            RetentionWiring::MisparsedTruthy,
            "the reaper accepts true, but retention does not; surface the asymmetric parse"
        );
        assert_eq!(
            retention_wiring_from(Some("true"), Some("1")),
            RetentionWiring::Enabled,
            "the existing accepted-value contract stays intact: reaper true plus retention 1"
        );
        assert_eq!(
            retention_wiring_from(Some("1"), None),
            RetentionWiring::ReaperOnly,
            "reaper-only mode remains the session-sweep-only behavior"
        );
        assert_eq!(
            retention_wiring_from(None, None),
            RetentionWiring::Disabled,
            "both flags absent is the quiet default-off posture"
        );
    }

    #[test]
    fn retention_sweep_is_default_permanent_even_when_the_flag_is_enabled() {
        // DATA-RETENTION-001 (R-Rust): the reaper tick passes `RetentionWindows::default()`, which
        // is now PERMANENT for every user-data category. So even with the retention flag ENABLED,
        // the sweep deletes NOTHING — local canonical user data is retained until the user
        // explicitly enables a per-category window. This is the tick-level mirror of #1608's
        // default-permanent policy; flipping the flag alone can never silently prune content.
        let (rt, _ws) = mock_runtime("retention-reaper-tick", OWNER);
        let now = 2_000 * 24 * 60 * 60 * 1000_i64;
        // A token_ledger row far older than the (opt-in) 90-day window — maximally eligible IF a
        // window were enabled; under the permanent default it must survive regardless.
        let old = now - friday_storage::retention::TOKEN_LEDGER_MAX_AGE_MS - 1;
        rt.db()
            .conn()
            .execute(
                "INSERT INTO token_ledger
                    (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
                     prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
                     result_link, created_at)
                 VALUES ('tl_reaper_old', NULL, NULL, 'deepseek', 'deepseek-chat',
                         'api.deepseek.com', 1, 1, 2, NULL, 0, NULL, ?1)",
                rusqlite::params![old],
            )
            .unwrap();

        let count = || {
            rt.db()
                .conn()
                .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(count(), 1, "seeded one old ledger row");

        run_session_reaper_tick(rt.db(), false, now);
        assert_eq!(count(), 1, "retention flag OFF keeps the old ledger row");

        run_session_reaper_tick(rt.db(), true, now);
        assert_eq!(
            count(),
            1,
            "retention flag ON still deletes NOTHING: the default policy is PERMANENT \
             (DATA-RETENTION-001)"
        );
        assert_eq!(
            rt.db()
                .conn()
                .query_row("SELECT COUNT(*) FROM audit_ledger", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0,
            "the tick did not synthesize audit rows"
        );
    }

    #[test]
    fn audit_chain_verify_flag_is_default_off_and_fail_closed() {
        // (INFO-sub2) DEFAULT-OFF + STRICT exact-1 (the scheduler/retention idiom, NOT the
        // reaper's 1|true). OFF is the byte-identical guarantee: unset/empty/0/false/true/garbage
        // ⇒ the verifier thread is NEVER spawned ⇒ no second DB connection, no chain recompute ⇒
        // today's behavior. The `"true" ⇒ false` assertion is the one that catches an accidental
        // reaper-style copy.
        assert!(
            !audit_chain_verify_enabled_from(None),
            "unset ⇒ disabled (default-off; the verifier thread is never spawned)"
        );
        assert!(
            !audit_chain_verify_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(!audit_chain_verify_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !audit_chain_verify_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !audit_chain_verify_enabled_from(Some("true")),
            "true is NOT the opt-in value (exact-1 idiom; differs from the reaper flag)"
        );
        assert!(
            !audit_chain_verify_enabled_from(Some("enabled")),
            "garbage ⇒ disabled"
        );
        // Only the exact (trimmed) "1" enables it.
        assert!(audit_chain_verify_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            audit_chain_verify_enabled_from(Some(" 1 ")),
            "padded 1 ⇒ enabled (trimmed)"
        );
    }

    #[test]
    fn audit_chain_verify_tick_verifies_intact_and_alarms_on_broken_without_writing() {
        use friday_hub::diagnostics::ChainStatus;
        let (rt, _ws) = mock_runtime("audit-chain-verify", OWNER);

        let audit_count = || {
            rt.db()
                .conn()
                .query_row("SELECT COUNT(*) FROM audit_ledger", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };

        // Empty/genesis ledger verifies (Verified{entries:0}); the tick writes NOTHING.
        assert_eq!(audit_count(), 0, "fresh DB has no audit rows");
        let status = run_audit_chain_verify_tick(rt.db());
        assert_eq!(
            status,
            ChainStatus::Verified { entries: 0 },
            "empty chain verifies (genesis)"
        );
        assert_eq!(
            audit_count(),
            0,
            "READ-ONLY verify must NEVER synthesize an audit row (anti-M3/M4 verify-then-write)"
        );

        // Seed ONE REAL chained audit row through the real append path (the chain extends from
        // genesis). The tick verifies it.
        {
            let tx = rt.db().conn().unchecked_transaction().unwrap();
            friday_storage::audit::append_audit(
                &tx,
                "audit-verify-1",
                "friday_hub",
                "test_action",
                None,
                1_000,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        let before = audit_count();
        assert_eq!(before, 1, "seeded one real audit row");
        let status = run_audit_chain_verify_tick(rt.db());
        assert_eq!(
            status,
            ChainStatus::Verified { entries: 1 },
            "the one-row chain verifies"
        );
        assert_eq!(
            audit_count(),
            before,
            "READ-ONLY verify left the audit_ledger row count unchanged (no write on the verify path)"
        );

        // TAMPER a HASHED column (`action`) → the recomputed entry_hash mismatches → the tick maps
        // the Err to the Broken alarm (the diagnostics Err→Broken policy). It does NOT fail-closed.
        let n = rt
            .db()
            .conn()
            .execute("UPDATE audit_ledger SET action = 'TAMPERED'", [])
            .unwrap();
        assert_eq!(n, 1, "tampered the one audit row");
        let status = run_audit_chain_verify_tick(rt.db());
        assert!(
            matches!(status, ChainStatus::Broken { .. }),
            "a tampered chain must surface Broken (alarm), got {status:?}"
        );
        // Even on a broken chain the read-only verify writes nothing (it never tries to "repair").
        assert_eq!(
            audit_count(),
            before,
            "the alarm path is read-only too — no rows added/removed on a broken chain"
        );
    }

    #[test]
    fn agent_run_control_flag_is_default_off_and_fail_closed() {
        // The on-wire run-control plane is DEFAULT-OFF: unset ⇒ disabled (deploy-safe). Only the
        // exact opt-in values enable it; everything else is OFF.
        assert!(
            !agent_run_control_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(
            !agent_run_control_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(!agent_run_control_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !agent_run_control_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !agent_run_control_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(agent_run_control_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            agent_run_control_enabled_from(Some("true")),
            "true ⇒ enabled"
        );
        assert!(
            agent_run_control_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ enabled"
        );
    }

    #[test]
    fn mission_bound_run_flag_is_default_off_and_fail_closed() {
        // (NS-4) The mission-bound run seam is DEFAULT-OFF: unset ⇒ disabled (deploy-safe, the
        // dispatch arm never enters the bound-seam code). Only the exact opt-in values enable it;
        // everything else is OFF.
        assert!(
            !mission_bound_run_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(
            !mission_bound_run_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(!mission_bound_run_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !mission_bound_run_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !mission_bound_run_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(mission_bound_run_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            !mission_bound_run_enabled_from(Some("true")),
            "true ⇒ disabled (only exact 1)"
        );
        assert!(
            !mission_bound_run_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ disabled (only exact 1)"
        );
    }

    #[test]
    fn mission_intake_flag_is_default_off_and_fail_closed() {
        // (NS-5) The mission-intake ingress arm is DEFAULT-OFF: unset ⇒ disabled (deploy-safe, the
        // dispatch arm never handles a MissionIntakeRequest — it falls through to the keepalive
        // echo). Only the exact opt-in values enable it; everything else is OFF.
        assert!(
            !mission_intake_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(!mission_intake_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!mission_intake_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !mission_intake_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !mission_intake_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(mission_intake_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            !mission_intake_enabled_from(Some("true")),
            "true ⇒ disabled (only exact 1)"
        );
        assert!(
            !mission_intake_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ disabled (only exact 1)"
        );
    }

    /// (NS-5) Build a `MissionIntakeRequest` envelope for an organic surface intake — the SAME
    /// wire shape an inbound intake message carries. No `auth_proof`: the sealed session IS the
    /// channel auth (mirroring `HubServer::dispatch`'s session-authed intake).
    fn mission_intake_request(msg_id: &str) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::MissionIntakeRequest {
                request: friday_protocol::MissionIntakeRequestWire {
                    friday_conversation_id: "fconv_ns5_intake".into(),
                    owner_principal: OWNER.into(),
                    surface_thread_id: "surface-ns5-intake".into(),
                    surface_kind: "mobile".into(),
                    delivery_route: "mobile://local/thread/ns5".into(),
                    visibility_policy: "compact".into(),
                    mission_id: "mission-ns5".into(),
                    work_item_id: "work-ns5".into(),
                    title: "NS-5 organic intake".into(),
                    intent: "resolve the organic surface intake into a Mission".into(),
                    lane: "deepseek".into(),
                    target_provider_or_agent: Some("deepseek".into()),
                    capability_id: Some("ask_friday.deepseek".into()),
                    body_ref: Some("friday://body/mobile/ns5-intake".into()),
                    proof_requirements: Vec::new(),
                    includes_sensitive_context: false,
                },
            },
        )
    }

    /// (FIX-Q3b) The SAME intake shape as [`mission_intake_request`] but with a SPOOFED
    /// `owner_principal` — a principal that is NOT the configured/authenticated owner. The dispatch
    /// arm binds the persisted owner to `runtime.policy().principal_id()` (== `OWNER`), so this
    /// self-asserted body owner must be REJECTED (writes ZERO rows), never silently persisted.
    fn mission_intake_request_spoofed_owner(msg_id: &str) -> Envelope {
        let mut env = mission_intake_request(msg_id);
        if let Message::MissionIntakeRequest { request } = &mut env.message {
            request.owner_principal = "principal:not-the-owner".into();
        }
        env
    }

    /// (NS-5) FLAG-ON: an inbound MissionIntakeRequest driven through the REAL dispatch path
    /// (`accept_one` → `serve_sealed_session`, NOT a direct `mission_intake_result_for_db` call)
    /// BIRTHS a Mission: it persists a Mission row + a WorkItem(Draft) + a SurfaceThread +
    /// a route_decision, returns a `MissionIntakeResult{status:"ready"}`, and writes ZERO
    /// `token_ledger` rows (no model call). This proves the WIRING, not the inner helper.
    #[test]
    fn flag_on_mission_intake_births_a_mission_through_dispatch_and_writes_no_ledger() {
        let (rt, _ws) = mock_runtime("intake-on", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake clears the peer gate and the test
        // exercises the NS-5 intake arm (the sealed session is the intake's channel auth).
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = mission_intake_request("req-intake-on");
            (req, session.clone(), session.clone())
        });

        // SERVER on the main thread (holds the non-Send runtime). Flag ON (last arg).
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                true,  // (NS-5) mission-intake ingress ON
                false, // (KEYSTONE) mission-spine dispatch OFF for the mission-intake test
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one mission-intake request processed");

        // The client got a MissionIntakeResult (ready) — the intake wired through dispatch.
        let obs = client.join().unwrap();
        let Some(Message::MissionIntakeResult { result }) = obs.result.clone() else {
            panic!(
                "flag ON must reply with MissionIntakeResult, got {:?}",
                obs.result
            );
        };
        assert_eq!(result.mission_id, "mission-ns5");
        assert_eq!(result.work_item_id.as_deref(), Some("work-ns5"));
        assert_eq!(result.surface_thread_id, "surface-ns5-intake");
        assert_eq!(result.status, "ready", "intake births a ready Mission");
        assert!(result.created_or_ready, "the WorkItem was created");
        assert!(result.blockers.is_empty());

        // MISSION-BIRTH: the canonical rows are persisted in the runtime's REAL DB.
        let db = rt.db();
        let mission = db
            .get_mission("mission-ns5")
            .unwrap()
            .expect("Mission row persisted");
        assert_eq!(
            mission.intent,
            "resolve the organic surface intake into a Mission"
        );

        let work_item = db
            .get_work_item("work-ns5")
            .unwrap()
            .expect("WorkItem row persisted");
        assert_eq!(work_item.mission_id, "mission-ns5");
        // The intake CONSTRUCTS the WorkItem as Draft (see `mission_intake_result_for_db`), and
        // `preflight_and_stage_work_item` STAGES it to ReadyToDispatch on a clean preflight (the
        // existing, proven post-preflight state — `mission_preflight.rs:148`). So the BORN row is
        // ReadyToDispatch; that is the WorkItem-birth the wiring produces.
        assert_eq!(
            work_item.status,
            friday_core::WorkItemStatus::ReadyToDispatch,
            "the WorkItem is born (Draft) and staged to ReadyToDispatch by preflight"
        );

        let surface = db
            .get_surface_thread("surface-ns5-intake")
            .unwrap()
            .expect("SurfaceThread row persisted");
        assert_eq!(surface.mission_id.as_deref(), Some("mission-ns5"));

        let route_decisions = db.list_route_decisions_for_mission("mission-ns5").unwrap();
        assert_eq!(
            route_decisions.len(),
            1,
            "exactly one route_decision is persisted for the birthed Mission"
        );
        assert_eq!(route_decisions[0].work_item_id, "work-ns5");

        // ZERO model call: intake is a pure &Db mutation, so the token_ledger has NO rows. COUNT
        // (not a SUM) is the faithful "no model call" assertion — a zero-token row is still a row.
        let ledger_rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ledger_rows, 0,
            "mission intake makes NO model call ⇒ ZERO token_ledger rows"
        );
    }

    /// (NS-5) DEPLOY-SAFETY (the load-bearing test): with the mission-intake flag OFF, an inbound
    /// MissionIntakeRequest is treated as a benign keepalive ECHO — BYTE-IDENTICAL to today (the
    /// server has never had a MissionIntakeRequest arm, so the live behavior on this message is the
    /// catch-all echo). It births NO Mission and writes NO rows. This is the same dark-when-off
    /// shape as `control_message_is_keepalive_echo_when_flag_off`.
    #[test]
    fn flag_off_mission_intake_is_keepalive_echo_and_births_nothing() {
        let (rt, _ws) = mock_runtime("intake-off", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = mission_intake_request("req-intake-off");
            (req, session.clone(), session.clone())
        });

        // Flag OFF (last arg) ⇒ the MissionIntakeRequest falls through to the keepalive echo.
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // (NS-5) mission-intake ingress OFF — byte-identical to today
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the intake message is processed as a keepalive"
        );

        // The flag is OFF ⇒ the request is ECHOED verbatim (keepalive), NOT a MissionIntakeResult.
        match client.join().unwrap().result.expect("an echo reply") {
            Message::MissionIntakeRequest { request } => {
                assert_eq!(
                    request.mission_id, "mission-ns5",
                    "the request is echoed verbatim"
                );
            }
            other => panic!("flag OFF must echo the MissionIntakeRequest, got {other:?}"),
        }

        // BYTE-IDENTICAL deploy safety: NO Mission was birthed — none of the canonical rows exist.
        let db = rt.db();
        assert!(
            db.get_mission("mission-ns5").unwrap().is_none(),
            "flag OFF births NO Mission"
        );
        assert!(
            db.get_work_item("work-ns5").unwrap().is_none(),
            "flag OFF births NO WorkItem"
        );
        assert!(
            db.get_surface_thread("surface-ns5-intake")
                .unwrap()
                .is_none(),
            "flag OFF births NO SurfaceThread"
        );
        assert!(
            db.list_route_decisions_for_mission("mission-ns5")
                .unwrap()
                .is_empty(),
            "flag OFF writes NO route_decision"
        );
    }

    /// (FIX-Q3b) OWNER-SPOOF: with the mission-intake flag ON, an inbound MissionIntakeRequest whose
    /// self-asserted `owner_principal` does NOT match the AUTHENTICATED owner
    /// (`runtime.policy().principal_id()` == the configured `--owner`) is FAIL-CLOSED — a typed
    /// `Error` that births NO Mission and writes ZERO rows. This closes the audit gap where a
    /// self-asserted owner_principal was silently persisted (the FIX-Q3b precondition before
    /// multi-owner / live-flip). The happy path (matching owner) is unchanged — proven by
    /// `flag_on_mission_intake_births_a_mission_through_dispatch_and_writes_no_ledger`.
    #[test]
    fn flag_on_mission_intake_spoofed_owner_is_rejected_and_writes_zero_rows() {
        let (rt, _ws) = mock_runtime("intake-spoof", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            // SPOOFED owner_principal — NOT the configured/authenticated owner.
            let req = mission_intake_request_spoofed_owner("req-intake-spoof");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                true,  // (NS-5) mission-intake ingress ON
                false, // (KEYSTONE) mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the spoofed intake is processed (then denied)"
        );

        // FAIL-CLOSED: a typed Error, NOT a MissionIntakeResult.
        match client.join().unwrap().result.expect("a reply is sent") {
            Message::Error { message, .. } => {
                assert!(
                    message.contains("owner_principal does not match the authenticated owner"),
                    "the spoofed owner is rejected with the owner-binding error: {message}"
                );
            }
            other => panic!("a spoofed owner_principal must be a typed Error, got {other:?}"),
        }

        // ZERO rows: no Mission/WorkItem/SurfaceThread/route_decision/conversation born under either
        // the spoofed owner OR the authenticated owner. The intake fail-closed BEFORE any write.
        let db = rt.db();
        assert!(
            db.get_mission("mission-ns5").unwrap().is_none(),
            "a spoofed owner births NO Mission"
        );
        assert!(
            db.get_work_item("work-ns5").unwrap().is_none(),
            "a spoofed owner births NO WorkItem"
        );
        assert!(
            db.get_surface_thread("surface-ns5-intake")
                .unwrap()
                .is_none(),
            "a spoofed owner births NO SurfaceThread"
        );
        assert!(
            db.get_friday_conversation("fconv_ns5_intake")
                .unwrap()
                .is_none(),
            "a spoofed owner births NO conversation row"
        );
        assert!(
            db.list_route_decisions_for_mission("mission-ns5")
                .unwrap()
                .is_empty(),
            "a spoofed owner writes NO route_decision"
        );
    }

    /// (FIX-Q3b) OWNER-BINDING: with the flag ON, the created Mission's conversation owner is the
    /// AUTHENTICATED owner regardless of what the (matching) body field carried — the persisted
    /// owner is BOUND to `runtime.policy().principal_id()`, never the raw body string. (Today the
    /// body field MUST equal the authenticated owner to pass the binding gate; this test proves the
    /// persisted value tracks the authenticated identity, the load-bearing invariant before
    /// multi-owner.)
    #[test]
    fn flag_on_mission_intake_persists_authenticated_owner() {
        let (rt, _ws) = mock_runtime("intake-owner-bind", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = mission_intake_request("req-intake-owner-bind");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                true, // mission-intake ON
                false,
                false,
                false,
                false,
                false, // (C1/C2) provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(processed, 1, "one intake processed");
        assert!(
            matches!(
                client.join().unwrap().result,
                Some(Message::MissionIntakeResult { .. })
            ),
            "the matching-owner intake births a Mission"
        );

        // The persisted conversation owner == the AUTHENTICATED owner (OWNER), not a body-supplied
        // string — the binding the audit fix requires.
        let conversation = rt
            .db()
            .get_friday_conversation("fconv_ns5_intake")
            .unwrap()
            .expect("conversation row persisted");
        assert_eq!(
            conversation.owner_principal, OWNER,
            "the persisted owner is BOUND to the authenticated owner"
        );
    }

    // =======================================================================
    // (C1/C2 §3) FRIDAY_PROVIDER_WORKSPACE_DISPATCH — Provider Workspace action arm
    // =======================================================================

    const PW_FCONV: &str = "fconv_pw_dispatch";
    const PW_MISSION: &str = "mission-pw-dispatch";
    const PW_WORK_ITEM: &str = "work-pw-dispatch";
    const PW_SESSION: &str = "friday-codex-pw";

    /// (C1/C2) A `ProviderWorkspaceActionRequest` envelope for the codex `list_sessions` action,
    /// carrying the canonical Mission context. The SAME wire shape an inbound provider-action
    /// message carries. No `auth_proof`: the sealed session IS the channel auth (mirroring the
    /// merged mission-intake/spine/memory arms).
    fn provider_workspace_action_request(msg_id: &str) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::ProviderWorkspaceActionRequest {
                request: friday_protocol::ProviderWorkspaceActionRequestWire {
                    request_id: "pw-req-1".into(),
                    friday_session_id: PW_SESSION.into(),
                    provider: "codex".into(),
                    action: "list_sessions".into(),
                    capability_id: "provider.codex.list_sessions".into(),
                    payload_ref: Some("friday://body/provider-action/pw-1".into()),
                    mission_context: Some(friday_protocol::ProviderWorkspaceMissionContextWire {
                        friday_conversation_id: PW_FCONV.into(),
                        mission_id: PW_MISSION.into(),
                        work_item_id: PW_WORK_ITEM.into(),
                    }),
                },
            },
        )
    }

    /// Seed the canonical rows the provider-dispatch GATE resolves before the adapter: a
    /// FridayConversation + Mission + WorkItem (codex-targeted, active) + a Hub provider-session
    /// link. With these present the guard reaches the capability lookup (which is
    /// `ImplementedUnproven` ⇒ routed:false), proving the request reached `dispatch_provider_action`.
    fn seed_provider_workspace_context(db: &friday_storage::Db) {
        use friday_core::{
            ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
            ProviderSessionLink, Risk, SyncMode, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
        };
        let now = 1_700_000_000_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: PW_FCONV.into(),
            owner_principal: OWNER.into(),
            title: "Provider workspace dispatch".into(),
            current_focus_summary: "provider action attached to WorkItem".into(),
            active_mission_ids: vec![PW_MISSION.into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://pw-dispatch".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: PW_MISSION.into(),
            friday_conversation_id: PW_FCONV.into(),
            title: "Provider workspace dispatch".into(),
            intent: "dispatch a provider workspace action with Mission context".into(),
            status: MissionStatus::Active,
            why_now: "Provider work must attach to a WorkItem.".into(),
            decision_path_summary: "Resolve Mission context before adapter call.".into(),
            considered_options: vec!["detached dispatch".into(), "mission-bound dispatch".into()],
            deferred_options: vec!["provider live proof".into()],
            known_pitfalls: vec!["ack is not completion".into()],
            handoff_inheritance: vec!["preserve judgment".into()],
            work_item_ids: vec![PW_WORK_ITEM.into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://pw-dispatch".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_work_item(&WorkItem {
            work_item_id: PW_WORK_ITEM.into(),
            mission_id: PW_MISSION.into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("provider.codex.list_sessions".into()),
            risk_level: Risk::Low,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["friday://body/provider-action/pw-1".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["provider dispatch test".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Dispatch a provider workspace action".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "codex".into(),
                read_first_files: vec![
                    "rust-core/crates/friday-hub/src/provider_dispatch.rs".into()
                ],
                required_output: "provider dispatch result".into(),
                done_criteria: vec!["adapter called only after Mission context resolves".into()],
                red_lines: vec!["do not dispatch detached provider work".into()],
                why_this_route: "Provider action must attach to a WorkItem.".into(),
                considered_options: vec![
                    "detached provider dispatch".into(),
                    "Mission context".into(),
                ],
                deferred_options: vec!["native UI".into()],
                previous_pitfalls: vec!["provider ack looked like completion".into()],
                inheritable_context: vec!["Mission Spine owns product state".into()],
                proof_requirements: vec!["provider dispatch test".into()],
                ownership_claim_ids: vec!["own-test".into()],
            },
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_provider_session_link(&ProviderSessionLink {
            friday_session_id: PW_SESSION.into(),
            provider: "codex".into(),
            account_key_hash: "acct-hash-test".into(), // pragma: allowlist secret
            workspace_id: "workspace-pw".into(),
            cwd: None,
            external_session_id: None,
            external_thread_id: None,
            external_url: None,
            sync_mode: SyncMode::ProviderAppServerLocal,
            capability_snapshot: "[]".into(),
            last_provider_seen_at: None,
            last_friday_event_id: None,
            truth_label: "provider dispatch test".into(),
        })
        .unwrap();
    }

    /// (C1/C2) DEFAULT-OFF KAT (the standard exact-`"1"` flag idiom). The provider-workspace
    /// dispatch flag matcher (shared with #797's adapter selection) is DEFAULT-OFF; only the exact
    /// opt-in value `"1"` (after trim) enables it; everything else (including unset / `"true"`) is OFF.
    #[test]
    fn provider_workspace_dispatch_flag_is_default_off_and_fail_closed() {
        use friday_hub::provider_dispatch_adapter::provider_workspace_dispatch_from as f;
        assert!(!f(None), "unset ⇒ disabled (default-off, deploy-safe)");
        assert!(!f(Some(String::new())), "empty ⇒ disabled");
        assert!(!f(Some("0".into())), "0 ⇒ disabled");
        assert!(!f(Some("false".into())), "false ⇒ disabled");
        assert!(!f(Some("on".into())), "garbage ⇒ disabled");
        assert!(!f(Some("true".into())), "true ⇒ disabled (only exact 1)");
        assert!(f(Some("1".into())), "1 ⇒ enabled");
        assert!(f(Some("  1  ".into())), "padded 1 ⇒ enabled (trimmed)");
    }

    /// (C1/C2) DEPLOY-SAFETY (the load-bearing inertness test): with the provider-workspace flag
    /// OFF, an inbound ProviderWorkspaceActionRequest is treated as a benign keepalive ECHO —
    /// BYTE-IDENTICAL to today (the server has never had a provider arm, so the live behavior on
    /// this message is the catch-all echo). It reaches NO `dispatch_provider_action`, writes NO row.
    /// The reply is the ECHOED *Request* (NOT a `ProviderWorkspaceActionResult`).
    #[test]
    fn flag_off_provider_workspace_action_is_keepalive_echo() {
        let (rt, _ws) = mock_runtime("pw-off", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // Seed the context so the ONLY thing keeping the request from dispatching is the FLAG.
        seed_provider_workspace_context(rt.db());
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = provider_workspace_action_request("req-pw-off");
            (req, session.clone(), session.clone())
        });

        // Flag OFF (last arg) ⇒ the ProviderWorkspaceActionRequest falls through to the keepalive echo.
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF
                false, // (C1/C2) provider-workspace dispatch OFF — the bit under test
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the provider action message is processed as a keepalive"
        );

        // The flag is OFF ⇒ the request is ECHOED verbatim (keepalive), NOT a result.
        match client.join().unwrap().result.expect("an echo reply") {
            Message::ProviderWorkspaceActionRequest { request } => {
                assert_eq!(
                    request.request_id, "pw-req-1",
                    "the request is echoed verbatim"
                );
                assert_eq!(request.action, "list_sessions");
            }
            other => panic!("flag OFF must echo the ProviderWorkspaceActionRequest, got {other:?}"),
        }
    }

    /// (C1/C2) FLAG-ON, arm-specific FAIL-CLOSED: there is NO per-request principal to forge on this
    /// wire shape (the unauthenticated boundary is the handshake/peer-allowlist, proven by
    /// `non_allowlisted_peer_pubkey_gets_no_session_forgery_defeated`). The arm's OWN fail-closed
    /// gate is the producer's session-link lookup: with the flag ON but NO provider session link
    /// seeded, the producer refuses with `missing_session` BEFORE `dispatch_provider_action` is
    /// called at all (the call lives only inside the resolved-session arm) — so the adapter is never
    /// touched. (The full structural owner-binding — `WorkItem.target_provider == session.provider`
    /// inside `dispatch_provider_action` — is unit-tested in `provider_dispatch.rs`; it is NOT
    /// reached here, nor in any serve-bin test, because no capability is `Verified`.)
    #[test]
    fn flag_on_provider_workspace_action_without_session_link_is_refused() {
        let (rt, _ws) = mock_runtime("pw-no-session", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // Intentionally do NOT seed the provider session link (nor the Mission rows): the gate must
        // refuse before any adapter call.
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = provider_workspace_action_request("req-pw-no-session");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                true, // (C1/C2) provider-workspace dispatch ON
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the provider action is processed (then refused)"
        );

        match client.join().unwrap().result.expect("a result is sent") {
            Message::ProviderWorkspaceActionResult { result } => {
                assert!(!result.accepted, "no session link ⇒ NOT accepted");
                assert!(!result.routed, "no session link ⇒ NOT routed");
                assert_eq!(
                    result.status, "missing_session",
                    "the producer's session-link lookup refuses BEFORE dispatch_provider_action"
                );
                assert!(
                    result.dispatch_ref.is_none(),
                    "no dispatch on a refused action"
                );
            }
            other => {
                panic!("flag ON must reply with a ProviderWorkspaceActionResult, got {other:?}")
            }
        }
    }

    /// (C1/C2) FLAG-ON REACHABILITY (the headline of this slice): with the flag ON, a seeded,
    /// Mission-resolvable, session-linked ProviderWorkspaceActionRequest routes through
    /// `dispatch_provider_action`'s GATE — and is REFUSED with the capability's
    /// `implemented_unproven` status (the codex `list_sessions` capability is `ImplementedUnproven`
    /// in `friday_current()`, so the guard sets routed:false). ONLY the capability guard produces
    /// that exact status, so this PROVES the request reached `dispatch_provider_action` (the #797
    /// dark machinery is now REACHABLE from the live serve-bin). The adapter is NOT consulted (the
    /// guard refuses first) and ZERO `token_ledger` rows are written (no model call).
    #[test]
    fn flag_on_provider_workspace_action_reaches_dispatch_gate_and_is_unproven() {
        let (rt, _ws) = mock_runtime("pw-on", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // Seed the canonical context so the guard reaches the capability lookup (the ONLY producer
        // of the `implemented_unproven` status).
        seed_provider_workspace_context(rt.db());
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = provider_workspace_action_request("req-pw-on");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                true, // (C1/C2) provider-workspace dispatch ON
            )
            .unwrap();
        assert_eq!(processed, 1, "one provider action processed");

        match client.join().unwrap().result.expect("a result is sent") {
            Message::ProviderWorkspaceActionResult { result } => {
                assert_eq!(result.request_id, "pw-req-1");
                assert_eq!(result.provider, "codex");
                assert_eq!(result.action, "list_sessions");
                // REACHED the gate: only the capability guard emits `implemented_unproven`.
                assert_eq!(
                    result.status, "implemented_unproven",
                    "the request reached dispatch_provider_action's capability guard"
                );
                assert!(
                    !result.accepted && !result.routed,
                    "an ImplementedUnproven capability is refused before the adapter"
                );
                assert!(
                    result.dispatch_ref.is_none(),
                    "a non-routed action carries no dispatch_ref"
                );
                assert!(
                    result.blocker.is_some(),
                    "the unproven capability carries its exact blocker"
                );
            }
            other => {
                panic!("flag ON must reply with a ProviderWorkspaceActionResult, got {other:?}")
            }
        }

        // ZERO model call: the guard refused before the adapter, so the token_ledger has NO rows.
        let ledger_rows: i64 = rt
            .db()
            .conn()
            .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ledger_rows, 0,
            "a refused provider action makes NO model call ⇒ ZERO token_ledger rows"
        );
    }

    // =======================================================================
    // (KEYSTONE) FRIDAY_MISSION_SPINE_DISPATCH — Mission/WorkItem lifecycle arms
    // =======================================================================

    #[test]
    fn mission_spine_dispatch_flag_is_default_off_and_fail_closed() {
        // The mission-spine dispatch arms are DEFAULT-OFF: unset ⇒ disabled (deploy-safe, each
        // arm falls through to the keepalive echo). Only the exact opt-in value enables it.
        assert!(
            !mission_spine_dispatch_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("0")),
            "0 ⇒ disabled"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(
            mission_spine_dispatch_enabled_from(Some("1")),
            "1 ⇒ enabled"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("true")),
            "true ⇒ disabled (only exact 1)"
        );
        assert!(
            !mission_spine_dispatch_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ disabled (only exact 1)"
        );
    }

    #[test]
    fn memory_confirm_flag_is_default_off_and_fail_closed() {
        // The memory-confirm dispatch arm is DEFAULT-OFF: unset ⇒ disabled (deploy-safe — the arm
        // falls through to the keepalive echo). Only the exact opt-in value `"1"` enables it.
        assert!(
            !memory_confirm_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(!memory_confirm_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!memory_confirm_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !memory_confirm_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !memory_confirm_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(memory_confirm_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            memory_confirm_enabled_from(Some(" 1 ")),
            "padded 1 ⇒ enabled (trimmed)"
        );
        assert!(
            !memory_confirm_enabled_from(Some("true")),
            "true ⇒ disabled (only exact 1)"
        );
        assert!(
            !memory_confirm_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ disabled (only exact 1)"
        );
    }

    #[test]
    fn context_passport_transfer_flag_is_default_off_and_fail_closed() {
        assert!(!context_passport_transfer_enabled_from(None));
        assert!(!context_passport_transfer_enabled_from(Some("")));
        assert!(!context_passport_transfer_enabled_from(Some("0")));
        assert!(!context_passport_transfer_enabled_from(Some("true")));
        assert!(!context_passport_transfer_enabled_from(Some("on")));
        assert!(context_passport_transfer_enabled_from(Some("1")));
        assert!(context_passport_transfer_enabled_from(Some(" 1 ")));
    }

    #[test]
    fn run_outcome_learning_confirm_flag_is_default_off_and_fail_closed() {
        assert!(!run_outcome_learning_confirm_enabled_from(None));
        assert!(!run_outcome_learning_confirm_enabled_from(Some("")));
        assert!(!run_outcome_learning_confirm_enabled_from(Some("0")));
        assert!(!run_outcome_learning_confirm_enabled_from(Some("true")));
        assert!(run_outcome_learning_confirm_enabled_from(Some("1")));
        assert!(run_outcome_learning_confirm_enabled_from(Some(" 1 ")));
    }

    #[test]
    fn activity_mark_done_flag_is_default_off_and_fail_closed() {
        assert!(!activity_mark_done_enabled_from(None));
        assert!(!activity_mark_done_enabled_from(Some("")));
        assert!(!activity_mark_done_enabled_from(Some("0")));
        assert!(!activity_mark_done_enabled_from(Some("true")));
        assert!(!activity_mark_done_enabled_from(Some("on")));
        assert!(activity_mark_done_enabled_from(Some("1")));
        assert!(activity_mark_done_enabled_from(Some(" 1 ")));
    }

    fn seed_run_outcome_learning_candidate<T: Transport>(
        rt: &HubRuntime<T>,
        run_id: &str,
        session_id: &str,
    ) {
        friday_storage::ensure_session_with_owner(
            rt.db().conn(),
            session_id,
            &friday_storage::SessionOwner {
                user_id: Some(OWNER.to_string()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();
        friday_storage::agent_run::create_run(rt.db().conn(), run_id, "refs-only task", 1_000)
            .unwrap();
        friday_storage::learning_candidate::record_run_outcome_candidates(
            rt.db().conn(),
            run_id,
            Some(session_id),
            2,
            1,
            1_100,
        )
        .unwrap();
    }

    fn run_outcome_learning_decision_request(
        msg_id: &str,
        candidate_id: &str,
        decision: &str,
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::RunOutcomeLearningDecisionRequest {
                request: friday_protocol::RunOutcomeLearningDecisionRequestWire {
                    candidate_id: candidate_id.into(),
                    decision: decision.into(),
                    reason: Some("owner decision from sealed session".into()),
                },
            },
        )
    }

    #[test]
    fn flag_on_run_outcome_learning_decision_confirms_through_dispatch() {
        let (rt, _ws) = mock_runtime("run-outcome-learning-on", OWNER);
        seed_run_outcome_learning_candidate(&rt, "run-a1-wire", "sess-a1-wire");

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = run_outcome_learning_decision_request(
                "req-a1-learning-on",
                "a1:run-a1-wire:preference",
                "confirm",
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                true,  // run-outcome-learning confirm ON
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(processed, 1, "one run-outcome learning decision processed");

        let Some(Message::RunOutcomeLearningDecisionResult { result }) =
            client.join().unwrap().result.clone()
        else {
            panic!("flag ON must reply with RunOutcomeLearningDecisionResult");
        };
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.state, "confirmed");
        assert_eq!(result.run_id.as_deref(), Some("run-a1-wire"));

        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            rt.db().conn(),
            "a1:run-a1-wire:preference",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Confirmed
        );
        assert_eq!(
            rt.db().count("token_ledger").unwrap(),
            0,
            "run-outcome learning decision makes NO model call"
        );
    }

    #[test]
    fn flag_off_run_outcome_learning_decision_is_keepalive_echo_and_changes_nothing() {
        let (rt, _ws) = mock_runtime("run-outcome-learning-off", OWNER);
        seed_run_outcome_learning_candidate(&rt, "run-a1-dark", "sess-a1-dark");

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = run_outcome_learning_decision_request(
                "req-a1-learning-off",
                "a1:run-a1-dark:preference",
                "confirm",
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(processed, 1, "the message is processed as a keepalive");

        match client.join().unwrap().result.expect("an echo reply") {
            Message::RunOutcomeLearningDecisionRequest { request } => {
                assert_eq!(request.candidate_id, "a1:run-a1-dark:preference");
                assert_eq!(request.decision, "confirm");
            }
            other => {
                panic!("flag OFF must echo the RunOutcomeLearningDecisionRequest, got {other:?}")
            }
        }
        let row = friday_storage::learning_candidate::get_run_outcome_candidate(
            rt.db().conn(),
            "a1:run-a1-dark:preference",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            row.state,
            friday_storage::learning_candidate::RunOutcomeLearningState::Pending
        );
    }

    /// Seed ONE pending, owner-owned, content-bearing memory candidate directly into the runtime's
    /// The COMPOSITE namespace OWNER's agent-run session resolves to — what the live extraction
    /// keys a candidate's `principal_id` on, and the SAME scope source the confirm dispatch arm
    /// now derives from `runtime.policy().principal_id()`. Account/channel unset, direct userId.
    fn owner_composite_ns() -> String {
        friday_hub::session_namespace::resolve_session_memory_namespace(None, None, Some(OWNER))
            .unwrap()
    }

    /// REAL DB (a pure `&Db` write — no session needed). The candidate is keyed on OWNER's
    /// COMPOSITE namespace (what live extraction stores), so the confirm dispatch arm — scoped by
    /// the authenticated owner's composite namespace candidate list — matches it. Content is
    /// non-empty so a confirm makes it recallable (`recall_confirmed` requires non-NULL content).
    fn seed_memory_candidate<T: Transport>(rt: &HubRuntime<T>, memory_id: &str) {
        let ns = owner_composite_ns();
        friday_storage::memory::record_candidate(
            rt.db().conn(),
            &friday_storage::memory::NewMemoryCandidate {
                memory_id,
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some("prefers rust"),
                principal_id: Some(ns.as_str()),
                sensitive: false,
                created_at: 1_000,
            },
        )
        .unwrap();
    }

    /// A `MemoryDecisionRequest` envelope. No `auth_proof`: the sealed session IS the channel auth
    /// (mirroring the merged mission-intake / mission-spine arms).
    fn memory_decision_request(msg_id: &str, memory_id: &str, decision: &str) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::MemoryDecisionRequest {
                request: friday_protocol::MemoryDecisionRequestWire {
                    memory_id: memory_id.into(),
                    owner_principal: OWNER.into(),
                    decision: decision.into(),
                },
            },
        )
    }

    /// FLAG-ON: a `MemoryDecisionRequest{confirm}` driven through the REAL dispatch path
    /// (`accept_one` → `serve_sealed_session`, NOT a direct `memory_decision_result_for_db` call)
    /// CONFIRMS the candidate: the row becomes Confirmed, `recall_confirmed` now returns it (the
    /// loop's payoff), the reply is a `MemoryDecisionResult{recallable:true}`, and ZERO
    /// `token_ledger` rows are written (no model call). This proves the WIRING, not the inner helper.
    #[test]
    fn flag_on_memory_decision_confirms_and_makes_recallable_through_dispatch() {
        let (rt, _ws) = mock_runtime("memory-confirm-on", OWNER);
        seed_memory_candidate(&rt, "mem-wired");
        let ns = owner_composite_ns();
        // Pre-confirm: NOT recallable (under the COMPOSITE namespace the candidate is keyed on).
        assert!(
            friday_storage::memory::recall_confirmed(rt.db().conn(), &ns)
                .unwrap()
                .is_empty()
        );

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = memory_decision_request("req-mem-on", "mem-wired", "confirm");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                true,  // memory-confirm ingress ON
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one memory-decision request processed");

        let obs = client.join().unwrap();
        let Some(Message::MemoryDecisionResult { result }) = obs.result.clone() else {
            panic!(
                "flag ON must reply with MemoryDecisionResult, got {:?}",
                obs.result
            );
        };
        assert_eq!(result.memory_id, "mem-wired");
        assert_eq!(result.status, "confirmed");
        assert_eq!(result.state, "confirmed");
        assert!(result.recallable, "a confirmed candidate is recallable");

        // STORAGE TRUTH: the row is Confirmed AND `recall_confirmed` now returns it.
        let db = rt.db();
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT state FROM memory_item WHERE memory_id = 'mem-wired'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "confirmed"
        );
        let recalled = friday_storage::memory::recall_confirmed(db.conn(), &ns).unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].memory_id, "mem-wired");

        // ZERO model call: the decision is a pure &Db mutation ⇒ NO token_ledger rows.
        let ledger_rows: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ledger_rows, 0,
            "memory decision makes NO model call ⇒ ZERO token_ledger rows"
        );
    }

    /// DEPLOY-SAFETY (the load-bearing test): with the memory-confirm flag OFF, an inbound
    /// `MemoryDecisionRequest` is treated as a benign keepalive ECHO — BYTE-IDENTICAL to today (the
    /// server has never had this arm). It changes NOTHING: the candidate stays a pending Candidate
    /// and is NOT recallable. Same dark-when-off shape as the mission-intake/control keepalive tests.
    #[test]
    fn flag_off_memory_decision_is_keepalive_echo_and_changes_nothing() {
        let (rt, _ws) = mock_runtime("memory-confirm-off", OWNER);
        seed_memory_candidate(&rt, "mem-dark");

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = memory_decision_request("req-mem-off", "mem-dark", "confirm");
            (req, session.clone(), session.clone())
        });

        // Flag OFF ⇒ the MemoryDecisionRequest falls through to the keepalive echo.
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the memory-decision message is processed as a keepalive"
        );

        // The flag is OFF ⇒ the request is ECHOED verbatim, NOT a MemoryDecisionResult.
        match client.join().unwrap().result.expect("an echo reply") {
            Message::MemoryDecisionRequest { request } => {
                assert_eq!(
                    request.memory_id, "mem-dark",
                    "the request is echoed verbatim"
                );
                assert_eq!(request.decision, "confirm");
            }
            other => panic!("flag OFF must echo the MemoryDecisionRequest, got {other:?}"),
        }

        // BYTE-IDENTICAL deploy safety: NOTHING changed — the candidate is still a pending
        // Candidate and is NOT recallable (the confirm was never applied).
        let db = rt.db();
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT state FROM memory_item WHERE memory_id = 'mem-dark'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "candidate",
            "flag OFF leaves the candidate pending (births/changes nothing)"
        );
        assert!(
            friday_storage::memory::recall_confirmed(db.conn(), &owner_composite_ns())
                .unwrap()
                .is_empty(),
            "flag OFF ⇒ nothing recallable"
        );
    }

    /// (KEYSTONE) Seed a real Mission + WorkItem(ReadyToDispatch) into the runtime's DB by driving
    /// the PROVEN intake free-fn directly (no session needed — it is a pure `&Db` mutation). Returns
    /// the canonical ids so the lifecycle/status KATs have a real target. Uses the SAME shape the
    /// `mission_intake_request` builder produces.
    fn seed_mission_and_work_item<T: Transport>(rt: &HubRuntime<T>) {
        let req = match mission_intake_request("seed").message {
            Message::MissionIntakeRequest { request } => request,
            _ => unreachable!("the seed builder produces a MissionIntakeRequest"),
        };
        // (FIX-Q3b) The seed binds the persisted owner to the authenticated owner (OWNER), the
        // same identity the live dispatch arm threads from `runtime.policy().principal_id()`.
        let env = friday_hub::hub_server::mission_intake_result_for_db(
            rt.db(),
            "seed",
            req,
            Some(OWNER),
            1_000,
        );
        match env.message {
            Message::MissionIntakeResult { result } => {
                assert_eq!(
                    result.status, "ready",
                    "seed births a ready Mission/WorkItem"
                );
            }
            other => panic!("seed intake must succeed, got {other:?}"),
        }
    }

    /// (FIX-Q3b) The principal a FOREIGN-owned seed Mission/WorkItem belongs to — deliberately NOT
    /// the session's authenticated `OWNER`, so a cross-owner transition must fail-closed.
    const FOREIGN_OWNER: &str = "principal:other-owner";

    /// (FIX-Q3b) Seed a Mission + WorkItem owned by `FOREIGN_OWNER` (NOT the session owner) by
    /// driving the intake free-fn with that authenticated owner directly. The body's
    /// `owner_principal` is set to match so the birth succeeds — this is how a row owned by a
    /// different principal exists in the (hypothetical multi-owner) DB. The canonical ids match
    /// `mission_lifecycle_request` / `work_item_status_request` so the cross-owner KATs have a real,
    /// foreign-owned target to be denied against.
    fn seed_foreign_owned_mission_and_work_item<T: Transport>(rt: &HubRuntime<T>) {
        let mut env = mission_intake_request("seed-foreign");
        if let Message::MissionIntakeRequest { request } = &mut env.message {
            request.owner_principal = FOREIGN_OWNER.into();
        }
        let req = match env.message {
            Message::MissionIntakeRequest { request } => request,
            _ => unreachable!("the seed builder produces a MissionIntakeRequest"),
        };
        let result = friday_hub::hub_server::mission_intake_result_for_db(
            rt.db(),
            "seed-foreign",
            req,
            Some(FOREIGN_OWNER),
            1_000,
        );
        match result.message {
            Message::MissionIntakeResult { result } => assert_eq!(
                result.status, "ready",
                "the foreign-owned seed births a ready Mission/WorkItem"
            ),
            other => panic!("foreign seed intake must succeed, got {other:?}"),
        }
        // Confirm the seeded owner really is the foreign principal (not OWNER).
        assert_eq!(
            rt.db()
                .get_friday_conversation("fconv_ns5_intake")
                .unwrap()
                .unwrap()
                .owner_principal,
            FOREIGN_OWNER,
            "the seed is owned by the foreign principal"
        );
    }

    /// (KEYSTONE) A `MissionLifecycleRequest` envelope. No `auth_proof`: the sealed session IS the
    /// channel auth (mirroring the merged mission-intake arm).
    fn mission_lifecycle_request(msg_id: &str, target_status: &str) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::MissionLifecycleRequest {
                request: friday_protocol::MissionLifecycleRequestWire {
                    friday_conversation_id: "fconv_ns5_intake".into(),
                    mission_id: "mission-ns5".into(),
                    target_status: target_status.into(),
                    actor_ref: OWNER.into(),
                    reason: "operator advances the Mission".into(),
                    proof_ref: None,
                    merged_into_mission_id: None,
                },
            },
        )
    }

    /// (KEYSTONE) A `WorkItemStatusRequest` envelope for `work_item_id` → `target_status`, carrying
    /// `proof_receipt`. No `auth_proof`: the sealed session is the channel auth.
    fn work_item_status_request(
        msg_id: &str,
        work_item_id: &str,
        target_status: &str,
        proof_receipt: Option<&str>,
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::WorkItemStatusRequest {
                request: friday_protocol::WorkItemStatusRequestWire {
                    work_item_id: work_item_id.into(),
                    target_status: target_status.into(),
                    actor_ref: OWNER.into(),
                    reason: "operator advances the WorkItem".into(),
                    proof_receipt: proof_receipt.map(str::to_string),
                },
            },
        )
    }

    /// (D20 W1-S3) A `RouteDecisionControlRequest` envelope. No `auth_proof`: the sealed session is
    /// the channel auth; the live arm owner-binds against the target decision's Mission owner.
    fn route_decision_control_request(
        msg_id: &str,
        decision_id: &str,
        control_kind: &str,
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::RouteDecisionControlRequest {
                request: friday_protocol::RouteDecisionControlRequestWire {
                    decision_id: decision_id.into(),
                    mission_id: None,
                    work_item_id: None,
                    control_kind: control_kind.into(),
                    override_lane: None,
                    override_provider_or_agent: None,
                    actor_ref: OWNER.into(),
                    reason: "operator controls the proposed route".into(),
                },
            },
        )
    }

    /// (KEYSTONE / KAT a) FLAG-ON: a `MissionLifecycleRequest` driven through the REAL dispatch path
    /// (`accept_one` → `serve_sealed_session`) advances the canonical Mission's status through the
    /// Hub state machine, returns a `MissionLifecycleResult`, and writes ZERO `token_ledger` rows.
    #[test]
    fn flag_on_mission_lifecycle_transitions_through_dispatch() {
        let (rt, _ws) = mock_runtime("spine-lifecycle-on", OWNER);
        seed_mission_and_work_item(&rt);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = mission_lifecycle_request("req-lifecycle-on", "paused");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                true,  // (KEYSTONE) mission-spine dispatch ON
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one mission-lifecycle request processed");

        let obs = client.join().unwrap();
        let Some(Message::MissionLifecycleResult { result }) = obs.result.clone() else {
            panic!(
                "flag ON must reply with MissionLifecycleResult, got {:?}",
                obs.result
            );
        };
        assert_eq!(result.mission_id, "mission-ns5");
        assert_eq!(result.previous_status, "active");
        assert_eq!(result.status, "paused", "the Mission was transitioned");

        // The DB row reflects the transition.
        let mission = rt
            .db()
            .get_mission("mission-ns5")
            .unwrap()
            .expect("Mission row persisted");
        assert_eq!(mission.status, friday_core::MissionStatus::Paused);

        // ZERO model call: a lifecycle transition is a pure &Db mutation.
        let ledger_rows: i64 = rt
            .db()
            .conn()
            .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ledger_rows, 0,
            "lifecycle makes NO model call ⇒ ZERO ledger rows"
        );
    }

    /// (KEYSTONE / KAT a) FLAG-ON: a `WorkItemStatusRequest` with a VALID proof_receipt completes
    /// the WorkItem with proof through the REAL dispatch path, returning a `WorkItemStatusResult`
    /// whose status is `completed_with_proof` and whose receipt COUNT is 1.
    #[test]
    fn flag_on_work_item_status_completes_with_proof_through_dispatch() {
        let (rt, _ws) = mock_runtime("spine-workitem-on", OWNER);
        seed_mission_and_work_item(&rt);
        // The seeded WorkItem is ReadyToDispatch; walk it to ProviderWaiting (the only legal
        // pre-completion state) so the completion hop is valid — exercising the state machine.
        for (i, next) in [
            friday_core::WorkItemStatus::Dispatched,
            friday_core::WorkItemStatus::HubAccepted,
            friday_core::WorkItemStatus::ProviderRouted,
            friday_core::WorkItemStatus::ProviderWaiting,
        ]
        .into_iter()
        .enumerate()
        {
            // DISTINCT now_ms per hop: the audit_id is `workitem_lifecycle:{id}:{now_ms}`, so a
            // shared timestamp would collide on the audit_ledger UNIQUE key.
            let now = 2_000 + i as i64;
            rt.db()
                .transition_work_item_status("work-ns5", next, OWNER, "advance", None, now)
                .unwrap();
        }
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = work_item_status_request(
                "req-workitem-on",
                "work-ns5",
                "completed_with_proof",
                Some("proof://work-ns5/verified-result"),
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true,  // (KEYSTONE) mission-spine dispatch ON
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one work-item-status request processed");

        let obs = client.join().unwrap();
        let Some(Message::WorkItemStatusResult { result }) = obs.result.clone() else {
            panic!(
                "flag ON must reply with WorkItemStatusResult, got {:?}",
                obs.result
            );
        };
        assert_eq!(result.work_item_id, "work-ns5");
        assert_eq!(result.mission_id, "mission-ns5");
        assert_eq!(result.previous_status, "provider_waiting");
        assert_eq!(result.status, "completed_with_proof");
        assert_eq!(
            result.proof_receipt_count, 1,
            "exactly one receipt persisted"
        );

        let work = rt
            .db()
            .get_work_item("work-ns5")
            .unwrap()
            .expect("WorkItem row persisted");
        assert_eq!(work.status, friday_core::WorkItemStatus::CompletedWithProof);
        assert_eq!(work.proof_receipts.len(), 1);
    }

    /// (KEYSTONE / KAT b) PROOF-ON-COMPLETION: a `completed_with_proof` WorkItemStatusRequest with an
    /// EMPTY proof_receipt is REJECTED — the dispatch arm returns a typed `Error`, NOT a fake-ready
    /// completion, and the WorkItem is NOT advanced. This is the load-bearing safety invariant.
    #[test]
    fn flag_on_work_item_completion_with_empty_proof_is_rejected() {
        let (rt, _ws) = mock_runtime("spine-workitem-emptyproof", OWNER);
        seed_mission_and_work_item(&rt);
        for (i, next) in [
            friday_core::WorkItemStatus::Dispatched,
            friday_core::WorkItemStatus::HubAccepted,
            friday_core::WorkItemStatus::ProviderRouted,
            friday_core::WorkItemStatus::ProviderWaiting,
        ]
        .into_iter()
        .enumerate()
        {
            // DISTINCT now_ms per hop: the audit_id is `workitem_lifecycle:{id}:{now_ms}`, so a
            // shared timestamp would collide on the audit_ledger UNIQUE key.
            let now = 2_000 + i as i64;
            rt.db()
                .transition_work_item_status("work-ns5", next, OWNER, "advance", None, now)
                .unwrap();
        }
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            // EMPTY (whitespace-only) receipt — must be treated as NO receipt and rejected.
            let req = work_item_status_request(
                "req-workitem-emptyproof",
                "work-ns5",
                "completed_with_proof",
                Some("   "),
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true,  // (KEYSTONE) mission-spine dispatch ON
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "the request is processed (then rejected)");

        // FAIL-CLOSED: a typed Error, never a WorkItemStatusResult.
        match client.join().unwrap().result.expect("a reply is sent") {
            Message::Error { message, .. } => {
                assert!(
                    message.contains("work item lifecycle blocked"),
                    "the proofless completion is a typed error: {message}"
                );
            }
            other => panic!("empty-proof completion must be REJECTED, got {other:?}"),
        }

        // The WorkItem was NOT completed — it stays at ProviderWaiting, no fake-ready write.
        let work = rt
            .db()
            .get_work_item("work-ns5")
            .unwrap()
            .expect("WorkItem row persisted");
        assert_eq!(
            work.status,
            friday_core::WorkItemStatus::ProviderWaiting,
            "a proofless completion never advances the WorkItem"
        );
        assert!(
            work.proof_receipts.is_empty(),
            "no receipt was appended for the rejected completion"
        );
    }

    /// (KEYSTONE / KAT c) CROSS-OWNER / NOT-FOUND: a WorkItemStatusRequest for a work_item_id that
    /// does NOT exist in this owner's DB is denied (typed `not found` Error). Under the single-peer/
    /// single-owner session-auth model, an unknown id IS the cross-owner denial (a non-owner could
    /// never open this session, and an id outside this DB is not found). No partial write.
    #[test]
    fn flag_on_work_item_status_unknown_id_is_denied_not_found() {
        let (rt, _ws) = mock_runtime("spine-workitem-notfound", OWNER);
        seed_mission_and_work_item(&rt);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = work_item_status_request(
                "req-workitem-notfound",
                "work-belonging-to-another-owner",
                "ready_to_dispatch",
                None,
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true,  // (KEYSTONE) mission-spine dispatch ON
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "the request is processed (then denied)");

        match client.join().unwrap().result.expect("a reply is sent") {
            Message::Error { message, .. } => {
                assert!(
                    message.contains("not found"),
                    "an unknown WorkItem is a not-found denial: {message}"
                );
            }
            other => panic!("unknown WorkItem must be denied, got {other:?}"),
        }
        // The seeded (owner's own) WorkItem is untouched — no cross-bleed write.
        let work = rt.db().get_work_item("work-ns5").unwrap().unwrap();
        assert_eq!(work.status, friday_core::WorkItemStatus::ReadyToDispatch);
    }

    /// (FIX-Q3b) CROSS-OWNER MISSION-LIFECYCLE: with the flag ON, a MissionLifecycleRequest that
    /// targets a Mission owned by a DIFFERENT principal (the session authenticated as `OWNER`, the
    /// Mission owned by `FOREIGN_OWNER`) is FAIL-CLOSED — a typed `Error` that does NOT transition
    /// the Mission. The transition binds to `runtime.policy().principal_id()`, not the request's
    /// `actor_ref`/conversation field. (An UNKNOWN Mission keeps its existing not-found shape; this
    /// is the EXISTS-but-not-owned arm.)
    #[test]
    fn flag_on_mission_lifecycle_cross_owner_is_rejected_no_transition() {
        let (rt, _ws) = mock_runtime("spine-lifecycle-cross", OWNER);
        seed_foreign_owned_mission_and_work_item(&rt);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = mission_lifecycle_request("req-lifecycle-cross", "paused");
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true, // mission-spine dispatch ON
                false,
                false,
                false,
                false, // (C1/C2) provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the cross-owner request is processed (then denied)"
        );

        match client.join().unwrap().result.expect("a reply is sent") {
            Message::Error { message, .. } => assert!(
                message.contains("not owned by the authenticated owner"),
                "a cross-owner Mission lifecycle is owner-rejected: {message}"
            ),
            other => panic!("a cross-owner Mission lifecycle must be a typed Error, got {other:?}"),
        }
        // NO transition: the foreign-owned Mission stays Active (the seed's birth status).
        let mission = rt.db().get_mission("mission-ns5").unwrap().unwrap();
        assert_eq!(
            mission.status,
            friday_core::MissionStatus::Active,
            "a cross-owner request never transitions the foreign-owned Mission"
        );
    }

    /// (FIX-Q3b) CROSS-OWNER WORK-ITEM-STATUS: with the flag ON, a WorkItemStatusRequest that
    /// targets a WorkItem owned (via its Mission's conversation) by a DIFFERENT principal is
    /// FAIL-CLOSED — a typed `Error` that does NOT transition the WorkItem. The owner is resolved
    /// from the WorkItem's Mission, compared to `runtime.policy().principal_id()`.
    #[test]
    fn flag_on_work_item_status_cross_owner_is_rejected_no_transition() {
        let (rt, _ws) = mock_runtime("spine-workitem-cross", OWNER);
        seed_foreign_owned_mission_and_work_item(&rt);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            // Target the foreign-owned WorkItem ("work-ns5"), a status it WOULD otherwise accept.
            let req =
                work_item_status_request("req-workitem-cross", "work-ns5", "dispatched", None);
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true, // mission-spine dispatch ON
                false,
                false,
                false,
                false, // (C1/C2) provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "the cross-owner request is processed (then denied)"
        );

        match client.join().unwrap().result.expect("a reply is sent") {
            Message::Error { message, .. } => assert!(
                message.contains("not owned by the authenticated owner"),
                "a cross-owner WorkItem status is owner-rejected: {message}"
            ),
            other => panic!("a cross-owner WorkItem status must be a typed Error, got {other:?}"),
        }
        // NO transition: the foreign-owned WorkItem stays at its seeded ReadyToDispatch status.
        let work = rt.db().get_work_item("work-ns5").unwrap().unwrap();
        assert_eq!(
            work.status,
            friday_core::WorkItemStatus::ReadyToDispatch,
            "a cross-owner request never transitions the foreign-owned WorkItem"
        );
    }

    /// (D20 W1-S3) FLAG-ON: a `RouteDecisionControlRequest{veto}` driven through the REAL sealed
    /// dispatch path persists a load-bearing pre-dispatch control. The subsequent
    /// `ReadyToDispatch -> Dispatched` lifecycle hop is blocked by storage, proving this is not a
    /// decorative field.
    #[test]
    fn flag_on_route_decision_veto_blocks_dispatch_lifecycle_hop() {
        let (rt, _ws) = mock_runtime("spine-route-veto-on", OWNER);
        seed_mission_and_work_item(&rt);
        let route_decisions = rt
            .db()
            .list_route_decisions_for_mission("mission-ns5")
            .unwrap();
        let decision_id = route_decisions
            .first()
            .expect("seed intake writes a route decision")
            .decision_id
            .clone();
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let decision_for_client = decision_id.clone();
        let client = spawn_client(addr, client_kp, move |session, _nonce| {
            let req = route_decision_control_request(
                "req-route-control-on",
                &decision_for_client,
                "veto",
            );
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                true,  // mission-spine dispatch ON, including route controls
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF
                false, // (C1/C2) provider-workspace dispatch OFF
            )
            .unwrap();
        assert_eq!(processed, 1);
        match client
            .join()
            .unwrap()
            .result
            .expect("a route-control reply")
        {
            Message::RouteDecisionControlResult { result } => {
                assert_eq!(result.decision_id, decision_id);
                assert_eq!(result.control_kind, "veto");
                assert_eq!(result.work_item_id, "work-ns5");
            }
            other => panic!("route-control flag ON must return a result, got {other:?}"),
        }

        let err = rt
            .db()
            .transition_work_item_status(
                "work-ns5",
                friday_core::WorkItemStatus::Dispatched,
                OWNER,
                "dispatch after route veto",
                None,
                2_000,
            )
            .expect_err("veto must block the dispatch lifecycle transition");
        assert!(
            err.to_string().contains("route_decision_veto_active"),
            "expected the storage lifecycle hook to block dispatch, got {err:?}"
        );
    }

    /// (KEYSTONE / KAT d) DEPLOY-SAFETY: with the flag OFF, BOTH a MissionLifecycleRequest and a
    /// WorkItemStatusRequest are treated as benign keepalive ECHOES — BYTE-IDENTICAL to today (the
    /// server has never had these arms). No transition, no write.
    #[test]
    fn flag_off_mission_spine_requests_are_keepalive_echoes_and_change_nothing() {
        let (rt, _ws) = mock_runtime("spine-off", OWNER);
        seed_mission_and_work_item(&rt);

        // (1) MissionLifecycleRequest with the flag OFF ⇒ echoed verbatim, Mission NOT transitioned.
        {
            let server_kp = DeviceKeypair::generate();
            let listener = AgentRunWsListener::bind_loopback(0).unwrap();
            let addr = listener.local_addr().unwrap();
            let allowlist = vec![OWNER.to_string()];
            let client_kp = DeviceKeypair::generate();
            let peer_allowlist = allowlist_of(client_kp.public_bytes());
            let client = spawn_client(addr, client_kp, |session, _nonce| {
                let req = mission_lifecycle_request("req-lifecycle-off", "paused");
                (req, session.clone(), session.clone())
            });
            let processed = listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &peer_allowlist,
                    false,
                    false,
                    false,
                    false, // (KEYSTONE) mission-spine dispatch OFF
                    false, // memory-confirm ingress OFF — byte-identical to today
                    false, // run-outcome-learning confirm OFF — byte-identical to today
                    false, // (Loop4) per-run token surface OFF — byte-identical to today
                    false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
                )
                .unwrap();
            assert_eq!(
                processed, 1,
                "the lifecycle request is processed as a keepalive"
            );
            match client.join().unwrap().result.expect("an echo reply") {
                Message::MissionLifecycleRequest { request } => {
                    assert_eq!(request.target_status, "paused", "echoed verbatim");
                }
                other => panic!("flag OFF must echo the MissionLifecycleRequest, got {other:?}"),
            }
            assert_eq!(
                rt.db().get_mission("mission-ns5").unwrap().unwrap().status,
                friday_core::MissionStatus::Active,
                "flag OFF transitions NOTHING (the seeded Mission stays Active)"
            );
        }

        // (2) WorkItemStatusRequest with the flag OFF ⇒ echoed verbatim, WorkItem NOT transitioned.
        {
            let server_kp = DeviceKeypair::generate();
            let listener = AgentRunWsListener::bind_loopback(0).unwrap();
            let addr = listener.local_addr().unwrap();
            let allowlist = vec![OWNER.to_string()];
            let client_kp = DeviceKeypair::generate();
            let peer_allowlist = allowlist_of(client_kp.public_bytes());
            let client = spawn_client(addr, client_kp, |session, _nonce| {
                let req =
                    work_item_status_request("req-workitem-off", "work-ns5", "dispatched", None);
                (req, session.clone(), session.clone())
            });
            let processed = listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &peer_allowlist,
                    false,
                    false,
                    false,
                    false, // (KEYSTONE) mission-spine dispatch OFF
                    false, // memory-confirm ingress OFF — byte-identical to today
                    false, // run-outcome-learning confirm OFF — byte-identical to today
                    false, // (Loop4) per-run token surface OFF — byte-identical to today
                    false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
                )
                .unwrap();
            assert_eq!(
                processed, 1,
                "the work-item-status request is processed as a keepalive"
            );
            match client.join().unwrap().result.expect("an echo reply") {
                Message::WorkItemStatusRequest { request } => {
                    assert_eq!(request.work_item_id, "work-ns5", "echoed verbatim");
                }
                other => panic!("flag OFF must echo the WorkItemStatusRequest, got {other:?}"),
            }
            assert_eq!(
                rt.db().get_work_item("work-ns5").unwrap().unwrap().status,
                friday_core::WorkItemStatus::ReadyToDispatch,
                "flag OFF transitions NOTHING (the seeded WorkItem stays ReadyToDispatch)"
            );
        }
    }

    #[test]
    fn non_allowlisted_principal_is_rejected_no_run_no_body() {
        reject_case("rej-forged", "principal:attacker-not-allowlisted");
    }

    #[test]
    fn empty_forwarded_principal_is_rejected() {
        reject_case("rej-empty", "   ");
    }

    #[test]
    fn anonymous_forwarded_principal_is_rejected() {
        reject_case("rej-anon", "public");
        reject_case("rej-anon2", "public:default");
    }

    // (b') A correct-handshake, allowlisted principal but a BAD auth_proof (sealed under a WRONG
    // key) is rejected — the possession-of-session proof must hold, not just the handshake.
    #[test]
    fn allowlisted_principal_with_bad_auth_proof_is_rejected() {
        let (rt, _ws) = mock_runtime("rej-proof", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake SUCCEEDS and the rejection is
        // attributable to the bad auth_proof (wrong key), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        // The envelope opens (correct session key) but the auth_proof is sealed under a WRONG key.
        let wrong = DataKey::generate();
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            // Bind the CORRECT nonce + AAD so the failure is attributable to the WRONG key, not a
            // missing nonce binding.
            let challenge = nonce_bound_challenge(AUTH_CHALLENGE, nonce);
            let req_aad = auth_aad(SESSION_AAD, OWNER, b"run-badproof");
            let bad_proof = encode_sealed_proof(&seal(&wrong, &challenge, &req_aad).unwrap());
            let req = Envelope::new(
                "req-badproof",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-badproof".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: bad_proof,
                    session_id: None,
                    constraints: None,
                    mission_context: None,
                },
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 0,
            "a bad auth_proof (wrong key) must fail closed"
        );
        let obs = client.join().unwrap();
        assert!(obs.result.is_none(), "no reply on a bad auth_proof");
    }

    // (c) WRONG-SESSION-KEY peer: the envelope itself cannot be opened ⇒ the session ends before
    // dispatch (fail-closed). No run, no body.
    #[test]
    fn wrong_session_key_peer_fails_closed_before_dispatch() {
        let (rt, _ws) = mock_runtime("wrong-key", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the HANDSHAKE succeeds (the client IS the authorized
        // peer) and the rejection is attributable to the wrong ENVELOPE key, not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        // Seal the request (and its auth_proof) under a key that is NOT the established session.
        let wrong_key = DataKey::generate();
        // Client SEALS under the wrong key but OPENS replies under the real session (there are
        // none — the server ends the session). The nonce is still bound correctly so the failure
        // is attributable to the wrong ENVELOPE key (the server can't even open the envelope).
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-wrong", "run-wrong", OWNER, &wrong_key, nonce);
            (req, wrong_key.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 0,
            "a wrong-session-key envelope must fail closed"
        );
        let obs = client.join().unwrap();
        assert!(obs.result.is_none(), "no reply on a wrong-key envelope");
    }

    // (d) NON-CONTRIBUTORY peer key: a known low-order X25519 point is rejected at session
    // establishment — through the REAL `accept_one` path (which also sets the read timeout and
    // calls `establish_session`). No session, no dispatch. The server holds the (non-Send)
    // runtime on the MAIN thread; the malicious client sends the low-order pubkey from a thread.
    fn assert_low_order_pubkey_rejected(tag: &str, peer_pub: [u8; 32]) {
        let (rt, _ws) = mock_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // S-F: ALLOWLIST the low-order point itself, so it CLEARS the (earlier) peer gate and the
        // rejection is attributable to the LOW-ORDER gate — keeping that PRESERVE'd property
        // exercised end-to-end through `accept_one`, not just by the standalone unit test.
        let peer_allowlist = allowlist_of(peer_pub);
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            // Send the low-order point as the peer pubkey; the server must reject it. The peer
            // reads back nothing (the server never writes its pubkey on rejection).
            let _ = write_frame(&mut stream, &peer_pub);
            // Hold the socket open briefly so the server's read/handshake resolves to an error
            // rather than a premature EOF ambiguity.
            std::thread::sleep(Duration::from_millis(50));
            drop(stream);
        });
        // accept_one runs the REAL production path; a low-order key must make it return Err.
        let outcome = listener.accept_one(
            &server_kp,
            &rt,
            &allowlist,
            &peer_allowlist,
            false,
            false,
            false,
            false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
            false, // memory-confirm ingress OFF — byte-identical to today
            false, // run-outcome-learning confirm OFF — byte-identical to today
            false, // (Loop4) per-run token surface OFF — byte-identical to today
            false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
        );
        client.join().unwrap();
        assert!(
            outcome.is_err(),
            "[{tag}] a non-contributory (low-order) peer key must fail closed (no session)"
        );
    }

    #[test]
    fn non_contributory_low_order_peer_key_is_rejected() {
        assert_low_order_pubkey_rejected("lo-zero", [0u8; 32]);
        // The order-8 point e0eb… — a real low-order curve point, not just an edge byte string.
        assert_low_order_pubkey_rejected("lo-order8", LOW_ORDER_X25519_POINTS[2]);
    }

    // (d') THE BYPASS the masking fix closes: a blacklisted low-order point with byte-31's HIGH
    // BIT FLIPPED decodes (RFC 7748) to the SAME degenerate point — the all-zero shared secret is
    // attacker-PREDICTABLE (independent of the server's private key) — so it MUST also be
    // rejected. An exact-byte table would miss it; the masked check catches it.
    #[test]
    fn high_bit_variant_of_low_order_point_is_the_same_point_and_is_rejected() {
        let lo = LOW_ORDER_X25519_POINTS[2]; // e0eb…  (order-8 point)
        let mut hb = lo;
        hb[31] |= 0x80; // flip bit 255

        // The danger: agreeing against the low-order point yields a key INDEPENDENT of the
        // agreeing party's secret (two distinct keypairs derive the SAME session key). DataKey is
        // intentionally `!Debug` (key material), so compare via `==`, not `assert_eq!`.
        let a = DeviceKeypair::generate();
        let b = DeviceKeypair::generate();
        assert!(
            a.agree(&lo) == b.agree(&lo),
            "a low-order point yields an attacker-predictable, secret-independent key"
        );
        // The bypass: the high-bit variant decodes to the SAME degenerate point.
        assert!(
            a.agree(&lo) == a.agree(&hb),
            "bit 255 is ignored on decode — the variant is the same point"
        );
        // The fix: the masked check rejects BOTH representations.
        assert!(is_low_order_x25519(&lo));
        assert!(
            is_low_order_x25519(&hb),
            "the masked low-order check must reject the high-bit variant too"
        );
        // And end-to-end through the real accept path.
        assert_low_order_pubkey_rejected("lo-highbit", hb);
    }

    #[test]
    fn low_order_point_table_detects_known_points() {
        assert!(is_low_order_x25519(&[0u8; 32]));
        let mut one = [0u8; 32];
        one[0] = 1;
        assert!(is_low_order_x25519(&one));
        // Every blacklist entry is detected in both its canonical and high-bit-set forms.
        for entry in &LOW_ORDER_X25519_POINTS {
            assert!(is_low_order_x25519(entry));
            let mut hb = *entry;
            hb[31] |= 0x80;
            assert!(
                is_low_order_x25519(&hb),
                "high-bit variant must be detected"
            );
        }
        // A fresh real pubkey is overwhelmingly NOT low-order.
        assert!(!is_low_order_x25519(
            &DeviceKeypair::generate().public_bytes()
        ));
    }

    // (e) STALLED peer: the per-connection read timeout fires so the server does not wedge. We
    // connect, send NOTHING, and assert the server's accept_one returns (a timeout error) within
    // a bounded wall-clock, rather than blocking forever.
    #[test]
    fn stalled_peer_hits_read_timeout_no_wedge() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        // Use a SHORT timeout for the test so it completes quickly (the prod const is 30s).
        let server = thread::spawn(move || -> Result<(), TransportError> {
            let (stream, _peer) = listener.listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_millis(300)))?;
            // The stall is at the PREAMBLE read, BEFORE the S-F peer gate — the allowlist is never
            // consulted, so any (here empty) allowlist suffices to drive `establish_session`.
            establish_session(stream, &server_kp, &[]).map(|_| ())
        });

        // Connect but send nothing — the server's preamble read must time out (not block).
        let _stalled = TcpStream::connect(addr).unwrap();
        let start = std::time::Instant::now();
        let outcome = server.join().unwrap();
        assert!(
            outcome.is_err(),
            "a stalled peer must hit the read timeout (no session)"
        );
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the read timeout must bound the wait (no wedge)"
        );
        drop(_stalled);
    }

    // (f) BODY ONLY to the bound owner, NEVER in refs — exercised structurally: the refs-only
    // wire result for a delivered outcome carries the fingerprint, never the body.
    #[test]
    fn refs_result_never_carries_body() {
        use friday_hub::hub_server::AuthedAnswer;
        // (A1) Attach real run COUNTS — the refs result must surface the counts but STILL
        // never carry the body.
        let delivered = AuthedAnswer::Delivered {
            run_id: "run-f".into(),
            status: "finished".into(),
            answer: BODY.into(),
            answer_sha256: sha256_hex(BODY.as_bytes()),
            answer_len: BODY.len() as i64,
            turns: Some(3),
            executed_tools: Some(2),
        };
        let refs = result_refs(&delivered);
        assert_eq!(refs.status, "finished");
        assert_eq!(
            refs.answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(refs.answer_len, Some(BODY.len() as u64));
        // (A1) The COUNTS rode through the refs projection.
        assert_eq!(refs.turns, Some(3));
        assert_eq!(refs.executed_tools, Some(2));
        let result = Message::AgentRunResult {
            run_id: "run-f".into(),
            status: refs.status,
            answer_sha256: refs.answer_sha256,
            answer_len: refs.answer_len,
            turns: refs.turns,
            executed_tools: refs.executed_tools,
            prompt_tokens: None,
            completion_tokens: None,
        };
        assert!(
            !format!("{result:?}").contains(BODY),
            "the refs result must never carry the body"
        );
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--port=7777".to_string(),
            "--owner=principal:o".to_string(),
        ];
        assert_eq!(arg_value(&args, "--workspace").as_deref(), Some("/tmp/ws"));
        assert_eq!(arg_value(&args, "--port").as_deref(), Some("7777"));
        assert_eq!(arg_value(&args, "--owner").as_deref(), Some("principal:o"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn validate_request_parses_the_operator_flags_default_off() {
        // BUG-6: a normal boot (no flag) ⇒ NO validation ⇒ zero quota. The flags are bare
        // (presence = true), independent, and accept the `=`-free OWN-argument form.
        let base = vec![
            "bin".to_string(),
            "--workspace".to_string(),
            "/tmp".to_string(),
        ];
        let none = ValidateRequest::from_args(&base);
        assert_eq!(none, ValidateRequest::default());
        assert!(
            !none.any(),
            "no flag ⇒ no probe (the prod default, zero quota)"
        );

        let mut claude = base.clone();
        claude.push(VALIDATE_CLAUDE_FLAG.to_string());
        let r = ValidateRequest::from_args(&claude);
        assert!(r.claude && !r.codex && r.any());

        let mut both = base.clone();
        both.push(VALIDATE_CLAUDE_FLAG.to_string());
        both.push(VALIDATE_CODEX_FLAG.to_string());
        let r = ValidateRequest::from_args(&both);
        assert!(r.claude && r.codex);

        // A value-form `--validate-claude=1` is NOT the bare flag — only the OWN-argument form
        // triggers (avoids an accidental enable from a stray `=`-suffixed arg).
        let valueish = vec!["bin".to_string(), "--validate-claude=1".to_string()];
        assert!(!ValidateRequest::from_args(&valueish).claude);
    }

    #[test]
    fn ephemeral_secret_is_32_bytes() {
        assert_eq!(ephemeral_dev_secret(1, 2).len(), 32);
    }

    #[test]
    fn interop_db_path_override_is_explicit_and_stable() {
        let override_path = std::env::temp_dir().join("friday-interop-persist-red.sqlite");
        let selected = interop_db_path(
            "persist-red",
            Some(override_path.to_string_lossy().as_ref()),
        );
        assert_eq!(
            selected, override_path,
            "manual interop evidence runs need an explicit DB path so Workbench projection can audit the completed_with_proof rows"
        );

        let generated = interop_db_path("persist-red", None);
        let generated_name = generated
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        assert!(
            generated_name.starts_with("friday-execrun-interop-")
                && generated_name.contains("-persist-red-")
                && generated_name.ends_with(".sqlite"),
            "default interop tests keep their isolated temp DB naming"
        );
    }

    #[test]
    fn sealed_proof_round_trips_and_rejects_malformed() {
        let k = DataKey::generate();
        let sealed = seal(&k, AUTH_CHALLENGE, SESSION_AAD).unwrap();
        let wire = encode_sealed_proof(&sealed);
        let back = decode_sealed_proof(&wire).unwrap();
        assert_eq!(crypto_open(&k, &back, SESSION_AAD).unwrap(), AUTH_CHALLENGE);
        assert!(decode_sealed_proof(&[]).is_none());
        assert!(decode_sealed_proof(&[200, 1, 2]).is_none()); // nlen > remaining
    }

    // ============================ S-E anti-replay (end-to-end) ============================

    // (S-E c) NONCE FRESHNESS: two SEPARATE handshakes against the SAME server keypair yield
    // DISTINCT per-handshake nonces (a CSPRNG token, not a predictable counter). This is the
    // freshness/uniqueness the replay defense rests on — if the nonce repeated, a captured proof
    // would replay.
    #[test]
    fn two_handshakes_get_distinct_csprng_nonces() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        // S-F: a KNOWN client keypair, allowlisted, so BOTH handshakes clear the peer gate and the
        // test exercises nonce FRESHNESS (not the peer gate). A fresh `generate()` per handshake
        // would be non-allowlisted and rejected before a nonce was ever sent.
        let peer_allowlist =
            allowlist_of(DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes());

        // Drive one handshake: spawn a client that reads the nonce, run the server's
        // establish_session on THIS (main) thread (server_kp is borrowed, not cloned), return the
        // client-observed nonce.
        let one_handshake = || -> Vec<u8> {
            let c = thread::spawn(move || {
                let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
                let (_ws, _s, nonce) = client_handshake(addr, &client_kp);
                nonce
            });
            let (stream, _peer) = listener.listener.accept().unwrap();
            stream.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
            let _ = establish_session(stream, &server_kp, &peer_allowlist).unwrap();
            c.join().unwrap()
        };

        let n1 = one_handshake();
        let n2 = one_handshake();

        assert_eq!(n1.len(), SESSION_NONCE_LEN, "nonce is the expected width");
        assert_eq!(n2.len(), SESSION_NONCE_LEN, "nonce is the expected width");
        assert_ne!(
            n1, n2,
            "two handshakes against the same server key MUST get distinct nonces (CSPRNG, not a \
             predictable counter) — else a captured proof would replay"
        );
    }

    // (S-E a) REPLAY-TO-AUTHENTICATE DEFEATED: capture a VALID `auth_proof` from connection-1
    // (bound to nonce N1) and REPLAY it verbatim on connection-2 (a fresh handshake, nonce N2)
    // against the SAME server AND client keypairs. The envelope is freshly sealed under conn-2's
    // session (so it opens — the attacker did complete a fresh handshake), but the inner
    // `auth_proof` is the STALE captured one. The server MUST reject (processed=0, no reply): the
    // captured proof sealed `CHALLENGE || N1`, but conn-2 expects `CHALLENGE || N2`.
    //
    // Holding BOTH keypairs constant is the crux: if conn-2 used a fresh client_kp the session key
    // would differ and the proof would fail to OPEN (the existing wrong-key test) — passing for
    // the WRONG reason. Same keys ⇒ same session key ⇒ the rejection is attributable ONLY to the
    // nonce binding.
    #[test]
    fn captured_auth_proof_replayed_on_a_new_handshake_is_rejected() {
        use std::sync::mpsc;

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // A FIXED client secret scalar (the shared `CLIENT_SECRET` test fixture) so the SAME client
        // keypair (hence the SAME session key) is reconstructed in BOTH connection threads
        // (DeviceKeypair is not Clone/Send-shared).
        let client_secret = CLIENT_SECRET;
        // S-F: allowlist that fixed client pubkey so BOTH handshakes (conn-1 valid, conn-2 replay)
        // CLEAR the peer gate — the conn-2 rejection is then attributable ONLY to the stale nonce
        // binding (the S-E replay defense), not the peer gate.
        let peer_allowlist =
            allowlist_of(DeviceKeypair::from_secret_bytes(client_secret).public_bytes());
        let client_session =
            DeviceKeypair::from_secret_bytes(client_secret).agree(&server_kp.public_bytes());

        // --- Connection 1: a VALID dispatch; the client returns the auth_proof it sealed (N1). ---
        let (rt1, _ws1) = mock_runtime("replay-c1", OWNER);
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sess_c1 = client_session.clone();
        let c1 = thread::spawn(move || {
            let kp = DeviceKeypair::from_secret_bytes(client_secret);
            let (mut ws, _session, nonce) = client_handshake(addr, &kp);
            // Build the proof binding THIS handshake's nonce (N1) and capture it.
            let proof = auth_proof_bytes(&sess_c1, &nonce, OWNER, "run-replay");
            tx.send(proof.clone()).unwrap();
            let req = Envelope::new(
                "req-c1",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-replay".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: proof,
                    session_id: None,
                    constraints: None,
                    mission_context: None,
                },
            );
            ws_send_envelope(&mut ws, &sess_c1, &req, SESSION_AAD).unwrap();
            // Drain the (accepted) reply so the server completes conn-1 cleanly.
            let _ = ws_recv_envelope(&mut ws, &sess_c1, SESSION_AAD);
        });
        let processed1 = listener
            .accept_one(
                &server_kp,
                &rt1,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed1, 1, "connection-1 is a VALID dispatch");
        let captured_proof = rx.recv().unwrap();
        c1.join().unwrap();

        // --- Connection 2: REPLAY the captured (N1) proof on a fresh handshake (N2). ----------
        let (rt2, _ws2) = mock_runtime("replay-c2", OWNER);
        let sess_c2 = client_session.clone();
        let c2 = thread::spawn(move || {
            let kp = DeviceKeypair::from_secret_bytes(client_secret);
            let (mut ws, _session, _n2) = client_handshake(addr, &kp);
            // The attacker re-seals the ENVELOPE under the (real, fresh) conn-2 session so it
            // OPENS, but stuffs the STALE captured auth_proof (bound to N1) inside.
            let req = Envelope::new(
                "req-c2",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-replay".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: captured_proof,
                    session_id: None,
                    constraints: None,
                    mission_context: None,
                },
            );
            ws_send_envelope(&mut ws, &sess_c2, &req, SESSION_AAD).unwrap();
            // The server must fail closed (END the session) — no reply.
            ws_recv_envelope(&mut ws, &sess_c2, SESSION_AAD)
                .ok()
                .map(|e| e.message)
        });
        let processed2 = listener
            .accept_one(
                &server_kp,
                &rt2,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed2, 0,
            "a captured auth_proof REPLAYED on a fresh handshake must be REJECTED (no dispatch)"
        );
        let reply2 = c2.join().unwrap();
        assert!(
            reply2.is_none(),
            "the replayed dispatch must end the session with NO reply (no run, no body)"
        );
    }

    // (S-E d) WITHIN-SESSION msg_id REPLAY rejected: a SECOND envelope with the SAME msg_id on one
    // session is rejected fail-closed (the per-session IdempotencyTracker). We send two benign
    // keepalives with the same msg_id; the first is echoed, the second ends the session.
    #[test]
    fn replayed_msg_id_within_a_session_is_rejected() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let (rt, _ws) = mock_runtime("dedup", OWNER);
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake clears the peer gate and the test
        // exercises the msg_id DEDUP (S-E within-session replay), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = thread::spawn(move || {
            let (mut ws, session, _nonce) = client_handshake(addr, &client_kp);
            // A benign keepalive (NOT an AgentRunRequest) — the dedup is checked BEFORE the branch.
            let keepalive = |id: &str| {
                Envelope::new(
                    id,
                    1000,
                    Message::AskFridayStream {
                        seq: 0,
                        chunk: "ping".into(),
                    },
                )
            };
            // First send with msg_id "dup-1": echoed back.
            ws_send_envelope(&mut ws, &session, &keepalive("dup-1"), SESSION_AAD).unwrap();
            let first = ws_recv_envelope(&mut ws, &session, SESSION_AAD).ok();
            // Second send with the SAME msg_id "dup-1": the server must END the session (no echo).
            ws_send_envelope(&mut ws, &session, &keepalive("dup-1"), SESSION_AAD).unwrap();
            let second = ws_recv_envelope(&mut ws, &session, SESSION_AAD).ok();
            (first.is_some(), second.is_some())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        // The first keepalive was processed (echoed); the replayed msg_id ended the session.
        assert_eq!(
            processed, 1,
            "exactly ONE envelope processed: the replayed msg_id is rejected, not processed"
        );
        let (first_echoed, second_echoed) = client.join().unwrap();
        assert!(first_echoed, "the first (fresh) msg_id is echoed");
        assert!(
            !second_echoed,
            "a replayed msg_id within the session must END the session (no echo)"
        );
    }

    // ======================= S-F peer authentication (forgery defeat) =======================

    /// What a peer observed during the cleartext preamble — used by the forgery tests to assert a
    /// NON-allowlisted peer learns NOTHING (no server pubkey, no nonce).
    struct PreambleObservations {
        /// The server's pubkey frame, if the server sent it (it does NOT on a peer-gate rejection).
        server_pub: Option<Vec<u8>>,
        /// The server's per-handshake nonce frame, if sent (never, on a peer-gate rejection).
        nonce: Option<Vec<u8>>,
    }

    /// Drive ONLY the cleartext preamble from the client side: send `client_pub`, then TRY to read
    /// the server pubkey + nonce. A peer-gate rejection ends the connection BEFORE the server writes
    /// either, so both reads fail (None). This is how we prove "the peer learns nothing".
    fn try_preamble(addr: SocketAddr, client_pub: [u8; 32]) -> PreambleObservations {
        let mut stream = TcpStream::connect(addr).unwrap();
        let _ = write_frame(&mut stream, &client_pub);
        let server_pub = read_frame(&mut stream).ok();
        let nonce = if server_pub.is_some() {
            read_frame(&mut stream).ok()
        } else {
            None
        };
        PreambleObservations { server_pub, nonce }
    }

    // (S-F a) HEADLINE — FORGERY DEFEATED: a FRESH local keypair that is NOT in the SecureStore
    // allowlist cannot establish a session. The server REJECTS at the peer gate (accept_one ⇒ Err)
    // BEFORE sending its own pubkey or nonce — so the attacker cannot even begin the handshake it
    // would need to forge an `auth_proof` for an allowlisted owner string. This is the gap S-E
    // explicitly deferred; S-F closes it. (Distinct from the principal-layer reject tests: a
    // DIFFERENT, EARLIER gate and a DIFFERENT allowlist — the peer pubkey, not the owner string.)
    #[test]
    fn non_allowlisted_peer_pubkey_gets_no_session_forgery_defeated() {
        let (rt, _ws) = mock_runtime("sf-forge", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];

        // The allowlist authorizes a DIFFERENT peer (a known fixture pubkey). The attacker uses a
        // FRESH keypair that is NOT in it — exactly the forgery S-E left open.
        let authorized_peer = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let peer_allowlist = allowlist_of(authorized_peer);
        let attacker_kp = DeviceKeypair::generate();
        let attacker_pub = attacker_kp.public_bytes();
        assert_ne!(
            attacker_pub, authorized_peer,
            "the attacker's fresh key must NOT be the allowlisted peer"
        );

        let client = thread::spawn(move || try_preamble(addr, attacker_pub));
        // The server runs the REAL accept path; a non-allowlisted peer must make it FAIL CLOSED.
        let outcome = listener.accept_one(
            &server_kp,
            &rt,
            &owner_allowlist,
            &peer_allowlist,
            false,
            false,
            false,
            false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
            false, // memory-confirm ingress OFF — byte-identical to today
            false, // run-outcome-learning confirm OFF — byte-identical to today
            false, // (Loop4) per-run token surface OFF — byte-identical to today
            false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
        );
        let obs = client.join().unwrap();

        assert!(
            outcome.is_err(),
            "a non-allowlisted peer pubkey must get NO session (fail closed — forgery defeated)"
        );
        // The peer learned NOTHING: the server sent neither its pubkey nor a nonce. Without the
        // server pubkey the attacker cannot derive the session key, and without the nonce it cannot
        // build the (nonce-bound) auth_proof — so an `auth_proof` for an allowlisted owner string
        // can never be forged on this connection.
        assert!(
            obs.server_pub.is_none(),
            "a rejected peer must NOT receive the server pubkey"
        );
        assert!(
            obs.nonce.is_none(),
            "a rejected peer must NOT receive the per-handshake nonce"
        );
    }

    // (S-F b) POSITIVE SecureStore read path + happy dispatch: provision a temp InMemorySecureStore
    // with the authorized peer pubkey, LOAD it via `load_peer_allowlist` (the real read path), and
    // run a full authed dispatch through `accept_one`. Proves the SecureStore-derived allowlist
    // path works POSITIVELY (not only the missing/invalid fail-closed cases) and that an ALLOWLISTED
    // peer establishes a session and runs.
    #[test]
    fn securestore_provisioned_allowlisted_peer_runs() {
        let (rt, _ws) = mock_runtime("sf-store-ok", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];

        // Provision the SecureStore with the authorized peer pubkey (raw 32 bytes), then load it
        // through the REAL read path — exactly what `run()` does at boot.
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let client_pub = client_kp.public_bytes();
        let mut store = InMemorySecureStore::new();
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &client_pub);
        let peer_allowlist =
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID).expect("provisioned allowlist");
        assert_eq!(peer_allowlist.len(), 1, "one provisioned peer pubkey");

        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-sf", "run-sf-ok", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(
            processed, 1,
            "a SecureStore-allowlisted peer establishes a session and runs"
        );
        let obs = client.join().unwrap();
        assert!(
            matches!(obs.result, Some(Message::AgentRunResult { .. })),
            "the allowlisted peer got a refs result"
        );
    }

    // (S-F c) FAIL CLOSED on a MISSING SecureStore entry: an empty store has no allowlist ⇒ the
    // load returns Missing (the boot would refuse to start). It never falls open to an empty/open
    // allowlist.
    #[test]
    fn missing_securestore_allowlist_fails_closed() {
        let store = InMemorySecureStore::new(); // empty store — an UNPROVISIONED allowlist
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Missing),
            "a MISSING SecureStore allowlist must fail closed (no open fallthrough)"
        );
    }

    // (S-F c') FAIL CLOSED on an INVALID SecureStore entry: empty bytes, and a length that is not a
    // nonzero multiple of 32, are both Invalid. A valid nonzero-multiple length parses to N keys.
    #[test]
    fn invalid_securestore_allowlist_fails_closed_valid_parses() {
        let mut store = InMemorySecureStore::new();

        // Empty value ⇒ Invalid.
        store.put(PEER_PUBKEY_ALLOWLIST_ID, b"");
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "an EMPTY allowlist value must fail closed"
        );

        // Not a multiple of 32 (31 bytes) ⇒ Invalid.
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &[0xABu8; 31]);
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "a non-32-multiple allowlist value must fail closed"
        );

        // A trailing partial key (33 bytes) ⇒ Invalid (no silent truncation).
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &[0xCDu8; 33]);
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "a partial trailing key must fail closed (no truncation)"
        );

        // Two concatenated 32-byte keys ⇒ parses to exactly two.
        let a = DeviceKeypair::generate().public_bytes();
        let b = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let mut two = Vec::new();
        two.extend_from_slice(&a);
        two.extend_from_slice(&b);
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &two);
        let loaded = load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("two-key allowlist parses");
        assert_eq!(loaded, vec![a, b], "two concatenated keys parse in order");
    }

    // (FIX-Q3a) SINGLE-PEER is a SERVER INVARIANT, not just a CLI convention. The loader still
    // PARSES N keys (see `invalid_securestore_allowlist_fails_closed_valid_parses`, which keeps the
    // parser forward-compatible for when the multi-principal bindings FIX-Q2/FIX-Q3b land), but the
    // boot-time `enforce_single_peer` guard REFUSES anything other than exactly one. This closes the
    // latent confidentiality chain (a 2nd enrolled pubkey + the client-asserted owner string) until
    // a real pubkey↔principal binding exists. DARK w.r.t. the running bin (live store = 1 entry).
    #[test]
    fn enforce_single_peer_fails_closed_above_one() {
        // (a) Exactly one peer ⇒ Ok — the single-peer happy path is UNCHANGED.
        let a = DeviceKeypair::generate().public_bytes();
        assert_eq!(
            enforce_single_peer(&[a]),
            Ok(()),
            "exactly one enrolled peer is admitted (single-peer happy path unchanged)"
        );

        // (b) The loader PARSES a 64-byte (two-key) store to two keys, but the guard then REFUSES
        //     it: prove via the REAL read path that a 2-pubkey store fails the boot closed.
        let b = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let mut store = InMemorySecureStore::new();
        let mut two = Vec::new();
        two.extend_from_slice(&a);
        two.extend_from_slice(&b);
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &two);
        let parsed = load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("the loader still parses a two-key allowlist (parser unchanged)");
        assert_eq!(parsed.len(), 2, "loader parses both keys");
        assert_eq!(
            enforce_single_peer(&parsed),
            Err(PeerAllowlistError::MultiPeer),
            "a TWO-pubkey allowlist must fail the boot closed (FIX-Q3a server invariant)"
        );

        // (c) Defensive: an (impossible-via-parser) EMPTY list is also refused fail-closed, not Ok.
        assert_eq!(
            enforce_single_peer(&[]),
            Err(PeerAllowlistError::MultiPeer),
            "a zero-peer list must also fail closed (!= 1, never falls open)"
        );

        // (d) Three peers ⇒ refused too (any N>1).
        let c = DeviceKeypair::generate().public_bytes();
        assert_eq!(
            enforce_single_peer(&[a, b, c]),
            Err(PeerAllowlistError::MultiPeer),
            "three pubkeys are refused (any N>1 fails closed)"
        );
    }

    // (S-F d) peer_is_allowlisted exact-match semantics: only an exact 32-byte match passes; a
    // fresh (non-listed) key and a one-bit-flipped near-miss both fail.
    #[test]
    fn peer_is_allowlisted_is_exact_match() {
        let a = DeviceKeypair::generate().public_bytes();
        let b = DeviceKeypair::generate().public_bytes();
        let list = vec![a];
        assert!(peer_is_allowlisted(&list, &a), "the listed key matches");
        assert!(
            !peer_is_allowlisted(&list, &b),
            "a fresh, non-listed key does NOT match"
        );
        let mut near = a;
        near[0] ^= 0x01; // flip one bit
        assert!(
            !peer_is_allowlisted(&list, &near),
            "a one-bit near-miss must NOT match (exact equality)"
        );
        assert!(
            !peer_is_allowlisted(&[], &a),
            "an EMPTY allowlist matches nothing (fail closed)"
        );
    }

    /// A unique temp dir per test (no `tempfile` dep — the workspace minimal-dep convention,
    /// mirroring `key_source`'s test helper). Removed on drop.
    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-execrun-s3-server-test-{tag}-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // (S-F e) THE TRUE END-TO-END ENROLL→PERSIST→SERVER-LOAD→ACCEPT PROOF (slice 3, deferred from
    // slice 2). This exercises the FULL chain that, at cutover, lets the live client's derived
    // pubkey pass the S-F peer gate:
    //
    //   master key  --key_source::derive_file_store_kek-->  FileSecureStore KEK
    //   master key  --key_source::derive_client_x25519_pubkey-->  enrolled pubkey
    //   enroll CLI:  FileSecureStore::open(dir, KEK).try_put(ALLOWLIST_ID, &pubkey)   [persist]
    //   server boot: FileSecureStore::open(dir, KEK) -> load_peer_allowlist(ALLOWLIST_ID)  [load]
    //   server gate: peer_is_allowlisted(&allowlist, &pubkey) == true                  [accept]
    //
    // It derives directly from a FIXED master (NO process-env mutation), persists exactly as
    // `hub_agent_run_enroll` does (`try_put`), then RE-OPENS the store and runs the server's OWN
    // private loader + gate. Mirroring the slice-2 KAT master (all 0x42) makes the round-tripped
    // pubkey the known parity value `1d4a03c1…98de56`, tying this proof to the cross-language KAT.
    #[test]
    fn enroll_to_server_load_accept_end_to_end() {
        // The slice-2 cross-language KAT master + its expected derived pubkey hex.
        let master = [0x42u8; friday_hub::key_source::MASTER_KEY_LEN];
        const KAT_PUBKEY_HEX: &str =
            "1d4a03c1c3af1a4639b616951c9b0e1cd1c957c9b0f25fe7a99b85101598de56"; // pragma: allowlist secret

        // Derive directly (no env). The KEK opens the store; the pubkey is what the enroll CLI
        // writes and the live handshake produces.
        let pubkey = friday_hub::key_source::derive_client_x25519_pubkey(&master);
        assert_eq!(
            hex_encode(&pubkey),
            KAT_PUBKEY_HEX,
            "the round-tripped pubkey must be the slice-2 cross-language KAT value (ties this \
             proof to the parity contract)"
        );

        let td = TempDir::new("e2e");
        let store_dir = td.child("agent-run-securestore");

        // ENROLL: open the store under the derived KEK and persist the pubkey under the SHARED
        // allowlist id — byte-for-byte what `hub_agent_run_enroll` does (`try_put`).
        {
            let kek = friday_hub::key_source::derive_file_store_kek(&master);
            let mut store = FileSecureStore::open(&store_dir, kek).expect("enroll: open store");
            store
                .try_put(PEER_PUBKEY_ALLOWLIST_ID, &pubkey)
                .expect("enroll: persist pubkey");
        }

        // SERVER BOOT: RE-OPEN the store under a FRESHLY re-derived KEK (Kek is consumed by `open`;
        // re-derive per the `key_source::kek_is_deterministic_for_a_master` pattern), then run the
        // server's OWN private loader — exactly the `run()` boot path (minus the listener).
        let server_store = {
            let kek = friday_hub::key_source::derive_file_store_kek(&master);
            FileSecureStore::open(&store_dir, kek).expect("server: open store")
        };
        let allowlist = load_peer_allowlist(&server_store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("server: the enroll-persisted allowlist must load (Ok)");
        assert_eq!(
            allowlist.len(),
            1,
            "exactly one enrolled peer pubkey round-trips"
        );

        // ACCEPT: the server's S-F gate admits the enrolled pubkey.
        assert!(
            peer_is_allowlisted(&allowlist, &pubkey),
            "the enroll→persist→load chain must produce an allowlist that ACCEPTS the derived \
             pubkey (the cutover accept path)"
        );

        // NEGATIVE: a DIFFERENT master derives a DIFFERENT pubkey that is NOT in this allowlist —
        // the gate fails closed against a non-enrolled peer (no fall-open).
        let other_master = [0x37u8; friday_hub::key_source::MASTER_KEY_LEN];
        let other_pubkey = friday_hub::key_source::derive_client_x25519_pubkey(&other_master);
        assert_ne!(
            pubkey, other_pubkey,
            "different masters → different pubkeys"
        );
        assert!(
            !peer_is_allowlisted(&allowlist, &other_pubkey),
            "a DIFFERENT master's pubkey must NOT be allowlisted (fail closed)"
        );
    }

    // === B1 interop scaffolding (additive, #[ignore], reuses establish_session/serve_sealed_session
    // via accept_one UNCHANGED; coordinator-applied to discharge the TS<->Rust wire proof bar) ======

    /// A "PONG"-answering mock runtime (additive test scaffolding — reuses `FinishTransport` /
    /// `HubRuntime::new` UNCHANGED, just a different deterministic answer than `BODY`).
    fn pong_runtime(
        tag: &str,
        principal: &str,
        answer: &str,
    ) -> (HubRuntime<FinishTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let persist_db_path = std::env::var("FRIDAY_INTEROP_PERSIST_DB_PATH").ok();
        let client = DeepSeekClient::with_transport(
            FinishTransport {
                answer: answer.to_string(),
            },
            "k".into(), // pragma: allowlist secret
        );
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: interop_db_path(tag, persist_db_path.as_deref())
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-interop-test-secret-0123456789ab".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    fn interop_db_path(tag: &str, persist_db_path: Option<&str>) -> std::path::PathBuf {
        if let Some(path) = persist_db_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            return std::path::PathBuf::from(path);
        }
        std::env::temp_dir().join(format!(
            "friday-execrun-interop-{}-{}-{}.sqlite",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// The fixed TS-client X25519 secret scalar (same fixture as `CLIENT_SECRET` above): the TS
    /// subprocess reconstructs the SAME keypair from this hex, so the test can derive its pubkey to
    /// enroll in the peer-allowlist. NON-secret test material.
    fn ts_client_secret_hex() -> String {
        CLIENT_SECRET.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The TS-client pubkey for `CLIENT_SECRET`, derived via the SAME `DeviceKeypair` the server
    /// uses — so enrolling it in the peer-allowlist is faithful.
    fn ts_client_pubkey() -> [u8; 32] {
        DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes()
    }

    /// Absolute path to the worktree root (3 levels up from `friday-hub`'s manifest dir).
    fn worktree_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("worktree root is 3 levels above friday-hub")
            .to_path_buf()
    }

    /// Spawn the TS sealed-client SUBPROCESS (the esbuild-bundled real client) targeting `port`,
    /// with `secret_hex` / `principal`. Returns the child so the caller can `wait_with_output`.
    /// Requires the bundle to be built (see the opt-in command above) and `node` on PATH.
    fn spawn_ts_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--task=ping")
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS client subprocess")
    }

    /// Spawn the TS sealed-client runner in agent-route start-run mode: the subprocess creates the
    /// real TS API runtime, calls the real `agent.runs.start` route, and lets the routeStartRun
    /// compose path drive the real sealed-client service plus owner-gated Rust answer readback.
    fn spawn_ts_agent_route_start_run_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        run_id: &str,
        hub_db_path: &str,
    ) -> std::process::Child {
        let root = worktree_root();
        let bundle = root.join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg("--mode=agent-route-start-run")
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--task=ping")
            .arg(format!("--hub-db-path={hub_db_path}"))
            .arg(format!("--repo-root={}", root.to_string_lossy()))
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS agent-route start-run subprocess")
    }

    /// Spawn the TS sealed-client runner in auto-dispatch mode: the subprocess first calls the real
    /// `intakeMission`, then invokes the real `createFridayMissionAutoDispatchDriver`, whose
    /// `startRun` thunk calls the real sealed client's `dispatchRun` with the emitted
    /// missionContext. The Rust side serves two loopback sealed sessions.
    fn spawn_ts_auto_dispatch_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg("--mode=auto-dispatch")
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS auto-dispatch subprocess")
    }

    /// Spawn the TS sealed-client runner in mission-route auto-dispatch mode: the subprocess calls
    /// the REAL `createFridayMissionSpineRoutes` POST handler, which delegates to the REAL dispatch
    /// adapter + REAL sealed client and then fires the REAL auto-dispatch driver into a second
    /// sealed `dispatchRun` carrying missionContext. This is the operator-surface-shaped proof for
    /// the same two Rust loopback sessions.
    fn spawn_ts_mission_route_auto_dispatch_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg("--mode=mission-route-auto-dispatch")
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS mission-route auto-dispatch subprocess")
    }

    /// Spawn the TS sealed-client runner in memory-route decision mode: the subprocess calls the
    /// REAL `createFridayMemorySpineRoutes` POST handler, which delegates to the REAL memory-spine
    /// dispatch adapter + REAL sealed client. The Rust side serves one loopback sealed session with
    /// the memory-confirm arm enabled.
    fn spawn_ts_memory_route_decision_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        memory_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg("--mode=memory-route-decision")
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--memory-id={memory_id}"))
            .arg("--decision=confirm")
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS memory-route decision subprocess")
    }

    /// Spawn the TS sealed-client runner in mission-route lifecycle/workitem mode: the subprocess
    /// calls the REAL mission-spine POST handlers, which delegate to the REAL dispatch adapter +
    /// REAL sealed client. The Rust side serves two loopback sealed sessions with the mission-spine
    /// dispatch arm enabled.
    fn spawn_ts_mission_route_lifecycle_workitem_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        mission_id: &str,
        work_item_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg("--mode=mission-route-lifecycle-workitem")
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--mission-id={mission_id}"))
            .arg(format!("--work-item-id={work_item_id}"))
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS mission-route lifecycle/workitem subprocess")
    }

    /// Read the ONE JSON line the runner prints on stdout.
    fn read_client_json(mut child: std::process::Child) -> serde_json::Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if child
                .try_wait()
                .expect("poll TS client subprocess")
                .is_some()
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let out = child
                    .wait_with_output()
                    .expect("await killed TS client subprocess");
                panic!(
                    "TS client did not exit before timeout. stdout={:?} stderr={:?}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            thread::sleep(Duration::from_millis(25));
        }
        let out = child
            .wait_with_output()
            .expect("await TS client subprocess");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout
            .lines()
            .find(|l| l.trim_start().starts_with('{'))
            .unwrap_or_else(|| {
                panic!(
                    "TS client produced no JSON line. stdout={:?} stderr={:?}",
                    stdout,
                    String::from_utf8_lossy(&out.stderr)
                )
            });
        serde_json::from_str(line).expect("client JSON parses")
    }

    // (1) FULL ROUND-TRIP: the real TS sealed client ↔ the real server. The allowlisted client +
    // allowlisted principal ⇒ the loop runs and a REFS-ONLY result is returned. (leg-A decouple,
    // #655 Part 4) The TS client now SETTLES on the refs envelope ALONE — it no longer awaits or
    // surfaces the owner-sealed body frame (compose sources the body from the owner-gated DB
    // readback). So we assert the REFS the client surfaces (status/sha256/len from the FIRST
    // envelope); proving TS-seal → Rust-open (auth_proof accepted) + refs settle over the REAL
    // protocol. The server STILL persists the body to the DB + STILL emits the body frame after
    // the refs frame. For a SMALL body (this "PONG") `accept_one` returns Ok(1): the post-refs
    // body send lands in the loopback send buffer before the client's teardown RST is processed.
    // NOTE (characterized, flagged to the operator — NOT fixed here, server-logic is out of
    // leg-A scope): for a LARGE answer (empirically ~256KB) the body write is still pending when
    // the client's RST arrives, so `ws_send_envelope(body)` returns Err → `serve_sealed_session`
    // returns Err → `accept_one` is Err and logs `leg=body_send error=transport_closed`. This is
    // a benign log (the answer is committed in the DB and the client already settled on refs), but
    // it fires on otherwise-healthy large-answer runs. Making the body send non-fatal is a
    // follow-up server change.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_full_round_trip_pong() {
        const ANSWER: &str = "PONG";
        let (rt, _ws) = pong_runtime("interop-ok", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll the TS client's pubkey (derived from the fixed secret the subprocess uses).
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let child = spawn_ts_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            "run-interop-ok",
        );
        // SERVER serves on the main thread (non-Send runtime); the TS client drives the socket.
        // (leg-A decouple) The dispatch still processes ONE authed run even though the client
        // settles on refs and tears down before draining the body frame — for this SMALL body the
        // body send lands in the loopback send buffer, so `serve_sealed_session` returns Ok (no
        // error settle). (Large bodies can Err on the body send; see the NOTE on the test above.)
        let processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .expect("server serves the interop session");
        assert_eq!(processed, 1, "one authed dispatch processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS client reports success: {v:?}"
        );
        // (leg-A decouple) The client no longer surfaces a body — it settles on the refs alone.
        assert!(
            v.get("body").is_none(),
            "leg-A decouple: the client surfaces NO body (refs-only settle): {v:?}"
        );
        assert_eq!(v["runId"], serde_json::json!("run-interop-ok"));
        // The refs fingerprint is surfaced from the FIRST (refs) envelope — sha256/len of the answer
        // the server persisted (and which the owner-gated DB readback will return to compose).
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes())),
            "TS surfaced the refs sha256"
        );
        assert_eq!(
            v["answerLen"],
            serde_json::json!(ANSWER.len()),
            "TS surfaced the refs len"
        );
    }

    // (1a) HTTP START-RUN ROUTE ON-RAMP: real TS API runtime -> real `agent.runs.start` route ->
    // routeStartRun compose -> real sealed-client service -> real Rust AgentRunRequest -> real
    // owner-gated Rust answer readback. This is still manual/ignored loopback proof, not organic
    // operator traffic and not a non-ignored PR-CI e2e.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_agent_start_route_drives_real_rust_run_and_readback() {
        const ANSWER: &str = "PONG";
        const RUN_ID: &str = "run-interop-agent-route";

        let (rt, _ws) = pong_runtime("interop-agent-route-start", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let child = spawn_ts_agent_route_start_run_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            RUN_ID,
            rt.db().path(),
        );

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                true,  // run-control ON so the route's read-only constraints are enforced
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS agent start-route session");
        assert_eq!(processed, 1, "one route-triggered agent run processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS agent start-route runner reports success: {v:?}"
        );
        assert_eq!(v["mode"], serde_json::json!("agent-route-start-run"));
        assert_eq!(v["runId"], serde_json::json!(RUN_ID));
        assert_eq!(v["status"], serde_json::json!("completed"));
        assert_eq!(v["responseLen"], serde_json::json!(ANSWER.len()));
        assert_eq!(v["finalResponseLen"], serde_json::json!(ANSWER.len()));

        match friday_storage::get_run_answer_for_principal(rt.db().conn(), RUN_ID, OWNER)
            .expect("owner-gated readback query succeeds")
        {
            friday_storage::RunAnswerAccess::Granted(stored) => {
                assert_eq!(stored.answer, ANSWER, "Rust DB stores the delivered answer");
            }
            other => panic!("owner must read the route-triggered Rust answer, got {other:?}"),
        }
    }

    // (1b) AUTO-DISPATCH FULL ROUND-TRIP: real TS sealed client -> real MissionIntakeRequest ->
    // real TS auto-dispatch driver -> real sealed AgentRunRequest with missionContext -> real Rust
    // mission-bound seam. This remains manual/ignored (Node bundle + subprocess), but closes the
    // split proof at the destination interop layer without claiming organic operator traffic.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_auto_dispatch_driver_intake_to_mission_bound_run() {
        const ANSWER: &str = "PONG";
        const RUN_ID: &str = "run-interop-auto";
        const FCONV_ID: &str = "fconv_interop_auto";
        const MISSION_ID: &str = "mission-interop-auto";
        const WORK_ITEM_ID: &str = "work-interop-auto";

        let (rt, _ws) = pong_runtime("interop-auto-dispatch", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let mut child =
            spawn_ts_auto_dispatch_client(addr.port(), &ts_client_secret_hex(), OWNER, RUN_ID);

        let intake_processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                true,  // mission-intake ingress ON
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS intake session");
        assert_eq!(intake_processed, 1, "one intake request processed");
        eprintln!("interop_auto_dispatch: intake session processed");
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(status) = child.try_wait().expect("poll TS auto-dispatch subprocess") {
            let v = read_client_json(child);
            panic!(
                "TS auto-dispatch subprocess exited before opening the run session: status={status:?} json={v:?}"
            );
        }
        eprintln!("interop_auto_dispatch: TS subprocess still running; awaiting bound run session");

        let run_processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                true,  // run-control ON so the driver's read-only constraints are applied
                true,  // mission-bound run ON
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS auto-dispatched run session");
        assert_eq!(run_processed, 1, "one bound run processed");
        eprintln!("interop_auto_dispatch: bound run session processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS auto-dispatch runner reports success: {v:?}"
        );
        assert_eq!(v["mode"], serde_json::json!("auto-dispatch"));
        assert_eq!(v["intakeStatus"], serde_json::json!("ready"));
        assert_eq!(v["intakeCreatedOrReady"], serde_json::json!(true));
        assert_eq!(v["runStatus"], serde_json::json!("finished"));
        assert_eq!(v["runId"], serde_json::json!(RUN_ID));
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes()))
        );
        assert_eq!(v["answerLen"], serde_json::json!(ANSWER.len()));
        assert_eq!(
            v["missionContext"],
            serde_json::json!({
                "fridayConversationId": FCONV_ID,
                "missionId": MISSION_ID,
                "workItemId": WORK_ITEM_ID,
            }),
            "driver must bind to the server-produced MissionIntakeResult handle"
        );
        assert_eq!(
            v["allowedRustRouteTools"],
            serde_json::json!(["read_file", "list_dir", "stat_file", "search"]),
            "driver must dispatch the exact Rust read-tool grant"
        );
        assert_eq!(v["constraints"], serde_json::json!({ "readOnly": true }));

        let work = rt
            .db()
            .get_work_item(WORK_ITEM_ID)
            .unwrap()
            .expect("auto-dispatched run keeps the intake WorkItem");
        assert_eq!(work.status, friday_core::WorkItemStatus::CompletedWithProof);
        assert!(work
            .proof_receipts
            .contains(&format!("friday://agent-run/{RUN_ID}")));

        let links = rt.db().list_mission_links(MISSION_ID).unwrap();
        assert!(
            links.iter().any(|link| link.target_ref
                == format!("friday://provider-timeline/{FCONV_ID}#{RUN_ID}")
                && link.work_item_id.as_deref() == Some(WORK_ITEM_ID)),
            "MissionLink must bind the TS auto-dispatched run: {links:?}"
        );

        let route = rt
            .db()
            .get_route_decision(&format!("route-decision:agent-loop:{RUN_ID}"))
            .unwrap()
            .expect("auto-dispatched mission-bound run writes route_decision");
        assert_eq!(route.mission_id, MISSION_ID);
        assert_eq!(route.work_item_id, WORK_ITEM_ID);
        assert_eq!(route.selected_lane, friday_core::WorkLane::DeepSeek);
    }

    // (1c) OPERATOR-SURFACE-SHAPED FULL ROUND-TRIP: real TS mission-spine POST route handler ->
    // real dispatch adapter -> real sealed MissionIntakeRequest -> real auto-dispatch driver ->
    // real sealed AgentRunRequest with missionContext -> real Rust mission-bound seam. This is
    // still manual/ignored (Node bundle + subprocess), not organic dogfood traffic, but closes the
    // split proof at the HTTP route surface rather than calling the driver directly.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_mission_route_auto_dispatch_to_mission_bound_run() {
        const ANSWER: &str = "PONG";
        const RUN_ID: &str = "run-interop-route-auto";
        const FCONV_ID: &str = "fconv_interop_route_auto";
        const MISSION_ID: &str = "mission-interop-route-auto";
        const WORK_ITEM_ID: &str = "work-interop-route-auto";

        let (rt, _ws) = pong_runtime("interop-route-auto-dispatch", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let mut child = spawn_ts_mission_route_auto_dispatch_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            RUN_ID,
        );

        let intake_processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                true,  // mission-intake ingress ON
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS mission-route intake session");
        assert_eq!(intake_processed, 1, "one route intake request processed");
        eprintln!("interop_route_auto_dispatch: intake session processed");
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(status) = child
            .try_wait()
            .expect("poll TS mission-route auto-dispatch subprocess")
        {
            let v = read_client_json(child);
            panic!(
                "TS mission-route auto-dispatch subprocess exited before opening the run session: status={status:?} json={v:?}"
            );
        }
        eprintln!(
            "interop_route_auto_dispatch: TS subprocess still running; awaiting bound run session"
        );

        let run_processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                true,  // run-control ON so the driver's read-only constraints are applied
                true,  // mission-bound run ON
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS mission-route auto-dispatched run session");
        assert_eq!(run_processed, 1, "one route-triggered bound run processed");
        eprintln!("interop_route_auto_dispatch: bound run session processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS mission-route auto-dispatch runner reports success: {v:?}"
        );
        assert_eq!(v["mode"], serde_json::json!("mission-route-auto-dispatch"));
        assert_eq!(v["intakeStatus"], serde_json::json!("ready"));
        assert_eq!(v["intakeCreatedOrReady"], serde_json::json!(true));
        assert_eq!(v["runStatus"], serde_json::json!("finished"));
        assert_eq!(v["runId"], serde_json::json!(RUN_ID));
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes()))
        );
        assert_eq!(v["answerLen"], serde_json::json!(ANSWER.len()));
        assert_eq!(
            v["missionContext"],
            serde_json::json!({
                "fridayConversationId": FCONV_ID,
                "missionId": MISSION_ID,
                "workItemId": WORK_ITEM_ID,
            }),
            "route-triggered driver must bind to the server-produced MissionIntakeResult handle"
        );
        assert_eq!(
            v["allowedRustRouteTools"],
            serde_json::json!(["read_file", "list_dir", "stat_file", "search"]),
            "route-triggered driver must dispatch the exact Rust read-tool grant"
        );
        assert_eq!(v["constraints"], serde_json::json!({ "readOnly": true }));

        let work = rt
            .db()
            .get_work_item(WORK_ITEM_ID)
            .unwrap()
            .expect("route-triggered auto-dispatched run keeps the intake WorkItem");
        assert_eq!(work.status, friday_core::WorkItemStatus::CompletedWithProof);
        assert!(work
            .proof_receipts
            .contains(&format!("friday://agent-run/{RUN_ID}")));

        let links = rt.db().list_mission_links(MISSION_ID).unwrap();
        assert!(
            links.iter().any(|link| link.target_ref
                == format!("friday://provider-timeline/{FCONV_ID}#{RUN_ID}")
                && link.work_item_id.as_deref() == Some(WORK_ITEM_ID)),
            "MissionLink must bind the TS route-triggered auto-dispatched run: {links:?}"
        );

        let route = rt
            .db()
            .get_route_decision(&format!("route-decision:agent-loop:{RUN_ID}"))
            .unwrap()
            .expect("route-triggered auto-dispatched mission-bound run writes route_decision");
        assert_eq!(route.mission_id, MISSION_ID);
        assert_eq!(route.work_item_id, WORK_ITEM_ID);
        assert_eq!(route.selected_lane, friday_core::WorkLane::DeepSeek);
    }

    // (1d) OPERATOR-SURFACE-SHAPED MISSION-SPINE ROUTE ROUND-TRIP: real TS mission-spine POST
    // route handlers -> real dispatch adapter -> real sealed WorkItemStatusRequest +
    // MissionLifecycleRequest -> real Rust mission-spine dispatch arm -> DB transitions. This is
    // still manual/ignored (Node bundle + subprocess), not organic dogfood traffic.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_mission_route_lifecycle_and_workitem_hit_real_rust_spine() {
        const MISSION_ID: &str = "mission-ns5";
        const WORK_ITEM_ID: &str = "work-ns5";

        let (rt, _ws) = mock_runtime("interop-mission-route-spine", OWNER);
        seed_mission_and_work_item(&rt);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let mut child = spawn_ts_mission_route_lifecycle_workitem_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            MISSION_ID,
            WORK_ITEM_ID,
        );

        let work_item_processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                true,  // mission-spine dispatch ON
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS mission-route workitem session");
        assert_eq!(
            work_item_processed, 1,
            "one route-triggered workitem request processed"
        );
        std::thread::sleep(std::time::Duration::from_millis(250));
        if let Some(status) = child
            .try_wait()
            .expect("poll TS mission-route lifecycle/workitem subprocess")
        {
            let v = read_client_json(child);
            panic!(
                "TS mission-route subprocess exited before lifecycle session: status={status:?} json={v:?}"
            );
        }

        let lifecycle_processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                true,  // mission-spine dispatch ON
                false, // memory-confirm ingress OFF
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS mission-route lifecycle session");
        assert_eq!(
            lifecycle_processed, 1,
            "one route-triggered lifecycle request processed"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS mission-route lifecycle/workitem runner reports success: {v:?}"
        );
        assert_eq!(
            v["mode"],
            serde_json::json!("mission-route-lifecycle-workitem")
        );
        assert_eq!(v["workItem"]["workItemId"], serde_json::json!(WORK_ITEM_ID));
        assert_eq!(v["workItem"]["status"], serde_json::json!("dispatched"));
        assert_eq!(v["lifecycle"]["missionId"], serde_json::json!(MISSION_ID));
        assert_eq!(v["lifecycle"]["status"], serde_json::json!("paused"));

        let work = rt
            .db()
            .get_work_item(WORK_ITEM_ID)
            .unwrap()
            .expect("route-triggered work item still exists");
        assert_eq!(work.status, friday_core::WorkItemStatus::Dispatched);
        let mission = rt
            .db()
            .get_mission(MISSION_ID)
            .unwrap()
            .expect("route-triggered mission still exists");
        assert_eq!(mission.status, friday_core::MissionStatus::Paused);
        let ledger_rows: i64 = rt
            .db()
            .conn()
            .query_row("SELECT COUNT(*) FROM token_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            ledger_rows, 0,
            "route-triggered mission-spine lifecycle/status transitions do not spend tokens"
        );
    }

    // (1e) OPERATOR-SURFACE-SHAPED MEMORY CONFIRM ROUND-TRIP: real TS memory-spine POST route
    // handler -> real dispatch adapter -> real sealed MemoryDecisionRequest -> real Rust
    // memory-confirm arm -> real DB candidate transition to Confirmed/recallable. This is still
    // controlled loopback proof (Node bundle + subprocess), not organic operator traffic, but it is
    // PR-CI runnable via rust-core.yml and closes the split proof at the HTTP route surface for
    // Lane M without provider/model spend.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_memory_route_decision_confirms_real_rust_candidate() {
        const MEMORY_ID: &str = "mem-interop-route";

        let (rt, _ws) = mock_runtime("interop-memory-route", OWNER);
        seed_memory_candidate(&rt, MEMORY_ID);
        let ns = owner_composite_ns();
        assert!(
            friday_storage::memory::recall_confirmed(rt.db().conn(), &ns)
                .unwrap()
                .is_empty(),
            "pre-confirm candidate must not be recallable"
        );

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let child = spawn_ts_memory_route_decision_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            MEMORY_ID,
        );

        let processed = listener
            .accept_one_with_timeout(
                Duration::from_secs(10),
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false, // run-control OFF
                false, // mission-bound seam OFF
                false, // mission-intake ingress OFF
                false, // mission-spine dispatch OFF
                true,  // memory-confirm ingress ON
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // token surface OFF
                false, // provider-workspace dispatch OFF
            )
            .expect("server serves the TS memory-route decision session");
        assert_eq!(
            processed, 1,
            "one route-triggered memory decision processed"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS memory-route runner reports success: {v:?}"
        );
        assert_eq!(v["mode"], serde_json::json!("memory-route-decision"));
        assert_eq!(v["result"]["memoryId"], serde_json::json!(MEMORY_ID));
        assert_eq!(v["result"]["status"], serde_json::json!("confirmed"));
        assert_eq!(v["result"]["state"], serde_json::json!("confirmed"));
        assert_eq!(v["result"]["recallable"], serde_json::json!(true));

        let db = rt.db();
        assert_eq!(
            db.conn()
                .query_row(
                    "SELECT state FROM memory_item WHERE memory_id = 'mem-interop-route'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "confirmed"
        );
        let recalled = friday_storage::memory::recall_confirmed(db.conn(), &ns).unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].memory_id, MEMORY_ID);
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "memory route confirmation is a pure DB decision, not a provider/model call"
        );
    }

    // (2) FAIL-CLOSED — FORGED PEER: a client pubkey NOT in the allowlist ⇒ the server establishes
    // NO session and sends NOTHING ⇒ the TS client must surface a 503-style fail-closed error (NOT a
    // hang, NOT success). Uses a DIFFERENT secret whose pubkey is not enrolled.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_forged_peer_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-forged", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // The allowlist contains a DIFFERENT (server-generated) pubkey — NOT the TS client's.
        let peer_allowlist = allowlist_of(DeviceKeypair::generate().public_bytes());

        // The TS client uses its fixed secret (whose pubkey is NOT enrolled) ⇒ rejected at preamble.
        let child = spawn_ts_client(addr.port(), &ts_client_secret_hex(), OWNER, "run-forged");
        // The server rejects the peer pubkey and returns an Err (no session established).
        let served = listener.accept_one(
            &server_kp,
            &rt,
            &owner_allowlist,
            &peer_allowlist,
            false,
            false,
            false,
            false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
            false, // memory-confirm ingress OFF — byte-identical to today
            false, // run-outcome-learning confirm OFF — byte-identical to today
            false, // (Loop4) per-run token surface OFF — byte-identical to today
            false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
        );
        assert!(
            served.is_err(),
            "a forged/non-allowlisted peer establishes NO session"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "forged peer ⇒ TS fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // (3) FAIL-CLOSED — BAD PRINCIPAL: a VALID handshake (allowlisted peer) but a forwarded principal
    // that is NOT in the owner allowlist ⇒ the server ends the session with no result ⇒ the TS client
    // fails closed (no body, no success).
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_bad_principal_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-badprincipal", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // The TS client's pubkey IS enrolled (handshake succeeds), so the rejection is attributable
        // to the PRINCIPAL gate, not the peer gate.
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        // Forward a NON-allowlisted principal — a well-formed handshake, but the owner gate rejects.
        let child = spawn_ts_client(
            addr.port(),
            &ts_client_secret_hex(),
            "principal:attacker-not-allowlisted",
            "run-badprincipal",
        );
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .expect("server serves the session but runs nothing");
        assert_eq!(
            processed, 0,
            "a non-allowlisted principal runs ZERO dispatches"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "bad principal ⇒ TS fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // === B1-compose interop scaffolding (additive, #[ignore]) — drives the REAL composition seam
    // (X25519 resolver -> service adapter -> real sealed client) the B1 client interop did NOT cover.

    /// The fixture master key the compose-adapter runner sees as FRIDAY_MASTER_KEY (64 hex). NON-secret
    /// test material — a fixed value so the Rust side can re-derive the SAME client pubkey to enroll.
    const COMPOSE_FIXTURE_MASTER_KEY: [u8; 32] = [0x42u8; 32]; // pragma: allowlist secret

    /// The TS resolver's domain-separation tag (mirrors
    /// `friday-rust-hub-agent-run-ws-client-x25519-secret.ts` `WS_X25519_SECRET_PURPOSE`). The Rust
    /// side re-derives the client secret the SAME way the TS resolver does — so a passing handshake
    /// LIVE-CHECKS that the resolver's derivation matches what 6b enrolls.
    const COMPOSE_X25519_PURPOSE: &[u8] = b"friday.rust.agent_run.ws.x25519_secret.v1";

    /// Re-derive the client X25519 pubkey the TS resolver produces for `master_key`:
    /// `secret = sha256(purpose ‖ master_key)` (streaming `update(purpose).update(key)` ==
    /// `digest(purpose ‖ key)`), `pubkey = DeviceKeypair::from_secret_bytes(secret).public_bytes()`.
    fn compose_derive_client_pubkey(master_key: &[u8; 32]) -> [u8; 32] {
        let mut input = COMPOSE_X25519_PURPOSE.to_vec();
        input.extend_from_slice(master_key);
        let secret: [u8; 32] = Sha256::digest(&input).into();
        DeviceKeypair::from_secret_bytes(secret).public_bytes()
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Spawn the compose-adapter runner SUBPROCESS (FRIDAY_MASTER_KEY in env → real resolver → real
    /// adapter → real sealed client). Requires the bundle built via
    /// `node test/interop/build-compose-adapter-runner.mjs` and `node` on PATH.
    fn spawn_compose_adapter_client(
        port: u16,
        master_key_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/compose-adapter-runner.cjs");
        assert!(
            bundle.exists(),
            "compose-adapter bundle missing at {bundle:?} — run `node test/interop/build-compose-adapter-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .env("FRIDAY_MASTER_KEY", master_key_hex)
            .arg(format!("--port={port}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--task=ping")
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node compose-adapter subprocess")
    }

    // (1) FULL COMPOSE-SEAM ROUND-TRIP: the REAL X25519 resolver (FRIDAY_MASTER_KEY fixture) → the REAL
    // service adapter (default createClient = real sealed client) → the REAL server. The Rust side
    // re-derives + enrolls the client pubkey, so a pass proves (a) the adapter's real construct+dispatch
    // path handshakes end-to-end and (b) the resolver's derivation matches the enrolled pubkey. Refs-only
    // (the adapter drops the in-band body; compose's body source is the proven slice-3 DB readback).
    #[test]
    #[ignore = "needs `node` + the prebuilt compose-adapter bundle; opt in with --ignored"]
    fn interop_compose_adapter_resolver_full_round_trip() {
        const ANSWER: &str = "PONG";
        let (rt, _ws) = pong_runtime("interop-compose-ok", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll the pubkey the TS resolver will derive from the fixture master key.
        let peer_allowlist =
            allowlist_of(compose_derive_client_pubkey(&COMPOSE_FIXTURE_MASTER_KEY));

        let child = spawn_compose_adapter_client(
            addr.port(),
            &hex_of(&COMPOSE_FIXTURE_MASTER_KEY),
            OWNER,
            "run-compose-ok",
        );
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &owner_allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .expect("server serves the compose-adapter session");
        assert_eq!(processed, 1, "one authed dispatch processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "compose adapter reports success: {v:?}"
        );
        assert_eq!(
            v["status"],
            serde_json::json!("finished"),
            "wire status is the literal 'finished'"
        );
        assert_eq!(v["runId"], serde_json::json!("run-compose-ok"));
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes())),
            "adapter surfaced the refs sha256"
        );
        assert_eq!(
            v["answerLen"],
            serde_json::json!(ANSWER.len()),
            "adapter surfaced the refs len"
        );
    }

    // (2) FAIL-CLOSED — the resolver-derived pubkey is NOT the one enrolled (forged): the server
    // establishes NO session ⇒ the adapter surfaces a 503 (NOT a hang, NOT success).
    #[test]
    #[ignore = "needs `node` + the prebuilt compose-adapter bundle; opt in with --ignored"]
    fn interop_compose_adapter_unenrolled_pubkey_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-compose-forged", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll a DIFFERENT pubkey (NOT the one the fixture master key derives).
        let peer_allowlist = allowlist_of(DeviceKeypair::generate().public_bytes());

        let child = spawn_compose_adapter_client(
            addr.port(),
            &hex_of(&COMPOSE_FIXTURE_MASTER_KEY),
            OWNER,
            "run-compose-forged",
        );
        let served = listener.accept_one(
            &server_kp,
            &rt,
            &owner_allowlist,
            &peer_allowlist,
            false,
            false,
            false,
            false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
            false, // memory-confirm ingress OFF — byte-identical to today
            false, // run-outcome-learning confirm OFF — byte-identical to today
            false, // (Loop4) per-run token surface OFF — byte-identical to today
            false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
        );
        assert!(
            served.is_err(),
            "an unenrolled derived pubkey establishes NO session"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "unenrolled pubkey ⇒ adapter fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // ────────────────────────────────────────────────────────────────────────────────────
    // (A2a Phase 1) SESSIONED read-only dispatch — the CONDITIONAL swap on `session_id`.
    // ────────────────────────────────────────────────────────────────────────────────────

    // OWNER-SCOPING: a sessioned request (non-empty `session_id`) routes through
    // `run_session_task` → `run_session_loop`. The session row is created OWNED by the
    // AUTHENTICATED forwarded principal (the `caller`), NOT the client-asserted `session_id`,
    // and the body is delivered owner-sealed to that owner EXACTLY like the sessionless path.
    #[test]
    fn sessioned_dispatch_creates_owner_scoped_session_and_delivers_body_to_owner() {
        let (rt, _ws) = mock_runtime("sess-owner", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        let client_session = client_kp.agree(&server_kp.public_bytes());
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            // CLIENT-ASSERTED session id — deliberately NOT the principal. The owner binding
            // must come from the authenticated `caller`, never this value.
            let req = sessioned_agent_run_request(
                "req-s1",
                "run-sess-1",
                OWNER,
                "chat-session-xyz",
                session,
                nonce,
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                false,
                false,
                false,
                false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                false, // memory-confirm ingress OFF — byte-identical to today
                false, // run-outcome-learning confirm OFF — byte-identical to today
                false, // (Loop4) per-run token surface OFF — byte-identical to today
                false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
            )
            .unwrap();
        assert_eq!(processed, 1, "one sessioned dispatch processed");

        let obs = client.join().unwrap();
        // The refs result + owner-sealed body are delivered EXACTLY as the sessionless path
        // (the two dispatch arms share the identical emit tail).
        let Some(Message::AgentRunResult {
            run_id,
            answer_sha256,
            answer_len,
            ..
        }) = obs.result.clone()
        else {
            panic!("expected AgentRunResult, got {:?}", obs.result);
        };
        assert_eq!(run_id, "run-sess-1");
        assert_eq!(
            answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(answer_len, Some(BODY.len() as u64));
        assert!(
            !format!("{:?}", obs.result).contains(BODY),
            "refs result leaked the body"
        );
        let chunk = obs
            .body_chunk
            .expect("owner-sealed body delivered for the sessioned run");
        let inner_bytes = hex_decode(&chunk).expect("body chunk is hex");
        let inner = decode_sealed_proof(&inner_bytes).expect("owner-sealed body decodes");
        let opened = friday_crypto::open(&client_session, &inner, SESSION_AAD).unwrap();
        assert_eq!(
            opened,
            BODY.as_bytes(),
            "owner opens the sealed sessioned body"
        );

        // OWNER-SCOPING (the load-bearing assertion): the session row was created OWNED by the
        // AUTHENTICATED principal (`OWNER`), NEVER the client-asserted `session_id`.
        let owner = friday_storage::load_session_owner(rt.db().conn(), "chat-session-xyz")
            .unwrap()
            .expect("the sessioned run created the session row");
        assert_eq!(
            owner.user_id.as_deref(),
            Some(OWNER),
            "the session owner MUST be the authenticated principal, never the client-asserted session_id"
        );
        assert_ne!(
            owner.user_id.as_deref(),
            Some("chat-session-xyz"),
            "the client-asserted session_id must NEVER become the owner"
        );

        // The run's turn was appended to THIS session (history is now persisted for the next turn).
        assert!(
            friday_storage::session_message_count(rt.db().conn(), "chat-session-xyz").unwrap() >= 1,
            "the sessioned run appended at least the user turn"
        );

        // BODY is releasable ONLY to the bound owner (a guessed/other principal is denied).
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        match friday_storage::get_run_answer_for_principal(rt.db().conn(), "run-sess-1", OWNER)
            .unwrap()
        {
            RunAnswerAccess::Granted(stored) => assert_eq!(stored.answer, BODY),
            other => panic!("owner must be Granted the sessioned body, got {other:?}"),
        }
        assert_eq!(
            friday_storage::get_run_answer_for_principal(
                rt.db().conn(),
                "run-sess-1",
                "principal:not-the-owner"
            )
            .unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch),
            "a non-owner (even one who guessed the session_id) must be DENIED the body"
        );
    }

    // SESSION THREADING: a SECOND turn on the SAME session id reloads + extends the SAME
    // session row — proving multi-turn history accumulates on one session (the Phase-1
    // capability). Two separate sealed connections (transport-stateless, DB-stateful).
    #[test]
    fn second_sessioned_turn_threads_into_the_same_session_history() {
        let (rt, _ws) = mock_runtime("sess-thread", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let sid = "chat-thread-1";

        // ── Turn 1 (fresh sealed connection) ──
        let kp1 = DeviceKeypair::generate();
        let peer1 = allowlist_of(kp1.public_bytes());
        let c1 = spawn_client(addr, kp1, move |s, n| {
            let req = sessioned_agent_run_request("req-t1", "run-t1", OWNER, "chat-thread-1", s, n);
            (req, s.clone(), s.clone())
        });
        assert_eq!(
            listener
                .accept_one(
                    &server_kp, &rt, &allowlist, &peer1, false, false, false, false, false, false,
                    false, false
                )
                .unwrap(),
            1
        );
        c1.join().unwrap();
        let after_turn1 = friday_storage::session_message_count(rt.db().conn(), sid).unwrap();
        assert!(after_turn1 >= 1, "turn 1 appended history");

        // ── Turn 2 (a SEPARATE sealed connection, SAME session id) ──
        let kp2 = DeviceKeypair::generate();
        let peer2 = allowlist_of(kp2.public_bytes());
        let c2 = spawn_client(addr, kp2, move |s, n| {
            let req = sessioned_agent_run_request("req-t2", "run-t2", OWNER, "chat-thread-1", s, n);
            (req, s.clone(), s.clone())
        });
        assert_eq!(
            listener
                .accept_one(
                    &server_kp, &rt, &allowlist, &peer2, false, false, false, false, false, false,
                    false, false
                )
                .unwrap(),
            1
        );
        c2.join().unwrap();

        // Turn 2 reloaded the SAME session and appended ON TOP of turn 1's history — the count
        // STRICTLY grew (it did not start a fresh session), and both runs' turns are present.
        let after_turn2 = friday_storage::session_message_count(rt.db().conn(), sid).unwrap();
        assert!(
            after_turn2 > after_turn1,
            "turn 2 must extend the SAME session history (got {after_turn1} → {after_turn2})"
        );
        let msgs = friday_storage::load_session_messages(rt.db().conn(), sid).unwrap();
        assert!(
            msgs.iter().any(|m| m.refs.as_deref() == Some("run-t1")),
            "turn 1's message persists in the shared session"
        );
        assert!(
            msgs.iter().any(|m| m.refs.as_deref() == Some("run-t2")),
            "turn 2's message was appended to the SAME session"
        );
    }

    // (memory-loop) SESSIONLESS now routes through the SESSIONED entry with an EPHEMERAL per-run
    // session_id == the run_id. A request with NO `session_id` still DELIVERS a result (the live
    // dispatch is unbroken), AND it now creates EXACTLY ONE session row keyed on the run id (so
    // post-run memory extraction can fire) — owned by the AUTHENTICATED caller. The turn loads
    // EMPTY history (behaviorally one-shot, as the prior sessionless arm was). This is the
    // regression fence for the deliberate NO-LONGER-byte-identical change that closes the
    // extract→confirm→recall loop on the common live path. (Extraction itself stays flag-gated +
    // default-OFF, so this run with the flag unset makes NO extra model call.)
    #[test]
    fn sessionless_dispatch_routes_through_ephemeral_per_run_session_owned_by_caller() {
        let (rt, _ws) = mock_runtime("sess-none", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            // The sessionless shape today's live path uses (session_id: None).
            let req = agent_run_request("req-none", "run-none", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        assert_eq!(
            listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &peer_allowlist,
                    false,
                    false,
                    false,
                    false, // (KEYSTONE) mission-spine dispatch OFF — byte-identical to today
                    false, // memory-confirm ingress OFF — byte-identical to today
                    false, // run-outcome-learning confirm OFF — byte-identical to today
                    false, // (Loop4) per-run token surface OFF — byte-identical to today
                    false, // (C1/C2) provider-workspace dispatch OFF — byte-identical to today
                )
                .unwrap(),
            1
        );
        let obs = client.join().unwrap();
        // The result is delivered (the live sessionless dispatch still works).
        assert!(
            matches!(obs.result, Some(Message::AgentRunResult { .. })),
            "sessionless dispatch still returns a refs result"
        );
        // A session row keyed on the RUN ID now exists, OWNED by the authenticated caller — the
        // ephemeral per-run session that lets post-run extraction fire + recall cross runs.
        let owner = friday_storage::load_session_owner(rt.db().conn(), "run-none")
            .unwrap()
            .expect("the ephemeral per-run session row exists, keyed on the run id");
        assert_eq!(
            owner.user_id.as_deref(),
            Some(OWNER),
            "the ephemeral session is owned by the AUTHENTICATED caller (never a client id)"
        );
        // EXACTLY ONE session row from this run (no extra/leaked sessions).
        let n: i64 = rt
            .db()
            .conn()
            .query_row("SELECT count(*) FROM agent_session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n, 1,
            "the sessionless dispatch creates exactly ONE ephemeral per-run session row"
        );
    }

    /// (FIX-Q3b) IDENTITY FLOW end-to-end: the SAME owner principal threads through
    /// authenticate_forwarded -> mission intake -> auto-dispatch -> run -> run_result. The session
    /// authenticates as `OWNER` (`authenticate_forwarded` against the allowlist); the mission
    /// intake binds the persisted Mission owner to that authenticated principal; the bound run
    /// (the Rust equivalent of the auto-dispatch driver firing `startRun` with the intake's owner)
    /// authenticates as the SAME principal and records its owner-scoped run answer + ephemeral
    /// session under it. We assert ONE identity (`OWNER`) is the owner at EVERY hop — closing the
    /// "no end-to-end identity flow exists today" gap. (Intake and the run are separate sealed
    /// envelopes, so they use separate `accept_one` connections — transport-stateless, DB-stateful;
    /// the binding is the persisted owner, not the connection.)
    #[test]
    fn identity_flows_through_authenticate_intake_dispatch_run_and_run_result() {
        let (rt, _ws) = mock_runtime("identity-flow", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        // ── Hop 1: authenticate (sealed session) -> mission intake -> Mission owned by OWNER ──
        let intake_kp = DeviceKeypair::generate();
        let intake_peer_allowlist = allowlist_of(intake_kp.public_bytes());
        let intake_client = spawn_client(addr, intake_kp, |session, _nonce| {
            let req = mission_intake_request("req-identity-intake");
            (req, session.clone(), session.clone())
        });
        assert_eq!(
            listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &intake_peer_allowlist,
                    false,
                    false,
                    true, // mission-intake ON
                    false,
                    false,
                    false,
                    false,
                    false, // (C1/C2) provider-workspace dispatch OFF
                )
                .unwrap(),
            1
        );
        let intake_result = match intake_client.join().unwrap().result {
            Some(Message::MissionIntakeResult { result }) => result,
            other => panic!("intake must birth a Mission, got {other:?}"),
        };
        assert_eq!(intake_result.status, "ready");
        assert!(intake_result.created_or_ready);
        let intake_owner = rt
            .db()
            .get_friday_conversation(&intake_result.friday_conversation_id)
            .unwrap()
            .expect("intake born the conversation")
            .owner_principal;
        assert_eq!(
            intake_owner, OWNER,
            "intake binds the Mission owner to the authenticated principal"
        );

        // ── Hop 2: auto-dispatch fires the Mission-bound run as the SAME principal -> run_result ──
        // (The run authenticates via authenticate_forwarded against the SAME allowlist; the Rust
        // auto-dispatch driver forwards the intake owner as the run principal and carries the
        // canonical Mission/WorkItem ids emitted by intake.)
        let run_kp = DeviceKeypair::generate();
        let run_peer_allowlist = allowlist_of(run_kp.public_bytes());
        let mission_context = friday_protocol::MissionWorkItemContextWire {
            friday_conversation_id: intake_result.friday_conversation_id.clone(),
            mission_id: intake_result.mission_id.clone(),
            work_item_id: intake_result
                .work_item_id
                .clone()
                .expect("ready intake includes a WorkItem id"),
        };
        let run_client = spawn_client(addr, run_kp, |session, nonce| {
            let req = mission_bound_agent_run_request(
                "req-identity-run",
                "run-identity",
                OWNER,
                session,
                nonce,
                mission_context,
            );
            (req, session.clone(), session.clone())
        });
        assert_eq!(
            listener
                .accept_one(
                    &server_kp,
                    &rt,
                    &allowlist,
                    &run_peer_allowlist,
                    false,
                    true, // mission-bound run ON
                    false,
                    false,
                    false,
                    false,
                    false,
                    false, // (C1/C2) provider-workspace dispatch OFF
                )
                .unwrap(),
            1
        );
        assert!(
            matches!(
                run_client.join().unwrap().result,
                Some(Message::AgentRunResult { .. })
            ),
            "the bound run returns a refs result"
        );

        // ── The single identity threads through: intake owner == run answer owner == OWNER ──
        let run_rows: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM agent_run WHERE run_id = ?1",
                ["run-identity"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            run_rows, 1,
            "the Mission-bound dispatch runs the agent loop exactly once"
        );
        let work_item_id = intake_result.work_item_id.as_deref().unwrap();
        let work_item = rt
            .db()
            .get_work_item(work_item_id)
            .unwrap()
            .expect("Mission-bound run keeps the intake WorkItem");
        assert_eq!(
            work_item.status,
            friday_core::WorkItemStatus::CompletedWithProof,
            "the Mission-bound run completes the intake WorkItem with proof"
        );
        assert!(
            work_item
                .proof_receipts
                .contains(&"friday://agent-run/run-identity".to_string()),
            "the WorkItem proof receipts must include this run: {:?}",
            work_item.proof_receipts
        );
        let links = rt
            .db()
            .list_mission_links(&intake_result.mission_id)
            .unwrap();
        assert!(
            links.iter().any(|link| link.target_ref
                == format!(
                    "friday://provider-timeline/{}#run-identity",
                    intake_result.friday_conversation_id
                )
                && link.work_item_id.as_deref() == Some(work_item_id)),
            "a provider-timeline mission_link must bind this sealed run to the intake WorkItem: {links:?}"
        );
        let route_decision = rt
            .db()
            .get_route_decision("route-decision:agent-loop:run-identity")
            .unwrap()
            .expect("Mission-bound run writes a route_decision keyed to the run id");
        assert_eq!(route_decision.mission_id, intake_result.mission_id);
        assert_eq!(route_decision.work_item_id, work_item_id);
        assert_eq!(
            route_decision.selected_lane,
            friday_core::WorkLane::DeepSeek
        );
        // The run answer is releasable ONLY to that same owner — a different principal is denied.
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        assert!(
            matches!(
                friday_storage::get_run_answer_for_principal(rt.db().conn(), "run-identity", OWNER)
                    .unwrap(),
                RunAnswerAccess::Granted(_)
            ),
            "the same owner is Granted the bound run's answer"
        );
        assert_eq!(
            friday_storage::get_run_answer_for_principal(
                rt.db().conn(),
                "run-identity",
                "principal:not-the-owner"
            )
            .unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch),
            "a different principal is DENIED the bound run's answer"
        );
        assert_eq!(
            intake_owner, OWNER,
            "ONE identity (OWNER) is the owner at intake AND run — the end-to-end flow holds"
        );
    }
}
