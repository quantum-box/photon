use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use photon_engine::{
    ActorId, CollectionName, HybridTimestamp, Operation, OperationKind, PhotonEngine, RecordKey,
    ScopeId, SqliteAdapter, StorageAdapter,
};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;
use yrs::{updates::decoder::Decode, Doc, ReadTxn, StateVector, Transact, Update};

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

#[derive(OpenApi)]
#[openapi(
    paths(
        health,
        list_issues,
        get_issue,
        create_issue,
        update_issue,
        delete_issue,
        list_documents,
        get_document,
        create_document,
        update_document,
        delete_document,
        list_attachments,
        get_attachment,
        create_attachment,
        update_attachment,
        delete_attachment,
        link_attachment,
        delete_attachment_link,
    ),
    components(schemas(
        Issue,
        CreateIssue,
        UpdateIssue,
        IssueListResponse,
        DocumentMetadata,
        CreateDocument,
        UpdateDocument,
        DocumentListResponse,
        Attachment,
        AttachmentLink,
        CreateAttachment,
        UpdateAttachment,
        CreateAttachmentLink,
        AttachmentListResponse,
        HealthResponse
    )),
    info(
        title = "Photon API",
        version = "0.1.0",
        description = "Photon backend REST API"
    )
)]
struct ApiDoc;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub project: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct IssueRecord {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub assignee: Option<String>,
    pub labels: String,
    pub project: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<IssueRecord> for Issue {
    fn from(record: IssueRecord) -> Self {
        Self {
            id: record.id,
            identifier: record.identifier,
            title: record.title,
            description: record.description,
            status: record.status,
            priority: record.priority,
            assignee: record.assignee,
            labels: parse_labels(&record.labels),
            project: record.project,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateIssue {
    pub title: String,
    pub identifier: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    pub assignee: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default = "default_project")]
    pub project: String,
}

fn default_status() -> String {
    "todo".into()
}
fn default_priority() -> String {
    "none".into()
}
fn default_project() -> String {
    "Client App Kit".into()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateIssue {
    pub identifier: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_text")]
    pub assignee: Option<Option<String>>,
    pub labels: Option<Vec<String>>,
    pub project: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct IssueListResponse {
    pub issues: Vec<Issue>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DocumentMetadata {
    pub id: String,
    pub title: String,
    pub workspace_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateDocument {
    pub id: Option<String>,
    pub title: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateDocument {
    pub title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DocumentListResponse {
    pub documents: Vec<DocumentMetadata>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AttachmentLink {
    pub id: String,
    pub attachment_id: String,
    pub surface_type: String,
    pub surface_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Attachment {
    pub id: String,
    pub workspace_id: String,
    pub filename: String,
    pub content_type: String,
    pub byte_size: i64,
    pub storage_provider: String,
    pub storage_key: String,
    pub content_status: String,
    pub preview_metadata: serde_json::Value,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub links: Vec<AttachmentLink>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AttachmentRecord {
    pub id: String,
    pub workspace_id: String,
    pub filename: String,
    pub content_type: String,
    pub byte_size: i64,
    pub storage_provider: String,
    pub storage_key: String,
    pub content_status: String,
    pub preview_metadata: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct AttachmentLinkRecord {
    pub id: String,
    pub attachment_id: String,
    pub surface_type: String,
    pub surface_id: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAttachmentLink {
    pub surface_type: String,
    pub surface_id: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAttachment {
    pub workspace_id: String,
    pub filename: String,
    pub content_type: String,
    pub byte_size: i64,
    pub storage_provider: String,
    pub storage_key: Option<String>,
    #[serde(default = "default_attachment_content_status")]
    pub content_status: String,
    #[serde(default)]
    pub preview_metadata: serde_json::Value,
    pub created_by: Option<String>,
    #[serde(default)]
    pub links: Vec<CreateAttachmentLink>,
}

fn default_attachment_content_status() -> String {
    "local_cache".into()
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateAttachment {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub byte_size: Option<i64>,
    pub storage_provider: Option<String>,
    pub storage_key: Option<String>,
    pub content_status: Option<String>,
    pub preview_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct AttachmentListResponse {
    pub attachments: Vec<Attachment>,
    pub total: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub workspace_id: Option<String>,
    pub surface_type: Option<String>,
    pub surface_id: Option<String>,
}

fn now_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(text)
        }
    })
}

fn deserialize_nullable_text<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn parse_labels(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn serialize_labels(labels: &[String]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".into())
}

fn parse_preview_metadata(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::json!({}))
}

const DEFAULT_WORKSPACE_ID: &str = "photon-default";
const ENGINE_SCOPE_ID: &str = "workspace:photon-default";
const ENGINE_ACTOR_ID: &str = "photon-server";

enum EngineRecordMutation {
    Upsert(serde_json::Value),
    Patch(serde_json::Value),
    Delete,
}

fn engine_record_key(collection: &str, record_id: &str) -> RecordKey {
    RecordKey::new(
        ScopeId::from(ENGINE_SCOPE_ID),
        CollectionName::from(collection),
        record_id,
    )
}

fn value_to_patch_fields(
    value: serde_json::Value,
) -> Result<BTreeMap<String, serde_json::Value>, AppError> {
    match value {
        serde_json::Value::Object(fields) => Ok(fields.into_iter().collect()),
        _ => Err(AppError::InvalidEngineRecord),
    }
}

async fn apply_engine_record_operation(
    state: &AppState,
    collection: &str,
    record_id: &str,
    mutation: EngineRecordMutation,
) -> Result<(), AppError> {
    let kind = match mutation {
        EngineRecordMutation::Upsert(value) => OperationKind::Upsert { value },
        EngineRecordMutation::Patch(value) => OperationKind::Patch {
            fields: value_to_patch_fields(value)?,
        },
        EngineRecordMutation::Delete => OperationKind::Delete,
    };
    let actor_id = ActorId::from(ENGINE_ACTOR_ID);
    let operation = Operation::new(
        engine_record_key(collection, record_id),
        actor_id.clone(),
        kind,
    )
    .with_timestamp(HybridTimestamp::now(actor_id))
    .with_metadata(serde_json::json!({ "source": "photon-server-rest" }));
    let remote_sequence = state.engine_next_seq.fetch_add(1, Ordering::SeqCst) + 1;

    state
        .engine
        .apply_remote_operation(operation, remote_sequence)
        .await?;

    Ok(())
}

fn issue_to_engine_value(issue: &Issue) -> Result<serde_json::Value, AppError> {
    Ok(serde_json::to_value(issue)?)
}

async fn upsert_issue_engine_projection(state: &AppState, issue: &Issue) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "issues",
        &issue.id,
        EngineRecordMutation::Upsert(issue_to_engine_value(issue)?),
    )
    .await
}

async fn patch_issue_engine_projection(state: &AppState, issue: &Issue) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "issues",
        &issue.id,
        EngineRecordMutation::Patch(issue_to_engine_value(issue)?),
    )
    .await
}

async fn delete_issue_engine_projection(state: &AppState, issue_id: &str) -> Result<(), AppError> {
    apply_engine_record_operation(state, "issues", issue_id, EngineRecordMutation::Delete).await
}

fn default_document_title() -> String {
    "Untitled doc".into()
}

fn normalize_document_title(value: Option<String>) -> String {
    normalize_optional_text(value).unwrap_or_else(default_document_title)
}

fn document_to_engine_value(document: &DocumentMetadata) -> Result<serde_json::Value, AppError> {
    Ok(serde_json::to_value(document)?)
}

fn document_from_engine_record(
    record: photon_engine::Record,
) -> Result<Option<DocumentMetadata>, AppError> {
    if record.is_deleted() {
        return Ok(None);
    }

    Ok(Some(serde_json::from_value(record.value)?))
}

async fn fetch_document_from_engine(
    state: &AppState,
    document_id: &str,
) -> Result<Option<DocumentMetadata>, AppError> {
    let record = state
        .engine
        .record(&engine_record_key("documents", document_id))
        .await?;
    match record {
        Some(record) => document_from_engine_record(record),
        None => Ok(None),
    }
}

async fn list_documents_from_engine(
    state: &AppState,
    workspace_id: &str,
) -> Result<Vec<DocumentMetadata>, AppError> {
    let mut documents = state
        .engine
        .storage()
        .list_records(
            &ScopeId::from(ENGINE_SCOPE_ID),
            &CollectionName::from("documents"),
        )
        .await?
        .into_iter()
        .filter_map(|record| document_from_engine_record(record).transpose())
        .collect::<Result<Vec<_>, _>>()?;

    documents.retain(|document| document.workspace_id == workspace_id);
    documents.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(documents)
}

async fn upsert_document_engine_projection(
    state: &AppState,
    document: &DocumentMetadata,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "documents",
        &document.id,
        EngineRecordMutation::Upsert(document_to_engine_value(document)?),
    )
    .await
}

async fn patch_document_engine_projection(
    state: &AppState,
    document: &DocumentMetadata,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "documents",
        &document.id,
        EngineRecordMutation::Patch(document_to_engine_value(document)?),
    )
    .await
}

async fn delete_document_engine_projection(
    state: &AppState,
    document_id: &str,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "documents",
        document_id,
        EngineRecordMutation::Delete,
    )
    .await
}

async fn next_issue_identifier(pool: &SqlitePool) -> Result<String, sqlx::Error> {
    let max_number: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(CAST(SUBSTR(identifier, 5) AS INTEGER))
         FROM issues
         WHERE identifier LIKE 'PLT-%'",
    )
    .fetch_one(pool)
    .await?;

    Ok(format!("PLT-{}", max_number.unwrap_or(100) + 1))
}

async fn fetch_issue_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Issue>, sqlx::Error> {
    let issue = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .map(Into::into);

    Ok(issue)
}

async fn fetch_attachment_links(
    pool: &SqlitePool,
    attachment_id: &str,
) -> Result<Vec<AttachmentLink>, sqlx::Error> {
    let links = sqlx::query_as::<_, AttachmentLinkRecord>(
        "SELECT id, attachment_id, surface_type, surface_id, created_at
         FROM attachment_links
         WHERE attachment_id = ?
         ORDER BY created_at ASC",
    )
    .bind(attachment_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|record| AttachmentLink {
        id: record.id,
        attachment_id: record.attachment_id,
        surface_type: record.surface_type,
        surface_id: record.surface_id,
        created_at: record.created_at,
    })
    .collect();

    Ok(links)
}

async fn attachment_from_record(
    pool: &SqlitePool,
    record: AttachmentRecord,
) -> Result<Attachment, sqlx::Error> {
    let links = fetch_attachment_links(pool, &record.id).await?;
    Ok(Attachment {
        id: record.id,
        workspace_id: record.workspace_id,
        filename: record.filename,
        content_type: record.content_type,
        byte_size: record.byte_size,
        storage_provider: record.storage_provider,
        storage_key: record.storage_key,
        content_status: record.content_status,
        preview_metadata: parse_preview_metadata(&record.preview_metadata),
        created_by: record.created_by,
        created_at: record.created_at,
        updated_at: record.updated_at,
        links,
    })
}

async fn fetch_attachment_by_id(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<Attachment>, sqlx::Error> {
    let record = sqlx::query_as::<_, AttachmentRecord>(
        "SELECT id, workspace_id, filename, content_type, byte_size, storage_provider, storage_key,
                content_status, preview_metadata, created_by, created_at, updated_at
         FROM attachments WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    match record {
        Some(record) => attachment_from_record(pool, record).await.map(Some),
        None => Ok(None),
    }
}

fn attachment_to_engine_value(attachment: &Attachment) -> Result<serde_json::Value, AppError> {
    Ok(serde_json::to_value(attachment)?)
}

fn attachment_link_to_engine_value(link: &AttachmentLink) -> Result<serde_json::Value, AppError> {
    Ok(serde_json::to_value(link)?)
}

async fn upsert_attachment_link_engine_projection(
    state: &AppState,
    link: &AttachmentLink,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "attachment_links",
        &link.id,
        EngineRecordMutation::Upsert(attachment_link_to_engine_value(link)?),
    )
    .await
}

async fn delete_attachment_link_engine_projection(
    state: &AppState,
    link_id: &str,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "attachment_links",
        link_id,
        EngineRecordMutation::Delete,
    )
    .await
}

async fn upsert_attachment_engine_projection(
    state: &AppState,
    attachment: &Attachment,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "attachments",
        &attachment.id,
        EngineRecordMutation::Upsert(attachment_to_engine_value(attachment)?),
    )
    .await?;

    for link in &attachment.links {
        upsert_attachment_link_engine_projection(state, link).await?;
    }

    Ok(())
}

async fn patch_attachment_engine_projection(
    state: &AppState,
    attachment: &Attachment,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "attachments",
        &attachment.id,
        EngineRecordMutation::Patch(attachment_to_engine_value(attachment)?),
    )
    .await?;

    for link in &attachment.links {
        upsert_attachment_link_engine_projection(state, link).await?;
    }

    Ok(())
}

async fn delete_attachment_engine_projection(
    state: &AppState,
    attachment: &Attachment,
) -> Result<(), AppError> {
    apply_engine_record_operation(
        state,
        "attachments",
        &attachment.id,
        EngineRecordMutation::Delete,
    )
    .await?;

    for link in &attachment.links {
        delete_attachment_link_engine_projection(state, &link.id).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const DEFAULT_ROOM_ID: &str = "default";
/// Compact the on-disk update log when it grows beyond this many rows.
const YJS_COMPACTION_THRESHOLD: i64 = 100;

pub struct AppState {
    pub db: SqlitePool,
    pub engine: PhotonEngine<SqliteAdapter>,
    pub engine_next_seq: AtomicI64,
    pub rooms: RwLock<HashMap<String, Arc<RoomState>>>,
}

pub struct RoomState {
    pub db: SqlitePool,
    pub doc: RwLock<Doc>,
    pub broadcast_tx: broadcast::Sender<Vec<u8>>,
    pub presence_tx: broadcast::Sender<String>,
    pub active_connections: AtomicUsize,
    pub room_id: String,
    pub next_seq: AtomicI64,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/health",
    responses((status = 200, description = "Service is healthy", body = HealthResponse)),
    tag = "health"
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
    })
}

#[utoipa::path(
    get,
    path = "/api/issues",
    params(
        ("limit" = Option<i64>, Query, description = "Max items to return"),
        ("offset" = Option<i64>, Query, description = "Items to skip"),
    ),
    responses((status = 200, description = "List of issues", body = IssueListResponse)),
    tag = "issues"
)]
async fn list_issues(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<IssueListResponse>, AppError> {
    let limit = params.limit.unwrap_or(50);
    let offset = params.offset.unwrap_or(0);

    let issue_records = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;
    let issues = issue_records.into_iter().map(Into::into).collect();

    let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM issues")
        .fetch_one(&state.db)
        .await?;

    Ok(Json(IssueListResponse {
        issues,
        total: total.0,
    }))
}

#[utoipa::path(
    get,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    responses(
        (status = 200, description = "Issue found", body = Issue),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn get_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Issue>, AppError> {
    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(issue))
}

#[utoipa::path(
    post,
    path = "/api/issues",
    request_body = CreateIssue,
    responses((status = 201, description = "Issue created", body = Issue)),
    tag = "issues"
)]
async fn create_issue(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateIssue>,
) -> Result<(StatusCode, Json<Issue>), AppError> {
    let id = Uuid::new_v4().to_string();
    let identifier = match normalize_optional_text(payload.identifier) {
        Some(identifier) => identifier,
        None => next_issue_identifier(&state.db).await?,
    };
    let assignee = normalize_optional_text(payload.assignee);
    let labels = serialize_labels(&payload.labels);
    let project = if payload.project.trim().is_empty() {
        default_project()
    } else {
        payload.project
    };
    let now = now_timestamp();

    sqlx::query(
        "INSERT INTO issues (id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&identifier)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(&payload.status)
    .bind(&payload.priority)
    .bind(&assignee)
    .bind(&labels)
    .bind(&project)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    upsert_issue_engine_projection(&state, &issue).await?;

    Ok((StatusCode::CREATED, Json(issue)))
}

#[utoipa::path(
    put,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    request_body = UpdateIssue,
    responses(
        (status = 200, description = "Issue updated", body = Issue),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn update_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateIssue>,
) -> Result<Json<Issue>, AppError> {
    // Check exists
    let existing = sqlx::query_as::<_, IssueRecord>(
        "SELECT id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at
         FROM issues WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let identifier = normalize_optional_text(payload.identifier).unwrap_or(existing.identifier);
    let title = payload.title.unwrap_or(existing.title);
    let description = payload.description.unwrap_or(existing.description);
    let status = payload.status.unwrap_or(existing.status);
    let priority = payload.priority.unwrap_or(existing.priority);
    let assignee = match payload.assignee {
        Some(value) => normalize_optional_text(value),
        None => existing.assignee,
    };
    let labels = payload
        .labels
        .map(|labels| serialize_labels(&labels))
        .unwrap_or(existing.labels);
    let project = payload.project.unwrap_or(existing.project);
    let now = now_timestamp();

    sqlx::query(
        "UPDATE issues SET identifier = ?, title = ?, description = ?, status = ?, priority = ?, assignee = ?, labels = ?, project = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(&identifier)
    .bind(&title)
    .bind(&description)
    .bind(&status)
    .bind(&priority)
    .bind(&assignee)
    .bind(&labels)
    .bind(&project)
    .bind(&now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let issue = fetch_issue_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    patch_issue_engine_projection(&state, &issue).await?;

    Ok(Json(issue))
}

#[utoipa::path(
    delete,
    path = "/api/issues/:id",
    params(("id" = String, Path, description = "Issue ID")),
    responses(
        (status = 204, description = "Issue deleted"),
        (status = 404, description = "Issue not found"),
    ),
    tag = "issues"
)]
async fn delete_issue(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM issues WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    delete_issue_engine_projection(&state, &id).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/documents",
    params(
        ("limit" = Option<i64>, Query, description = "Max items to return"),
        ("offset" = Option<i64>, Query, description = "Items to skip"),
        ("workspace_id" = Option<String>, Query, description = "Workspace scope"),
    ),
    responses((status = 200, description = "List of document metadata", body = DocumentListResponse)),
    tag = "documents"
)]
async fn list_documents(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<DocumentListResponse>, AppError> {
    let limit = params.limit.unwrap_or(100).max(0) as usize;
    let offset = params.offset.unwrap_or(0).max(0) as usize;
    let workspace_id = params
        .workspace_id
        .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.into());

    let documents = list_documents_from_engine(&state, &workspace_id).await?;
    let total = documents.len() as i64;
    let documents = documents.into_iter().skip(offset).take(limit).collect();

    Ok(Json(DocumentListResponse { documents, total }))
}

#[utoipa::path(
    get,
    path = "/api/documents/:id",
    params(("id" = String, Path, description = "Document ID")),
    responses(
        (status = 200, description = "Document metadata found", body = DocumentMetadata),
        (status = 404, description = "Document metadata not found"),
    ),
    tag = "documents"
)]
async fn get_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<DocumentMetadata>, AppError> {
    let document = fetch_document_from_engine(&state, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(document))
}

