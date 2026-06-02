use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// On-disk schema is newer than this build understands. We refuse to open
    /// rather than silently downgrade (gate 21 §2.2).
    #[error("on-disk schema (v{disk}) is newer than this build (v{code}); refusing to open")]
    SchemaTooNew { disk: i64, code: i64 },

    #[error("destructive-migration backup failed: {0}")]
    BackupVerify(String),

    /// Audit hash-chain verification found a tampered/missing row.
    #[error("audit chain broken at audit_id={0}")]
    AuditChainBroken(String),

    #[error("unsupported for this profile: {0}")]
    Unsupported(String),

    #[error("core error: {0}")]
    Core(#[from] friday_core::CoreError),

    #[error("crypto error: {0}")]
    Crypto(#[from] friday_crypto::CryptoError),
}

pub type Result<T> = std::result::Result<T, StorageError>;
