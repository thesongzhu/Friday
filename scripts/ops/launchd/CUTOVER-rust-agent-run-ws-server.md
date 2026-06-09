# Cutover runbook — Rust agent-run WS server (execrun slice 6)

**Status: DARK until the operator runs this.** Slices 1–5 built and merged the
substrate (persistent `FileSecureStore`, the `key_source` master-key/KEK helpers,
the enroll CLI, the wired server, this launchd plist template, and the
build-and-install tool). Nothing is installed, loaded, or executed by those
slices. **This runbook is the slice-6 operator gate** — the one place the
production needle actually moves. Run it on the production Mac, as the **same
login user** that runs `com.friday.hub`.

The runbook makes the loopback Rust WS server live and flips the TS hub to route
qualifying read-only agent-runs to it. It is reversible at the launchd/flag level
(boot the service out, unset the flag) — but see the **rollback-not-protected**
acceptance criterion at the end before you proceed.

---

## Preconditions (read before step 1)

- **Same user / same `$HOME` for everything.** The enroll CLI (step 2), the
  master key, and the launchd-supervised server (step 4) must all resolve the
  same `$HOME`. The server reads its master key from `~/.friday/master.key` (or
  `FRIDAY_MASTER_KEY` in its own login session) and opens the FileSecureStore
  under a KEK derived from it; the enroll CLI writes the allowlist into that same
  store under the same KEK. A different user/`$HOME` ⇒ different `master.key`
  and/or different store dir ⇒ the server boots **fail-closed**
  (`master_key_unavailable` or `peer_allowlist_unavailable`). Use the launchd
  `gui/$UID` domain of that user.
- **`~/.friday/master.key` exists for that user** (TS owns auto-generation; the
  Rust side NEVER mints one). If it is absent the server refuses to boot
  (`master_key_unavailable`). Provision/confirm it first.
- **One `STORE_DIR`, used identically in steps 2 and 3.** Default
  `~/.friday/agent-run-securestore`. The `--store-dir` filled into the plist MUST
  equal the dir you enroll into; a mismatch boots fail-closed
  (`peer_allowlist_unavailable`).
- **A concrete, non-zero loopback `WS_PORT`** that is free and is NOT the TS hub's
  port (`FRIDAY_PORT`, default `3141`). The install tool's *verify-b* enforces
  this, but choose deliberately (e.g. `48750`). The server binds `127.0.0.1`
  ONLY — never the LAN.

---

## Sequence

### 1. Release-build the two bins
From the repo root:

```sh
( cd rust-core && cargo build --release \
    --bin hub_agent_run_server --bin hub_agent_run_enroll )
```

Produces:
- `rust-core/target/release/hub_agent_run_server`
- `rust-core/target/release/hub_agent_run_enroll`

(The build-and-install tool in step 3 also runs this build unless you pass
`--skip-build`; doing it here first lets you run enroll in step 2.)

### 2. Enroll the client pubkey ONCE
Run the enroll CLI exactly once to write the authorized client X25519 pubkey into
the SecureStore allowlist (`PEER_PUBKEY_ALLOWLIST_ID`). Use the **same STORE_DIR**
you will fill into the plist:

```sh
rust-core/target/release/hub_agent_run_enroll --store-dir "$HOME/.friday/agent-run-securestore"
# (omit --store-dir to use the same default ~/.friday/agent-run-securestore)
```

This is a SEPARATE, one-time step — the install tool deliberately does NOT run it.
Without it the server boots fail-closed (the allowlist is missing/empty).

