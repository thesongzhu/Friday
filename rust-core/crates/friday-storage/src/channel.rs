//! Channel binding persistence (Channels track, A-PR1; `02` channels, `09` §1/§2).
//! Hub-only (a channel binding holds the owner principal + inbound-auth reference;
//! never on a phone).
//!
//! Trusted-inbound foundation: each binding ties a channel (Telegram first) to a
//! BOUND OWNER PRINCIPAL. The single write path [`register_channel`] FAILS CLOSED on
//! an anonymous / public / empty bound principal — reusing the exact
//! [`friday_core::gate::is_anonymous_principal`] sentinel the gate uses — so an
//! unbound/anonymous channel can never be persisted (the bound-principal invariant is
//! unrepresentable through this API, not merely discouraged).
//!
//! No secret material in SQLite (`09` §3 / gate 21 §3): `webhook_auth_ref` is an
//! OPAQUE REFERENCE to the per-channel inbound bearer secret held in the Hub OS secure
//! store (`friday_crypto::InMemorySecureStore` in v1) — never the secret itself.

use crate::error::{Result, StorageError};
use friday_core::gate::{is_anonymous_principal, Actor, ActorKind};
use rusqlite::{params, Connection, OptionalExtension};

/// A messaging channel kind. Telegram is the first live lane; the others are typed
/// (so a binding can be recorded) but their live lanes are deferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelKind {
    Telegram,
    Discord,
    Lark,
    Feishu,
}

impl ChannelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelKind::Telegram => "telegram",
            ChannelKind::Discord => "discord",
            ChannelKind::Lark => "lark",
            ChannelKind::Feishu => "feishu",
        }
    }

    /// Parse a stored kind token. Returns `None` for an unknown token — the read path
    /// then fails closed (a corrupted row is never silently mis-typed).
    pub fn parse(s: &str) -> Option<ChannelKind> {
        match s {
            "telegram" => Some(ChannelKind::Telegram),
            "discord" => Some(ChannelKind::Discord),
            "lark" => Some(ChannelKind::Lark),
            "feishu" => Some(ChannelKind::Feishu),
            _ => None,
        }
    }

    /// Canonical kind (deterministic alias remap, UNW-005): Lark and Feishu are the
    /// same platform — both canonicalize to `Feishu`. Applied at registration so the
    /// stored kind is always canonical.
    pub fn canonical(self) -> ChannelKind {
        match self {
            ChannelKind::Lark => ChannelKind::Feishu,
            other => other,
        }
    }
}

/// A channel binding's lifecycle status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelStatus {
    Active,
    Disabled,
}

impl ChannelStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelStatus::Active => "active",
            ChannelStatus::Disabled => "disabled",
        }
    }
    fn parse(s: &str) -> ChannelStatus {
        // Fail-closed default: an unknown/garbage status reads as Disabled (never Active).
        match s {
            "active" => ChannelStatus::Active,
            _ => ChannelStatus::Disabled,
        }
    }
}

/// A persisted channel binding (mirrors `channel_binding`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelBindingRow {
    pub channel_id: String,
    /// Always canonical (alias-remapped at registration).
    pub kind: ChannelKind,
    /// The bound OWNER principal — guaranteed non-anonymous by [`register_channel`].
    pub bound_principal_id: String,
    /// Allowed inbound sender ids (a non-allowlisted sender is rejected, A-PR2).
    pub allowlist: Vec<String>,
    /// OPAQUE reference to the inbound bearer secret in the Hub OS secure store —
    /// NEVER the secret material.
    pub webhook_auth_ref: Option<String>,
    pub status: ChannelStatus,
    pub created_at: i64,
}

/// A channel binding to register.
#[derive(Clone, Debug)]
pub struct NewChannelBinding<'a> {
    pub channel_id: &'a str,
    pub kind: ChannelKind,
    /// The bound owner principal — MUST be non-anonymous (enforced).
    pub bound_principal_id: &'a str,
    pub allowlist: &'a [String],
    pub webhook_auth_ref: Option<&'a str>,
    pub created_at: i64,
}

const SELECT_COLS: &str =
    "channel_id, kind, bound_principal_id, allowlist, webhook_auth_ref, status, created_at";

