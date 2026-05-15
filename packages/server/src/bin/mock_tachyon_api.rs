use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use photon_engine::{
    CollectionName, Conflict, Operation, OperationFilter, OperationStatus, PhotonEngine,
    PullRequest, PullResult, PulledOperation, PushDecision, PushRequest, PushResult, Record,
    RecordKey, ScopeId, SqliteAdapter, StorageAdapter, SyncCursor,
};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

const DEFAULT_DATABASE_URL: &str = "sqlite:mock-tachyon-api.db?mode=rwc";
const DEFAULT_REMOTE_ID: &str = "mock-tachyon-api";

#[derive(Clone)]
struct MockTachyonState {
    engine: PhotonEngine<SqliteAdapter>,
    next_sequence: Arc<AtomicI64>,
    events: Arc<Mutex<Vec<AdminEvent>>>,
}

#[derive(Debug)]
enum MockApiError {
    Engine(photon_engine::EngineError),
}

impl From<photon_engine::EngineError> for MockApiError {
    fn from(error: photon_engine::EngineError) -> Self {
        Self::Engine(error)
    }
}

impl From<serde_json::Error> for MockApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Engine(photon_engine::EngineError::from(error))
    }
}

impl From<sqlx::Error> for MockApiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Engine(photon_engine::EngineError::from(error))
    }
}

