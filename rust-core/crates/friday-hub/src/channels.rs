//! Channel trusted-inbound (Channels track, UNW-013). Hub-only. A-PR2 = AUTH;
//! A-PR3 = PII redaction at the boundary ([`redact_inbound`] / [`RedactedInbound`] —
//! authenticated channel content is PII-stripped via the single Hub redactor before it
//! can become a Hub event / be persisted / reach the model). Ownership guarantees the raw
//! body is consumed and never re-exposed (R2); redaction COMPLETENESS is best-effort,
//! bounded by the redactor's documented limits (see [`redact_inbound`]).
//!
//! Verifies an inbound channel request FAIL-CLOSED, AUTHENTICATE-before-AUTHORIZE:
//! 1. the channel must be `Active`;
//! 2. a valid store-handle auth ref must be configured (closes the A-PR1 review flag:
//!    the bearer secret lives in the Hub secure store, the binding holds only an opaque
//!    `kc://…` handle — code-enforced here, not just a doc contract);
//! 3. constant-time HMAC bearer verify against the resolved per-channel secret (reuses
//!    the proven `friday_crypto::verify_approval_signature` — a non-hex / truncated /
//!    empty / forged bearer fails closed);
//! 4. the sender must be in the channel's allowlist.
//!
//! Any miss → a distinct [`InboundRejection`] and NO [`VerifiedInbound`] — the caller
//! emits no Hub event / takes no side effect on `Err` (A-PR5). Authentication (3)
//! precedes authorization (4) so an unauthenticated caller cannot probe allowlist
//! membership.
//!
//! The per-channel secret lives ONLY in the Hub secure store ([`SecureStore`]); SQLite
//! holds only the handle. The wire bearer is HMAC-SHA256(secret, channel_id) hex — so a
//! bearer minted for one channel can never authenticate another (the HMAC binds the
//! channel id), and the raw secret never goes on the wire.
//!
//! DECISION (A-PR1 review flag — reserved-approval-action binding for `ActorKind::Channel`):
//! a channel actor should NOT be able to self-execute a reserved approve/deny action.
//! The gate's reserved-action hard-`Deny` currently binds ONLY `ActorKind::Agent`. A
//! channel-origin action does NOT reach the gate in A-PR2/A-PR3 (no event wiring yet);
//! the gate's `Channel` reserved-action binding MUST be added in A-PR4 (trigger safety /
//! channel→Hub action) BEFORE any channel-origin action is dispatched. Documented here
//! so it is not silently dropped; deliberately NOT bundled into this auth PR.

use friday_crypto::{sign_approval, verify_approval_signature, SecureStore};
use friday_storage::channel::{
    register_channel, ChannelBindingRow, ChannelKind, ChannelStatus, NewChannelBinding,
};
use friday_storage::StorageError;
use rusqlite::Connection;

/// Prefix of a secure-store handle ref (NOT a secret — points at the secret in the
/// Hub OS secure store).
const AUTH_REF_PREFIX: &str = "kc://channel/";

/// The canonical secure-store handle for a channel's inbound secret.
pub fn auth_ref_for(channel_id: &str) -> String {
    format!("{AUTH_REF_PREFIX}{channel_id}")
}

/// Is `auth_ref` a store HANDLE (not raw secret material)? A valid ref is the
/// `kc://channel/<id>` shape with a non-empty id. Closes the A-PR1 review flag that the
/// opaque-ref contract was doc-only: `verify_inbound` rejects (`NoAuthConfigured`) any
/// binding whose ref is not a store handle, so a stuffed raw secret never authenticates.
pub fn is_store_handle(auth_ref: &str) -> bool {
    auth_ref
        .strip_prefix(AUTH_REF_PREFIX)
        .is_some_and(|id| !id.is_empty())
}

/// The canonical inbound bearer for a channel: `HMAC-SHA256(secret_key, channel_id)` hex.
/// The operator configures THIS as the channel's inbound secret token (e.g. Telegram's
/// `secret_token`). The raw `secret_key` never goes on the wire.
pub fn expected_bearer(channel_id: &str, secret_key: &[u8]) -> String {
    sign_approval(channel_id.as_bytes(), secret_key)
}