// Allowlist is stored newline-joined (sender ids never contain a newline — guarded at
// registration). Empty list ⇒ empty string.
fn encode_allowlist(ids: &[String]) -> String {
    ids.join("\n")
}
fn decode_allowlist(s: &str) -> Vec<String> {
    if s.is_empty() {
        Vec::new()
    } else {
        s.split('\n').map(|x| x.to_string()).collect()
    }
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<ChannelBindingRow> {
    let kind_s: String = r.get("kind")?;
    let kind = ChannelKind::parse(&kind_s).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown channel kind '{kind_s}'").into(),
        )
    })?;
    let status: String = r.get("status")?;
    let allowlist: String = r.get("allowlist")?;
    Ok(ChannelBindingRow {
        channel_id: r.get("channel_id")?,
        kind,
        bound_principal_id: r.get("bound_principal_id")?,
        allowlist: decode_allowlist(&allowlist),
        webhook_auth_ref: r.get("webhook_auth_ref")?,
        status: ChannelStatus::parse(&status),
        created_at: r.get("created_at")?,
    })
}

/// Register a channel binding. FAILS CLOSED when:
/// - `channel_id` is empty;
/// - the bound principal is anonymous/public/empty (the trusted-inbound bound-principal
///   invariant — reuses [`friday_core::gate::is_anonymous_principal`]);
/// - any allowlist sender id is empty or contains a newline (the storage delimiter).
///
/// The kind is canonicalized (alias remap) and the binding is stored `Active`. A
/// duplicate `channel_id` is a PK violation (no silent re-bind / takeover).
pub fn register_channel(conn: &Connection, b: &NewChannelBinding) -> Result<()> {
    if b.channel_id.trim().is_empty() {
        return Err(StorageError::Unsupported(
            "channel_id must be non-empty".into(),
        ));
    }
    // Bound-principal invariant: reject an anonymous/public/empty owner — the SAME
    // sentinel set the gate uses, evaluated for an ActorKind::Channel actor.
    let actor = Actor {
        kind: ActorKind::Channel,
        id: b.channel_id.to_string(),
        principal_id: Some(b.bound_principal_id.to_string()),
    };
    if is_anonymous_principal(&actor) {
        return Err(StorageError::Unsupported(format!(
            "channel '{}' must bind a non-anonymous owner principal (got '{}')",
            b.channel_id, b.bound_principal_id
        )));
    }
    for sender in b.allowlist {
        if sender.trim().is_empty() || sender.contains('\n') {
            return Err(StorageError::Unsupported(
                "allowlist sender ids must be non-empty and newline-free".into(),
            ));
        }
    }
    conn.execute(
        "INSERT INTO channel_binding
            (channel_id, kind, bound_principal_id, allowlist, webhook_auth_ref, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            b.channel_id,
            b.kind.canonical().as_str(),
            b.bound_principal_id,
            encode_allowlist(b.allowlist),
            b.webhook_auth_ref,
            ChannelStatus::Active.as_str(),
            b.created_at
        ],
    )?;
    Ok(())
}

pub fn get_channel(conn: &Connection, channel_id: &str) -> Result<Option<ChannelBindingRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM channel_binding WHERE channel_id = ?1"),
            [channel_id],
            row_from,
        )
        .optional()?;
    Ok(row)
}

/// All bindings, deterministically ordered by channel_id.
pub fn list_channels(conn: &Connection) -> Result<Vec<ChannelBindingRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM channel_binding ORDER BY channel_id"
    ))?;
    let rows = stmt.query_map([], row_from)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Enable/disable a channel (a disabled channel rejects inbound — enforced at A-PR2).
/// No-op for an unknown id.
pub fn set_channel_status(
    conn: &Connection,
    channel_id: &str,
    status: ChannelStatus,
    _now: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE channel_binding SET status = ?1 WHERE channel_id = ?2",
        params![status.as_str(), channel_id],
    )?;
    Ok(())
}