impl IntoResponse for MockApiError {
    fn into_response(self) -> axum::response::Response {
        match self {
            Self::Engine(error) => {
                tracing::error!(%error, "mock Tachyon API engine error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "engine error" })),
                )
                    .into_response()
            }
        }
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    remote: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct AdminEvent {
    at_ms: i64,
    event: String,
    scope: Option<String>,
    collection: Option<String>,
    record_id: Option<String>,
    operation_id: Option<String>,
    detail: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct AdminStateResponse {
    remote: &'static str,
    position: i64,
    scopes: Vec<AdminScope>,
    operations: Vec<AdminOperation>,
    events: Vec<AdminEvent>,
}

#[derive(Debug, Serialize)]
struct AdminScope {
    scope: String,
    collections: Vec<AdminCollection>,
}

#[derive(Debug, Serialize)]
struct AdminCollection {
    collection: String,
    records: Vec<AdminRecord>,
}

#[derive(Debug, Serialize)]
struct AdminRecord {
    record_id: String,
    deleted: bool,
    version: i64,
    updated_by: String,
    value: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct AdminOperation {
    id: String,
    scope: String,
    collection: String,
    record_id: String,
    actor_id: String,
    status: &'static str,
    local_sequence: i64,
    remote_sequence: Option<i64>,
    received_at_ms: i64,
    kind: serde_json::Value,
    metadata: serde_json::Value,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mock_tachyon_api=debug,tower_http=debug".into()),
        )
        .init();

    let database_url =
        std::env::var("MOCK_TACHYON_DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.into());
    let port = std::env::var("MOCK_TACHYON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3101);
    let state = init_state(&database_url).await?;
    let app = build_app(state);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    info!(%addr, %database_url, "Mock Tachyon API listening");
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn init_state(database_url: &str) -> photon_engine::Result<MockTachyonState> {
    let adapter = SqliteAdapter::connect(database_url).await?;
    let next_sequence = init_next_sequence(&adapter).await?;
    Ok(MockTachyonState {
        engine: PhotonEngine::new(adapter),
        next_sequence: Arc::new(AtomicI64::new(next_sequence)),
        events: Arc::new(Mutex::new(Vec::new())),
    })
}

async fn init_next_sequence(adapter: &SqliteAdapter) -> photon_engine::Result<i64> {
    let operations = adapter
        .list_operations(OperationFilter {
            status: Some(OperationStatus::Accepted),
            ..OperationFilter::default()
        })
        .await?;

    Ok(operations
        .into_iter()
        .filter_map(|operation| operation.remote_sequence)
        .max()
        .unwrap_or_default())
}

fn build_app(state: MockTachyonState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/", get(admin_dashboard))
        .route("/__admin", get(admin_dashboard))
        .route("/__admin/state", get(admin_state))
        .route("/favicon.ico", get(favicon))
        .route("/health", get(health))
        .route("/v1/sync/push", post(push_sync))
        .route("/v1/sync/pull", post(pull_sync))
        .route("/v1/records/:scope/:collection/:record_id", get(get_record))
        .route("/__admin/reset", post(reset_state))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        remote: DEFAULT_REMOTE_ID,
    })
}

async fn favicon() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn admin_dashboard() -> Html<&'static str> {
    Html(ADMIN_DASHBOARD_HTML)
}

async fn admin_state(
    State(state): State<MockTachyonState>,
) -> Result<Json<AdminStateResponse>, MockApiError> {
    let mut stored_operations = state
        .engine
        .storage()
        .list_operations(OperationFilter::default())
        .await?;
    stored_operations.sort_by_key(|stored| stored.local_sequence);

    let mut current_records = BTreeMap::<RecordKey, Record>::new();
    for stored in &stored_operations {
        if let Some(record) = state.engine.record(&stored.operation.key).await? {
            current_records.insert(stored.operation.key.clone(), record);
        }
    }

    let mut scope_map = BTreeMap::<String, BTreeMap<String, Vec<AdminRecord>>>::new();
    for (key, record) in current_records {
        scope_map
            .entry(key.scope.to_string())
            .or_default()
            .entry(key.collection.to_string())
            .or_default()
            .push(AdminRecord {
                record_id: key.record_id.to_string(),
                deleted: record.is_deleted(),
                version: record.version.wall_time_ms,
                updated_by: record.updated_by.to_string(),
                value: record.value,
            });
    }

    let scopes = scope_map
        .into_iter()
        .map(|(scope, collections)| AdminScope {
            scope,
            collections: collections
                .into_iter()
                .map(|(collection, mut records)| {
                    records.sort_by(|left, right| left.record_id.cmp(&right.record_id));
                    AdminCollection {
                        collection,
                        records,
                    }
                })
                .collect(),
        })
        .collect();

    let operations = stored_operations
        .into_iter()
        .rev()
        .take(100)
        .map(|stored| AdminOperation {
            id: stored.operation.id.to_string(),
            scope: stored.operation.key.scope.to_string(),
            collection: stored.operation.key.collection.to_string(),
            record_id: stored.operation.key.record_id.to_string(),
            actor_id: stored.operation.actor_id.to_string(),
            status: stored.status.as_str(),
            local_sequence: stored.local_sequence,
            remote_sequence: stored.remote_sequence,
            received_at_ms: stored.received_at_ms,
            kind: serde_json::to_value(&stored.operation.kind).unwrap_or(serde_json::Value::Null),
            metadata: stored.operation.metadata,
        })
        .collect();

    let events = {
        let events = state.events.lock().await;
        events.iter().rev().take(100).cloned().collect()
    };

    Ok(Json(AdminStateResponse {
        remote: DEFAULT_REMOTE_ID,
        position: current_position(&state),
        scopes,
        operations,
        events,
    }))
}

async fn push_sync(
    State(state): State<MockTachyonState>,
    Json(request): Json<PushRequest>,
) -> Result<Json<PushResult>, MockApiError> {
    let mut decisions = Vec::with_capacity(request.operations.len());

    for operation in request.operations {
        if let Some(existing) = state.engine.storage().get_operation(&operation.id).await? {
            record_event(
                &state,
                "push_duplicate",
                Some(&existing.operation),
                Some(&request.scope),
                serde_json::json!({ "status": existing.status.as_str() }),
            )
            .await;
            let decision = match existing.status {
                OperationStatus::Accepted => PushDecision::Accepted {
                    operation_id: existing.operation.id,
                    remote_sequence: existing.remote_sequence.unwrap_or_default(),
                },
                OperationStatus::Rejected => PushDecision::Rejected {
                    operation_id: existing.operation.id,
                    reason: "operation was previously rejected".into(),
                },
                OperationStatus::Conflict => PushDecision::Conflict {
                    operation_id: existing.operation.id.clone(),
                    conflict: Conflict::new(
                        existing.operation.key,
                        existing.operation.id,
                        "operation was previously marked as conflict",
                        None,
                        None,
                    ),
                },
                OperationStatus::Pending => PushDecision::Rejected {
                    operation_id: existing.operation.id,
                    reason: "remote operation is unexpectedly pending".into(),
                },
            };
            decisions.push(decision);
            continue;
        }

        if operation
            .metadata
            .get("mock_reject")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            record_event(
                &state,
                "push_rejected",
                Some(&operation),
                Some(&request.scope),
                serde_json::json!({ "reason": "mock Tachyon validation rejected operation" }),
            )
            .await;
            decisions.push(PushDecision::Rejected {
                operation_id: operation.id,
                reason: "mock Tachyon validation rejected operation".into(),
            });
            continue;
        }

        if let Some(reason) = operation
            .metadata
            .get("mock_conflict_reason")
            .and_then(serde_json::Value::as_str)
        {
            record_event(
                &state,
                "push_conflict",
                Some(&operation),
                Some(&request.scope),
                serde_json::json!({ "reason": reason }),
            )
            .await;
            decisions.push(PushDecision::Conflict {
                operation_id: operation.id.clone(),
                conflict: Conflict::new(
                    operation.key.clone(),
                    operation.id,
                    reason,
                    Some(serde_json::to_value(&operation.kind)?),
                    None,
                ),
            });
            continue;
        }

        let remote_sequence = state.next_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        state
            .engine
            .apply_remote_operation(operation.clone(), remote_sequence)
            .await?;
        record_event(
            &state,
            "push_accepted",
            Some(&operation),
            Some(&request.scope),
            serde_json::json!({ "remote_sequence": remote_sequence }),
        )
        .await;
        decisions.push(PushDecision::Accepted {
            operation_id: operation.id,
            remote_sequence,
        });
    }

    let cursor = SyncCursor::new(request.scope, DEFAULT_REMOTE_ID, current_position(&state));
    Ok(Json(PushResult {
        decisions,
        server_operations: Vec::new(),
        cursor: Some(cursor),
    }))
}

async fn pull_sync(
    State(state): State<MockTachyonState>,
    Json(request): Json<PullRequest>,
) -> Result<Json<PullResult>, MockApiError> {
    let since = request
        .cursor
        .as_ref()
        .map(|cursor| cursor.position)
        .unwrap_or_default();
    let stored_operations = state
        .engine
        .storage()
        .list_operations(OperationFilter {
            scope: Some(request.scope.clone()),
            status: Some(OperationStatus::Accepted),
            after_remote_sequence: Some(since),
            ..OperationFilter::default()
        })
        .await?;
    let operations = stored_operations
        .into_iter()
        .filter_map(|stored| {
            stored
                .remote_sequence
                .map(|remote_sequence| PulledOperation {
                    operation: stored.operation,
                    remote_sequence,
                })
        })
        .collect::<Vec<_>>();
    record_event(
        &state,
        "pull",
        None,
        Some(&request.scope),
        serde_json::json!({ "since": since, "returned": operations.len() }),
    )
    .await;
    let cursor = SyncCursor::new(request.scope, DEFAULT_REMOTE_ID, current_position(&state));

    Ok(Json(PullResult {
        operations,
        cursor: Some(cursor),
    }))
}

async fn get_record(
    State(state): State<MockTachyonState>,
    Path((scope, collection, record_id)): Path<(String, String, String)>,
) -> Result<(StatusCode, Json<Option<Record>>), MockApiError> {
    let key = RecordKey::new(
        ScopeId::from(scope),
        CollectionName::from(collection),
        record_id,
    );
    let record = state.engine.record(&key).await?;
    let status = if record.is_some() {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    Ok((status, Json(record)))
}

async fn reset_state(State(state): State<MockTachyonState>) -> Result<StatusCode, MockApiError> {
    let pool = state.engine.storage().pool();
    for table in [
        "photon_engine_operations",
        "photon_engine_records",
        "photon_engine_cursors",
        "photon_engine_conflicts",
        "photon_engine_snapshots",
        "photon_engine_snapshot_updates",
    ] {
        let query = format!("DELETE FROM {table}");
        sqlx::query(&query).execute(pool).await?;
    }
    state.next_sequence.store(0, Ordering::SeqCst);
    {
        let mut events = state.events.lock().await;
        events.clear();
        events.push(AdminEvent {
            at_ms: now_ms(),
            event: "reset".into(),
            scope: None,
            collection: None,
            record_id: None,
            operation_id: None,
            detail: serde_json::json!({ "status": "cleared" }),
        });
    }
    Ok(StatusCode::NO_CONTENT)
}

fn current_position(state: &MockTachyonState) -> i64 {
    state.next_sequence.load(Ordering::SeqCst)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

async fn record_event(
    state: &MockTachyonState,
    event: impl Into<String>,
    operation: Option<&Operation>,
    scope: Option<&ScopeId>,
    detail: serde_json::Value,
) {
    let mut events = state.events.lock().await;
    events.push(AdminEvent {
        at_ms: now_ms(),
        event: event.into(),
        scope: scope
            .map(ToString::to_string)
            .or_else(|| operation.map(|operation| operation.key.scope.to_string())),
        collection: operation.map(|operation| operation.key.collection.to_string()),
        record_id: operation.map(|operation| operation.key.record_id.to_string()),
        operation_id: operation.map(|operation| operation.id.to_string()),
        detail,
    });
    if events.len() > 200 {
        let remove_count = events.len() - 200;
        events.drain(..remove_count);
    }
}

const ADMIN_DASHBOARD_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mock Tachyon Sync Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #657085;
      --line: #d9deea;
      --accent: #0f766e;
      --warn: #b45309;
      --bad: #b91c1c;
      --good: #15803d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 20px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 20px; }
    h2 { font-size: 16px; }
    h3 { font-size: 14px; }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      min-height: 34px;
      padding: 0 12px;
      cursor: pointer;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    main { padding: 20px 24px 32px; display: grid; gap: 18px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric, section, .record {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 14px; }
    .metric span { color: var(--muted); display: block; font-size: 12px; }
    .metric strong { display: block; font-size: 24px; margin-top: 4px; }
    section { padding: 16px; overflow: hidden; }
    .section-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 12px; }
    .muted { color: var(--muted); }
    .collections { display: grid; gap: 14px; }
    .records { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin-top: 8px; }
    .record { padding: 12px; }
    .record.deleted { border-color: #fecaca; background: #fff5f5; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f1f4f9;
      border-radius: 6px;
      padding: 10px;
      overflow: auto;
      max-height: 260px;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; word-break: break-word; }
    th { color: var(--muted); font-size: 12px; font-weight: 600; }
    .pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #eef2ff; }
    .accepted, .push_accepted { color: var(--good); }
    .conflict, .push_conflict { color: var(--warn); }
    .rejected, .push_rejected { color: var(--bad); }
    .empty { color: var(--muted); padding: 24px 0; }
    @media (max-width: 860px) {
      header { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      table { font-size: 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Mock Tachyon Sync Dashboard</h1>
      <div class="muted" id="last-updated">Loading...</div>
    </div>
    <div class="toolbar">
      <button class="primary" id="refresh">Refresh</button>
      <button id="reset">Reset remote</button>
      <label class="muted"><input type="checkbox" id="auto" checked> auto refresh</label>
    </div>
  </header>
  <main>
    <div class="grid">
      <div class="metric"><span>Remote</span><strong id="remote">-</strong></div>
      <div class="metric"><span>Position</span><strong id="position">0</strong></div>
      <div class="metric"><span>Records</span><strong id="records-count">0</strong></div>
      <div class="metric"><span>Operations</span><strong id="ops-count">0</strong></div>
    </div>
    <section>
      <div class="section-head">
        <h2>Records by scope and collection</h2>
        <span class="muted">current materialized state</span>
      </div>
      <div id="scopes" class="collections"></div>
    </section>
    <section>
      <div class="section-head">
        <h2>Recent sync events</h2>
        <span class="muted">push / pull / reset</span>
      </div>
      <div id="events"></div>
    </section>
    <section>
      <div class="section-head">
        <h2>Recent stored operations</h2>
        <span class="muted">latest 100</span>
      </div>
      <div id="operations"></div>
    </section>
  </main>
  <script>
    const state = { timer: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const json = (value) => esc(JSON.stringify(value, null, 2));
    const time = (ms) => ms ? new Date(ms).toLocaleTimeString() : '-';

    async function load() {
      const response = await fetch('/__admin/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`state failed: ${response.status}`);
      const data = await response.json();
      render(data);
    }

    function render(data) {
      const records = data.scopes.flatMap((scope) => scope.collections.flatMap((collection) => collection.records));
      $('remote').textContent = data.remote;
      $('position').textContent = data.position;
      $('records-count').textContent = records.length;
      $('ops-count').textContent = data.operations.length;
      $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
      renderScopes(data.scopes);
      renderEvents(data.events);
      renderOperations(data.operations);
    }

    function renderScopes(scopes) {
      if (!scopes.length) {
        $('scopes').innerHTML = '<div class="empty">No records yet. Run a sync push to populate this remote.</div>';
        return;
      }
      $('scopes').innerHTML = scopes.map((scope) => `
        <div>
          <h3>${esc(scope.scope)}</h3>
          ${scope.collections.map((collection) => `
            <div style="margin-top: 10px">
              <div class="muted">${esc(collection.collection)} · ${collection.records.length} records</div>
              <div class="records">
                ${collection.records.map((record) => `
                  <article class="record ${record.deleted ? 'deleted' : ''}">
                    <strong>${esc(record.record_id)}</strong>
                    <div class="muted">version ${esc(record.version)} · ${esc(record.updated_by)}</div>
                    <pre>${json(record.value)}</pre>
                  </article>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');
    }

    function renderEvents(events) {
      if (!events.length) {
        $('events').innerHTML = '<div class="empty">No sync events observed in this process.</div>';
        return;
      }
      $('events').innerHTML = `<table>
        <thead><tr><th style="width: 92px">Time</th><th style="width: 130px">Event</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>${events.map((event) => `
          <tr>
            <td>${esc(time(event.at_ms))}</td>
            <td class="${esc(event.event)}">${esc(event.event)}</td>
            <td>${esc([event.scope, event.collection, event.record_id].filter(Boolean).join(' / ') || '-')}</td>
            <td><pre>${json(event.detail)}</pre></td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    }

    function renderOperations(operations) {
      if (!operations.length) {
        $('operations').innerHTML = '<div class="empty">No stored operations yet.</div>';
        return;
      }
      $('operations').innerHTML = `<table>
        <thead><tr><th>Status</th><th>Target</th><th>Sequence</th><th>Kind</th></tr></thead>
        <tbody>${operations.map((operation) => `
          <tr>
            <td><span class="pill ${esc(operation.status)}">${esc(operation.status)}</span></td>
            <td>${esc(operation.scope)} / ${esc(operation.collection)} / ${esc(operation.record_id)}<br><span class="muted">${esc(operation.id)}</span></td>
            <td>local ${esc(operation.local_sequence)}<br>remote ${esc(operation.remote_sequence ?? '-')}</td>
            <td><pre>${json(operation.kind)}</pre></td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    }

    $('refresh').addEventListener('click', () => load().catch((error) => alert(error.message)));
    $('reset').addEventListener('click', async () => {
      await fetch('/__admin/reset', { method: 'POST' });
      await load();
    });
    $('auto').addEventListener('change', (event) => {
      clearInterval(state.timer);
      state.timer = event.target.checked ? setInterval(() => load().catch(console.error), 2000) : null;
    });
    state.timer = setInterval(() => load().catch(console.error), 2000);
    load().catch((error) => {
      $('last-updated').textContent = error.message;
    });
  </script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use photon_engine::{ActorId, HybridTimestamp, Operation, OperationKind, SyncEndpoint};
    use serde::de::DeserializeOwned;
    use std::collections::BTreeMap;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct RouterSyncEndpoint {
        app: Router,
    }

    #[async_trait]
    impl SyncEndpoint for RouterSyncEndpoint {
        async fn push(&self, request: PushRequest) -> photon_engine::Result<PushResult> {
            self.post_json("/v1/sync/push", &request).await
        }

        async fn pull(&self, request: PullRequest) -> photon_engine::Result<PullResult> {
            self.post_json("/v1/sync/pull", &request).await
        }
    }

    impl RouterSyncEndpoint {
        async fn post_json<T, B>(&self, path: &str, body: &B) -> photon_engine::Result<T>
        where
            T: DeserializeOwned,
            B: Serialize,
        {
            let response = self
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(body)?))
                        .unwrap(),
                )
                .await
                .map_err(|error| photon_engine::EngineError::Storage(error.to_string()))?;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .map_err(|error| photon_engine::EngineError::Storage(error.to_string()))?;
            Ok(serde_json::from_slice(&bytes)?)
        }
    }

    async fn test_state() -> MockTachyonState {
        init_state("sqlite::memory:").await.unwrap()
    }

    async fn get_text(app: Router, path: &str) -> (StatusCode, String) {
        let response = app
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn test_operation(record_id: &str, title: &str, wall_time_ms: i64) -> Operation {
        let mut fields = BTreeMap::new();
        fields.insert("title".into(), serde_json::json!(title));
        Operation::new(
            RecordKey::new("workspace:test", "issues", record_id),
            ActorId::from("client-a"),
            OperationKind::Patch { fields },
        )
        .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, "client-a"))
    }

    #[tokio::test]
    async fn sync_once_round_trips_over_mock_tachyon_http_routes() {
        let state = test_state().await;
        let app = build_app(state);
        let endpoint = RouterSyncEndpoint { app: app.clone() };
        let client_a = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        let client_b = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        let operation = test_operation("issue-1", "from client A", 10);

        client_a.apply_local_operation(operation).await.unwrap();
        let summary_a = client_a
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();
        let summary_b = client_b
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();

        assert_eq!(summary_a.pushed, 1);
        assert_eq!(summary_b.pulled, 1);

        let record_a = client_a
            .record(&RecordKey::new("workspace:test", "issues", "issue-1"))
            .await
            .unwrap()
            .unwrap();
        let record_b = client_b
            .record(&RecordKey::new("workspace:test", "issues", "issue-1"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record_a.value, record_b.value);
        assert_eq!(record_b.value["title"], "from client A");

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/records/workspace:test/issues/issue-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn admin_dashboard_exposes_current_sync_state_for_any_collection() {
        let state = test_state().await;
        let app = build_app(state);
        let endpoint = RouterSyncEndpoint { app: app.clone() };
        let client = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        let mut fields = BTreeMap::new();
        fields.insert("body".into(), serde_json::json!("Hello dashboard"));
        let operation = Operation::new(
            RecordKey::new("workspace:test", "documents", "doc-1"),
            ActorId::from("client-a"),
            OperationKind::Patch { fields },
        )
        .with_timestamp(HybridTimestamp::new(20, 0, "client-a"));

        client.apply_local_operation(operation).await.unwrap();
        client
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();

        let (status, html) = get_text(app.clone(), "/").await;
        assert_eq!(status, StatusCode::OK);
        assert!(html.contains("Mock Tachyon Sync Dashboard"));

        let (status, body) = get_text(app, "/__admin/state").await;
        assert_eq!(status, StatusCode::OK);
        let state: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(state["remote"], DEFAULT_REMOTE_ID);
        assert_eq!(state["position"], 1);
        assert_eq!(state["scopes"][0]["scope"], "workspace:test");
        assert_eq!(
            state["scopes"][0]["collections"][0]["collection"],
            "documents"
        );
        assert_eq!(
            state["scopes"][0]["collections"][0]["records"][0]["record_id"],
            "doc-1"
        );
        assert_eq!(
            state["scopes"][0]["collections"][0]["records"][0]["value"]["body"],
            "Hello dashboard"
        );
        assert!(state["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["event"] == "push_accepted"));
    }

    #[tokio::test]
    async fn reset_clears_mock_tachyon_remote_state() {
        let state = test_state().await;
        let app = build_app(state);
        let endpoint = RouterSyncEndpoint { app: app.clone() };
        let client = PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap());
        client
            .apply_local_operation(test_operation("issue-1", "temporary", 10))
            .await
            .unwrap();
        client
            .sync_once("workspace:test", DEFAULT_REMOTE_ID, &endpoint)
            .await
            .unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/__admin/reset")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/records/workspace:test/issues/issue-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
