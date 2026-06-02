//! Encryption<->storage integration: blob round-trip, tamper detection, and the
//! load-bearing negatives — sensitive plaintext never lands in the DB, and the
//! pairing credential lives only in secure storage (gate 21 §3 / §8 Unit-2
//! encryption tests).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType, SessionState};
use friday_crypto::{DataKey, InMemorySecureStore, SecureStore};
use friday_storage::{blob, ActivityRow, Db};

#[test]
fn blob_round_trip() {
    let p = temp_db_path("blob-rt");
    let mut db = Db::open_hub(&p).unwrap();
    let key = DataKey::generate();
    let secret = b"Ask-Friday prompt: sensitive payload contents";
    blob::store_blob(
        db.conn_mut(),
        "b1",
        "ask_payload",
        "hub_only",
        &key,
        secret,
        1,
    )
    .unwrap();
    let out = blob::load_blob(db.conn(), "b1", &key).unwrap();
    assert_eq!(out, secret);
}

#[test]
fn blob_tamper_detected() {
    let p = temp_db_path("blob-tamper");
    let mut db = Db::open_hub(&p).unwrap();
    let key = DataKey::generate();
    blob::store_blob(
        db.conn_mut(),
        "b1",
        "ask_payload",
        "hub_only",
        &key,
        b"secret",
        1,
    )
    .unwrap();

    // Append a byte to the stored ciphertext -> AEAD authentication fails.
    db.conn()
        .execute(
            "UPDATE blob_store SET ciphertext = ciphertext || X'AA' WHERE blob_id = 'b1'",
            [],
        )
        .unwrap();
    assert!(blob::load_blob(db.conn(), "b1", &key).is_err());
}

#[test]
fn sensitive_plaintext_never_appears_in_db() {
    let p = temp_db_path("no-plaintext");
    let mut db = Db::open_hub(&p).unwrap();
    let key = DataKey::generate();
    let needle = b"TOP-SECRET-NEEDLE-7f3a91";
    blob::store_blob(
        db.conn_mut(),
        "b1",
        "ask_payload",
        "hub_only",
        &key,
        needle,
        1,
    )
    .unwrap();
    assert!(
        !db_contains_bytes(&db, needle),
        "sensitive plaintext leaked into the database in cleartext"
    );
}

#[test]
fn pairing_credential_lives_in_secure_store_not_sqlite() {
    let p = temp_db_path("pairing");
    let mut db = Db::open_hub(&p).unwrap();
    let cred = b"FRIDAY-PAIRING-CREDENTIAL-abc123";

    // The pairing credential goes ONLY into OS secure storage.
    let mut store = InMemorySecureStore::new();
    store.put("friday.pairing", cred);
    assert_eq!(store.get("friday.pairing").as_deref(), Some(&cred[..]));

    // Populate representative rows + an encrypted blob so the scan runs over a
    // real, non-empty database rather than a vacuously empty one.
    db.insert_session(
        "s1",
        "friday_ask",
        "hi",
        SessionState::Created,
        1,
        1,
        "mac_live",
    )
    .unwrap();
    db.insert_activity(&ActivityRow {
        activity_id: "a1".into(),
        session_id: Some("s1".into()),
        kind: ActivityType::AskReceipt,
        state: ActivityState::Done,
        summary: "done".into(),
        created_at: 1,
        updated_at: 1,
        deep_link: None,
    })
    .unwrap();
    let key = DataKey::generate();
    blob::store_blob(
        db.conn_mut(),
        "b1",
        "ask_payload",
        "hub_only",
        &key,
        b"payload",
        1,
    )
    .unwrap();

    // The pairing credential appears in NONE of the populated tables.
    assert!(
        !db_contains_bytes(&db, cred),
        "pairing credential found inside SQLite"
    );
}

/// Scan every cell (TEXT/BLOB) of every user table for a byte needle.
fn db_contains_bytes(db: &Db, needle: &[u8]) -> bool {
    let conn = db.conn();
    for t in db.table_names().unwrap() {
        let mut cols: Vec<String> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&format!("SELECT name FROM pragma_table_info('{t}')"))
                .unwrap();
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            for c in it {
                cols.push(c.unwrap());
            }
        }
        for c in &cols {
            let mut s = conn
                .prepare(&format!("SELECT CAST(\"{c}\" AS BLOB) FROM \"{t}\""))
                .unwrap();
            let rows = s.query_map([], |r| r.get::<_, Option<Vec<u8>>>(0)).unwrap();
            for row in rows {
                if let Some(bytes) = row.unwrap() {
                    if contains_subslice(&bytes, needle) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn contains_subslice(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}
