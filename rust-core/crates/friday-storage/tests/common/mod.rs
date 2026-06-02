//! Shared helpers for friday-storage integration tests.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh on-disk SQLite path under the OS temp dir (needs a real file so the
/// destructive-migration backup guard can copy it).
pub fn temp_db_path(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-storage-test-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("db.sqlite");
    dir.to_string_lossy().to_string()
}
