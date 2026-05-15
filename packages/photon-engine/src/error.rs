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

    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),

    #[cfg(feature = "sqlite")]
    #[error("sqlite adapter error: {0}")]
    Sqlite(#[from] sqlx::Error),
}
