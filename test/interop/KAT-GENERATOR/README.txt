B1 KAT FIXTURE GENERATOR — provenance record (source preserved; NOT compiled in this repo)
==========================================================================================

The KAT fixtures in `test/unit/api/mission-spine/fixtures/b1-rust-handshake-kat.ts` were
produced by the throwaway Rust project whose source is preserved here as:
  - main.rs.txt      (the generator)
  - Cargo.toml.txt   (path-deps the rust-core crates)

It lived OUTSIDE the worktree (e.g. /private/tmp/b1-kat-gen) so rust-core stays byte-for-byte
untouched. It calls ONLY the real `pub` friday-crypto / friday-hub API the production server
uses — so the fixtures anchor on the REAL Rust crates, not a reimplementation.

To re-run it (optional; the KATs do NOT need it at test time — the bytes are checked in):
  1. mkdir -p /private/tmp/b1-kat-gen/src
  2. cp main.rs.txt    /private/tmp/b1-kat-gen/src/main.rs
  3. cp Cargo.toml.txt /private/tmp/b1-kat-gen/Cargo.toml
     (edit the two `path = "…"` entries in Cargo.toml to point at THIS worktree's
      rust-core/crates/friday-crypto and rust-core/crates/friday-hub)
  4. cd /private/tmp/b1-kat-gen && cargo run
     then hex-encode the byte arrays into the .ts fixture shape.

REPRODUCIBILITY NOTE (important, do not over-claim):
  - DETERMINISTIC fields reproduce byte-for-byte on every run: clientPub / serverPub (derived
    from the fixed test secret scalars), auth_aad, nonce_bound_challenge, and the constants.
  - The `sealedWire` blobs (k1Agree.sealedWire, k2Aead.sealedWire) are NOT byte-reproducible:
    `friday_crypto::seal` uses a FRESH RANDOM 24-byte nonce per call, so each run produces a
    DIFFERENT (but equally valid) ciphertext. Their validity is established by the KAT OPENING
    them to the known sentinel plaintext — NOT by regenerating identical bytes.