/// Why an inbound request was rejected. Distinct variants for honest audit (A-PR5);
/// all are fail-closed (no verified context produced).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InboundRejection {
    /// The channel binding is `Disabled`.
    ChannelDisabled,
    /// No valid store-handle auth ref / no secret resolvable (fail-closed).
    NoAuthConfigured,
    /// The presented bearer failed the constant-time HMAC verify.
    BadBearer,
    /// The bearer was valid but the sender is not in the channel's allowlist.
    SenderNotAllowed,
}

/// A verified inbound request — the ONLY thing produced on success. Carries the channel,
/// the sender, and the bound owner principal, so the downstream Hub event / gate dispatch
/// acts as the channel's bound, non-anonymous principal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedInbound {
    pub channel_id: String,
    pub sender_id: String,
    pub bound_principal_id: String,
}

/// Verify an inbound request against a binding + the resolved per-channel `secret_key`.
/// Fail-closed, authenticate-before-authorize (see module docs).
///
/// SECURITY: `secret_key` MUST originate from the Hub [`SecureStore`] (via
/// [`resolve_and_verify`], the only intended production entry point). Passing a
/// caller-supplied / empty / wrong secret here would compute the constant-time HMAC
/// against a secret the caller controls — a forgeable bearer. This is `pub(crate)` (not
/// public API) so no out-of-crate caller can reach this raw-secret seam; in-crate
/// callers (e.g. the A-PR4 channel→Hub wiring) MUST route through `resolve_and_verify`.
pub(crate) fn verify_inbound(
    binding: &ChannelBindingRow,
    presented_bearer: &str,
    sender_id: &str,
    secret_key: &[u8],
) -> Result<VerifiedInbound, InboundRejection> {
    if binding.status != ChannelStatus::Active {
        return Err(InboundRejection::ChannelDisabled);
    }
    // The binding must carry a store-handle ref (not a stuffed secret).
    match binding.webhook_auth_ref.as_deref() {
        Some(r) if is_store_handle(r) => {}
        _ => return Err(InboundRejection::NoAuthConfigured),
    }
    // AUTHENTICATE (constant-time HMAC) before AUTHORIZE — don't leak allowlist
    // membership to an unauthenticated caller.
    if !verify_approval_signature(binding.channel_id.as_bytes(), secret_key, presented_bearer) {
        return Err(InboundRejection::BadBearer);
    }
    if !binding.allowlist.iter().any(|s| s == sender_id) {
        return Err(InboundRejection::SenderNotAllowed);
    }
    Ok(VerifiedInbound {
        channel_id: binding.channel_id.clone(),
        sender_id: sender_id.to_string(),
        bound_principal_id: binding.bound_principal_id.clone(),
    })
}

/// Resolve the channel's secret from the secure store (via its handle ref) and verify.
/// A missing handle / missing-in-store secret → `NoAuthConfigured` (fail-closed — the
/// secret is never in SQLite; if it is not in the store there is nothing to verify).
pub fn resolve_and_verify<S: SecureStore>(
    store: &S,
    binding: &ChannelBindingRow,
    presented_bearer: &str,
    sender_id: &str,
) -> Result<VerifiedInbound, InboundRejection> {
    let secret = match binding.webhook_auth_ref.as_deref() {
        Some(r) if is_store_handle(r) => match store.get(r) {
            Some(s) => s,
            None => return Err(InboundRejection::NoAuthConfigured),
        },
        _ => return Err(InboundRejection::NoAuthConfigured),
    };
    verify_inbound(binding, presented_bearer, sender_id, &secret)
}

