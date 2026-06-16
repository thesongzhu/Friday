//! **J2 read-seam enroll core** — the ADDITIVE, idempotent, no-eviction read-seam allowlist
//! mutators, factored out of [`hub_read_seam_enroll`]'s `run()` so the CLI's `--add` path AND the
//! [`hub_pairing_server`] pairing→read-seam bridge share ONE implementation (no reimplementation).
//!
//! ## Why a shared module
//! The read-projection server boots on the DISTINCT
//! [`crate::key_source::READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID`] and enforces
//! [`crate::sealed_ws::enforce_peer_allowlist_nonempty`] (NOT `enforce_single_peer`), so the read
//! allowlist may hold ONE OR MORE 32-byte X25519 pubkeys concatenated (`chunks_exact(32)`). Two
//! callers now grow/shrink that set:
//! * the operator CLI [`hub_read_seam_enroll`] `--add` path (a master-derived OR externally-supplied
//!   pubkey), and
//! * the [`hub_pairing_server`] bridge — on a SUCCESSFUL QR pairing it enrolls the paired device's
//!   pubkey so that device can read (:48751).
//!
//! Factoring the byte-format-sensitive append/remove HERE means the two callers cannot drift on the
//! on-disk format or the idempotency rule.
//!
//! ## Invariants (the security guards the bridge + CLI both inherit)
//! * **Additive only — NO eviction.** [`enroll_read_seam_peer_additive`] APPENDS a new 32-byte key
//!   to the existing allowlist; it NEVER replaces or drops an already-enrolled peer (the desktop
//!   master peer + any other device survive).
//! * **Idempotent.** Re-adding an already-present aligned 32-byte chunk is a no-op (no duplicate).
//! * **Fixed 32-byte keys.** A non-32-byte pubkey is rejected ([`ReadSeamEnrollError::BadPubkeyLen`])
//!   BEFORE any write — fail-closed, so a malformed key never lands in the allowlist.
//! * **The WRITE seam is untouched.** This module names ONLY the read-seam id; the write server's
//!   `PEER_PUBKEY_ALLOWLIST_ID` + `enforce_single_peer` are never referenced here.
//!
//! No key bytes are ever logged by this module (the callers report only counts / fingerprints).

use friday_crypto::FileSecureStore;

use crate::key_source::{READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN};

/// A coarse, non-leaking error category for the read-seam allowlist mutators. `Display` carries no
/// key bytes and no store path — only a stable classification.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadSeamEnrollError {
    /// The supplied pubkey was not exactly [`X25519_PUBKEY_LEN`] (32) bytes — rejected before any
    /// write so a malformed key can never enter the allowlist (fail-closed).
    BadPubkeyLen(usize),
    /// Reading the existing allowlist failed (IO / KEK mismatch). Secret-free.
    StoreRead,
    /// The checked allowlist write (`try_put`) / delete failed. Secret-free.
    StoreWrite,
}

impl std::fmt::Display for ReadSeamEnrollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadSeamEnrollError::BadPubkeyLen(n) => write!(
                f,
                "read-seam pubkey must be exactly {X25519_PUBKEY_LEN} bytes (got {n}) — not enrolled"
            ),
            ReadSeamEnrollError::StoreRead => {
                write!(f, "could not read the existing read-seam peer allowlist")
            }
            ReadSeamEnrollError::StoreWrite => write!(f, "read-seam allowlist write failed"),
        }
    }
}

impl std::error::Error for ReadSeamEnrollError {}

/// The outcome of an additive enroll — how many peers are now allowlisted, and whether THIS call
/// actually grew the set (vs. an idempotent no-op because the key was already present).
#[derive(Debug, PartialEq, Eq)]
pub struct EnrollOutcome {
    /// Total distinct peers in the allowlist AFTER this call.
    pub total_peers: usize,
    /// `true` iff this call appended a NEW key; `false` for an idempotent re-add.
    pub newly_added: bool,
}

/// Coerce an arbitrary-length pubkey byte slice into a fixed 32-byte X25519 key, fail-closed on any
/// other length. The `Message::Pair` `device_pubkey` is a `Vec<u8>`, so the bridge MUST validate its
/// width before enrolling — an off-size key would either be rejected by the read server's
/// `establish_session` (which requires exactly 32 bytes) or, worse, mis-align the concatenated
/// allowlist. Rejecting here keeps the on-disk allowlist a clean multiple of 32.
pub fn require_x25519_pubkey(bytes: &[u8]) -> Result<[u8; X25519_PUBKEY_LEN], ReadSeamEnrollError> {
    if bytes.len() != X25519_PUBKEY_LEN {
        return Err(ReadSeamEnrollError::BadPubkeyLen(bytes.len()));
    }
    let mut k = [0u8; X25519_PUBKEY_LEN];
    k.copy_from_slice(bytes);
    Ok(k)
}

