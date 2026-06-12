# Cutover runbook — Rust read-projection WS server + S6 (slice-6 live activation)

**Status: DARK/STAGED until the operator runs this.** This slice builds and stages the
read-seam live-activation infra (the `hub_read_projection_server` LaunchAgent template +
run-wrapper template + the `hub_read_seam_enroll` UI-peer enroll CLI + the staged S6 wrapper
edit). Nothing is installed, loaded, or executed by it. **This runbook is the slice-6 operator
gate** — one of the places the production needle actually moves. Run it on the production Mac,
as the **same login user** that runs `com.friday.hub`.

It activates two INDEPENDENT seams:
- **The UI read seam** (`hub_read_projection_server` on `127.0.0.1:48751`): direct UI → Rust
  reads over a separate sealed-WS read server. Independent of the prod-tree advance.
- **S6 mutating-chat control plane** (on the agent-run WRITE server): the staged wrapper edit
  exports `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1` + `FRIDAY_OPERATOR_VK_PATH`. Gated on the
  operator provisioning the signing seed + verify key (O-2).

> **HONEST SCOPE.** Installing the read-projection LaunchAgent makes the **engine read-seam**
> live. A SwiftUI surface rendering a LIVE sealed snapshot is STILL gated on the unbuilt real
> Swift sealed-WS client (B-1), and mobile direct-connect on the multi-peer enroll lane (B-2,
> deferred — see below). Built ≠ flipped; this is engine de-risking, not v1 GO.

---

## Topology (operator-locked transport 2b)

| Server | Label | Port (loopback) | Writes? | Needs DeepSeek key? |
| --- | --- | --- | --- | --- |
| TS hub | `com.friday.hub` | 3141 (`FRIDAY_PORT`) | yes | n/a |
| Agent-run WRITE | `com.friday.rust-agent-run-ws-server` | 48750 | yes | YES (wrapper) |
| Read-projection | `com.friday.read-projection-server` | **48751** | **NO (read-only DB)** | **NO** |

The read server binds `127.0.0.1` ONLY (never the LAN), builds NO `HubRuntime`/`DeepSeekClient`
(no model-call path, no provider credential), and opens the hub DB READ-ONLY.

---

## Part A — the UI read seam

### Preconditions
- **Same user / same `$HOME` for everything** (the enroll CLI, the master key, the supervised
  server). The server reads its master key from `~/.friday/master.key` (or `FRIDAY_MASTER_KEY`
  in its own login session) and opens the FileSecureStore under a KEK derived from it; the
  enroll CLI writes the peer allowlist into that same store under the same KEK. A different
  user/`$HOME` ⇒ the server boots fail-closed (`master_key_unavailable` /
  `peer_allowlist_unavailable`). Use the launchd `gui/$UID` domain of that user.
- **`~/.friday/master.key` exists for that user** (the Rust side NEVER mints one). If absent,
  either provision it OR use the install tool's `--master-key-env-file` wrapper mode.
- **One `STORE_DIR`, used identically** in the enroll step and the plist. Default
  `~/.friday/agent-run-securestore` (the SAME store the write server uses — the desktop UI peer
  IS the write peer). A mismatch boots fail-closed.
- **A concrete, non-zero loopback `WS_PORT`** that is free, is NOT the WRITE server port
  (48750), and is NOT the TS hub's port (3141). Use **48751**. The tool's *verify-b* enforces
  all three.

### 1. Release-build the two bins
```sh
( cd rust-core && cargo build --release \
    --bin hub_read_projection_server --bin hub_read_seam_enroll )
```

### 2. Enroll the UI peer pubkey ONCE
Single-peer v1. Choose the source:

```sh
# DESKTOP UI (same OS user, master-derived peer == the write peer):
rust-core/target/release/hub_read_seam_enroll --from-master \
  --store-dir "$HOME/.friday/agent-run-securestore"

# OR a DISTINCT DEVICE that generated its OWN keypair off-box (hand over only its PUBLIC key):
rust-core/target/release/hub_read_seam_enroll --pubkey <64-hex-x25519-pubkey> \
  --store-dir "$HOME/.friday/agent-run-securestore"
```

`--from-master` is idempotent (REPLACE; never appends). `--pubkey` REPLACES the prior single
peer (the device becomes the sole allowlisted reader). Verify a pubkey before enrolling with
`--print-pubkey` (prints + exits without writing) or preview with `--dry-run`.

> **Single-peer only (multi-peer DEFERRED).** The read server enforces single-peer at boot
> (`enforce_single_peer`). Enrolling a DESKTOP master-derived peer AND a distinct mobile device
> key CONCURRENTLY (`--add`) writes a multi-key allowlist the server will REFUSE to boot on —
> `--add` is gated behind `--allow-multi-peer-unsupported-by-server` and prints a loud warning.
> Concurrent multi-peer is a separate build-first lane (relax `enforce_single_peer` for the read
> server + the tamper-evident pubkey→principal bindings). Until then: one peer at a time.

