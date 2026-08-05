use thiserror::Error;

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("storage adapter error: {0}")]
    Storage(String),

    #[error("record value must be a JSON object for field-level operation")]
    InvalidRecordValue,

    #[error("operation status is invalid: {0}")]
    InvalidOperationStatus(String),

    #[error("sync protocol response is invalid: {0}")]
    SyncProtocol(String),

    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),

    #[cfg(any(feature = "sqlite", feature = "mysql"))]
    #[error("sql adapter error: {0}")]
    Sql(#[from] sqlx::Error),
}
