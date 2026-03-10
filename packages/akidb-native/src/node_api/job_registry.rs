use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const JOB_REGISTRY_CREATE_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS files (
  source_path TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  doc_id TEXT NOT NULL,
  doc_version TEXT NOT NULL,
  chunk_ids TEXT NOT NULL DEFAULT '[]',
  last_ingest_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_message TEXT
);
"#;

const JOB_REGISTRY_UPSERT_SQL: &str = r#"
INSERT INTO files (source_path, fingerprint, size_bytes, mtime_ms, doc_id, doc_version, chunk_ids, last_ingest_at, status, error_message)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source_path) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  size_bytes = excluded.size_bytes,
  mtime_ms = excluded.mtime_ms,
  doc_id = excluded.doc_id,
  doc_version = excluded.doc_version,
  chunk_ids = excluded.chunk_ids,
  last_ingest_at = excluded.last_ingest_at,
  status = excluded.status,
  error_message = excluded.error_message;
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobRegistryFileRecord {
    source_path: String,
    fingerprint: String,
    #[serde(default)]
    size_bytes: i64,
    #[serde(default)]
    mtime_ms: f64,
    doc_id: String,
    doc_version: String,
    chunk_ids: Vec<String>,
    last_ingest_at: String,
    status: String,
    error_message: Option<String>,
}

/// SQLite-backed file registry used by `fabric-ingest`.
///
/// Kept as a separate N-API adapter so the main engine entrypoint stays focused
/// on collection, segment, manifest, and query operations.
#[napi]
pub struct JobRegistryNative {
    conn: Mutex<Option<Connection>>,
}

#[napi]
impl JobRegistryNative {
    #[napi(constructor)]
    pub fn new(db_path: String) -> Result<Self> {
        let conn = Connection::open(&db_path)
            .map_err(|e| Error::from_reason(format!("Failed to open job registry at {db_path}: {e}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| {
            Error::from_reason(format!(
                "Failed to configure job registry pragmas at {db_path}: {e}"
            ))
        })?;
        conn.execute_batch(JOB_REGISTRY_CREATE_TABLE_SQL)
            .map_err(|e| {
                Error::from_reason(format!(
                    "Failed to initialize job registry schema at {db_path}: {e}"
                ))
            })?;
        ensure_job_registry_columns(&conn)?;

        Ok(Self {
            conn: Mutex::new(Some(conn)),
        })
    }

    #[napi]
    pub fn get_file(&self, source_path: String) -> Result<Option<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT source_path, fingerprint, size_bytes, mtime_ms, doc_id, doc_version, chunk_ids, last_ingest_at, status, error_message
                     FROM files WHERE source_path = ?",
                )
                .map_err(to_napi_error)?;

            let row = stmt
                .query_row(params![source_path], |row| {
                    let chunk_ids_raw: String = row.get(6)?;
                    let chunk_ids = serde_json::from_str::<Vec<String>>(&chunk_ids_raw).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            6,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                    Ok(JobRegistryFileRecord {
                        source_path: row.get(0)?,
                        fingerprint: row.get(1)?,
                        size_bytes: row.get(2)?,
                        mtime_ms: row.get(3)?,
                        doc_id: row.get(4)?,
                        doc_version: row.get(5)?,
                        chunk_ids,
                        last_ingest_at: row.get(7)?,
                        status: row.get(8)?,
                        error_message: row.get(9)?,
                    })
                })
                .optional()
                .map_err(to_napi_error)?;