/// Provision a channel's inbound auth: store the per-channel `secret_key` in the Hub
/// secure store under a `kc://…` handle (never SQLite), register the binding with that
/// handle, and return the bearer the operator configures. `secret_key` is caller-supplied
/// (operator config / a generated key) and must be >= 16 bytes.
#[allow(clippy::too_many_arguments)]
pub fn provision_channel_auth<S: SecureStore>(
    store: &mut S,
    conn: &Connection,
    channel_id: &str,
    kind: ChannelKind,
    bound_principal_id: &str,
    allowlist: &[String],
    secret_key: &[u8],
    created_at: i64,
) -> Result<String, StorageError> {
    if secret_key.len() < 16 {
        return Err(StorageError::Unsupported(
            "channel inbound secret key must be >= 16 bytes".into(),
        ));
    }
    let auth_ref = auth_ref_for(channel_id);
    // Register FIRST — register_channel enforces the bound-principal / allowlist
    // invariants (A-PR1) and fails closed on a duplicate channel_id. We store the secret
    // only AFTER a successful registration so a failed provision (e.g. dup id) can never
    // clobber an already-live channel's secret under the shared `kc://channel/<id>`
    // handle. The binding holds the handle, never the secret material.
    register_channel(
        conn,
        &NewChannelBinding {
            channel_id,
            kind,
            bound_principal_id,
            allowlist,
            webhook_auth_ref: Some(&auth_ref),
            created_at,
        },
    )?;
    // Secret material → Hub secure store ONLY (never SQLite).
    store.put(&auth_ref, secret_key);
    Ok(expected_bearer(channel_id, secret_key))
}

/// A verified inbound request whose message body has been PII-redacted (A-PR3). This is
/// the ONLY type that carries channel-origin content past the channel boundary into the
/// Hub (event / audit / reasoning in A-PR5). It has NO field holding the raw text — the
/// raw body is consumed by [`redact_inbound`] and never re-exposed, so a caller cannot
/// forward un-redacted channel content onward (the ownership guarantee, R2). Redaction
/// COMPLETENESS is bounded by the redactor — see [`redact_inbound`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactedInbound {
    pub channel_id: String,
    pub sender_id: String,
    pub bound_principal_id: String,
    /// The message body with every detected PII span replaced by its opaque marker.
    pub text: String,
    /// The DISTINCT PII kinds that were stripped (for honest audit — records THAT PII
    /// was present, never the values). Empty when the body was clean.
    pub pii_redacted: Vec<crate::cognition::PiiKind>,
}

