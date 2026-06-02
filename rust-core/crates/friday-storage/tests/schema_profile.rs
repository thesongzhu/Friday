//! Profile schema split: the phone DB omits the Hub-only secret/audit tables,
//! the Hub omits phone-only tables, and no profile has a provider-secret table
//! (gate 21 §2/§3, §8 Unit-2 "negative — secrets on phone").

mod common;

use common::temp_db_path;
use friday_storage::{Db, HUB_ONLY_TABLES, PHONE_ONLY_TABLES};

#[test]
fn phone_omits_hub_only_tables_and_has_phone_only() {
    let pp = temp_db_path("phone-schema");
    let phone = Db::open_phone(&pp).unwrap();
    let ptables = phone.table_names().unwrap();
    for t in HUB_ONLY_TABLES {
        assert!(
            !ptables.iter().any(|x| x == t),
            "phone schema must NOT contain hub-only table {t}: {ptables:?}"
        );
    }
    for t in PHONE_ONLY_TABLES {
        assert!(
            ptables.iter().any(|x| x == t),
            "phone schema missing phone-only table {t}: {ptables:?}"
        );
    }
}

#[test]
fn hub_has_hub_only_tables_and_omits_phone_only() {
    let hp = temp_db_path("hub-schema");
    let hub = Db::open_hub(&hp).unwrap();
    let htables = hub.table_names().unwrap();
    for t in HUB_ONLY_TABLES {
        assert!(
            htables.iter().any(|x| x == t),
            "hub schema missing hub-only table {t}: {htables:?}"
        );
    }
    for t in PHONE_ONLY_TABLES {
        assert!(
            !htables.iter().any(|x| x == t),
            "hub schema must NOT contain phone-only table {t}: {htables:?}"
        );
    }
}

#[test]
fn no_provider_secret_table_in_any_profile() {
    // Provider creds live only in OS secure storage, never SQLite (gate 21 §3).
    // No table name in either profile may resemble a secret/credential store.
    let forbidden = [
        "secret",
        "apikey",
        "api_key",
        "token_secret",
        "provider_key",
        "deepseek_key",
        "credential",
    ];
    let hp = temp_db_path("hub-sec");
    let pp = temp_db_path("phone-sec");
    let hub = Db::open_hub(&hp).unwrap();
    let phone = Db::open_phone(&pp).unwrap();
    for db in [&hub, &phone] {
        for t in db.table_names().unwrap() {
            let lower = t.to_lowercase();
            for f in forbidden {
                assert!(!lower.contains(f), "table {t} looks like a secret store");
            }
        }
    }
}