/// **ADDITIVE, idempotent, no-eviction** enroll of one 32-byte X25519 pubkey into the read-seam
/// allowlist. This is the EXACT append rule the [`hub_read_seam_enroll`] `--add` path used inline —
/// pulled here so the CLI AND the pairing bridge share ONE format-sensitive implementation:
///
/// 1. Read the existing allowlist value (absent ⇒ empty).
/// 2. If `pubkey` is already an aligned 32-byte chunk in it ⇒ idempotent NO-OP (no duplicate).
/// 3. Else APPEND the 32 bytes (the existing peers are NEVER dropped — additive only).
/// 4. CHECKED `try_put` so the caller KNOWS it landed.
///
/// The read-projection server enforces only `enforce_peer_allowlist_nonempty`, so a multi-peer list
/// is ADMITTED with no eviction (the per-handshake S-F gate checks the presented key against EVERY
/// enrolled key). Returns the new peer count + whether this call grew the set.
pub fn enroll_read_seam_peer_additive(
    store: &mut FileSecureStore,
    pubkey: &[u8; X25519_PUBKEY_LEN],
) -> Result<EnrollOutcome, ReadSeamEnrollError> {
    let mut existing = store
        .try_get(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
        .map_err(|_| ReadSeamEnrollError::StoreRead)?
        .unwrap_or_default();

    // Idempotent: only treat an EXISTING aligned chunk as "already present". A misaligned existing
    // value (length not a multiple of 32) is never matched here, so the new key is appended rather
    // than silently coalescing into corruption — `load_peer_allowlist` would already reject a
    // misaligned value at boot, surfacing the corruption fail-closed rather than this masking it.
    let already = existing.len() % X25519_PUBKEY_LEN == 0
        && existing
            .chunks_exact(X25519_PUBKEY_LEN)
            .any(|c| c == pubkey);

    if !already {
        existing.extend_from_slice(pubkey);
        store
            .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &existing)
            .map_err(|_| ReadSeamEnrollError::StoreWrite)?;
    }

    Ok(EnrollOutcome {
        total_peers: existing.len() / X25519_PUBKEY_LEN,
        newly_added: !already,
    })
}