/// The gate [`Actor`] for a channel binding — an `ActorKind::Channel` actor bound to
/// the owner principal. This is how channel-origin actions enter the UNW-001 gate
/// (a channel can NEVER self-execute a reserved approval action, and an anonymous
/// channel is impossible since `register_channel` refuses to persist one).
pub fn channel_actor(row: &ChannelBindingRow) -> Actor {
    Actor {
        kind: ActorKind::Channel,
        id: row.channel_id.clone(),
        principal_id: Some(row.bound_principal_id.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-channel-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn nb<'a>(
        id: &'a str,
        kind: ChannelKind,
        owner: &'a str,
        allow: &'a [String],
    ) -> NewChannelBinding<'a> {
        NewChannelBinding {
            channel_id: id,
            kind,
            bound_principal_id: owner,
            allowlist: allow,
            webhook_auth_ref: Some("kc://chan/secret-ref"),
            created_at: 1,
        }
    }

    #[test]
    fn register_and_read_back_canonicalizes_kind_and_actor_is_channel_bound() {
        let db = Db::open_hub(&tmp("ok")).unwrap();
        let allow = vec!["sender-1".to_string(), "sender-2".to_string()];
        register_channel(db.conn(), &nb("c1", ChannelKind::Telegram, "owner", &allow)).unwrap();
        let row = get_channel(db.conn(), "c1").unwrap().unwrap();
        assert_eq!(row.kind, ChannelKind::Telegram);
        assert_eq!(row.bound_principal_id, "owner");
        assert_eq!(row.allowlist, allow);
        assert_eq!(row.status, ChannelStatus::Active);
        // the channel actor is a bound, non-anonymous Channel actor.
        let actor = channel_actor(&row);
        assert_eq!(actor.kind, ActorKind::Channel);
        assert!(!is_anonymous_principal(&actor));
    }

    #[test]
    fn lark_canonicalizes_to_feishu_on_registration() {
        let db = Db::open_hub(&tmp("alias")).unwrap();
        register_channel(db.conn(), &nb("c1", ChannelKind::Lark, "owner", &[])).unwrap();
        assert_eq!(
            get_channel(db.conn(), "c1").unwrap().unwrap().kind,
            ChannelKind::Feishu
        );
    }

    #[test]
    fn anonymous_or_public_or_empty_owner_is_refused() {
        let db = Db::open_hub(&tmp("anon")).unwrap();
        for bad in ["", "   ", "public", "PUBLIC", "public:default"] {
            assert!(
                register_channel(db.conn(), &nb("c1", ChannelKind::Telegram, bad, &[])).is_err(),
                "bound principal '{bad}' must be refused"
            );
        }
        // none were persisted.
        assert!(list_channels(db.conn()).unwrap().is_empty());
    }

    #[test]
    fn empty_id_and_bad_allowlist_refused() {
        let db = Db::open_hub(&tmp("bad")).unwrap();
        assert!(register_channel(db.conn(), &nb("", ChannelKind::Telegram, "owner", &[])).is_err());
        let nl = vec!["a\nb".to_string()];
        assert!(
            register_channel(db.conn(), &nb("c1", ChannelKind::Telegram, "owner", &nl)).is_err()
        );
        let empty_sender = vec!["".to_string()];
        assert!(register_channel(
            db.conn(),
            &nb("c2", ChannelKind::Telegram, "owner", &empty_sender)
        )
        .is_err());
    }

    #[test]
    fn duplicate_channel_id_is_refused_no_silent_rebind() {
        let db = Db::open_hub(&tmp("dup")).unwrap();
        register_channel(db.conn(), &nb("c1", ChannelKind::Telegram, "owner-a", &[])).unwrap();
        // a second registration of the same id (even a different owner) must fail (PK).
        assert!(
            register_channel(db.conn(), &nb("c1", ChannelKind::Telegram, "owner-b", &[])).is_err()
        );
        assert_eq!(
            get_channel(db.conn(), "c1")
                .unwrap()
                .unwrap()
                .bound_principal_id,
            "owner-a"
        );
    }

    #[test]
    fn disable_flips_status_and_list_is_ordered() {
        let db = Db::open_hub(&tmp("disable")).unwrap();
        register_channel(db.conn(), &nb("b", ChannelKind::Telegram, "owner", &[])).unwrap();
        register_channel(db.conn(), &nb("a", ChannelKind::Telegram, "owner", &[])).unwrap();
        set_channel_status(db.conn(), "a", ChannelStatus::Disabled, 2).unwrap();
        let ids: Vec<String> = list_channels(db.conn())
            .unwrap()
            .into_iter()
            .map(|r| r.channel_id)
            .collect();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(
            get_channel(db.conn(), "a").unwrap().unwrap().status,
            ChannelStatus::Disabled
        );
    }

    #[test]
    fn channel_binding_is_hub_only_absent_on_phone() {
        let db = Db::open_phone(&tmp("phone")).unwrap();
        assert!(!db
            .table_names()
            .unwrap()
            .iter()
            .any(|t| t == "channel_binding"));
    }
}