            match row {
                Some(record) => serde_json::to_string(&record)
                    .map(Some)
                    .map_err(|e| Error::from_reason(format!("Failed to serialize file record: {e}"))),
                None => Ok(None),
            }
        })
    }

    #[napi]
    pub fn upsert_file(&self, record_json: String) -> Result<()> {
        let record = serde_json::from_str::<JobRegistryFileRecord>(&record_json)
            .map_err(|e| Error::from_reason(format!("Invalid file record JSON: {e}")))?;

        self.with_conn(|conn| {
            conn.execute(
                JOB_REGISTRY_UPSERT_SQL,
                params![
                    record.source_path,
                    record.fingerprint,
                    record.size_bytes,
                    record.mtime_ms,
                    record.doc_id,
                    record.doc_version,
                    serde_json::to_string(&record.chunk_ids)
                        .map_err(|e| Error::from_reason(format!("Failed to encode chunk_ids: {e}")))?,
                    record.last_ingest_at,
                    record.status,
                    record.error_message,
                ],
            )
            .map_err(to_napi_error)?;
            Ok(())
        })
    }

    #[napi]
    pub fn delete_file(&self, source_path: String) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM files WHERE source_path = ?", params![source_path])
                .map_err(to_napi_error)?;
            Ok(())
        })
    }

    #[napi]
    pub fn list_files(&self) -> Result<String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT source_path, fingerprint, size_bytes, mtime_ms, doc_id, doc_version, chunk_ids, last_ingest_at, status, error_message
                     FROM files ORDER BY source_path",
                )
                .map_err(to_napi_error)?;
            let mut rows = stmt.query([]).map_err(to_napi_error)?;
            let mut out: Vec<JobRegistryFileRecord> = Vec::new();
            while let Some(row) = rows.next().map_err(to_napi_error)? {
                let chunk_ids_raw: String = row.get(6).map_err(to_napi_error)?;
                let chunk_ids = serde_json::from_str::<Vec<String>>(&chunk_ids_raw)
                    .map_err(|e| Error::from_reason(format!("Invalid chunk_ids JSON in registry: {e}")))?;
                out.push(JobRegistryFileRecord {
                    source_path: row.get(0).map_err(to_napi_error)?,
                    fingerprint: row.get(1).map_err(to_napi_error)?,
                    size_bytes: row.get(2).map_err(to_napi_error)?,
                    mtime_ms: row.get(3).map_err(to_napi_error)?,
                    doc_id: row.get(4).map_err(to_napi_error)?,
                    doc_version: row.get(5).map_err(to_napi_error)?,
                    chunk_ids,
                    last_ingest_at: row.get(7).map_err(to_napi_error)?,
                    status: row.get(8).map_err(to_napi_error)?,
                    error_message: row.get(9).map_err(to_napi_error)?,
                });
            }
            serde_json::to_string(&out)
                .map_err(|e| Error::from_reason(format!("Failed to serialize file list: {e}")))
        })
    }

    #[napi]
    pub fn get_known_file_states(&self) -> Result<String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT source_path, fingerprint, size_bytes, mtime_ms FROM files")
                .map_err(to_napi_error)?;
            let mut rows = stmt.query([]).map_err(to_napi_error)?;
            let mut out = serde_json::Map::new();
            while let Some(row) = rows.next().map_err(to_napi_error)? {
                let source_path: String = row.get(0).map_err(to_napi_error)?;
                let fingerprint: String = row.get(1).map_err(to_napi_error)?;
                let size_bytes: i64 = row.get(2).map_err(to_napi_error)?;
                let mtime_ms: f64 = row.get(3).map_err(to_napi_error)?;
                out.insert(source_path, serde_json::json!({
                    "fingerprint": fingerprint,
                    "sizeBytes": size_bytes,
                    "mtimeMs": mtime_ms,
                }));
            }
            Ok(serde_json::Value::Object(out).to_string())
        })
    }

    #[napi]
    pub fn get_known_fingerprints(&self) -> Result<String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT source_path, fingerprint FROM files")
                .map_err(to_napi_error)?;
            let mut rows = stmt.query([]).map_err(to_napi_error)?;
            let mut out = serde_json::Map::new();
            while let Some(row) = rows.next().map_err(to_napi_error)? {
                let source_path: String = row.get(0).map_err(to_napi_error)?;
                let fingerprint: String = row.get(1).map_err(to_napi_error)?;
                out.insert(source_path, serde_json::Value::String(fingerprint));
            }
            Ok(serde_json::Value::Object(out).to_string())
        })
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| Error::from_reason("JobRegistryNative lock poisoned"))?;
        if let Some(conn) = guard.take() {
            conn.close()
                .map_err(|(_, e)| Error::from_reason(format!("Failed to close job registry: {e}")))?;
        }
        Ok(())
    }
}

impl JobRegistryNative {
    fn with_conn<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let guard = self
            .conn
            .lock()
            .map_err(|_| Error::from_reason("JobRegistryNative lock poisoned"))?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| Error::from_reason("Job registry is closed"))?;
        f(conn)
    }
}

fn to_napi_error(err: rusqlite::Error) -> Error {
    Error::from_reason(format!("SQLite error: {err}"))
}

fn ensure_job_registry_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(files)")
        .map_err(to_napi_error)?;
    let mut rows = stmt.query([]).map_err(to_napi_error)?;
    let mut has_size_bytes = false;
    let mut has_mtime_ms = false;

    while let Some(row) = rows.next().map_err(to_napi_error)? {
        let name: String = row.get(1).map_err(to_napi_error)?;
        if name == "size_bytes" {
            has_size_bytes = true;
        } else if name == "mtime_ms" {
            has_mtime_ms = true;
        }
    }

    if !has_size_bytes {
        conn.execute(
            "ALTER TABLE files ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(to_napi_error)?;
    }
    if !has_mtime_ms {
        conn.execute(
            "ALTER TABLE files ADD COLUMN mtime_ms REAL NOT NULL DEFAULT 0",
            [],
        )
        .map_err(to_napi_error)?;
    }

    Ok(())
}