/// Redact an authenticated inbound message body at the channel boundary.
///
/// `raw_text` is taken BY VALUE and is never re-exposed by [`RedactedInbound`] — so the
/// caller cannot forward the raw body onward (the ownership guarantee, R2). That is the
/// part ownership buys; it does NOT by itself make redaction "strict".
///
/// Redaction COMPLETENESS is delegated to and bounded by the single Hub redactor
/// [`crate::cognition::redact_pii`] (Email / Phone / SSN / credit-card-by-Luhn, with the
/// ASCII leading-boundary so PII adjacent to CJK is still stripped — the operator works
/// in Chinese). KNOWN RESIDUAL LIMIT: a value with an ASCII word/digit char glued to its
/// LEFT (e.g. `x123-45-6789`) can under-match — this layer inherits the redactor's
/// documented bounds and does not claim to defeat every evasion.
///
/// We apply the redactor to a fixpoint (release-active, bounded, never panics): tags like
/// `[EMAIL]` never re-match a pattern, so this converges in one pass for the current
/// patterns; the bounded loop is belt-and-braces against a future pattern that could
/// leave re-detectable residue, and replaces the prior debug-only assertion (which gave
/// zero protection in release and could panic on attacker input).
///
/// Only authenticated + allowlisted inbound (a [`VerifiedInbound`] from
/// [`resolve_and_verify`]) should reach this; this layer assumes auth already passed.
pub fn redact_inbound(verified: VerifiedInbound, raw_text: String) -> RedactedInbound {
    let mut text = raw_text; // moved in; overwritten/dropped below, never re-exposed
    let mut pii_redacted: Vec<crate::cognition::PiiKind> = Vec::new();
    for _ in 0..4 {
        let (redacted, kinds) = crate::cognition::redact_pii(&text);
        for k in kinds {
            if !pii_redacted.contains(&k) {
                pii_redacted.push(k);
            }
        }
        let converged = redacted == text;
        text = redacted;
        if converged {
            break;
        }
    }
    RedactedInbound {
        channel_id: verified.channel_id,
        sender_id: verified.sender_id,
        bound_principal_id: verified.bound_principal_id,
        text,
        pii_redacted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::InMemorySecureStore;
    use friday_storage::channel::get_channel;
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-chauth-{}-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
                nanos
            ))
            .to_string_lossy()
            .into_owned()
    }

    // Test-only HMAC input material — not a real credential. pragma: allowlist secret
    const SHARED: &[u8] = b"friday-chan-inbound-hmac-material-0123456";

    fn setup(tag: &str, allow: &[&str]) -> (Db, InMemorySecureStore, String) {
        let db = Db::open_hub(&tmp(tag)).unwrap();
        let mut store = InMemorySecureStore::new();
        let allowv: Vec<String> = allow.iter().map(|s| s.to_string()).collect();
        let bearer = provision_channel_auth(
            &mut store,
            db.conn(),
            "c1",
            ChannelKind::Telegram,
            "owner",
            &allowv,
            SHARED,
            1,
        )
        .unwrap();
        (db, store, bearer)
    }

    #[test]
    fn provision_then_valid_bearer_and_allowlisted_sender_verifies() {
        let (db, store, bearer) = setup("ok", &["sender-1"]);
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        // the binding stores the HANDLE, not the secret.
        assert_eq!(binding.webhook_auth_ref.as_deref(), Some("kc://channel/c1"));
        let v = resolve_and_verify(&store, &binding, &bearer, "sender-1").unwrap();
        assert_eq!(v.bound_principal_id, "owner");
        assert_eq!(v.sender_id, "sender-1");
    }

    #[test]
    fn unauthenticated_or_forged_bearer_is_rejected() {
        let (db, store, _bearer) = setup("badbearer", &["sender-1"]);
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        for bad in ["", "deadbeef", "not-hex-at-all", "00", &"a".repeat(64)] {
            assert_eq!(
                resolve_and_verify(&store, &binding, bad, "sender-1"),
                Err(InboundRejection::BadBearer),
                "bearer {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn valid_bearer_but_non_allowlisted_sender_is_rejected() {
        let (db, store, bearer) = setup("allow", &["sender-1"]);
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        assert_eq!(
            resolve_and_verify(&store, &binding, &bearer, "intruder"),
            Err(InboundRejection::SenderNotAllowed)
        );
    }

    #[test]
    fn disabled_channel_rejects_even_with_valid_bearer_and_sender() {
        let (db, store, bearer) = setup("disabled", &["sender-1"]);
        friday_storage::channel::set_channel_status(db.conn(), "c1", ChannelStatus::Disabled, 2)
            .unwrap();
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        assert_eq!(
            resolve_and_verify(&store, &binding, &bearer, "sender-1"),
            Err(InboundRejection::ChannelDisabled)
        );
    }

    #[test]
    fn cross_channel_bearer_does_not_authenticate_another_channel() {
        // A bearer minted for c1 must NOT verify for a different channel id (the HMAC
        // binds the channel id) — even with the same secret key.
        let bearer_c1 = expected_bearer("c1", SHARED);
        let db = Db::open_hub(&tmp("cross")).unwrap();
        let mut store = InMemorySecureStore::new();
        provision_channel_auth(
            &mut store,
            db.conn(),
            "c2",
            ChannelKind::Telegram,
            "owner",
            &["s".to_string()],
            SHARED,
            1,
        )
        .unwrap();
        let c2 = get_channel(db.conn(), "c2").unwrap().unwrap();
        assert_eq!(
            resolve_and_verify(&store, &c2, &bearer_c1, "s"),
            Err(InboundRejection::BadBearer)
        );
    }

    #[test]
    fn no_auth_configured_when_ref_is_not_a_store_handle_or_secret_missing() {
        // A binding registered WITHOUT a store-handle ref (raw value) → NoAuthConfigured,
        // even if a real bearer is presented.
        let db = Db::open_hub(&tmp("noauth")).unwrap();
        friday_storage::channel::register_channel(
            db.conn(),
            &NewChannelBinding {
                channel_id: "c1",
                kind: ChannelKind::Telegram,
                bound_principal_id: "owner",
                allowlist: &["s".to_string()],
                webhook_auth_ref: Some("raw-secret-not-a-handle"),
                created_at: 1,
            },
        )
        .unwrap();
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        let store = InMemorySecureStore::new();
        assert_eq!(
            resolve_and_verify(&store, &binding, &expected_bearer("c1", SHARED), "s"),
            Err(InboundRejection::NoAuthConfigured)
        );
        // a valid handle but no secret in the store → also NoAuthConfigured.
        let db2 = Db::open_hub(&tmp("noauth2")).unwrap();
        friday_storage::channel::register_channel(
            db2.conn(),
            &NewChannelBinding {
                channel_id: "c1",
                kind: ChannelKind::Telegram,
                bound_principal_id: "owner",
                allowlist: &["s".to_string()],
                webhook_auth_ref: Some("kc://channel/c1"),
                created_at: 1,
            },
        )
        .unwrap();
        let b2 = get_channel(db2.conn(), "c1").unwrap().unwrap();
        assert_eq!(
            resolve_and_verify(&InMemorySecureStore::new(), &b2, "00", "s"),
            Err(InboundRejection::NoAuthConfigured)
        );
    }

    #[test]
    fn is_store_handle_accepts_handles_rejects_raw() {
        assert!(is_store_handle("kc://channel/c1"));
        assert!(!is_store_handle("kc://channel/")); // empty id
        assert!(!is_store_handle("rawsecretmaterial"));
        assert!(!is_store_handle(""));
    }

    #[test]
    fn short_secret_key_is_refused() {
        let db = Db::open_hub(&tmp("shortkey")).unwrap();
        let mut store = InMemorySecureStore::new();
        assert!(provision_channel_auth(
            &mut store,
            db.conn(),
            "c1",
            ChannelKind::Telegram,
            "owner",
            &["s".to_string()],
            b"short",
            1
        )
        .is_err());
    }

    #[test]
    fn failed_reprovision_does_not_clobber_an_existing_channels_secret() {
        // A second provision for an existing channel_id must fail at registration
        // (dup PK) WITHOUT overwriting the live secret under the shared handle — the
        // original bearer must keep authenticating.
        let db = Db::open_hub(&tmp("reprov")).unwrap();
        let mut store = InMemorySecureStore::new();
        let allow = vec!["sender-1".to_string()];
        let bearer1 = provision_channel_auth(
            &mut store,
            db.conn(),
            "c1",
            ChannelKind::Telegram,
            "owner",
            &allow,
            SHARED,
            1,
        )
        .unwrap();
        // attempt to re-provision the SAME channel_id with a DIFFERENT key → must fail.
        let other_input = b"a-totally-different-hmac-input-material";
        assert!(provision_channel_auth(
            &mut store,
            db.conn(),
            "c1",
            ChannelKind::Telegram,
            "owner",
            &allow,
            other_input,
            2
        )
        .is_err());
        // the original secret is intact: the first bearer still verifies, and a bearer
        // computed from the rejected key does NOT.
        let binding = get_channel(db.conn(), "c1").unwrap().unwrap();
        assert!(resolve_and_verify(&store, &binding, &bearer1, "sender-1").is_ok());
        assert_eq!(
            resolve_and_verify(
                &store,
                &binding,
                &expected_bearer("c1", other_input),
                "sender-1"
            ),
            Err(InboundRejection::BadBearer)
        );
    }

    use crate::cognition::PiiKind;

    fn verified(text_owner: &str) -> VerifiedInbound {
        VerifiedInbound {
            channel_id: "c1".into(),
            sender_id: "sender-1".into(),
            bound_principal_id: text_owner.into(),
        }
    }

    #[test]
    fn redact_inbound_strips_every_pii_kind_and_keeps_no_original_value() {
        let raw = "mail me a@b.com or call 212-555-0143, ssn 123-45-6789, card 4111 1111 1111 1111";
        let out = redact_inbound(verified("owner"), raw.to_string());
        // no original PII value survives
        for leak in [
            "a@b.com",
            "212-555-0143",
            "123-45-6789",
            "4111 1111 1111 1111",
        ] {
            assert!(
                !out.text.contains(leak),
                "leaked {leak:?} in {:?}",
                out.text
            );
        }
        // every kind reported (distinct), provenance carried through
        for k in [
            PiiKind::Email,
            PiiKind::Phone,
            PiiKind::Ssn,
            PiiKind::CreditCard,
        ] {
            assert!(out.pii_redacted.contains(&k), "missing {k:?}");
        }
        assert_eq!(out.bound_principal_id, "owner");
        assert_eq!(out.sender_id, "sender-1");
    }

    #[test]
    fn redact_inbound_strips_secret_credentials_using_shared_redactor() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.e30.aaaaaaaaaaaaaaaa";
        let raw = format!(
            "inbound Authorization: Bearer sk-new1-inbound-canary123456 \
             github_pat_11NEW1CHANNEL_abcdefghijklmnopqrstuvwxyz1234567890 \
             \"access_token\": \"new1inboundjson123\" \
             jwt {jwt} \
             -----BEGIN PRIVATE KEY-----\nnew1-inbound-private-key\n-----END PRIVATE KEY-----"
        );

        let out = redact_inbound(verified("owner"), raw);

        for leak in [
            "sk-new1-inbound-canary123456",
            "github_pat_11NEW1CHANNEL_abcdefghijklmnopqrstuvwxyz1234567890",
            "new1inboundjson123",
            jwt,
            "new1-inbound-private-key",
        ] {
            assert!(
                !out.text.contains(leak),
                "channel inbound leaked secret credential {leak:?}: {:?}",
                out.text
            );
        }
        assert!(out.text.contains("[API_KEY]"), "missing API key marker");
        assert!(out.text.contains("[JWT]"), "missing JWT marker");
        assert!(
            out.text.contains("[PRIVATE_KEY]"),
            "missing private key marker"
        );
        assert!(
            !out.pii_redacted.is_empty(),
            "channel inbound must report redaction kinds"
        );
        assert_eq!(out.bound_principal_id, "owner");
        assert_eq!(out.sender_id, "sender-1");
    }

    #[test]
    fn redact_inbound_strips_pii_adjacent_to_cjk() {
        // The operator works in Chinese: PII glued to CJK (no ASCII space) must still be
        // stripped (the (?-u:\b) ASCII-boundary fix). The CJK text is preserved.
        let raw = "我的邮箱是a@b.com，电话212-555-0143，谢谢";
        let out = redact_inbound(verified("owner"), raw.to_string());
        assert!(!out.text.contains("a@b.com"));
        assert!(!out.text.contains("212-555-0143"));
        assert!(out.text.contains("我的邮箱是"));
        assert!(out.text.contains("谢谢"));
        assert!(out.pii_redacted.contains(&PiiKind::Email));
        assert!(out.pii_redacted.contains(&PiiKind::Phone));
    }

    #[test]
    fn redact_inbound_passes_clean_text_through_unchanged() {
        let raw = "hello friday, what's on my calendar today?";
        let out = redact_inbound(verified("owner"), raw.to_string());
        assert_eq!(out.text, raw);
        assert!(out.pii_redacted.is_empty());
    }

    #[test]
    fn redact_inbound_strips_card_followed_by_separator_joined_digits() {
        // Direct regression at the strict boundary for the confirmed BLOCKING leak: a
        // card followed by a separator-joined digit group (which made the greedy
        // candidate fail Luhn and get dropped) must NOT leak the PAN. Holds in release
        // (no debug-assert reliance) and must not panic.
        let out = redact_inbound(
            verified("owner"),
            "card 4012888888881881 000-00-0000".to_string(),
        );
        assert!(
            !out.text.contains("4012888888881881"),
            "PAN leaked: {:?}",
            out.text
        );
        assert!(out.pii_redacted.contains(&PiiKind::CreditCard));
    }

    #[test]
    fn redact_inbound_reports_a_repeated_kind_once() {
        let raw = "a@b.com and c@d.com and e@f.com";
        let out = redact_inbound(verified("owner"), raw.to_string());
        assert_eq!(out.pii_redacted, vec![PiiKind::Email]);
        assert!(!out.text.contains('@'));
    }
}