#[utoipa::path(
    post,
    path = "/api/documents",
    request_body = CreateDocument,
    responses((status = 201, description = "Document metadata created", body = DocumentMetadata)),
    tag = "documents"
)]
async fn create_document(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateDocument>,
) -> Result<(StatusCode, Json<DocumentMetadata>), AppError> {
    let now = now_timestamp();
    let document = DocumentMetadata {
        id: normalize_optional_text(payload.id).unwrap_or_else(|| Uuid::new_v4().to_string()),
        title: normalize_document_title(payload.title),
        workspace_id: normalize_optional_text(payload.workspace_id)
            .unwrap_or_else(|| DEFAULT_WORKSPACE_ID.into()),
        created_at: now.clone(),
        updated_at: now,
    };

    upsert_document_engine_projection(&state, &document).await?;

    Ok((StatusCode::CREATED, Json(document)))
}

#[utoipa::path(
    put,
    path = "/api/documents/:id",
    params(("id" = String, Path, description = "Document ID")),
    request_body = UpdateDocument,
    responses(
        (status = 200, description = "Document metadata updated", body = DocumentMetadata),
        (status = 404, description = "Document metadata not found"),
    ),
    tag = "documents"
)]
async fn update_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateDocument>,
) -> Result<Json<DocumentMetadata>, AppError> {
    let mut document = fetch_document_from_engine(&state, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    document.title = normalize_document_title(payload.title);
    document.updated_at = now_timestamp();

    patch_document_engine_projection(&state, &document).await?;

    Ok(Json(document))
}

#[utoipa::path(
    delete,
    path = "/api/documents/:id",
    params(("id" = String, Path, description = "Document ID")),
    responses(
        (status = 204, description = "Document metadata deleted"),
        (status = 404, description = "Document metadata not found"),
    ),
    tag = "documents"
)]
async fn delete_document(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    fetch_document_from_engine(&state, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    delete_document_engine_projection(&state, &id).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/api/attachments",
    params(
        ("limit" = Option<i64>, Query, description = "Max items to return"),
        ("offset" = Option<i64>, Query, description = "Items to skip"),
        ("workspace_id" = Option<String>, Query, description = "Workspace scope"),
        ("surface_type" = Option<String>, Query, description = "issue, chat, or document"),
        ("surface_id" = Option<String>, Query, description = "Surface identifier"),
    ),
    responses((status = 200, description = "List of attachment metadata", body = AttachmentListResponse)),
    tag = "attachments"
)]
async fn list_attachments(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<AttachmentListResponse>, AppError> {
    let limit = params.limit.unwrap_or(100);
    let offset = params.offset.unwrap_or(0);
    let workspace_id = params
        .workspace_id
        .unwrap_or_else(|| "photon-default".into());

    let records = if let (Some(surface_type), Some(surface_id)) =
        (params.surface_type.as_deref(), params.surface_id.as_deref())
    {
        sqlx::query_as::<_, AttachmentRecord>(
            "SELECT attachments.id, attachments.workspace_id, attachments.filename, attachments.content_type,
                    attachments.byte_size, attachments.storage_provider, attachments.storage_key,
                    attachments.content_status, attachments.preview_metadata, attachments.created_by,
                    attachments.created_at, attachments.updated_at
             FROM attachments
             INNER JOIN attachment_links ON attachment_links.attachment_id = attachments.id
             WHERE attachments.workspace_id = ?
               AND attachment_links.surface_type = ?
               AND attachment_links.surface_id = ?
             ORDER BY attachments.updated_at DESC
             LIMIT ? OFFSET ?",
        )
        .bind(&workspace_id)
        .bind(surface_type)
        .bind(surface_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, AttachmentRecord>(
            "SELECT id, workspace_id, filename, content_type, byte_size, storage_provider, storage_key,
                    content_status, preview_metadata, created_by, created_at, updated_at
             FROM attachments
             WHERE workspace_id = ?
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?",
        )
        .bind(&workspace_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.db)
        .await?
    };

    let total: (i64,) = if let (Some(surface_type), Some(surface_id)) =
        (params.surface_type.as_deref(), params.surface_id.as_deref())
    {
        sqlx::query_as(
            "SELECT COUNT(*)
             FROM attachments
             INNER JOIN attachment_links ON attachment_links.attachment_id = attachments.id
             WHERE attachments.workspace_id = ?
               AND attachment_links.surface_type = ?
               AND attachment_links.surface_id = ?",
        )
        .bind(&workspace_id)
        .bind(surface_type)
        .bind(surface_id)
        .fetch_one(&state.db)
        .await?
    } else {
        sqlx::query_as("SELECT COUNT(*) FROM attachments WHERE workspace_id = ?")
            .bind(&workspace_id)
            .fetch_one(&state.db)
            .await?
    };

    let mut attachments = Vec::with_capacity(records.len());
    for record in records {
        attachments.push(attachment_from_record(&state.db, record).await?);
    }

    Ok(Json(AttachmentListResponse {
        attachments,
        total: total.0,
    }))
}

#[utoipa::path(
    get,
    path = "/api/attachments/:id",
    params(("id" = String, Path, description = "Attachment ID")),
    responses(
        (status = 200, description = "Attachment found", body = Attachment),
        (status = 404, description = "Attachment not found"),
    ),
    tag = "attachments"
)]
async fn get_attachment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Attachment>, AppError> {
    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(attachment))
}

