use async_trait::async_trait;
use sqlx::{mysql::MySqlPoolOptions, MySql, MySqlPool, QueryBuilder, Row};

use crate::{
    projection::apply_operation,
    storage::StorageAdapter,
    types::{
        unix_time_ms, CollectionName, Conflict, Operation, OperationFilter, OperationId,
        OperationStatus, Record, RecordId, RecordKey, RemoteId, ScopeId, Snapshot, SnapshotFormat,
        SnapshotUpdate, StoredOperation, SyncCursor,
    },
    EngineError, Result,
};

#[derive(Clone, Debug)]
pub struct MySqlAdapter {
    pool: MySqlPool,
}

impl MySqlAdapter {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let database_url = Self::normalize_database_url(database_url);
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await?;
        let adapter = Self { pool };
        adapter.migrate().await?;
        Ok(adapter)
    }

    pub fn normalize_database_url(database_url: &str) -> String {
        database_url
            .strip_prefix("tidb://")
            .map(|rest| format!("mysql://{rest}"))
            .unwrap_or_else(|| database_url.to_owned())
    }

    pub fn from_pool(pool: MySqlPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }

    /// Apply every schema migration this build knows about, in order,
    /// recording each in `photon_engine_schema_migrations`.
    ///
    /// MySQL/TiDB DDL is not transactional, so each migration's statements
    /// must be individually idempotent (`IF NOT EXISTS`, index-existence
    /// checks): a crash mid-migration is then repaired by simply running
    /// `migrate()` again.
    pub async fn migrate(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_schema_migrations (
                version BIGINT NOT NULL PRIMARY KEY,
                name VARCHAR(191) NOT NULL,
                applied_at_ms BIGINT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        let current = self.schema_version().await?;
        for (version, name) in SCHEMA_MIGRATIONS {
            if *version <= current {
                continue;
            }
            self.apply_migration(*version).await?;
            sqlx::query(
                "INSERT INTO photon_engine_schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
            )
            .bind(version)
            .bind(name)
            .bind(unix_time_ms())
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Highest applied schema migration version, 0 when none have run.
    pub async fn schema_version(&self) -> Result<i64> {
        let version: Option<i64> =
            sqlx::query_scalar("SELECT MAX(version) FROM photon_engine_schema_migrations")
                .fetch_one(&self.pool)
                .await?;
        Ok(version.unwrap_or(0))
    }

    async fn apply_migration(&self, version: i64) -> Result<()> {
        match version {
            1 => self.migrate_v1_initial_schema().await,
            2 => self.migrate_v2_authority_sequence().await,
            unknown => Err(EngineError::Storage(format!(
                "unknown photon-engine schema migration version {unknown}"
            ))),
        }
    }

    async fn migrate_v1_initial_schema(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_operations (
                local_sequence BIGINT PRIMARY KEY AUTO_INCREMENT,
                operation_id VARCHAR(191) NOT NULL UNIQUE,
                scope VARCHAR(191) NOT NULL,
                collection VARCHAR(191) NOT NULL,
                record_id VARCHAR(191) NOT NULL,
                actor_id VARCHAR(191) NOT NULL,
                status VARCHAR(32) NOT NULL,
                remote_sequence BIGINT,
                received_at_ms BIGINT NOT NULL,
                operation_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        create_index_if_missing(
            &self.pool,
            "photon_engine_operations",
            "idx_photon_engine_operations_scope",
            "CREATE INDEX idx_photon_engine_operations_scope ON photon_engine_operations(scope, collection, status, remote_sequence)",
        )
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_records (
                scope VARCHAR(191) NOT NULL,
                collection VARCHAR(191) NOT NULL,
                record_id VARCHAR(191) NOT NULL,
                record_json TEXT NOT NULL,
                PRIMARY KEY (scope, collection, record_id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_cursors (
                scope VARCHAR(191) NOT NULL,
                remote VARCHAR(191) NOT NULL,
                cursor_json TEXT NOT NULL,
                PRIMARY KEY (scope, remote)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_conflicts (
                conflict_id VARCHAR(191) NOT NULL PRIMARY KEY,
                scope VARCHAR(191) NOT NULL,
                collection VARCHAR(191) NOT NULL,
                record_id VARCHAR(191) NOT NULL,
                operation_id VARCHAR(191) NOT NULL,
                conflict_json TEXT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_snapshots (
                scope VARCHAR(191) NOT NULL,
                collection VARCHAR(191) NOT NULL,
                record_id VARCHAR(191) NOT NULL,
                format VARCHAR(64) NOT NULL,
                sequence BIGINT NOT NULL,
                payload LONGBLOB NOT NULL,
                metadata_json TEXT NOT NULL,
                updated_at_ms BIGINT NOT NULL,
                PRIMARY KEY (scope, collection, record_id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_snapshot_updates (
                scope VARCHAR(191) NOT NULL,
                collection VARCHAR(191) NOT NULL,
                record_id VARCHAR(191) NOT NULL,
                sequence BIGINT NOT NULL,
                format VARCHAR(64) NOT NULL,
                payload LONGBLOB NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at_ms BIGINT NOT NULL,
                PRIMARY KEY (scope, collection, record_id, sequence)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        create_index_if_missing(
            &self.pool,
            "photon_engine_snapshot_updates",
            "idx_photon_engine_snapshot_updates_key_sequence",
            "CREATE INDEX idx_photon_engine_snapshot_updates_key_sequence ON photon_engine_snapshot_updates(scope, collection, record_id, sequence)",
        )
        .await?;

        Ok(())
    }

    /// The authority's remote-sequence allocator.
    ///
    /// A single row, so that locking it is a database-wide lock: whichever
    /// transaction holds it is the only one allocating a sequence, whether the
    /// others are pool connections, processes, or hosts. This is what lets more
    /// than one Engine instance share one database.
    async fn migrate_v2_authority_sequence(&self) -> Result<()> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS photon_engine_sync_state (
                id TINYINT NOT NULL PRIMARY KEY,
                next_sequence BIGINT NOT NULL
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Seed past whatever an in-process allocator already handed out, so an
        // existing op-log does not get its sequences reissued.
        sqlx::query(
            r#"
            INSERT IGNORE INTO photon_engine_sync_state (id, next_sequence)
            SELECT 1, COALESCE(MAX(remote_sequence), 0) + 1
            FROM photon_engine_operations
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }
}

/// Every schema version this build knows how to reach, in order. Append-only:
/// a released migration is never edited, schema changes get a new entry.
const SCHEMA_MIGRATIONS: &[(i64, &str)] = &[
    (1, "initial engine schema"),
    (2, "authority remote-sequence state"),
];

async fn create_index_if_missing(
    pool: &MySqlPool,
    table_name: &str,
    index_name: &str,
    create_statement: &str,
) -> Result<()> {
    let exists: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND index_name = ?
        "#,
    )
    .bind(table_name)
    .bind(index_name)
    .fetch_one(pool)
    .await?;

    if exists == 0 {
        sqlx::query(create_statement).execute(pool).await?;
    }

    Ok(())
}

#[async_trait]
impl StorageAdapter for MySqlAdapter {
    async fn append_operation(
        &self,
        operation: Operation,
        status: OperationStatus,
    ) -> Result<StoredOperation> {
        let operation_json = serde_json::to_string(&operation)?;
        let received_at_ms = unix_time_ms();

        sqlx::query(
            r#"
            INSERT IGNORE INTO photon_engine_operations (
                operation_id,
                scope,
                collection,
                record_id,
                actor_id,
                status,
                remote_sequence,
                received_at_ms,
                operation_json
            )
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
            "#,
        )
        .bind(operation.id.as_str())
        .bind(operation.key.scope.as_str())
        .bind(operation.key.collection.as_str())
        .bind(operation.key.record_id.as_str())
        .bind(operation.actor_id.as_str())
        .bind(status.as_str())
        .bind(received_at_ms)
        .bind(operation_json)
        .execute(&self.pool)
        .await?;

        self.get_operation(&operation.id)
            .await?
            .ok_or_else(|| EngineError::Storage("operation insert was not readable".to_owned()))
    }

    async fn append_authoritative_operation(
        &self,
        operation: Operation,
    ) -> Result<(StoredOperation, Record)> {
        let mut transaction = self.pool.begin().await?;

        // `FOR UPDATE` on the singleton row is the authority lock. Every other
        // acceptance — in this process or any other sharing this database —
        // waits here, so sequence allocation and commit stay in the same order.
        // Held until commit, not just until the read returns.
        let next_sequence = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT next_sequence
            FROM photon_engine_sync_state
            WHERE id = 1
            FOR UPDATE
            "#,
        )
        .fetch_one(&mut *transaction)
        .await?;

        let existing = sqlx::query(
            r#"
            SELECT local_sequence, operation_json, status, remote_sequence, received_at_ms
            FROM photon_engine_operations
            WHERE operation_id = ?
            "#,
        )
        .bind(operation.id.as_str())
        .fetch_optional(&mut *transaction)
        .await?
        .map(stored_operation_from_row)
        .transpose()?;

        if let Some(existing) = &existing {
            if existing.operation != operation {
                return Err(EngineError::Storage(format!(
                    "operation id {} was reused with a different payload",
                    operation.id
                )));
            }
            if existing.remote_sequence.is_some() {
                // Already accepted. Return the committed projection rather than
                // replaying a non-idempotent kind.
                let record = match read_record(&mut transaction, &existing.operation.key).await? {
                    Some(record) => record,
                    None => {
                        let record = apply_operation(None, &existing.operation)?;
                        write_record(&mut transaction, &record).await?;
                        record
                    }
                };
                let stored = existing.clone();
                transaction.commit().await?;
                return Ok((stored, record));
            }
        }

        sqlx::query(
            r#"
            UPDATE photon_engine_sync_state
            SET next_sequence = next_sequence + 1
            WHERE id = 1
            "#,
        )
        .execute(&mut *transaction)
        .await?;

        if existing.is_some() {
            sqlx::query(
                r#"
                UPDATE photon_engine_operations
                SET status = 'accepted',
                    remote_sequence = ?
                WHERE operation_id = ?
                "#,
            )
            .bind(next_sequence)
            .bind(operation.id.as_str())
            .execute(&mut *transaction)
            .await?;
        } else {
            sqlx::query(
                r#"
                INSERT INTO photon_engine_operations (
                    operation_id,
                    scope,
                    collection,
                    record_id,
                    actor_id,
                    status,
                    remote_sequence,
                    received_at_ms,
                    operation_json
                )
                VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?)
                "#,
            )
            .bind(operation.id.as_str())
            .bind(operation.key.scope.as_str())
            .bind(operation.key.collection.as_str())
            .bind(operation.key.record_id.as_str())
            .bind(operation.actor_id.as_str())
            .bind(next_sequence)
            .bind(unix_time_ms())
            .bind(serde_json::to_string(&operation)?)
            .execute(&mut *transaction)
            .await?;
        }

        let stored = sqlx::query(
            r#"
            SELECT local_sequence, operation_json, status, remote_sequence, received_at_ms
            FROM photon_engine_operations
            WHERE operation_id = ?
            "#,
        )
        .bind(operation.id.as_str())
        .fetch_one(&mut *transaction)
        .await
        .map_err(EngineError::from)
        .and_then(stored_operation_from_row)?;

        let current = read_record(&mut transaction, &stored.operation.key).await?;
        let projected = apply_operation(current, &stored.operation)?;
        write_record(&mut transaction, &projected).await?;

        transaction.commit().await?;
        Ok((stored, projected))
    }

    async fn next_remote_sequence(&self) -> Result<i64> {
        let next_sequence = sqlx::query_scalar::<_, i64>(
            "SELECT next_sequence FROM photon_engine_sync_state WHERE id = 1",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(next_sequence)
    }

    async fn get_operation(&self, operation_id: &OperationId) -> Result<Option<StoredOperation>> {
        let row = sqlx::query(
            r#"
            SELECT local_sequence, operation_json, status, remote_sequence, received_at_ms
            FROM photon_engine_operations
            WHERE operation_id = ?
            "#,
        )
        .bind(operation_id.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(stored_operation_from_row).transpose()
    }

    async fn mark_operation_status(
        &self,
        operation_id: &OperationId,
        status: OperationStatus,
        remote_sequence: Option<i64>,
    ) -> Result<()> {
        sqlx::query(
            r#"
            UPDATE photon_engine_operations
            SET status = ?,
                remote_sequence = COALESCE(?, remote_sequence)
            WHERE operation_id = ?
            "#,
        )
        .bind(status.as_str())
        .bind(remote_sequence)
        .bind(operation_id.as_str())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn list_operations(&self, filter: OperationFilter) -> Result<Vec<StoredOperation>> {
        let mut builder = QueryBuilder::<MySql>::new(
            "SELECT local_sequence, operation_json, status, remote_sequence, received_at_ms FROM photon_engine_operations",
        );
        let mut has_where = false;

        if let Some(scope) = filter.scope {
            push_where(&mut builder, &mut has_where);
            builder.push("scope = ");
            builder.push_bind(scope.0);
        }

        if let Some(collection) = filter.collection {
            push_where(&mut builder, &mut has_where);
            builder.push("collection = ");
            builder.push_bind(collection.0);
        }

        if let Some(status) = filter.status {
            push_where(&mut builder, &mut has_where);
            builder.push("status = ");
            builder.push_bind(status.as_str());
        }

        if let Some(after_remote_sequence) = filter.after_remote_sequence {
            push_where(&mut builder, &mut has_where);
            builder.push("COALESCE(remote_sequence, 0) > ");
            builder.push_bind(after_remote_sequence);
        }

        // Paginate in the same order the cursor advances. Ordering by
        // local_sequence while filtering on remote_sequence lets a page skip or
        // repeat operations whenever the two orders diverge, which they do
        // whenever operations are published in a different order than stored.
        if filter.after_remote_sequence.is_some() {
            builder.push(" ORDER BY remote_sequence ASC");
        } else {
            builder.push(" ORDER BY local_sequence ASC");
        }

        if let Some(limit) = filter.limit {
            builder.push(" LIMIT ");
            builder.push_bind(limit as i64);
        }

        let rows = builder.build().fetch_all(&self.pool).await?;

        rows.into_iter().map(stored_operation_from_row).collect()
    }

    async fn upsert_record(&self, record: Record) -> Result<()> {
        let record_json = serde_json::to_string(&record)?;

        sqlx::query(
            r#"
            INSERT INTO photon_engine_records (scope, collection, record_id, record_json)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE record_json = VALUES(record_json)
            "#,
        )
        .bind(record.key.scope.as_str())
        .bind(record.key.collection.as_str())
        .bind(record.key.record_id.as_str())
        .bind(record_json)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn get_record(&self, key: &RecordKey) -> Result<Option<Record>> {
        let row = sqlx::query(
            r#"
            SELECT record_json
            FROM photon_engine_records
            WHERE scope = ? AND collection = ? AND record_id = ?
            "#,
        )
        .bind(key.scope.as_str())
        .bind(key.collection.as_str())
        .bind(key.record_id.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            let record_json: String = row.try_get("record_json")?;
            Ok(serde_json::from_str(&record_json)?)
        })
        .transpose()
    }

    async fn list_records(
        &self,
        scope: &ScopeId,
        collection: &CollectionName,
    ) -> Result<Vec<Record>> {
        let rows = sqlx::query(
            r#"
            SELECT record_json
            FROM photon_engine_records
            WHERE scope = ? AND collection = ?
            ORDER BY record_id ASC
            "#,
        )
        .bind(scope.as_str())
        .bind(collection.as_str())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let record_json: String = row.try_get("record_json")?;
                Ok(serde_json::from_str(&record_json)?)
            })
            .collect()
    }

    async fn delete_record_projection(&self, key: &RecordKey) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM photon_engine_records
            WHERE scope = ? AND collection = ? AND record_id = ?
            "#,
        )
        .bind(key.scope.as_str())
        .bind(key.collection.as_str())
        .bind(key.record_id.as_str())
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn save_snapshot(&self, snapshot: Snapshot) -> Result<()> {
        let metadata_json = serde_json::to_string(&snapshot.metadata)?;

        sqlx::query(
            r#"
            INSERT INTO photon_engine_snapshots (
                scope,
                collection,
                record_id,
                format,
                sequence,
                payload,
                metadata_json,
                updated_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                format = VALUES(format),
                sequence = VALUES(sequence),
                payload = VALUES(payload),
                metadata_json = VALUES(metadata_json),
                updated_at_ms = VALUES(updated_at_ms)
            "#,
        )
        .bind(snapshot.key.scope.as_str())
        .bind(snapshot.key.collection.as_str())
        .bind(snapshot.key.record_id.as_str())
        .bind(snapshot.format.as_str())
        .bind(snapshot.sequence)
        .bind(snapshot.payload)
        .bind(metadata_json)
        .bind(snapshot.updated_at_ms)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn get_snapshot(&self, key: &RecordKey) -> Result<Option<Snapshot>> {
        let row = sqlx::query(
            r#"
            SELECT format, sequence, payload, metadata_json, updated_at_ms
            FROM photon_engine_snapshots
            WHERE scope = ? AND collection = ? AND record_id = ?
            "#,
        )
        .bind(key.scope.as_str())
        .bind(key.collection.as_str())
        .bind(key.record_id.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| snapshot_from_row(key.clone(), row))
            .transpose()
    }

    async fn append_snapshot_update(&self, update: SnapshotUpdate) -> Result<()> {
        let metadata_json = serde_json::to_string(&update.metadata)?;

        sqlx::query(
            r#"
            INSERT IGNORE INTO photon_engine_snapshot_updates (
                scope,
                collection,
                record_id,
                sequence,
                format,
                payload,
                metadata_json,
                created_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(update.key.scope.as_str())
        .bind(update.key.collection.as_str())
        .bind(update.key.record_id.as_str())
        .bind(update.sequence)
        .bind(update.format.as_str())
        .bind(update.payload)
        .bind(metadata_json)
        .bind(update.created_at_ms)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn list_snapshot_updates(
        &self,
        key: &RecordKey,
        after_sequence: i64,
    ) -> Result<Vec<SnapshotUpdate>> {
        let rows = sqlx::query(
            r#"
            SELECT sequence, format, payload, metadata_json, created_at_ms
            FROM photon_engine_snapshot_updates
            WHERE scope = ?
              AND collection = ?
              AND record_id = ?
              AND sequence > ?
            ORDER BY sequence ASC
            "#,
        )
        .bind(key.scope.as_str())
        .bind(key.collection.as_str())
        .bind(key.record_id.as_str())
        .bind(after_sequence)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| snapshot_update_from_row(key.clone(), row))
            .collect()
    }

    async fn compact_snapshot_updates(&self, key: &RecordKey, up_to_sequence: i64) -> Result<()> {
        sqlx::query(
            r#"
            DELETE FROM photon_engine_snapshot_updates
            WHERE scope = ?
              AND collection = ?
              AND record_id = ?
              AND sequence <= ?
            "#,
        )
        .bind(key.scope.as_str())
        .bind(key.collection.as_str())
        .bind(key.record_id.as_str())
        .bind(up_to_sequence)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn save_cursor(&self, cursor: SyncCursor) -> Result<()> {
        let cursor_json = serde_json::to_string(&cursor)?;

        sqlx::query(
            r#"
            INSERT INTO photon_engine_cursors (scope, remote, cursor_json)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE cursor_json = VALUES(cursor_json)
            "#,
        )
        .bind(cursor.scope.as_str())
        .bind(cursor.remote.as_str())
        .bind(cursor_json)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn get_cursor(&self, scope: &ScopeId, remote: &RemoteId) -> Result<Option<SyncCursor>> {
        let row = sqlx::query(
            r#"
            SELECT cursor_json
            FROM photon_engine_cursors
            WHERE scope = ? AND remote = ?
            "#,
        )
        .bind(scope.as_str())
        .bind(remote.as_str())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            let cursor_json: String = row.try_get("cursor_json")?;
            Ok(serde_json::from_str(&cursor_json)?)
        })
        .transpose()
    }

    async fn save_conflict(&self, conflict: Conflict) -> Result<()> {
        let conflict_json = serde_json::to_string(&conflict)?;

        sqlx::query(
            r#"
            REPLACE INTO photon_engine_conflicts (
                conflict_id,
                scope,
                collection,
                record_id,
                operation_id,
                conflict_json
            )
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(conflict.id.as_str())
        .bind(conflict.key.scope.as_str())
        .bind(conflict.key.collection.as_str())
        .bind(conflict.key.record_id.as_str())
        .bind(conflict.operation_id.as_str())
        .bind(conflict_json)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn list_conflicts(
        &self,
        scope: &ScopeId,
        collection: Option<&CollectionName>,
        record_id: Option<&RecordId>,
    ) -> Result<Vec<Conflict>> {
        let mut builder = QueryBuilder::<MySql>::new(
            "SELECT conflict_json FROM photon_engine_conflicts WHERE scope = ",
        );
        builder.push_bind(scope.as_str());

        if let Some(collection) = collection {
            builder.push(" AND collection = ");
            builder.push_bind(collection.as_str());
        }

        if let Some(record_id) = record_id {
            builder.push(" AND record_id = ");
            builder.push_bind(record_id.as_str());
        }

        builder.push(" ORDER BY conflict_id ASC");

        let rows = builder.build().fetch_all(&self.pool).await?;

        rows.into_iter()
            .map(|row| {
                let conflict_json: String = row.try_get("conflict_json")?;
                Ok(serde_json::from_str(&conflict_json)?)
            })
            .collect()
    }
}

/// Read a record projection inside an open transaction, under `FOR UPDATE`, so
/// the read and the write that follows it stay under the same lock.
async fn read_record(
    transaction: &mut sqlx::Transaction<'_, MySql>,
    key: &RecordKey,
) -> Result<Option<Record>> {
    let row = sqlx::query(
        r#"
        SELECT record_json
        FROM photon_engine_records
        WHERE scope = ? AND collection = ? AND record_id = ?
        FOR UPDATE
        "#,
    )
    .bind(key.scope.as_str())
    .bind(key.collection.as_str())
    .bind(key.record_id.as_str())
    .fetch_optional(&mut **transaction)
    .await?;

    row.map(|row| {
        let record_json: String = row.try_get("record_json")?;
        Ok(serde_json::from_str(&record_json)?)
    })
    .transpose()
}

async fn write_record(
    transaction: &mut sqlx::Transaction<'_, MySql>,
    record: &Record,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO photon_engine_records (scope, collection, record_id, record_json)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE record_json = VALUES(record_json)
        "#,
    )
    .bind(record.key.scope.as_str())
    .bind(record.key.collection.as_str())
    .bind(record.key.record_id.as_str())
    .bind(serde_json::to_string(record)?)
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

fn push_where(builder: &mut QueryBuilder<'_, MySql>, has_where: &mut bool) {
    if *has_where {
        builder.push(" AND ");
    } else {
        builder.push(" WHERE ");
        *has_where = true;
    }
}

fn stored_operation_from_row(row: sqlx::mysql::MySqlRow) -> Result<StoredOperation> {
    let operation_json: String = row.try_get("operation_json")?;
    let status: String = row.try_get("status")?;

    Ok(StoredOperation {
        operation: serde_json::from_str(&operation_json)?,
        status: OperationStatus::parse(&status)?,
        local_sequence: row.try_get("local_sequence")?,
        remote_sequence: row.try_get("remote_sequence")?,
        received_at_ms: row.try_get("received_at_ms")?,
    })
}

fn snapshot_from_row(key: RecordKey, row: sqlx::mysql::MySqlRow) -> Result<Snapshot> {
    let metadata_json: String = row.try_get("metadata_json")?;
    let format: String = row.try_get("format")?;

    Ok(Snapshot {
        key,
        format: SnapshotFormat::from(format),
        payload: row.try_get("payload")?,
        sequence: row.try_get("sequence")?,
        metadata: serde_json::from_str(&metadata_json)?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn snapshot_update_from_row(key: RecordKey, row: sqlx::mysql::MySqlRow) -> Result<SnapshotUpdate> {
    let metadata_json: String = row.try_get("metadata_json")?;
    let format: String = row.try_get("format")?;

    Ok(SnapshotUpdate {
        key,
        format: SnapshotFormat::from(format),
        payload: row.try_get("payload")?,
        sequence: row.try_get("sequence")?,
        metadata: serde_json::from_str(&metadata_json)?,
        created_at_ms: row.try_get("created_at_ms")?,
    })
}

#[cfg(test)]
mod tests {
    use super::MySqlAdapter;

    #[test]
    fn normalizes_tidb_urls_for_sqlx_mysql_driver() {
        assert_eq!(
            MySqlAdapter::normalize_database_url("tidb://user:pass@host:4000/photon"),
            "mysql://user:pass@host:4000/photon"
        );
        assert_eq!(
            MySqlAdapter::normalize_database_url("mysql://user:pass@host:3306/photon"),
            "mysql://user:pass@host:3306/photon"
        );
    }
}
