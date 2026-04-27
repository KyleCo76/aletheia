use thiserror::Error;

#[derive(Debug, Error)]
pub enum AletheiaError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TOML parse error: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Auth error: {0}")]
    Auth(String),

    #[error("Scope error: {0}")]
    Scope(String),

    #[error("Migration in progress — tool calls blocked until migration completes")]
    MigrationInProgress,

    #[error("Tool removed since {since}: {hint}")]
    ToolRemoved { since: String, hint: String },

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AletheiaError>;