#[utoipa::path(
    post,
    path = "/api/attachments",
    request_body = CreateAttachment,
    responses((status = 201, description = "Attachment metadata created", body = Attachment)),
    tag = "attachments"
)]
async fn create_attachment(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateAttachment>,
) -> Result<(StatusCode, Json<Attachment>), AppError> {
    let id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    let filename = payload.filename.trim().to_string();
    let storage_key = payload
        .storage_key
        .and_then(|value| normalize_optional_text(Some(value)))
        .unwrap_or_else(|| format!("{}/attachments/{}", payload.workspace_id, id));
    let preview_metadata =
        serde_json::to_string(&payload.preview_metadata).unwrap_or_else(|_| "{}".into());

    sqlx::query(
        "INSERT INTO attachments (
            id, workspace_id, filename, content_type, byte_size, storage_provider, storage_key,
            content_status, preview_metadata, created_by, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&payload.workspace_id)
    .bind(&filename)
    .bind(&payload.content_type)
    .bind(payload.byte_size)
    .bind(&payload.storage_provider)
    .bind(&storage_key)
    .bind(&payload.content_status)
    .bind(&preview_metadata)
    .bind(&payload.created_by)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await?;

    for link in payload.links {
        upsert_attachment_link(&state.db, &id, &payload.workspace_id, link).await?;
    }

    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    upsert_attachment_engine_projection(&state, &attachment).await?;

    Ok((StatusCode::CREATED, Json(attachment)))
}