/// **REMOVE** one 32-byte X25519 pubkey from the read-seam allowlist (the revoke→read-seam sibling
/// of [`enroll_read_seam_peer_additive`]). Removes ONLY the matching aligned chunk(s); every OTHER
/// enrolled peer survives (no broader eviction). Removing an absent key is an idempotent no-op.
///
/// When the LAST peer is removed the allowlist value becomes empty; rather than leaving a 0-byte
/// value that `load_peer_allowlist` rejects as `Invalid`, we DELETE the entry (so a missing entry —
/// `Missing` — is the fail-closed state the read server already handles, identical to a never-
/// provisioned host). Returns the remaining peer count + whether a key was actually removed.
pub fn remove_read_seam_peer(
    store: &mut FileSecureStore,
    pubkey: &[u8; X25519_PUBKEY_LEN],
) -> Result<EnrollOutcome, ReadSeamEnrollError> {
    let existing = store
        .try_get(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
        .map_err(|_| ReadSeamEnrollError::StoreRead)?
        .unwrap_or_default();

    // Only operate on a cleanly-aligned value; a misaligned value is corruption the read server
    // already fail-closes on, so we do not try to "fix" it by partial removal.
    if existing.is_empty() || existing.len() % X25519_PUBKEY_LEN != 0 {
        return Ok(EnrollOutcome {
            total_peers: 0,
            newly_added: false,
        });
    }

    let kept: Vec<u8> = existing
        .chunks_exact(X25519_PUBKEY_LEN)
        .filter(|c| *c != pubkey)
        .flatten()
        .copied()
        .collect();

    let removed = kept.len() != existing.len();
    if removed {
        if kept.is_empty() {
            // Last peer removed → DELETE the entry (a Missing entry is the read server's fail-closed
            // state, NOT a 0-byte Invalid value).
            store
                .try_delete(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
                .map_err(|_| ReadSeamEnrollError::StoreWrite)?;
        } else {
            store
                .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &kept)
                .map_err(|_| ReadSeamEnrollError::StoreWrite)?;
        }
    }

    Ok(EnrollOutcome {
        total_peers: kept.len() / X25519_PUBKEY_LEN,
        // Reuse `newly_added` as "the set changed" for the remove direction.
        newly_added: removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::key_source::derive_file_store_kek;
    use crate::sealed_ws::{
        enforce_peer_allowlist_nonempty, load_peer_allowlist, peer_is_allowlisted,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-read-seam-enroll-core-{tag}-{}-{n}",
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

    fn open_store(dir: &std::path::Path) -> FileSecureStore {
        FileSecureStore::open(dir, derive_file_store_kek(&[0x42u8; 32])).unwrap()
    }

    #[test]
    fn require_x25519_pubkey_rejects_off_size() {
        assert_eq!(
            require_x25519_pubkey(&[0u8; 31]),
            Err(ReadSeamEnrollError::BadPubkeyLen(31))
        );
        assert_eq!(
            require_x25519_pubkey(&[0u8; 33]),
            Err(ReadSeamEnrollError::BadPubkeyLen(33))
        );
        assert_eq!(
            require_x25519_pubkey(&[]),
            Err(ReadSeamEnrollError::BadPubkeyLen(0))
        );
        assert_eq!(require_x25519_pubkey(&[7u8; 32]), Ok([7u8; 32]));
    }

    #[test]
    fn additive_enroll_appends_no_eviction_and_is_idempotent() {
        let td = TempDir::new("add");
        let dir = td.child("store");
        let mut store = open_store(&dir);
        let pk_a = [0x01u8; X25519_PUBKEY_LEN];
        let pk_b = [0x02u8; X25519_PUBKEY_LEN];

        let o1 = enroll_read_seam_peer_additive(&mut store, &pk_a).unwrap();
        assert_eq!(
            o1,
            EnrollOutcome {
                total_peers: 1,
                newly_added: true
            }
        );
        let o2 = enroll_read_seam_peer_additive(&mut store, &pk_b).unwrap();
        assert_eq!(
            o2,
            EnrollOutcome {
                total_peers: 2,
                newly_added: true
            }
        );
        // Idempotent re-add of B → still 2, not newly added.
        let o3 = enroll_read_seam_peer_additive(&mut store, &pk_b).unwrap();
        assert_eq!(
            o3,
            EnrollOutcome {
                total_peers: 2,
                newly_added: false
            }
        );

        // The pre-existing peer A SURVIVES (no eviction) and the read server ADMITS the 2-peer list.
        let store2 = open_store(&dir);
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allow.len(), 2);
        assert!(enforce_peer_allowlist_nonempty(&allow).is_ok());
        assert!(peer_is_allowlisted(&allow, &pk_a));
        assert!(peer_is_allowlisted(&allow, &pk_b));
    }

    #[test]
    fn remove_drops_only_the_target_and_keeps_the_rest() {
        let td = TempDir::new("remove");
        let dir = td.child("store");
        let mut store = open_store(&dir);
        let master_peer = [0xAAu8; X25519_PUBKEY_LEN];
        let device = [0xBBu8; X25519_PUBKEY_LEN];
        enroll_read_seam_peer_additive(&mut store, &master_peer).unwrap();
        enroll_read_seam_peer_additive(&mut store, &device).unwrap();

        // Revoke the DEVICE only → the desktop master peer survives.
        let r = remove_read_seam_peer(&mut store, &device).unwrap();
        assert_eq!(
            r,
            EnrollOutcome {
                total_peers: 1,
                newly_added: true
            }
        );

        let store2 = open_store(&dir);
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allow.len(), 1);
        assert!(
            peer_is_allowlisted(&allow, &master_peer),
            "master peer NOT evicted"
        );
        assert!(
            !peer_is_allowlisted(&allow, &device),
            "revoked device removed"
        );
    }

    #[test]
    fn remove_absent_key_is_noop() {
        let td = TempDir::new("remove-absent");
        let dir = td.child("store");
        let mut store = open_store(&dir);
        let pk = [0x01u8; X25519_PUBKEY_LEN];
        enroll_read_seam_peer_additive(&mut store, &pk).unwrap();
        let r = remove_read_seam_peer(&mut store, &[0x09u8; X25519_PUBKEY_LEN]).unwrap();
        assert_eq!(
            r,
            EnrollOutcome {
                total_peers: 1,
                newly_added: false
            }
        );
    }

    #[test]
    fn remove_last_peer_deletes_entry_to_missing_not_empty_invalid() {
        let td = TempDir::new("remove-last");
        let dir = td.child("store");
        let mut store = open_store(&dir);
        let pk = [0x05u8; X25519_PUBKEY_LEN];
        enroll_read_seam_peer_additive(&mut store, &pk).unwrap();
        let r = remove_read_seam_peer(&mut store, &pk).unwrap();
        assert_eq!(
            r,
            EnrollOutcome {
                total_peers: 0,
                newly_added: true
            }
        );

        // The entry is DELETED (Missing), NOT a 0-byte Invalid value: load fail-closes as Missing,
        // identical to a never-provisioned host (the read server's existing fail-closed state).
        let store2 = open_store(&dir);
        assert_eq!(
            load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID),
            Err(crate::sealed_ws::PeerAllowlistError::Missing)
        );
    }
}