### 3. Fill + validate + stage the plist
Run the slice-6 cutover tool. It release-builds (unless `--skip-build`), runs
*verify-b* (port free + `!=` the TS hub's port, loopback-only), `plutil -lint`s the
filled plist, **stages** it (NOT into `~/Library/LaunchAgents`), and PRINTS the
bootstrap command. Pass the **same STORE_DIR as step 2**:

```sh
scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh \
  --repo-dir       "$(pwd)" \
  --workspace-root "<abs workspace root>" \
  --hub-db-path    "<abs Rust Hub SQLite path>" \
  --ws-port        48750 \
  --owner-principal "<the bound owner principal>" \
  --store-dir      "$HOME/.friday/agent-run-securestore" \
  --log-dir        "$HOME/.friday/launchd"
```

It places **no secret** in the plist and does NOT set the TS route flag. If
*verify-b* aborts (exit `75`), the chosen port is in use or collides with the TS
hub — pick another and re-run.

### 4. Install + bootstrap (operator runs the printed commands by hand)
The tool prints the exact commands; they are, for the staged plist:

```sh
cp '<staged plist>' "$HOME/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist"
launchctl bootout   "gui/$UID" "$HOME/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist" 2>/dev/null || true
launchctl enable    "gui/$UID/com.friday.rust-agent-run-ws-server"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist"
launchctl kickstart -k "gui/$UID/com.friday.rust-agent-run-ws-server"
```

Confirm it came up loopback-only and did not fail-closed:

```sh
launchctl print "gui/$UID/com.friday.rust-agent-run-ws-server" | grep -E 'state|pid'
tail -n 40 "$HOME/.friday/launchd/friday-rust-agent-run-ws-server.stderr.log"
# expect: "listening (loopback-only) on 127.0.0.1:<WS_PORT>" and
#         "peer-pubkey allowlist loaded from SecureStore (count=…)"
# a fail-closed boot logs one of: master_key_unavailable / secure_store_unavailable /
#         peer_allowlist_unavailable / bind_failed
```

### 5. Flip the TS-side route flag (on `com.friday.hub`, NOT here)
The route decision lives on the **TS hub**, not on this Rust server. On
`com.friday.hub` set:

- `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST=1` — turns on the default-OFF route.
- `FRIDAY_HUB_AGENT_RUN_WS_PORT=<WS_PORT>` — the SAME loopback port from step 3.

Do NOT put either of these on the Rust WS server plist (it does not read them).
The WS X25519 secret is resolved on the TS side from SecureStore — never an env
var. Restart/reload `com.friday.hub` so it picks up the env.

### 6. Acceptance
A qualifying **read-only** agent-run request, routed via Rust, returns the
**owner-gated DB-readback body** and `loopStatus=Finished`. Concretely: the run
completes, the answer body is delivered sealed back over the owner-only session
(not as a refs field), and the TS owner-gated readback returns that body to the
owner. A non-qualifying or non-owner request must NOT route / must NOT see the
body (fail-closed). If the server is unreachable the TS client must fail-closed
(503), never a silent/unauthenticated path.

---

## Rollback-not-protected acceptance criterion (operator must acknowledge)

The peer-pubkey **allowlist in the FileSecureStore is NOT rollback-protected**.
The store is a persistent on-disk artifact keyed by the derived KEK; it has no
monotonic counter / anti-rollback seal. An actor who can restore an older copy of
the store dir (e.g. from a backup/snapshot) could revert the allowlist to a prior
state — re-adding a previously-enrolled pubkey or removing a later revocation —
without detection by this mechanism. Loopback-only binding + filesystem
permissions on `~/.friday/agent-run-securestore` are the bounding controls; there
is no in-band rollback detection.

**Before bootstrapping (step 4), the operator must explicitly acknowledge this**
and confirm the store dir's filesystem ACLs and backup posture are acceptable for
the owner-gated surface this enables. If rollback protection is required, that is
a separate, later hardening item — it is NOT provided by slices 1–6.

## Rollback (operational, to take the service back down)

```sh
launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist"
rm -f "$HOME/Library/LaunchAgents/com.friday.rust-agent-run-ws-server.plist"
# and on com.friday.hub: unset FRIDAY_ROUTE_AGENT_RUN_VIA_RUST (back to default-OFF),
# then reload the hub. With the flag off the WS server is never contacted.
```

This takes the route and the supervisor down; it does NOT, by itself, undo any
state already written, and (per the criterion above) does not add rollback
protection to the store.