#[utoipa::path(
    put,
    path = "/api/attachments/:id",
    params(("id" = String, Path, description = "Attachment ID")),
    request_body = UpdateAttachment,
    responses(
        (status = 200, description = "Attachment updated", body = Attachment),
        (status = 404, description = "Attachment not found"),
    ),
    tag = "attachments"
)]
async fn update_attachment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<UpdateAttachment>,
) -> Result<Json<Attachment>, AppError> {
    let existing = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    let now = now_timestamp();
    let preview_metadata = payload
        .preview_metadata
        .map(|metadata| serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".into()))
        .unwrap_or_else(|| {
            serde_json::to_string(&existing.preview_metadata).unwrap_or_else(|_| "{}".into())
        });

    sqlx::query(
        "UPDATE attachments
         SET filename = ?, content_type = ?, byte_size = ?, storage_provider = ?,
             storage_key = ?, content_status = ?, preview_metadata = ?, updated_at = ?
         WHERE id = ?",
    )
    .bind(payload.filename.unwrap_or(existing.filename))
    .bind(payload.content_type.unwrap_or(existing.content_type))
    .bind(payload.byte_size.unwrap_or(existing.byte_size))
    .bind(
        payload
            .storage_provider
            .unwrap_or(existing.storage_provider),
    )
    .bind(payload.storage_key.unwrap_or(existing.storage_key))
    .bind(payload.content_status.unwrap_or(existing.content_status))
    .bind(preview_metadata)
    .bind(now)
    .bind(&id)
    .execute(&state.db)
    .await?;

    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    patch_attachment_engine_projection(&state, &attachment).await?;
    Ok(Json(attachment))
}

#[utoipa::path(
    delete,
    path = "/api/attachments/:id",
    params(("id" = String, Path, description = "Attachment ID")),
    responses((status = 204, description = "Attachment metadata deleted")),
    tag = "attachments"
)]
async fn delete_attachment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    let result = sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    sqlx::query("DELETE FROM attachment_links WHERE attachment_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;

    delete_attachment_engine_projection(&state, &attachment).await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn upsert_attachment_link(
    pool: &SqlitePool,
    attachment_id: &str,
    workspace_id: &str,
    link: CreateAttachmentLink,
) -> Result<(), sqlx::Error> {
    let link_id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    sqlx::query(
        "INSERT INTO attachment_links (id, attachment_id, workspace_id, surface_type, surface_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (attachment_id, surface_type, surface_id) DO NOTHING",
    )
    .bind(link_id)
    .bind(attachment_id)
    .bind(workspace_id)
    .bind(link.surface_type)
    .bind(link.surface_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

#[utoipa::path(
    post,
    path = "/api/attachments/:id/links",
    params(("id" = String, Path, description = "Attachment ID")),
    request_body = CreateAttachmentLink,
    responses((status = 200, description = "Attachment linked", body = Attachment)),
    tag = "attachments"
)]
async fn link_attachment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(payload): Json<CreateAttachmentLink>,
) -> Result<Json<Attachment>, AppError> {
    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    upsert_attachment_link(&state.db, &id, &attachment.workspace_id, payload).await?;
    let attachment = fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    patch_attachment_engine_projection(&state, &attachment).await?;
    Ok(Json(attachment))
}