### 3. Fill + validate + stage the plist
```sh
scripts/ops/launchd/build-and-install-read-projection-server.sh \
  --repo-dir       "$(pwd)" \
  --hub-db-path    "<abs Rust Hub SQLite path>" \
  --ws-port        48751 \
  --owner-principal admin-001 \
  --store-dir      "$HOME/.friday/agent-run-securestore" \
  --log-dir        "$HOME/.friday/launchd"
```
It release-builds (unless `--skip-build`), runs *verify-b* (port free + != 48750 + != the TS
hub's port), `plutil -lint`s the filled plist, **stages** it (NOT into `~/Library/LaunchAgents`),
and PRINTS the bootstrap command. It places **no secret** and sets **no route flag**.

If `~/.friday/master.key` is absent for the supervised user, add
`--master-key-env-file "$HOME/.config/friday/<your>.env"` (a 0600/0400 file defining a non-empty
`FRIDAY_MASTER_KEY`); the tool then also stages the run-wrapper and points the plist at its
install path. Most installs do NOT need this.

### 4. Install + bootstrap (operator runs the printed commands by hand)
```sh
cp '<staged plist>' "$HOME/Library/LaunchAgents/com.friday.read-projection-server.plist"
launchctl bootout   "gui/$UID" "$HOME/Library/LaunchAgents/com.friday.read-projection-server.plist" 2>/dev/null || true
launchctl enable    "gui/$UID/com.friday.read-projection-server"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.friday.read-projection-server.plist"
launchctl kickstart -k "gui/$UID/com.friday.read-projection-server"
```
Confirm it came up loopback-only and did not fail-closed:
```sh
launchctl print "gui/$UID/com.friday.read-projection-server" | grep -E 'state|pid'
tail -n 40 "$HOME/.friday/launchd/friday-read-projection-server.stderr.log"
# expect: "listening (loopback-only) on 127.0.0.1:48751" and
#         "peer-pubkey allowlist loaded from SecureStore (count=1)"
# a fail-closed boot logs one of: master_key_unavailable / secure_store_unavailable /
#         peer_allowlist_unavailable / peer_allowlist_multi_peer_unsupported / bind_failed
```

### 5. UI connect (GATED on B-1, the real Swift sealed-WS client)
The desktop SwiftUI client points `FridayRustReadClient` at `127.0.0.1:48751`, completes the
sealed handshake (desktop uses the master-derived peer), and renders the live sealed snapshot.
**Until B-1 lands, the console renders the mock — NOT a live snapshot.** A
non-allowlisted/forged-principal connection gets NOTHING (server silent).

### Acceptance (read seam)
A read request from the allowlisted UI peer over the sealed read session returns an
OWNER-SEALED, refs-only projection (workbench / run-readback / providers-doctor) whose
`truth_status` rides from the registry, with 503/stale surfaced as truth. A non-owner /
non-allowlisted request sees NOTHING (fail-closed, session ends).

---

## Part B — S6 mutating-chat control plane (gated on O-2)

The staged S6 wrapper edit is `scripts/ops/launchd/rust-agent-run-ws-server-run.sh.s6-staged`.
It is the live agent-run WS wrapper PLUS exactly two `export` lines before `exec`:
`FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1` and
`FRIDAY_OPERATOR_VK_PATH="$HOME/.friday/operator-approval.vk"`.

**O-2 (operator provisions SEPARATELY — off this PR):** using `friday-operator-sign` (KEK from
`FRIDAY_OPERATOR_SIGNER_MASTER` / `~/.friday/operator-signer.key` per #671 — a master the Hub
CANNOT derive, INV-6), the operator (1) provisions the 32-byte Ed25519 SIGNING seed into the
isolated operator-signer SecureStore (the PRIVATE seed lives ONLY with the operator, off-box),
and (2) writes the PUBLIC verify key (64-hex) to `~/.friday/operator-approval.vk`. The Hub holds
ONLY the verify key — never a signing key.

**Apply at GO (operator, by hand — gated on both files existing):**
```sh
# diff first against the live wrapper, then:
cp scripts/ops/launchd/rust-agent-run-ws-server-run.sh.s6-staged \
   ~/.friday/launchd/rust-agent-run-ws-server-run.sh
chmod 0700 ~/.friday/launchd/rust-agent-run-ws-server-run.sh
launchctl kickstart -k "gui/$UID/com.friday.rust-agent-run-ws-server"
# VERIFY stderr: "hub_agent_run_server: on-wire run-CONTROL plane ENABLED
#                 (FRIDAY_AGENT_RUN_CONTROL_VIA_RUST)" + a clean boot (no OperatorVk hard-error).
```
> If `FRIDAY_OPERATOR_VK_PATH` is set but the `.vk` file is missing/malformed, `HubRuntime::live`
> returns a HARD boot error (refuse-to-boot) — by design, so a broken provision never silently
> degrades to "no key / always pause". So this is gated on O-2.

**Acceptance (S6):** a mutating chat run PAUSES; the operator signs the canonical action digest
off-box with `friday-operator-sign`; the signed `CanonicalApproval` is fed back; the run RESUMES
and EXECUTES — a `run_result.status=finished` reached THROUGH a verified Ed25519 approval (NOT a
self-report, NOT a `no_answer`/keepalive). A forged/absent signature yields
`operator_vk_unprovisioned`/refusal (fail-closed).

---

## Rollback-not-protected acceptance criterion (operator must acknowledge)

The peer-pubkey **allowlist in the FileSecureStore is NOT rollback-protected** (the SAME store
the write server uses). It has no monotonic counter / anti-rollback seal; an actor who can
restore an older copy of the store dir could revert the allowlist without detection.
Loopback-only binding + filesystem permissions on `~/.friday/agent-run-securestore` are the
bounding controls. **Before bootstrapping, the operator must acknowledge this** and confirm the
store dir's ACLs/backup posture are acceptable for the owner-gated read surface this enables. If
rollback protection is required, that is a separate, later hardening item.

## Rollback (operational)

```sh
scripts/ops/launchd/uninstall-read-projection-server.sh        # read seam down (no DB state to undo)
# S6: restore the snapshotted original wrapper (no S6 exports) + kickstart -k → S6-dark.
```
Read-only server → no DB state to undo. The peer allowlist + DB are not touched.