#[utoipa::path(
    delete,
    path = "/api/attachments/:id/links/:link_id",
    params(
        ("id" = String, Path, description = "Attachment ID"),
        ("link_id" = String, Path, description = "Attachment link ID"),
    ),
    responses((status = 204, description = "Attachment link removed")),
    tag = "attachments"
)]
async fn delete_attachment_link(
    State(state): State<Arc<AppState>>,
    Path((id, link_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    fetch_attachment_by_id(&state.db, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    let result = sqlx::query("DELETE FROM attachment_links WHERE attachment_id = ? AND id = ?")
        .bind(&id)
        .bind(&link_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }

    if let Some(attachment) = fetch_attachment_by_id(&state.db, &id).await? {
        patch_attachment_engine_projection(&state, &attachment).await?;
    }
    delete_attachment_link_engine_projection(&state, &link_id).await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// WebSocket — yrs CRDT sync
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let room_id = params
        .get("room")
        .filter(|room| !room.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_ROOM_ID.to_string());

    ws.on_upgrade(move |socket| async move {
        match get_or_create_room(&state, &room_id).await {
            Ok(room) => handle_ws(socket, room).await,
            Err(err) => {
                tracing::error!(room = %room_id, error = %err, "Failed to initialize Yjs room");
            }
        }
    })
}

async fn get_or_create_room(
    state: &Arc<AppState>,
    room_id: &str,
) -> Result<Arc<RoomState>, sqlx::Error> {
    if let Some(room) = state.rooms.read().await.get(room_id).cloned() {
        return Ok(room);
    }

    let mut rooms = state.rooms.write().await;
    if let Some(room) = rooms.get(room_id).cloned() {
        return Ok(room);
    }

    let (doc, max_seq) = hydrate_yjs_doc(&state.db, room_id).await?;
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
    let (presence_tx, _) = broadcast::channel::<String>(256);
    let room = Arc::new(RoomState {
        db: state.db.clone(),
        doc: RwLock::new(doc),
        broadcast_tx,
        presence_tx,
        active_connections: AtomicUsize::new(0),
        room_id: room_id.to_string(),
        next_seq: AtomicI64::new(max_seq),
    });

    rooms.insert(room_id.to_string(), room.clone());
    Ok(room)
}

fn is_awareness_message(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(|kind| kind.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some("awareness")
}

async fn handle_ws(socket: WebSocket, state: Arc<RoomState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let active_count = state.active_connections.fetch_add(1, Ordering::SeqCst) + 1;

    // Send initial state — scope the transaction so it's dropped before await
    let initial_update = {
        let doc = state.doc.read().await;
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    if ws_sender
        .send(Message::Binary(initial_update))
        .await
        .is_err()
    {
        state.active_connections.fetch_sub(1, Ordering::SeqCst);
        return;
    }

    // Subscribe to broadcast channel for updates from other clients
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let mut presence_rx = state.presence_tx.subscribe();
    let _ = state.presence_tx.send(format!(
        r#"{{"type":"presence","onlineCount":{active_count}}}"#
    ));

    // Task: forward broadcast messages to this client's WebSocket
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Ok(data) = broadcast_rx.recv() => {
                    if ws_sender.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Ok(presence) = presence_rx.recv() => {
                    if ws_sender.send(Message::Text(presence)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Task: receive updates from this client, apply to doc, persist, broadcast
    let recv_state = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Binary(data) => match apply_and_persist_update(&recv_state, &data).await {
                    Ok(true) => {
                        let _ = recv_state.broadcast_tx.send(data.to_vec());
                    }
                    Ok(false) => {
                        // Malformed update; logged inside apply_and_persist_update.
                    }
                    Err(err) => {
                        tracing::error!(error = %err, "Failed to persist yjs update");
                    }
                },
                Message::Text(text) if is_awareness_message(&text) => {
                    let _ = recv_state.presence_tx.send(text);
                }
                Message::Text(_) => {}
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish, then clean up
    tokio::select! {
        _ = &mut send_task => {},
        _ = &mut recv_task => {},
    }
    send_task.abort();
    recv_task.abort();

    let active_count = state.active_connections.fetch_sub(1, Ordering::SeqCst) - 1;
    let _ = state.presence_tx.send(format!(
        r#"{{"type":"presence","onlineCount":{active_count}}}"#
    ));
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum AppError {
    NotFound,
    InvalidEngineRecord,
    Sqlx(sqlx::Error),
    Engine(photon_engine::EngineError),
    Serde(serde_json::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Sqlx(e)
    }
}

impl From<photon_engine::EngineError> for AppError {
    fn from(e: photon_engine::EngineError) -> Self {
        AppError::Engine(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serde(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found"),
            AppError::InvalidEngineRecord => {
                tracing::error!("Invalid photon engine record mutation");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            AppError::Sqlx(e) => {
                tracing::error!("Database error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            AppError::Engine(e) => {
                tracing::error!("Photon engine error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
            AppError::Serde(e) => {
                tracing::error!("Serialization error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
    }
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(include_str!("../migrations/001_create_issues.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/002_create_yjs_state.sql"))
        .execute(pool)
        .await?;
    sqlx::raw_sql(include_str!("../migrations/003_create_attachments.sql"))
        .execute(pool)
        .await?;
    ensure_issue_projection_columns(pool).await?;
    Ok(())
}

async fn init_engine(
    pool: &SqlitePool,
) -> Result<PhotonEngine<SqliteAdapter>, photon_engine::EngineError> {
    let adapter = SqliteAdapter::from_pool(pool.clone());
    adapter.migrate().await?;
    Ok(PhotonEngine::new(adapter))
}

async fn init_engine_next_sequence(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COALESCE(MAX(remote_sequence), 0) FROM photon_engine_operations")
        .fetch_one(pool)
        .await
}

async fn issue_table_has_column(pool: &SqlitePool, column_name: &str) -> Result<bool, sqlx::Error> {
    let columns = sqlx::query_as::<_, (String,)>("SELECT name FROM pragma_table_info('issues')")
        .fetch_all(pool)
        .await?;

    Ok(columns.iter().any(|(name,)| name == column_name))
}

async fn ensure_issue_projection_columns(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    if !issue_table_has_column(pool, "identifier").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN identifier TEXT")
            .execute(pool)
            .await?;
    }

    if !issue_table_has_column(pool, "labels").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'")
            .execute(pool)
            .await?;
    }

    if !issue_table_has_column(pool, "project").await? {
        sqlx::query("ALTER TABLE issues ADD COLUMN project TEXT NOT NULL DEFAULT 'Client App Kit'")
            .execute(pool)
            .await?;
    }

    sqlx::query(
        "UPDATE issues
         SET identifier = 'PLT-' || (rowid + 100)
         WHERE identifier IS NULL OR identifier = ''",
    )
    .execute(pool)
    .await?;

    sqlx::query("UPDATE issues SET labels = '[]' WHERE labels IS NULL OR labels = ''")
        .execute(pool)
        .await?;
    sqlx::query(
        "UPDATE issues
         SET project = 'Client App Kit'
         WHERE project IS NULL OR project = ''",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier)")
        .execute(pool)
        .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project)")
        .execute(pool)
        .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Yjs persistence — snapshot + update log + replay
// ---------------------------------------------------------------------------

/// Loads the persisted Y.Doc state for `room_id` from SQLite. Applies the
/// snapshot first (if any), then replays updates with `seq > snapshot_seq`
/// in order. Corrupt rows (un-decodeable bytes or apply-time errors) are
/// skipped with a warning so a single bad row can't poison the room.
///
/// Returns the hydrated `Doc` and the highest seq observed in the log
/// (or the snapshot's seq if the log is empty), which seeds `next_seq`.
async fn hydrate_yjs_doc(pool: &SqlitePool, room_id: &str) -> Result<(Doc, i64), sqlx::Error> {
    let doc = Doc::new();

    let snapshot_row: Option<(Vec<u8>, i64)> =
        sqlx::query_as("SELECT snapshot, snapshot_seq FROM yjs_snapshots WHERE room_id = ?")
            .bind(room_id)
            .fetch_optional(pool)
            .await?;

    let snapshot_seq = if let Some((bytes, seq)) = snapshot_row {
        match Update::decode_v1(&bytes) {
            Ok(update) => {
                let mut txn = doc.transact_mut();
                if let Err(err) = txn.apply_update(update) {
                    tracing::warn!(
                        room = room_id,
                        seq,
                        error = %err,
                        "Failed to apply yjs snapshot; starting from empty doc"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    room = room_id,
                    seq,
                    error = %err,
                    "Corrupt yjs snapshot; starting from empty doc"
                );
            }
        }
        seq
    } else {
        0
    };

    let updates: Vec<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, update_bytes FROM yjs_updates WHERE room_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .bind(room_id)
    .bind(snapshot_seq)
    .fetch_all(pool)
    .await?;

    let mut max_seq = snapshot_seq;
    let mut applied = 0usize;
    let mut skipped = 0usize;
    for (seq, bytes) in updates {
        if seq > max_seq {
            max_seq = seq;
        }
        match Update::decode_v1(&bytes) {
            Ok(update) => {
                let mut txn = doc.transact_mut();
                match txn.apply_update(update) {
                    Ok(_) => applied += 1,
                    Err(err) => {
                        tracing::warn!(
                            room = room_id,
                            seq,
                            error = %err,
                            "Skipping un-applyable yjs update"
                        );
                        skipped += 1;
                    }
                }
            }
            Err(err) => {
                tracing::warn!(
                    room = room_id,
                    seq,
                    error = %err,
                    "Skipping un-decodable yjs update"
                );
                skipped += 1;
            }
        }
    }

    info!(
        room = room_id,
        snapshot_seq, max_seq, applied, skipped, "Hydrated yjs room from persisted state"
    );

    Ok((doc, max_seq))
}

/// Apply a validated update to the in-memory doc, persist it to the log
/// with a monotonic seq, and trigger compaction if the log has grown past
/// the threshold. Holds the doc write lock for the entire critical section
/// so that `compact_yjs_log` always sees a doc state that matches the DB.
///
/// Returns `Ok(true)` if the update was applied + persisted (caller should
/// broadcast); `Ok(false)` if the update was malformed and dropped.
async fn apply_and_persist_update(
    state: &Arc<RoomState>,
    update_bytes: &[u8],
) -> Result<bool, sqlx::Error> {
    // Decode + apply happens entirely inside this sync block. yrs values
    // (Update, TransactionMut, Doc write guard) are NOT Send and cannot be
    // held across an await; confining them to a non-await scope keeps the
    // outer future Send so it can be tokio::spawn'd.
    let applied = {
        let doc_guard = state.doc.write().await;
        let decoded = match Update::decode_v1(update_bytes) {
            Ok(update) => update,
            Err(err) => {
                tracing::warn!(
                    room = %state.room_id,
                    error = %err,
                    bytes = update_bytes.len(),
                    "Dropping un-decodable yjs update from client"
                );
                return Ok(false);
            }
        };
        let mut txn = doc_guard.transact_mut();
        match txn.apply_update(decoded) {
            Ok(_) => true,
            Err(err) => {
                tracing::warn!(
                    room = %state.room_id,
                    error = %err,
                    "Dropping un-applyable yjs update from client"
                );
                false
            }
        }
    };
    if !applied {
        return Ok(false);
    }

    let seq = state.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let now = now_timestamp();

    sqlx::query(
        "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&state.room_id)
    .bind(seq)
    .bind(update_bytes)
    .bind(&now)
    .execute(&state.db)
    .await?;

    let log_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates WHERE room_id = ?")
        .bind(&state.room_id)
        .fetch_one(&state.db)
        .await?;

    if log_count.0 > YJS_COMPACTION_THRESHOLD {
        compact_yjs_log(state).await?;
    }

    Ok(true)
}

/// Materialize the current doc as a snapshot, persist it transactionally
/// alongside deleting the rolled-up update rows. The boundary is captured
/// from the in-memory `next_seq` atomic *while still holding the doc read
/// lock*, so it can never exceed the seqs whose applies are reflected in
/// the snapshot. (Reading MAX(seq) from the DB after releasing the lock
/// would race with a concurrent writer that already inserted its row but
/// whose apply wasn't in the captured snapshot — that scenario would
/// silently delete the writer's row.) Boundary may legitimately under-
/// count if a writer is between releasing the write lock and its
/// `fetch_add`; the orphan log row is harmless because yrs apply is
/// idempotent on rehydrate.
async fn compact_yjs_log(state: &Arc<RoomState>) -> Result<(), sqlx::Error> {
    let (snapshot_bytes, boundary_seq) = {
        let doc_guard = state.doc.read().await;
        let txn = doc_guard.transact();
        let bytes = txn.encode_state_as_update_v1(&StateVector::default());
        let seq = state.next_seq.load(Ordering::SeqCst);
        (bytes, seq)
    };

    if boundary_seq <= 0 {
        return Ok(());
    }

    let now = now_timestamp();
    let snapshot_len = snapshot_bytes.len();
    let mut tx = state.db.begin().await?;

    sqlx::query(
        "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
             snapshot = excluded.snapshot,
             snapshot_seq = excluded.snapshot_seq,
             updated_at = excluded.updated_at",
    )
    .bind(&state.room_id)
    .bind(&snapshot_bytes)
    .bind(boundary_seq)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM yjs_updates WHERE room_id = ? AND seq <= ?")
        .bind(&state.room_id)
        .bind(boundary_seq)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    info!(
        room = %state.room_id,
        boundary_seq,
        snapshot_bytes = snapshot_len,
        "Compacted yjs update log into snapshot"
    );
    Ok(())
}

async fn seed_if_empty(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM issues")
        .fetch_one(pool)
        .await?;

    if count.0 > 0 {
        return Ok(());
    }

    let seeds = vec![
        (
            "Set up project repository",
            "Initialize the monorepo structure with frontend and backend packages",
            "done",
            "urgent",
            Some("Alice"),
            vec!["infra"],
            "Photon Core",
        ),
        (
            "Design database schema",
            "Define tables for issues, users, and projects",
            "done",
            "high",
            Some("Bob"),
            vec!["database"],
            "Photon Core",
        ),
        (
            "Implement authentication",
            "Add JWT-based auth with login/register endpoints",
            "in_progress",
            "urgent",
            Some("Alice"),
            vec!["auth"],
            "Auth Service",
        ),
        (
            "Build issue list view",
            "Create the main table view for browsing issues",
            "in_progress",
            "high",
            Some("Charlie"),
            vec!["feature", "ui"],
            "Client App Kit",
        ),
        (
            "Add real-time collaboration",
            "Integrate CRDT-based sync for concurrent editing",
            "todo",
            "medium",
            None,
            vec!["sync"],
            "Photon Core",
        ),
        (
            "Write API documentation",
            "Generate OpenAPI docs and add usage examples",
            "backlog",
            "low",
            None,
            vec!["docs"],
            "API Gateway",
        ),
    ];

    let seed_count = seeds.len();
    for (title, desc, status, priority, assignee, labels, project) in seeds {
        let id = Uuid::new_v4().to_string();
        let identifier = next_issue_identifier(pool).await?;
        let labels = serialize_labels(
            &labels
                .into_iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
        );
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO issues (id, identifier, title, description, status, priority, assignee, labels, project, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&identifier)
        .bind(title)
        .bind(desc)
        .bind(status)
        .bind(priority)
        .bind(assignee)
        .bind(&labels)
        .bind(project)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    info!("Seeded {} issues", seed_count);
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "photon_server=debug,tower_http=debug".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:photon.db?mode=rwc".into());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    init_db(&pool).await?;
    let engine = init_engine(&pool).await?;
    let engine_next_seq = init_engine_next_sequence(&pool).await?;
    seed_if_empty(&pool).await?;

    let state = Arc::new(AppState {
        db: pool,
        engine,
        engine_next_seq: AtomicI64::new(engine_next_seq),
        rooms: RwLock::new(HashMap::new()),
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        // Health
        .route("/api/health", get(health))
        // Issues CRUD
        .route("/api/issues", get(list_issues).post(create_issue))
        .route(
            "/api/issues/:id",
            get(get_issue).put(update_issue).delete(delete_issue),
        )
        // Document metadata backed by photon-engine generic records
        .route("/api/documents", get(list_documents).post(create_document))
        .route(
            "/api/documents/:id",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        // Attachment metadata + surface links
        .route(
            "/api/attachments",
            get(list_attachments).post(create_attachment),
        )
        .route(
            "/api/attachments/:id",
            get(get_attachment)
                .put(update_attachment)
                .delete(delete_attachment),
        )
        .route(
            "/api/attachments/:id/links",
            axum::routing::post(link_attachment),
        )
        .route(
            "/api/attachments/:id/links/:link_id",
            axum::routing::delete(delete_attachment_link),
        )
        // WebSocket
        .route("/ws", get(ws_handler))
        // Swagger UI
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        // Middleware
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let port = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(3001);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Photon server listening on {addr}");
    info!("Swagger UI: http://{addr}/swagger-ui/");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn engine_issue_value(state: &AppState, issue_id: &str) -> serde_json::Value {
        state
            .engine
            .record(&engine_record_key("issues", issue_id))
            .await
            .unwrap()
            .unwrap()
            .value
    }

    async fn engine_document_record(state: &AppState, document_id: &str) -> photon_engine::Record {
        state
            .engine
            .record(&engine_record_key("documents", document_id))
            .await
            .unwrap()
            .unwrap()
    }

    async fn engine_attachment_record(
        state: &AppState,
        attachment_id: &str,
    ) -> photon_engine::Record {
        state
            .engine
            .record(&engine_record_key("attachments", attachment_id))
            .await
            .unwrap()
            .unwrap()
    }

    async fn engine_attachment_link_record(
        state: &AppState,
        link_id: &str,
    ) -> photon_engine::Record {
        state
            .engine
            .record(&engine_record_key("attachment_links", link_id))
            .await
            .unwrap()
            .unwrap()
    }

    async fn test_app() -> (Router, Arc<AppState>) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();

        init_db(&pool).await.unwrap();
        let engine = init_engine(&pool).await.unwrap();
        let engine_next_seq = init_engine_next_sequence(&pool).await.unwrap();

        let state = Arc::new(AppState {
            db: pool,
            engine,
            engine_next_seq: AtomicI64::new(engine_next_seq),
            rooms: RwLock::new(HashMap::new()),
        });

        let app = Router::new()
            .route("/api/health", get(health))
            .route("/api/issues", get(list_issues).post(create_issue))
            .route(
                "/api/issues/:id",
                get(get_issue).put(update_issue).delete(delete_issue),
            )
            .route("/api/documents", get(list_documents).post(create_document))
            .route(
                "/api/documents/:id",
                get(get_document)
                    .put(update_document)
                    .delete(delete_document),
            )
            .route(
                "/api/attachments",
                get(list_attachments).post(create_attachment),
            )
            .route(
                "/api/attachments/:id",
                get(get_attachment)
                    .put(update_attachment)
                    .delete(delete_attachment),
            )
            .route(
                "/api/attachments/:id/links",
                axum::routing::post(link_attachment),
            )
            .route(
                "/api/attachments/:id/links/:link_id",
                axum::routing::delete(delete_attachment_link),
            )
            .with_state(state.clone());

        (app, state)
    }

    #[tokio::test]
    async fn test_health() {
        let (app, _) = test_app().await;

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_create_and_list_issues() {
        let (app, state) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Test issue",
                            "description": "A test",
                            "labels": ["Feature", "sync"],
                            "project": "Photon Core"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Issue = serde_json::from_slice(&body).unwrap();
        let engine_value = engine_issue_value(&state, &created.id).await;
        assert_eq!(engine_value, serde_json::to_value(&created).unwrap());

        let operations = state
            .engine
            .storage()
            .list_operations(photon_engine::OperationFilter {
                scope: Some(ScopeId::from(ENGINE_SCOPE_ID)),
                collection: Some(CollectionName::from("issues")),
                status: Some(photon_engine::OperationStatus::Accepted),
                ..photon_engine::OperationFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].remote_sequence, Some(1));
        assert_eq!(init_engine_next_sequence(&state.db).await.unwrap(), 1);

        // List
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/issues")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: IssueListResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.issues[0].title, "Test issue");
        assert!(list.issues[0].identifier.starts_with("PLT-"));
        assert_eq!(list.issues[0].labels, vec!["Feature", "sync"]);
        assert_eq!(list.issues[0].project, "Photon Core");
    }

    #[tokio::test]
    async fn test_engine_record_helper_accepts_arbitrary_collections() {
        let (_app, state) = test_app().await;

        apply_engine_record_operation(
            &state,
            "documents",
            "doc-1",
            EngineRecordMutation::Upsert(serde_json::json!({
                "title": "Offline sync spec",
                "status": "draft"
            })),
        )
        .await
        .unwrap();
        apply_engine_record_operation(
            &state,
            "documents",
            "doc-1",
            EngineRecordMutation::Patch(serde_json::json!({
                "status": "ready"
            })),
        )
        .await
        .unwrap();

        let record = state
            .engine
            .record(&engine_record_key("documents", "doc-1"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(record.value["title"], "Offline sync spec");
        assert_eq!(record.value["status"], "ready");
    }

    #[tokio::test]
    async fn test_document_metadata_is_engine_backed_generic_record() {
        let (app, state) = test_app().await;

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/documents")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "id": "doc-alpha",
                            "title": "Offline sync spec",
                            "workspace_id": DEFAULT_WORKSPACE_ID
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: DocumentMetadata = serde_json::from_slice(&body).unwrap();
        assert_eq!(created.id, "doc-alpha");
        assert_eq!(created.title, "Offline sync spec");
        assert_eq!(created.workspace_id, DEFAULT_WORKSPACE_ID);

        let engine_record = engine_document_record(&state, &created.id).await;
        assert_eq!(engine_record.key.collection.as_str(), "documents");
        assert_eq!(engine_record.value, serde_json::to_value(&created).unwrap());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/documents/doc-alpha")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "title": "Accepted document title" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let updated: DocumentMetadata = serde_json::from_slice(&body).unwrap();
        assert_eq!(updated.title, "Accepted document title");
        assert_eq!(updated.created_at, created.created_at);

        let engine_record = engine_document_record(&state, &updated.id).await;
        assert_eq!(engine_record.value, serde_json::to_value(&updated).unwrap());

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/documents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: DocumentListResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.documents[0].id, "doc-alpha");
        assert_eq!(list.documents[0].title, "Accepted document title");

        let operations = state
            .engine
            .storage()
            .list_operations(photon_engine::OperationFilter {
                scope: Some(ScopeId::from(ENGINE_SCOPE_ID)),
                collection: Some(CollectionName::from("documents")),
                status: Some(photon_engine::OperationStatus::Accepted),
                ..photon_engine::OperationFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(operations.len(), 2);
        assert_eq!(operations[0].remote_sequence, Some(1));
        assert_eq!(operations[1].remote_sequence, Some(2));

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/documents/doc-alpha")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(engine_document_record(&state, "doc-alpha")
            .await
            .is_deleted());

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/documents/doc-alpha")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let (app, _) = test_app().await;

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/issues/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_update_issue() {
        let (app, state) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Original title",
                            "assignee": "Alice"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Issue = serde_json::from_slice(&body).unwrap();

        // Update
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/issues/{}", created.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "title": "Updated title",
                            "status": "in_progress",
                            "assignee": null,
                            "labels": ["backend"],
                            "project": "API Gateway"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let updated: Issue = serde_json::from_slice(&body).unwrap();
        assert_eq!(updated.title, "Updated title");
        assert_eq!(updated.status, "in_progress");
        assert_eq!(updated.assignee, None);
        assert_eq!(updated.labels, vec!["backend"]);
        assert_eq!(updated.project, "API Gateway");

        let engine_value = engine_issue_value(&state, &updated.id).await;
        assert_eq!(engine_value, serde_json::to_value(&updated).unwrap());
    }

    #[tokio::test]
    async fn test_delete_issue() {
        let (app, state) = test_app().await;

        // Create
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/issues")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "title": "To delete" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Issue = serde_json::from_slice(&body).unwrap();

        // Delete
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/issues/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let engine_record = state
            .engine
            .record(&engine_record_key("issues", &created.id))
            .await
            .unwrap()
            .unwrap();
        assert!(engine_record.is_deleted());

        // Verify gone
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/issues/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_attachment_metadata_can_link_multiple_surfaces() {
        let (app, state) = test_app().await;

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/attachments")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "workspace_id": "photon-default",
                            "filename": "brief.pdf",
                            "content_type": "application/pdf",
                            "byte_size": 42,
                            "storage_provider": "web-object-storage",
                            "content_status": "local_cache",
                            "preview_metadata": { "fileType": "pdf" },
                            "links": [
                                { "surface_type": "issue", "surface_id": "issue-1" },
                                { "surface_type": "document", "surface_id": "doc-1" }
                            ]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: Attachment = serde_json::from_slice(&body).unwrap();
        assert_eq!(created.filename, "brief.pdf");
        assert_eq!(created.links.len(), 2);

        let engine_record = engine_attachment_record(&state, &created.id).await;
        assert_eq!(engine_record.key.collection.as_str(), "attachments");
        assert_eq!(engine_record.value, serde_json::to_value(&created).unwrap());
        for link in &created.links {
            let link_record = engine_attachment_link_record(&state, &link.id).await;
            assert_eq!(link_record.value, serde_json::to_value(link).unwrap());
        }

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/attachments/{}/links", created.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "surface_type": "chat",
                            "surface_id": "general"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let linked: Attachment = serde_json::from_slice(&body).unwrap();
        assert_eq!(linked.links.len(), 3);
        let chat_link = linked
            .links
            .iter()
            .find(|link| link.surface_type == "chat" && link.surface_id == "general")
            .cloned()
            .unwrap();
        assert_eq!(
            engine_attachment_record(&state, &created.id).await.value,
            serde_json::to_value(&linked).unwrap()
        );
        assert_eq!(
            engine_attachment_link_record(&state, &chat_link.id)
                .await
                .value,
            serde_json::to_value(&chat_link).unwrap()
        );

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/attachments?workspace_id=photon-default&surface_type=chat&surface_id=general")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let list: AttachmentListResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.attachments[0].id, created.id);
        assert_eq!(list.attachments[0].links.len(), 3);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/api/attachments/{}/links/{}",
                        created.id, chat_link.id
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(engine_attachment_link_record(&state, &chat_link.id)
            .await
            .is_deleted());
        let attachment_after_unlink = fetch_attachment_by_id(&state.db, &created.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attachment_after_unlink.links.len(), 2);
        assert_eq!(
            engine_attachment_record(&state, &created.id).await.value,
            serde_json::to_value(&attachment_after_unlink).unwrap()
        );

        let remaining_link_ids = attachment_after_unlink
            .links
            .iter()
            .map(|link| link.id.clone())
            .collect::<Vec<_>>();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/attachments/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(engine_attachment_record(&state, &created.id)
            .await
            .is_deleted());
        for link_id in remaining_link_ids {
            assert!(engine_attachment_link_record(&state, &link_id)
                .await
                .is_deleted());
        }
    }

    // -----------------------------------------------------------------------
    // Yjs persistence + replay tests
    // -----------------------------------------------------------------------

    use yrs::Map;

    fn make_test_state(pool: SqlitePool) -> Arc<RoomState> {
        let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);
        let (presence_tx, _) = broadcast::channel::<String>(256);
        Arc::new(RoomState {
            db: pool,
            doc: RwLock::new(Doc::new()),
            broadcast_tx,
            presence_tx,
            active_connections: AtomicUsize::new(0),
            room_id: DEFAULT_ROOM_ID.to_string(),
            next_seq: AtomicI64::new(0),
        })
    }

    async fn yjs_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        pool
    }

    /// Generate an update from a fresh source doc that sets a key on the
    /// shared "issues" map, returning the update bytes.
    fn build_update_setting_key(key: &str, value: &str) -> Vec<u8> {
        let source = Doc::new();
        let map = source.get_or_insert_map("issues");
        let initial_state = source.transact().state_vector();
        {
            let mut txn = source.transact_mut();
            map.insert(&mut txn, key, value);
        }
        let txn = source.transact();
        txn.encode_state_as_update_v1(&initial_state)
    }

    fn read_map_string(doc: &Doc, key: &str) -> Option<String> {
        let map = doc.get_or_insert_map("issues");
        let txn = doc.transact();
        map.get(&txn, key).and_then(|v| v.cast::<String>().ok())
    }

    #[tokio::test]
    async fn test_apply_and_persist_round_trip() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let update = build_update_setting_key("a", "alpha");
        let applied = apply_and_persist_update(&state, &update).await.unwrap();
        assert!(applied);
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 1);

        // Hydrate a fresh doc from the same DB and confirm state survived.
        let (reloaded, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 1);
        assert_eq!(read_map_string(&reloaded, "a"), Some("alpha".into()));
    }

    #[tokio::test]
    async fn test_corrupt_update_skipped_on_replay() {
        let pool = yjs_test_pool().await;

        // One good update at seq=1, one corrupt blob at seq=2, one good at seq=3.
        let good_one = build_update_setting_key("k1", "v1");
        let good_two = build_update_setting_key("k2", "v2");
        let now = now_timestamp();

        for (seq, bytes) in [(1i64, good_one), (2, vec![0xFFu8; 8]), (3, good_two)] {
            sqlx::query(
                "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
            )
            .bind(DEFAULT_ROOM_ID)
            .bind(seq)
            .bind(&bytes)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        }

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 3, "max seq must include the corrupt row's seq");
        assert_eq!(read_map_string(&doc, "k1"), Some("v1".into()));
        assert_eq!(read_map_string(&doc, "k2"), Some("v2".into()));
    }

    #[tokio::test]
    async fn test_apply_rejects_garbage_bytes() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let garbage = vec![0xFFu8; 32];
        let applied = apply_and_persist_update(&state, &garbage).await.unwrap();
        assert!(!applied, "garbage bytes should be dropped, not persisted");
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 0);

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
    }

    #[tokio::test]
    async fn test_compaction_collapses_log_into_snapshot() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        // Push enough updates to cross the compaction threshold.
        let total = (YJS_COMPACTION_THRESHOLD as usize) + 5;
        for i in 0..total {
            let update = build_update_setting_key(&format!("k{i}"), &format!("v{i}"));
            apply_and_persist_update(&state, &update).await.unwrap();
        }

        let log_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_updates")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            log_count.0 <= YJS_COMPACTION_THRESHOLD,
            "log should be compacted: rows={}",
            log_count.0
        );

        let snapshot_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM yjs_snapshots")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(snapshot_count.0, 1, "exactly one snapshot row expected");

        // Hydrate from disk and verify all values survived compaction.
        let (reloaded, _) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        for i in 0..total {
            assert_eq!(
                read_map_string(&reloaded, &format!("k{i}")),
                Some(format!("v{i}")),
                "key k{i} missing after compaction + reload"
            );
        }
    }

    #[tokio::test]
    async fn test_hydrate_from_snapshot_and_replay() {
        let pool = yjs_test_pool().await;

        // Build a doc and store its full state as a snapshot at seq=10.
        let snap_doc = Doc::new();
        {
            let map = snap_doc.get_or_insert_map("issues");
            let mut txn = snap_doc.transact_mut();
            map.insert(&mut txn, "snap", "in-snapshot");
        }
        let snap_bytes = {
            let txn = snap_doc.transact();
            txn.encode_state_as_update_v1(&StateVector::default())
        };
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(&snap_bytes)
        .bind(10i64)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // A post-snapshot update at seq=11 — should be replayed.
        let post = build_update_setting_key("post", "after-snapshot");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(11i64)
        .bind(&post)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        // A pre-snapshot orphan update at seq=5 — should be ignored by hydrate.
        let pre = build_update_setting_key("pre", "before-snapshot");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(5i64)
        .bind(&pre)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 11);
        assert_eq!(read_map_string(&doc, "snap"), Some("in-snapshot".into()));
        assert_eq!(read_map_string(&doc, "post"), Some("after-snapshot".into()));
        assert_eq!(
            read_map_string(&doc, "pre"),
            None,
            "pre-snapshot update should not be replayed"
        );
    }

    /// Regression test for the race fix in `compact_yjs_log`. A row whose
    /// seq is past the in-memory `next_seq` boundary (i.e. its writer has
    /// already inserted but the compactor hasn't observed its `fetch_add`
    /// or the apply isn't in the captured snapshot) MUST survive
    /// compaction — otherwise the orphan apply is silently lost.
    #[tokio::test]
    async fn test_compaction_preserves_rows_past_next_seq_boundary() {
        let pool = yjs_test_pool().await;
        let state = make_test_state(pool.clone());

        let real = build_update_setting_key("real", "yes");
        apply_and_persist_update(&state, &real).await.unwrap();
        assert_eq!(state.next_seq.load(Ordering::SeqCst), 1);

        // Simulate a writer that inserted its row but whose data is NOT
        // yet reflected in the doc snapshot from the compactor's view.
        // The old `SELECT MAX(seq)` boundary would treat seq=2 as in-scope
        // and delete it, losing the apply. With the new boundary captured
        // from `next_seq.load()` (=1), seq=2 is preserved.
        let pending = build_update_setting_key("pending", "preserved");
        let now = now_timestamp();
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(2i64)
        .bind(&pending)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        compact_yjs_log(&state).await.unwrap();

        let surviving: Vec<(i64,)> =
            sqlx::query_as("SELECT seq FROM yjs_updates WHERE room_id = ? ORDER BY seq")
                .bind(DEFAULT_ROOM_ID)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            surviving.iter().any(|(s,)| *s == 2),
            "compaction must not delete row at seq=2 (boundary should be next_seq=1), surviving: {:?}",
            surviving,
        );

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 2);
        assert_eq!(read_map_string(&doc, "real"), Some("yes".into()));
        assert_eq!(read_map_string(&doc, "pending"), Some("preserved".into()));
    }

    /// Stress test: many parallel writers + interleaved compactions must
    /// preserve every applied update on hydrate. Doesn't deterministically
    /// schedule the race but exercises the parallel paths under load.
    #[tokio::test]
    async fn test_parallel_writes_preserve_all_data() {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        let state = make_test_state(pool.clone());

        let total = (YJS_COMPACTION_THRESHOLD as usize) * 2;
        let mut handles = Vec::with_capacity(total);
        for i in 0..total {
            let st = state.clone();
            handles.push(tokio::spawn(async move {
                let update = build_update_setting_key(&format!("k{i}"), &format!("v{i}"));
                apply_and_persist_update(&st, &update).await.unwrap();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let (doc, _) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        for i in 0..total {
            assert_eq!(
                read_map_string(&doc, &format!("k{i}")),
                Some(format!("v{i}")),
                "key k{i} missing after parallel writes + compaction",
            );
        }
    }

    #[tokio::test]
    async fn test_corrupt_snapshot_starts_fresh_and_replays_log() {
        let pool = yjs_test_pool().await;
        let now = now_timestamp();

        sqlx::query(
            "INSERT INTO yjs_snapshots (room_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(vec![0xDEu8, 0xAD, 0xBE, 0xEF])
        .bind(0i64)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let update = build_update_setting_key("survives", "yes");
        sqlx::query(
            "INSERT INTO yjs_updates (room_id, seq, update_bytes, applied_at) VALUES (?, ?, ?, ?)",
        )
        .bind(DEFAULT_ROOM_ID)
        .bind(1i64)
        .bind(&update)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let (doc, max_seq) = hydrate_yjs_doc(&pool, DEFAULT_ROOM_ID).await.unwrap();
        assert_eq!(max_seq, 1);
        assert_eq!(read_map_string(&doc, "survives"), Some("yes".into()));
    }
}
